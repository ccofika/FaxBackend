import fs from 'fs/promises';
import path from 'path';
import crypto from 'crypto';
import pdfParse from 'pdf-parse';
import pdf2pic from 'pdf2pic';
import Tesseract from 'tesseract.js';
import sharp from 'sharp';
import { Poppler } from 'node-poppler';

import { Material, DocumentSection, DocumentChunk } from '../models';
import { IMaterial } from '../models/Material';
import qdrantService from './qdrantService';
import r2Service from './r2Service';
import aiAnalysisService from './aiAnalysisService';

interface PageText {
  pageNumber: number;
  text: string;
  isOCR: boolean;
}

interface DocumentStructure {
  sections: Array<{
    sectionId: string;
    title: string;
    path: string;
    level: number;
    parentSectionId?: string;
    semanticType?: 'chapter' | 'section' | 'subsection' | 'paragraph';
    pageStart: number;
    pageEnd: number;
    charStart: number;
    charEnd: number;
    content: string;
  }>;
}

interface ChunkData {
  chunkId: string;
  sectionId: string;
  title?: string;
  path: string;
  page: number;
  paragraphIdx: number;
  charStart: number;
  charEnd: number;
  content: string;
}

interface HeaderFooterFilterConfig {
  // Y-position thresholds (0 = top, 1 = bottom)
  headerThreshold: number; // Content above this Y position is considered header
  footerThreshold: number; // Content below this Y position is considered footer
  
  // Text patterns to exclude
  excludePatterns: RegExp[];
  
  // Page number patterns
  pageNumberPatterns: RegExp[];
  
  // Title/header text patterns
  titlePatterns: RegExp[];
  
  // Reference/citation patterns
  referencePatterns: RegExp[];
}

class DocumentIngestionService {
  // Configurable filter for different PDF types
  private defaultFilterConfig: HeaderFooterFilterConfig = {
    headerThreshold: 0.15,  // Top 15% of page
    footerThreshold: 0.85,  // Bottom 15% of page
    excludePatterns: [
      /^Informacione i internet tehnologije$/i,  // Common header title
      /^\d+$/, // Standalone page numbers
      /^https?:\/\/\S+/, // URLs
      /^\d+\s*Prema podacima/i, // Reference markers
      /^Slika \d+\.\d+-\d+\./i, // Figure captions that are headers
    ],
    pageNumberPatterns: [
      /^\d+$/,
      /^Page \d+$/i,
      /^\d+\s*\/\s*\d+$/,
    ],
    titlePatterns: [
      /^Informacione i internet tehnologije$/i,
      /^HARDVER$/i,
      /^SOFTVER$/i,
      /^UMREŽAVANJE I INTERNET$/i,
    ],
    referencePatterns: [
      /^\d+\s*Prema podacima/i,
      /^https?:\/\/\S+/,
      /^http:\/\/\S+/,
      /Techcrunch\./i,
      /^Arrington, Michael/i,
    ]
  };

  private async logProgress(
    materialId: string,
    step: string,
    percent: number,
    message?: string
  ): Promise<void> {
    try {
      const updateData: any = {
        $set: {
          'progress.step': step,
          'progress.percent': percent,
        },
      };

      if (message) {
        updateData.$push = {
          logs: {
            timestamp: new Date(),
            level: 'info',
            message,
          },
        };
      }

      await Material.findByIdAndUpdate(materialId, updateData);
      console.log(`Progress: ${step} - ${percent}% - ${message || ''}`);
    } catch (error) {
      console.error('Error logging progress:', error);
    }
  }

  private async logError(materialId: string, message: string): Promise<void> {
    try {
      await Material.findByIdAndUpdate(materialId, {
        $push: {
          logs: {
            timestamp: new Date(),
            level: 'error',
            message,
          },
        },
      });
      console.error(`Error: ${message}`);
    } catch (error) {
      console.error('Error logging error:', error);
    }
  }

  private async downloadFromR2(r2Key: string): Promise<Buffer> {
    try {
      // This would use the existing R2 service or fetch directly
      const response = await fetch(
        `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`,
        {
          headers: this.getR2Headers('GET', r2Key),
        }
      );

      if (!response.ok) {
        throw new Error(`Failed to download from R2: ${response.statusText}`);
      }

      return Buffer.from(await response.arrayBuffer());
    } catch (error) {
      console.error('Error downloading from R2:', error);
      throw error;
    }
  }

  private getR2Headers(method: string, path: string): Record<string, string> {
    const credentials = {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || '',
    };

    const requestOptions = {
      method,
      host: `${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      path: `/${path}`,
      headers: {},
      service: 's3',
      region: 'auto',
    };

    const signedRequest = require('aws4').sign(requestOptions, credentials);
    return signedRequest.headers;
  }

  private async uploadToR2(r2Key: string, buffer: Buffer, contentType: string = 'application/octet-stream'): Promise<void> {
    try {
      const uploadUrl = `https://${process.env.R2_BUCKET_NAME}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
      
      const headers = {
        'Content-Type': contentType,
        ...this.getR2Headers('PUT', r2Key),
      };

      const response = await fetch(uploadUrl, {
        method: 'PUT',
        headers,
        body: buffer as any,
      });

      if (!response.ok) {
        throw new Error(`Failed to upload to R2: ${response.statusText}`);
      }
    } catch (error) {
      console.error('Error uploading to R2:', error);
      throw error;
    }
  }

  private calculateFileHash(buffer: Buffer): string {
    return crypto.createHash('sha256').update(buffer).digest('hex');
  }

  private cleanExtractedText(text: string): string {
    // Comprehensive text cleaning and normalization
    return text
      // Fix URL-encoded spaces and characters that might remain
      .replace(/%20/g, ' ')
      .replace(/%0A/g, '\n')
      .replace(/%09/g, ' ')
      
      // Remove excessive spaces (3+ consecutive spaces)
      .replace(/   +/g, ' ')
      
      // Fix spacing around punctuation - remove spaces before, ensure space after
      .replace(/ +([.,;:!?])/g, '$1')
      .replace(/([.,;:!?])([a-zA-ZšđčćžŠĐČĆŽ0-9])/g, '$1 $2')
      
      // Fix spacing around parentheses
      .replace(/ +\(/g, ' (')
      .replace(/\( +/g, '(')
      .replace(/ +\)/g, ')')
      .replace(/\) +([a-zA-ZšđčćžŠĐČĆŽ])/g, ') $1')
      
      // Remove spaces at the start/end of lines
      .replace(/^ +/gm, '')
      .replace(/ +$/gm, '')
      
      // Fix broken words that are split across lines
      .replace(/([a-zA-ZšđčćžŠĐČĆŽ])-\n([a-zA-ZšđčćžŠĐČĆŽ])/g, '$1$2')
      
      // Join lines that clearly belong together (lowercase to lowercase, or continuing sentences)
      .replace(/([a-zšđčćž,])\n([a-zšđčćž])/g, '$1 $2')
      
      // Keep paragraph breaks (double line breaks)
      .replace(/\n\n+/g, '\n\n')
      
      // Fix broken words (characters separated by single spaces - common OCR issue)
      .replace(/\b([a-zA-ZšđčćžŠĐČĆŽ]) ([a-zA-ZšđčćžŠĐČĆŽ]) ([a-zA-ZšđčćžŠĐČĆŽ])\b/g, '$1$2$3')
      .replace(/\b([a-zA-ZšđčćžŠĐČĆŽ]) ([a-zA-ZšđčćžŠĐČĆŽ])\b/g, (match, p1, p2) => {
        // Only merge if it looks like a broken word (both parts are lowercase or both uppercase)
        if ((p1.toLowerCase() === p1 && p2.toLowerCase() === p2) || 
            (p1.toUpperCase() === p1 && p2.toUpperCase() === p2)) {
          return p1 + p2;
        }
        return match;
      })
      
      // Normalize multiple line breaks
      .replace(/\n{3,}/g, '\n\n')
      
      // Clean up any remaining issues
      .trim();
  }

  async extractTextFromPDF(buffer: Buffer, startPage?: number, maxPages?: number): Promise<{ pages: PageText[]; pageCount: number }> {
    // Use node-poppler for true page-by-page extraction
    return this.extractTextWithNodePoppler(buffer, startPage || 1, maxPages || 1000);
  }

  private async extractTextWithNodePoppler(buffer: Buffer, startPage: number, maxPages: number): Promise<{ pages: PageText[]; pageCount: number }> {
    let tempFilePath: string = '';
    
    try {
      console.log(`🔄 Using node-poppler for true page-by-page extraction (pages ${startPage} to ${startPage + maxPages - 1})`);
      
      // node-poppler needs a file path, not buffer, so create temp file
      const tempDir = require('os').tmpdir();
      tempFilePath = require('path').join(tempDir, `temp_pdf_${Date.now()}.pdf`);
      await fs.writeFile(tempFilePath, buffer);
      
      console.log(`📁 Created temp PDF file: ${tempFilePath}`);
      
      const poppler = new Poppler();
      
      // First, get PDF info to determine total page count
      const pdfInfoResult = await poppler.pdfInfo(tempFilePath);
      console.log(`🔍 PDF Info result:`, pdfInfoResult);
      
      // Parse the info result to extract page count
      let totalPageCount = 1000; // Default fallback
      if (typeof pdfInfoResult === 'string') {
        const pagesMatch = pdfInfoResult.match(/Pages:\s*(\d+)/);
        if (pagesMatch) {
          totalPageCount = parseInt(pagesMatch[1]);
        }
      }
      
      const endPage = Math.min(startPage + maxPages - 1, totalPageCount);
      
      console.log(`📚 PDF has ${totalPageCount} pages, extracting ${startPage} to ${endPage}`);
      
      const pages: PageText[] = [];
      
      // Extract text for each page individually
      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        try {
          console.log(`📄 Extracting page ${pageNum}/${endPage}...`);
          
          // Extract text for this specific page
          const pageText = await poppler.pdfToText(tempFilePath, undefined, {
            firstPageToConvert: pageNum,
            lastPageToConvert: pageNum,
            maintainLayout: true // Preserve layout for better structure
          });
          
          console.log(`🔍 Raw page text length: ${pageText ? pageText.length : 0}`);
          
          // Clean the extracted text
          const cleanedText = pageText ? this.cleanExtractedText(pageText) : '';
          
          console.log(`✅ Page ${pageNum} extracted: ${cleanedText.length} characters`);
          console.log(`📖 Page ${pageNum} preview: "${cleanedText.substring(0, 100)}..."`);
          
          pages.push({
            pageNumber: pageNum,
            text: cleanedText,
            isOCR: false,
          });
          
        } catch (pageError) {
          console.error(`❌ Error extracting page ${pageNum}:`, pageError);
          // Add empty page to maintain sequence
          pages.push({
            pageNumber: pageNum,
            text: '',
            isOCR: false,
          });
        }
      }
      
      console.log(`🎉 Successfully extracted ${pages.length} pages using node-poppler`);
      return { 
        pages, 
        pageCount: pages.length 
      };
      
    } catch (error) {
      console.error('❌ Error with node-poppler, falling back to pdf-parse:', error);
      // Fallback to pdf-parse if node-poppler fails
      return this.extractTextWithPdfParse(buffer, startPage, maxPages);
    } finally {
      // Clean up temp file
      if (tempFilePath) {
        try {
          await fs.unlink(tempFilePath);
          console.log(`🗑️ Cleaned up temp file: ${tempFilePath}`);
        } catch (cleanupError) {
          console.warn(`⚠️ Could not clean up temp file: ${cleanupError}`);
        }
      }
    }
  }

  private async extractTextWithPdfParse(buffer: Buffer, startPage: number, maxPages: number): Promise<{ pages: PageText[]; pageCount: number }> {
    try {
      console.log(`Fallback: Using pdf-parse to extract document content (pages ${startPage} to ${startPage + maxPages - 1})`);
      
      const pdfData = await pdfParse(buffer);
      const totalPageCount = pdfData.numpages;
      const endPage = Math.min(startPage + maxPages - 1, totalPageCount);
      
      // Extract entire document text without page restrictions
      const cleanedText = this.cleanExtractedText(pdfData.text);
      
      // Estimate text per page and split accordingly
      const estimatedTextPerPage = Math.ceil(cleanedText.length / totalPageCount);
      const pages: PageText[] = [];
      
      console.log(`📊 Total pages: ${totalPageCount}, estimated chars per page: ${estimatedTextPerPage}`);
      
      for (let pageNum = startPage; pageNum <= endPage; pageNum++) {
        const startCharIndex = (pageNum - 1) * estimatedTextPerPage;
        const endCharIndex = Math.min(startCharIndex + estimatedTextPerPage, cleanedText.length);
        const pageText = cleanedText.substring(startCharIndex, endCharIndex);
        
        console.log(`📄 PDF-Parse Page ${pageNum} estimated: ${pageText.length} characters`);
        console.log(`📄 PDF-Parse Page ${pageNum} content preview: "${pageText.substring(0, 100)}..."`);
        
        pages.push({
          pageNumber: pageNum,
          text: pageText,
          isOCR: false,
        });
      }

      return { 
        pages, 
        pageCount: pages.length 
      };
    } catch (error) {
      console.error('Error with pdf-parse fallback:', error);
      throw error;
    }
  }

  private async renderPDFPages(buffer: Buffer, materialId: string): Promise<{ pageCount: number; pagesPrefix: string }> {
    try {
      const pagesPrefix = `pages/${materialId}`;
      
      // Try to get page count from PDF first
      const pdfData = await pdfParse(buffer);
      const pageCount = pdfData.numpages;
      
      console.log(`PDF has ${pageCount} pages, skipping image rendering for now`);
      
      // For now, skip the image rendering to avoid the write EOF error
      // This is a Windows-specific issue with pdf2pic
      // We can implement a different approach later if needed
      
      return { pageCount, pagesPrefix };
    } catch (error) {
      console.error('Error getting PDF page count:', error);
      // Fallback to 1 page if we can't determine
      return { pageCount: 1, pagesPrefix: `pages/${materialId}` };
    }
  }

  private async performOCR(buffer: Buffer, materialId: string): Promise<{ pages: PageText[]; ocrPrefix: string }> {
    try {
      const ocrPrefix = `ocr/${materialId}`;
      
      console.log('OCR functionality disabled for now due to Windows compatibility issues');
      
      // Return empty OCR results for now
      // We can implement OCR later with a different approach
      return { pages: [], ocrPrefix };
    } catch (error) {
      console.error('Error performing OCR:', error);
      throw error;
    }
  }

  private async savePageTexts(pages: PageText[], materialId: string): Promise<string> {
    try {
      // Don't save individual page text files to R2
      // We'll store everything in MongoDB instead
      const textPrefix = `text/${materialId}`;
      console.log(`Skipping R2 text upload, using MongoDB storage instead`);
      return textPrefix;
    } catch (error) {
      console.error('Error saving page texts:', error);
      throw error;
    }
  }

  private splitTextIntoSafeChunks(text: string, maxTokens: number = 6000): string[] {
    // Conservative approach: assume 1 token = 3 characters (safer than 4)
    const maxChars = maxTokens * 3;
    const chunks: string[] = [];
    
    if (text.length <= maxChars) {
      return [text];
    }
    
    // Split by paragraphs first (double newlines)
    const paragraphs = text.split('\n\n');
    let currentChunk = '';
    
    for (const paragraph of paragraphs) {
      const trimmedParagraph = paragraph.trim();
      if (!trimmedParagraph) continue;
      
      // If adding this paragraph would exceed the limit
      if (currentChunk.length + trimmedParagraph.length + 2 > maxChars) {
        if (currentChunk) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        
        // If single paragraph is too large, split it by sentences
        if (trimmedParagraph.length > maxChars) {
          const sentences = trimmedParagraph.split(/[.!?]+\s+/);
          let sentenceChunk = '';
          
          for (const sentence of sentences) {
            if (sentenceChunk.length + sentence.length + 2 > maxChars) {
              if (sentenceChunk) {
                chunks.push(sentenceChunk.trim());
                sentenceChunk = '';
              }
              
              // If single sentence is still too long, force split by characters
              if (sentence.length > maxChars) {
                for (let i = 0; i < sentence.length; i += maxChars) {
                  chunks.push(sentence.substring(i, i + maxChars));
                }
              } else {
                sentenceChunk = sentence + '.';
              }
            } else {
              sentenceChunk += sentence + '. ';
            }
          }
          
          if (sentenceChunk) {
            currentChunk = sentenceChunk.trim();
          }
        } else {
          currentChunk = trimmedParagraph;
        }
      } else {
        currentChunk += (currentChunk ? '\n\n' : '') + trimmedParagraph;
      }
    }
    
    if (currentChunk) {
      chunks.push(currentChunk.trim());
    }
    
    return chunks.filter(chunk => chunk.length > 0);
  }

  private async detectDocumentStructure(fullText: string, materialId: string, tocPage?: number, tocToPage?: number, contentStartPage?: number): Promise<DocumentStructure> {
    // First, we need to extract text from the ENTIRE PDF to find the TOC
    // since TOC is usually at the beginning (pages 2-4) but we might be processing later pages
    let entirePdfText = '';
    
    try {
      // Get the material to access the PDF again
      const material = await Material.findById(materialId);
      if (material && material.r2Key) {
        console.log('Re-downloading PDF to extract complete text for TOC detection');
        const pdfBuffer = await this.downloadFromR2(material.r2Key);
        
        // Extract text from entire PDF (no page limits)
        const { pages: allPages } = await this.extractTextFromPDF(pdfBuffer, 1, 50); // Extract up to 50 pages to find TOC
        entirePdfText = allPages.map(page => page.text).join('\n\n');
        console.log(`Extracted complete PDF text: ${entirePdfText.length} characters`);
      }
    } catch (error) {
      console.error('Error re-extracting PDF text for TOC:', error);
      entirePdfText = fullText; // Fallback to provided text
    }
    
    // Try AI-based TOC analysis if we have page range
    if (tocPage && tocToPage) {
      console.log(`🤖 Using AI to analyze TOC from pages ${tocPage} to ${tocToPage}`);
      try {
        const aiStructure = await this.analyzeWithAI(entirePdfText, materialId, tocPage, tocToPage, fullText, contentStartPage);
        if (aiStructure && aiStructure.sections.length > 0) {
          console.log('✅ Using AI-based structure detection');
          return aiStructure;
        }
      } catch (error) {
        console.error('❌ AI analysis failed:', error);
      }
    }
    
    // Fallback to pattern-based TOC detection
    const tocBasedStructure = this.extractStructureFromTOC(entirePdfText, fullText, tocPage);
    if (tocBasedStructure && tocBasedStructure.sections.length > 0) {
      console.log('Using pattern-based TOC structure detection');
      return tocBasedStructure;
    }
    
    console.log('TOC not found, falling back to content-based detection');
    return this.fallbackDocumentStructure(fullText);
  }

  private async analyzeWithAI(entirePdfText: string, materialId: string, tocPage: number, tocToPage: number, currentPageText: string, contentStartPage?: number): Promise<DocumentStructure | null> {
    try {
      // Extract TOC text from the specified page range
      console.log(`📖 Extracting TOC text from pages ${tocPage} to ${tocToPage}`);
      
      const material = await Material.findById(materialId);
      if (!material || !material.r2Key) {
        throw new Error('Material not found for AI analysis');
      }

      // Download PDF again to extract specific TOC pages
      const pdfBuffer = await this.downloadFromR2(material.r2Key);
      const tocPageCount = tocToPage - tocPage + 1;
      
      console.log(`📋 Extracting TOC from pages ${tocPage} to ${tocToPage} (${tocPageCount} pages)`);
      const { pages: tocPages } = await this.extractTextFromPDF(pdfBuffer, tocPage, tocPageCount);
      
      console.log(`📝 TOC extraction result: ${tocPages.length} pages extracted`);
      tocPages.forEach((page, index) => {
        console.log(`📄 TOC Page ${page.pageNumber}: ${page.text.length} chars`);
        console.log(`📄 TOC Page ${page.pageNumber} preview: "${page.text.substring(0, 200)}..."`);
      });
      
      const tocText = tocPages.map(page => page.text).join('\n\n');
      console.log(`📝 Combined TOC text (${tocText.length} characters)`);
      console.log(`📝 Combined TOC preview: "${tocText.substring(0, 500)}..."`);
      
      if (tocText.length < 100) {
        console.log('⚠️ TOC text too short, falling back to pattern detection');
        return null;
      }

      // Analyze with AI
      console.log('🤖 Sending TOC to AI for analysis');
      const aiResult = await aiAnalysisService.analyzeTOC(tocText, tocPage, tocToPage);
      
      console.log(`🎯 AI found ${aiResult.sections.length} sections`);
      
      console.log(`📚 AI will analyze ALL sections from TOC, processing range filtering removed`);
      
      // Process sections sequentially using proper header-based content extraction
      console.log(`🎯 Processing ALL ${aiResult.sections.length} sections sequentially from complete TOC analysis`);
      
      const sections: DocumentStructure['sections'] = [];
      
      // Process sections in sequential order to properly extract content between headers
      for (let index = 0; index < aiResult.sections.length; index++) {
        const section = aiResult.sections[index];
        const sectionId = `section_${index + 1}`;
        
        console.log(`📝 Processing section ${index + 1}/${aiResult.sections.length}: "${section.title}"`);
        
        // Find the actual content for this section using enhanced header detection
        const contentResult = this.extractSectionContentSequentially(
          currentPageText, 
          section, 
          aiResult.sections, 
          index
        );
        
        // Create the main section
        const mainSection = {
          sectionId,
          title: section.title,
          path: this.generateAISectionPath(section, aiResult.sections),
          level: section.level,
          parentSectionId: section.parentSectionId,
          semanticType: section.semanticType,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          charStart: contentResult.charStart,
          charEnd: contentResult.charEnd,
          content: contentResult.content
        };
        
        sections.push(mainSection);
        
        // Handle section splitting if content exceeds limits
        if (contentResult.needsSplitting && contentResult.parts && contentResult.parts.length > 1) {
          console.log(`📚 Creating ${contentResult.parts.length - 1} additional part sections for "${section.title}"`);
          
          for (let partIndex = 1; partIndex < contentResult.parts.length; partIndex++) {
            const partSection = {
              sectionId: `${sectionId}_part${partIndex + 1}`,
              title: `${section.title} - Part ${partIndex + 1}`,
              path: `${this.generateAISectionPath(section, aiResult.sections)}.${partIndex + 1}`,
              level: section.level,
              parentSectionId: sectionId, // Parent is the main section
              semanticType: section.semanticType,
              pageStart: section.pageStart,
              pageEnd: section.pageEnd,
              charStart: contentResult.charStart + (partIndex * 8000), // Estimate char position
              charEnd: contentResult.charStart + ((partIndex + 1) * 8000),
              content: contentResult.parts[partIndex]
            };
            
            sections.push(partSection);
          }
        }
      }

      return { sections };
      
    } catch (error) {
      console.error('Error in AI analysis:', error);
      return null;
    }
  }

  private extractSectionContentSequentially(
    fullText: string, 
    section: any, 
    allSections: any[], 
    currentIndex: number
  ): { 
    content: string; 
    charStart: number; 
    charEnd: number; 
    parts?: string[]; 
    needsSplitting?: boolean; 
    metadata?: any 
  } {
    console.log(`🔍 Extracting content sequentially for section "${section.title}"`);
    
    // Enhanced header detection with multiple patterns and edge cases
    const headerInfo = this.findHeaderWithMultipleStrategies(fullText, section.title);
    
    if (!headerInfo.found) {
      console.log(`⚠️ Header not found for "${section.title}", using fallback position estimation`);
      return this.fallbackContentExtraction(fullText, section, allSections, currentIndex);
    }
    
    console.log(`✅ Found header "${section.title}" at position ${headerInfo.position}`);
    
    // Find the end position by looking for the next section header in sequence
    const contentEnd = this.findNextSectionBoundary(fullText, headerInfo.position, allSections, currentIndex);
    
    // Extract raw content between this header and the next
    const contentStart = headerInfo.position + headerInfo.headerLength;
    let rawContent = fullText.substring(contentStart, contentEnd).trim();
    
    // Clean and process the content
    rawContent = this.cleanSectionContent(rawContent, section.title);
    
    // Check if content needs to be split due to size limits
    const contentResult = this.handleContentSplitting(rawContent, section.title);
    
    return {
      content: contentResult.content,
      charStart: contentStart,
      charEnd: contentEnd,
      parts: contentResult.parts,
      needsSplitting: contentResult.needsSplitting,
      metadata: {
        headerPosition: headerInfo.position,
        headerPattern: headerInfo.pattern,
        originalLength: rawContent.length,
        extractionMethod: 'sequential_header_detection'
      }
    };
  }

  private findSectionContentByHeader(fullText: string, sectionTitle: string, pageStart: number, pageEnd: number, allSections: any[], currentIndex: number): { content: string; charStart: number; charEnd: number; parts?: string[]; metadata?: any } {
    console.log(`🔍 Finding content for section "${sectionTitle}" using header detection`);
    
    // Try to find the section title as a header in the text
    const headerMatch = this.detectHeaderInText(fullText, sectionTitle);
    
    if (headerMatch.found) {
      console.log(`✅ Found header "${sectionTitle}" at position ${headerMatch.position}`);
      
      // Find the end of this section by looking for the next section header
      const nextSectionEnd = this.findNextSectionHeader(fullText, headerMatch.position, allSections, currentIndex);
      
      // Extract content from after the header to the next section
      const contentStart = headerMatch.position + headerMatch.headerText.length;
      const contentEnd = nextSectionEnd;
      
      let content = fullText.substring(contentStart, contentEnd).trim();
      
      // Apply character limit and create parts if necessary
      const processedContent = this.processContentWithLimits(content, sectionTitle);
      
      console.log(`✅ Extracted header-based content for "${sectionTitle}": ${processedContent.content.length} characters`);
      return {
        content: processedContent.content,
        charStart: contentStart,
        charEnd: contentEnd,
        parts: processedContent.parts,
        metadata: processedContent.metadata
      };
    }
    
    // Fallback to the original method if header detection fails
    console.log(`⚠️ Header not found for "${sectionTitle}", falling back to title search`);
    const fallbackResult = this.findAISectionContent(fullText, sectionTitle, pageStart, pageEnd);
    return {
      ...fallbackResult,
      parts: undefined,
      metadata: undefined
    };
  }

  private detectHeaderInText(fullText: string, sectionTitle: string): { found: boolean; position: number; headerText: string; level: number } {
    console.log(`🎯 Detecting header patterns for: "${sectionTitle}"`);
    
    // Header detection patterns - look for structural elements that indicate headers
    const headerPatterns = [
      // Pattern 1: Title surrounded by whitespace (typical h1/h2 style)
      {
        pattern: new RegExp(`\\n\\s*${this.escapeRegex(sectionTitle)}\\s*\\n`, 'i'),
        level: 1
      },
      // Pattern 2: Title with numbering (e.g., "1. TITLE" or "1.1 TITLE")
      {
        pattern: new RegExp(`\\n\\s*\\d+\\.\\d*\\s*${this.escapeRegex(sectionTitle)}\\s*\\n`, 'i'),
        level: 2
      },
      // Pattern 3: All caps title (typical chapter/section style)
      {
        pattern: new RegExp(`\\n\\s*${this.escapeRegex(sectionTitle.toUpperCase())}\\s*\\n`, 'i'),
        level: 1
      },
      // Pattern 4: Title at line start (simple header)
      {
        pattern: new RegExp(`(?:^|\\n)\\s*${this.escapeRegex(sectionTitle)}\\s*(?:\\n|$)`, 'i'),
        level: 2
      },
      // Pattern 5: Flexible matching with word boundaries
      {
        pattern: new RegExp(`\\b${this.escapeRegex(sectionTitle)}\\b`, 'i'),
        level: 3
      }
    ];
    
    for (const { pattern, level } of headerPatterns) {
      const match = fullText.match(pattern);
      if (match) {
        const position = fullText.indexOf(match[0]);
        if (position !== -1) {
          console.log(`✅ Found header pattern (level ${level}) at position ${position}`);
          return {
            found: true,
            position,
            headerText: match[0],
            level
          };
        }
      }
    }
    
    console.log(`❌ No header pattern found for "${sectionTitle}"`);
    return { found: false, position: -1, headerText: '', level: 0 };
  }

  private findNextSectionHeader(fullText: string, currentPosition: number, allSections: any[], currentIndex: number): number {
    // Look for the next section title in the text
    let nextHeaderPosition = fullText.length; // Default to end of document
    
    // Check all subsequent sections from TOC
    for (let i = currentIndex + 1; i < allSections.length; i++) {
      const nextSection = allSections[i];
      const nextHeaderMatch = this.detectHeaderInText(fullText.substring(currentPosition + 100), nextSection.title);
      
      if (nextHeaderMatch.found) {
        const absolutePosition = currentPosition + 100 + nextHeaderMatch.position;
        if (absolutePosition < nextHeaderPosition) {
          nextHeaderPosition = absolutePosition;
          console.log(`🎯 Next section "${nextSection.title}" found at position ${absolutePosition}`);
          break;
        }
      }
    }
    
    // Also look for common section ending patterns
    const remainingText = fullText.substring(currentPosition + 100);
    const endingPatterns = [
      /\n\s*\d+\.\s*[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]{5,}/,  // Next numbered section
      /\n\s*[A-ZŠĐČĆŽ]{3,}[A-ZŠĐČĆŽa-zšđčćž\s]*\n/,        // Next all-caps section
      /\n\s*LITERATURA\s*\n/i,                              // Bibliography section
      /\n\s*ZAKLJUČAK\s*\n/i,                               // Conclusion section
    ];
    
    for (const pattern of endingPatterns) {
      const match = remainingText.search(pattern);
      if (match !== -1) {
        const absoluteMatch = currentPosition + 100 + match;
        if (absoluteMatch < nextHeaderPosition) {
          nextHeaderPosition = absoluteMatch;
          console.log(`🔚 Section end pattern found at position ${absoluteMatch}`);
        }
      }
    }
    
    return nextHeaderPosition;
  }

  private processContentWithLimits(content: string, sectionTitle: string): { content: string; parts?: string[]; metadata?: any } {
    // Maximum characters per section part (to fit in database and embeddings)
    const MAX_SECTION_CHARS = 8000;
    
    if (content.length <= MAX_SECTION_CHARS) {
      return { content: content.trim() };
    }
    
    console.log(`✂️ Section "${sectionTitle}" exceeds limit (${content.length} chars), splitting into parts`);
    
    // Split content into multiple parts
    const parts = this.splitContentIntoParts(content, MAX_SECTION_CHARS, sectionTitle);
    
    console.log(`📚 Split "${sectionTitle}" into ${parts.length} parts`);
    
    return { 
      content: parts[0], // Return first part as main content
      parts: parts,      // Store all parts for additional processing
      metadata: {
        originalLength: content.length,
        totalParts: parts.length,
        needsPartSplitting: true
      }
    };
  }

  private splitContentIntoParts(content: string, maxChars: number, sectionTitle: string): string[] {
    const parts: string[] = [];
    const safeMaxChars = maxChars - 100; // Leave margin for metadata
    
    // Try to split by paragraphs first (double newlines)
    const paragraphs = content.split('\n\n');
    let currentPart = '';
    let partNumber = 1;
    
    for (let i = 0; i < paragraphs.length; i++) {
      const paragraph = paragraphs[i].trim();
      if (!paragraph) continue;
      
      // Check if adding this paragraph would exceed the limit
      const potentialLength = currentPart.length + paragraph.length + 2; // +2 for \n\n
      
      if (potentialLength <= safeMaxChars) {
        // Add paragraph to current part
        currentPart += (currentPart ? '\n\n' : '') + paragraph;
      } else {
        // Save current part if it has content
        if (currentPart.trim()) {
          const partHeader = `[Part ${partNumber} of "${sectionTitle}"]`;
          parts.push(partHeader + '\n\n' + currentPart.trim());
          partNumber++;
        }
        
        // Start new part with current paragraph
        // If single paragraph is too long, split it by sentences
        if (paragraph.length > safeMaxChars) {
          const sentenceParts = this.splitLongParagraph(paragraph, safeMaxChars, sectionTitle, partNumber);
          parts.push(...sentenceParts);
          partNumber += sentenceParts.length;
          currentPart = '';
        } else {
          currentPart = paragraph;
        }
      }
    }
    
    // Add the last part if it has content
    if (currentPart.trim()) {
      const partHeader = `[Part ${partNumber} of "${sectionTitle}"]`;
      parts.push(partHeader + '\n\n' + currentPart.trim());
    }
    
    // If we somehow didn't create any parts, create at least one
    if (parts.length === 0) {
      const fallbackContent = content.length > safeMaxChars 
        ? content.substring(0, safeMaxChars) + '...[truncated]'
        : content;
      parts.push(`[Part 1 of "${sectionTitle}"]\n\n${fallbackContent}`);
    }
    
    console.log(`📝 Created ${parts.length} parts for "${sectionTitle}"`);
    return parts;
  }

  private splitLongParagraph(paragraph: string, maxChars: number, sectionTitle: string, startPartNumber: number): string[] {
    const parts: string[] = [];
    const sentences = paragraph.split(/([.!?]+\s+)/);
    let currentPart = '';
    let partNumber = startPartNumber;
    
    for (let i = 0; i < sentences.length; i += 2) { // Process sentence + delimiter pairs
      const sentence = sentences[i] + (sentences[i + 1] || '');
      
      if (currentPart.length + sentence.length <= maxChars - 100) {
        currentPart += sentence;
      } else {
        if (currentPart.trim()) {
          const partHeader = `[Part ${partNumber} of "${sectionTitle}"]`;
          parts.push(partHeader + '\n\n' + currentPart.trim());
          partNumber++;
        }
        currentPart = sentence;
      }
    }
    
    if (currentPart.trim()) {
      const partHeader = `[Part ${partNumber} of "${sectionTitle}"]`;
      parts.push(partHeader + '\n\n' + currentPart.trim());
    }
    
    return parts;
  }

  private findHeaderWithMultipleStrategies(fullText: string, sectionTitle: string): {
    found: boolean;
    position: number;
    headerLength: number;
    pattern: string;
  } {
    console.log(`🎯 Using multiple strategies to find header: "${sectionTitle}"`);
    
    // Strategy 1: Exact match with various formatting patterns
    const exactPatterns = [
      // Pattern: "1. NASLOV" or "NASLOV" surrounded by whitespace
      `\\n\\s*${this.escapeRegex(sectionTitle)}\\s*\\n`,
      // Pattern: "1.1 NASLOV" with numbering
      `\\n\\s*\\d+\\.?\\d*\\.?\\s*${this.escapeRegex(sectionTitle)}\\s*\\n`,
      // Pattern: All uppercase version
      `\\n\\s*${this.escapeRegex(sectionTitle.toUpperCase())}\\s*\\n`,
      // Pattern: Title case version
      `\\n\\s*${this.escapeRegex(this.toTitleCase(sectionTitle))}\\s*\\n`,
    ];
    
    for (let i = 0; i < exactPatterns.length; i++) {
      const pattern = exactPatterns[i];
      const regex = new RegExp(pattern, 'gi');
      const match = regex.exec(fullText);
      
      if (match) {
        console.log(`✅ Found header using exact pattern ${i + 1} at position ${match.index}`);
        return {
          found: true,
          position: match.index,
          headerLength: match[0].length,
          pattern: `exact_pattern_${i + 1}`
        };
      }
    }
    
    // Strategy 2: Flexible word-based matching
    const words = sectionTitle.split(/\s+/).filter(word => word.length > 2);
    if (words.length >= 2) {
      // Try matching key words in sequence
      const keyWordPattern = words.map(word => this.escapeRegex(word)).join('\\s+.*?');
      const regex = new RegExp(`\\n\\s*.*?${keyWordPattern}.*?\\n`, 'gi');
      const match = regex.exec(fullText);
      
      if (match) {
        console.log(`✅ Found header using word-based pattern at position ${match.index}`);
        return {
          found: true,
          position: match.index,
          headerLength: match[0].length,
          pattern: 'word_based_matching'
        };
      }
    }
    
    // Strategy 3: Partial matching with high confidence scoring
    const cleanTitle = sectionTitle.replace(/^\d+\.?\s*/, '').trim(); // Remove leading numbers
    if (cleanTitle.length > 3) {
      const partialPattern = this.escapeRegex(cleanTitle);
      const regex = new RegExp(`\\n\\s*.*?${partialPattern}.*?\\n`, 'gi');
      let match;
      
      while ((match = regex.exec(fullText)) !== null) {
        // Score this match based on context
        const context = fullText.substring(Math.max(0, match.index - 100), match.index + match[0].length + 100);
        const confidence = this.calculateHeaderConfidence(context, sectionTitle);
        
        if (confidence > 0.7) { // High confidence threshold
          console.log(`✅ Found header using partial matching (confidence: ${confidence}) at position ${match.index}`);
          return {
            found: true,
            position: match.index,
            headerLength: match[0].length,
            pattern: `partial_match_conf_${confidence.toFixed(2)}`
          };
        }
      }
    }
    
    console.log(`❌ No header found for "${sectionTitle}" using any strategy`);
    return { found: false, position: -1, headerLength: 0, pattern: 'none' };
  }

  private findNextSectionBoundary(fullText: string, currentPosition: number, allSections: any[], currentIndex: number): number {
    console.log(`🔍 Finding next section boundary from position ${currentPosition}`);
    
    let nextBoundaryPosition = fullText.length; // Default to end of document
    
    // Look for the next section header in the TOC sequence
    for (let i = currentIndex + 1; i < allSections.length; i++) {
      const nextSection = allSections[i];
      const nextHeaderInfo = this.findHeaderWithMultipleStrategies(
        fullText.substring(currentPosition + 100), // Skip some chars to avoid finding current header
        nextSection.title
      );
      
      if (nextHeaderInfo.found) {
        const absolutePosition = currentPosition + 100 + nextHeaderInfo.position;
        if (absolutePosition < nextBoundaryPosition) {
          nextBoundaryPosition = absolutePosition;
          console.log(`🎯 Next section "${nextSection.title}" found at position ${absolutePosition}`);
          break; // Found the immediate next section
        }
      }
    }
    
    // Also check for common section ending patterns
    const remainingText = fullText.substring(currentPosition + 200);
    const endingPatterns = [
      /\n\s*\d+\.\s*[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]{5,}\s*\n/,  // Next numbered section
      /\n\s*[A-ZŠĐČĆŽ]{4,}[A-ZŠĐČĆŽa-zšđčćž\s]*\s*\n/,        // Next all-caps section
      /\n\s*LITERATURA\s*\n/i,                                  // Bibliography section
      /\n\s*ZAKLJUČAK\s*\n/i,                                   // Conclusion section
      /\n\s*REFERENCE\s*\n/i,                                   // References section
      /\n\s*BIBLIOGRAFIJA\s*\n/i,                               // Bibliography (Serbian)
    ];
    
    for (const pattern of endingPatterns) {
      const match = remainingText.search(pattern);
      if (match !== -1) {
        const absoluteMatch = currentPosition + 200 + match;
        if (absoluteMatch < nextBoundaryPosition) {
          nextBoundaryPosition = absoluteMatch;
          console.log(`🔚 Section end pattern found at position ${absoluteMatch}`);
        }
      }
    }
    
    return nextBoundaryPosition;
  }

  private cleanSectionContent(content: string, sectionTitle: string): string {
    console.log(`🧹 Cleaning content for section "${sectionTitle}" (${content.length} chars)`);
    
    // Remove the header line if it appears at the beginning
    const lines = content.split('\n');
    let cleanLines = [...lines];
    
    // Check if first few lines contain the section title and remove them
    for (let i = 0; i < Math.min(3, lines.length); i++) {
      const line = lines[i].trim().toLowerCase();
      const titleLower = sectionTitle.toLowerCase().replace(/^\d+\.?\s*/, '');
      
      if (line.includes(titleLower) || this.calculateSimilarity(line, titleLower) > 0.8) {
        console.log(`🗑️ Removing header line: "${lines[i]}"`);
        cleanLines.splice(i, 1);
        break;
      }
    }
    
    // Join back and clean whitespace
    let cleanedContent = cleanLines.join('\n')
      .replace(/\n\n\n+/g, '\n\n') // Remove excessive line breaks
      .replace(/[ \t]+/g, ' ')      // Normalize spaces
      .trim();
    
    console.log(`✨ Cleaned content: ${cleanedContent.length} chars (was ${content.length})`);
    return cleanedContent;
  }

  private handleContentSplitting(content: string, sectionTitle: string): {
    content: string;
    parts?: string[];
    needsSplitting: boolean;
  } {
    const MAX_SECTION_SIZE = 8000; // Characters
    
    if (content.length <= MAX_SECTION_SIZE) {
      return { content, needsSplitting: false };
    }
    
    console.log(`✂️ Content exceeds limit (${content.length} chars), splitting for "${sectionTitle}"`);
    
    // Split content intelligently by paragraphs
    const parts = this.splitContentIntoParts(content, MAX_SECTION_SIZE, sectionTitle);
    
    return {
      content: parts[0], // First part as main content
      parts,
      needsSplitting: true
    };
  }

  private fallbackContentExtraction(fullText: string, section: any, allSections: any[], currentIndex: number): {
    content: string;
    charStart: number;
    charEnd: number;
    parts?: string[];
    needsSplitting?: boolean;
    metadata?: any;
  } {
    console.log(`🔄 Using fallback content extraction for "${section.title}"`);
    
    // Estimate position based on page numbers and document length
    const estimatedCharsPerPage = Math.floor(fullText.length / 100); // Rough estimate
    const estimatedStart = Math.max(0, (section.pageStart - 1) * estimatedCharsPerPage);
    const estimatedEnd = Math.min(fullText.length, section.pageEnd * estimatedCharsPerPage);
    
    let content = fullText.substring(estimatedStart, estimatedEnd).trim();
    const contentResult = this.handleContentSplitting(content, section.title);
    
    return {
      content: contentResult.content,
      charStart: estimatedStart,
      charEnd: estimatedEnd,
      parts: contentResult.parts,
      needsSplitting: contentResult.needsSplitting,
      metadata: {
        extractionMethod: 'fallback_page_estimation',
        estimatedCharsPerPage
      }
    };
  }

  private calculateHeaderConfidence(context: string, originalTitle: string): number {
    const contextLower = context.toLowerCase();
    const titleLower = originalTitle.toLowerCase();
    
    let confidence = 0;
    
    // Check if context looks like a header (isolated line)
    if (context.includes('\n') && context.split('\n').some(line => 
      line.trim().length > 0 && line.trim().length < 100 && line.includes(titleLower.substring(0, 5))
    )) {
      confidence += 0.3;
    }
    
    // Check for header formatting indicators
    if (/^\s*\d+\./.test(context)) confidence += 0.2; // Numbered
    if (/[A-Z]{4,}/.test(context)) confidence += 0.2; // Contains uppercase
    if (context.includes(titleLower)) confidence += 0.3; // Contains title
    
    return confidence;
  }

  private calculateSimilarity(str1: string, str2: string): number {
    const longer = str1.length > str2.length ? str1 : str2;
    const shorter = str1.length > str2.length ? str2 : str1;
    
    if (longer.length === 0) return 1.0;
    
    const editDistance = this.levenshteinDistance(longer, shorter);
    return (longer.length - editDistance) / longer.length;
  }

  private levenshteinDistance(str1: string, str2: string): number {
    const matrix = [];
    
    for (let i = 0; i <= str2.length; i++) {
      matrix[i] = [i];
    }
    
    for (let j = 0; j <= str1.length; j++) {
      matrix[0][j] = j;
    }
    
    for (let i = 1; i <= str2.length; i++) {
      for (let j = 1; j <= str1.length; j++) {
        if (str2.charAt(i - 1) === str1.charAt(j - 1)) {
          matrix[i][j] = matrix[i - 1][j - 1];
        } else {
          matrix[i][j] = Math.min(
            matrix[i - 1][j - 1] + 1,
            matrix[i][j - 1] + 1,
            matrix[i - 1][j] + 1
          );
        }
      }
    }
    
    return matrix[str2.length][str1.length];
  }

  private toTitleCase(str: string): string {
    return str.replace(/\w\S*/g, (txt) => 
      txt.charAt(0).toUpperCase() + txt.substr(1).toLowerCase()
    );
  }

  private detectPageSeparators(page: any, pageHeight: number, pageWidth: number): { top: number | null, bottom: number | null } {
    const separators = { top: null as number | null, bottom: null as number | null };
    
    try {
      // Method 1: Look for text-based separators (long sequences of dashes or underscores)
      if (page.Texts) {
        for (const text of page.Texts) {
          if (text.R) {
            for (const r of text.R) {
              if (r.T) {
                const textContent = decodeURIComponent(r.T);
                // Check for separator patterns: long dashes, underscores, or multiple dashes
                if (this.isSeparatorText(textContent)) {
                  const y = text.y || 0;
                  const normalizedY = y / pageHeight;
                  
                  // If in top area and we don't have a top separator yet
                  if (normalizedY < 0.3 && (!separators.top || y > separators.top)) {
                    separators.top = y;
                    console.log(`🔍 Found TOP separator: "${textContent}" at Y=${y} (${normalizedY.toFixed(2)})`);
                  }
                  // If in bottom area and we don't have a bottom separator yet  
                  else if (normalizedY > 0.7 && (!separators.bottom || y < separators.bottom)) {
                    separators.bottom = y;
                    console.log(`🔍 Found BOTTOM separator: "${textContent}" at Y=${y} (${normalizedY.toFixed(2)})`);
                  }
                }
              }
            }
          }
        }
      }

      // Method 2: Look for Fill elements (horizontal lines) - if available in PDF structure
      if (page.Fills) {
        for (const fill of page.Fills) {
          const width = fill.w || 0;
          const height = fill.h || 0;
          
          // Detect horizontal lines (wide but not tall)
          if (width > pageWidth * 0.3 && height < 0.1) {
            const y = fill.y || 0;
            const normalizedY = y / pageHeight;
            
            if (normalizedY < 0.3 && (!separators.top || y > separators.top)) {
              separators.top = y;
              console.log(`🔍 Found TOP line separator at Y=${y} (${normalizedY.toFixed(2)})`);
            } else if (normalizedY > 0.7 && (!separators.bottom || y < separators.bottom)) {
              separators.bottom = y;
              console.log(`🔍 Found BOTTOM line separator at Y=${y} (${normalizedY.toFixed(2)})`);
            }
          }
        }
      }

    } catch (error) {
      console.warn('Error detecting separators:', error);
    }

    return separators;
  }

  private isSeparatorText(text: string): boolean {
    if (!text || text.length < 5) return false;
    
    // Remove spaces and decode
    const cleanText = text.replace(/\s/g, '');
    
    // Check for common separator patterns
    const separatorPatterns = [
      /^-{5,}$/, // 5 or more dashes
      /^_{5,}$/, // 5 or more underscores  
      /^={5,}$/, // 5 or more equals
      /^\.{10,}$/, // 10 or more dots
      /^-+$/, // Only dashes (any length > 5 chars total)
      /^_+$/, // Only underscores
      /^[–—]{3,}$/, // Em/en dashes
    ];
    
    return separatorPatterns.some(pattern => pattern.test(cleanText));
  }

  private shouldExcludeText(
    text: string, 
    y: number, 
    pageHeight: number, 
    config: HeaderFooterFilterConfig,
    separators: { top: number | null, bottom: number | null } = { top: null, bottom: null }
  ): boolean {
    if (!text || text.trim().length === 0) return true;
    
    const trimmedText = text.trim();
    
    // First check if this text IS a separator - always exclude
    if (this.isSeparatorText(text)) {
      return true;
    }
    
    // Use separator-based filtering if separators are detected
    let inHeaderFooterArea = false;
    
    if (separators.top !== null || separators.bottom !== null) {
      // Use separator-based boundaries
      if (separators.top !== null && y <= separators.top) {
        inHeaderFooterArea = true; // Above top separator
      }
      if (separators.bottom !== null && y >= separators.bottom) {
        inHeaderFooterArea = true; // Below bottom separator
      }
    } else {
      // Fallback to Y-position based filtering
      const normalizedY = y / pageHeight;
      inHeaderFooterArea = normalizedY < config.headerThreshold || normalizedY > config.footerThreshold;
    }
    
    // If in header/footer area - be more aggressive with filtering
    if (inHeaderFooterArea) {
      // Check title patterns
      if (config.titlePatterns.some(pattern => pattern.test(trimmedText))) {
        return true;
      }
      
      // Check page numbers
      if (config.pageNumberPatterns.some(pattern => pattern.test(trimmedText))) {
        return true;
      }
      
      // Check reference patterns
      if (config.referencePatterns.some(pattern => pattern.test(trimmedText))) {
        return true;
      }
    }
    
    // Global exclusion patterns (apply everywhere)
    if (config.excludePatterns.some(pattern => pattern.test(trimmedText))) {
      return true;
    }
    
    return false;
  }

  private shouldExcludeTextSimple(text: string, normalizedY: number): boolean {
    if (!text || text.trim().length === 0) return true;
    
    const trimmedText = text.trim();
    
    // Basic header/footer filtering - exclude text in top 10% or bottom 10% of page
    if (normalizedY < 0.1 || normalizedY > 0.9) {
      // Check for common header/footer patterns
      const headerFooterPatterns = [
        /^\d+$/, // Just page numbers
        /^[A-ZŠĐČĆŽ\s]{3,}$/, // All caps headers
        /\b(strana|stranica|page)\s*\d+/i, // Page indicators
        /\b\d{1,2}\/\d{1,2}\/\d{2,4}\b/, // Dates
        /^\s*[-=_]{3,}\s*$/, // Separator lines
      ];
      
      if (headerFooterPatterns.some(pattern => pattern.test(trimmedText))) {
        return true;
      }
      
      // If text is very short in header/footer area, likely not content
      if (trimmedText.length < 5) {
        return true;
      }
    }
    
    return false;
  }

  private shouldAddSpace(previousText: string, currentText: string, xGap: number): boolean {
    // No space needed if either text is empty
    if (!previousText || !currentText) return false;
    
    // Get last character of previous text and first character of current text
    const lastChar = previousText.slice(-1);
    const firstChar = currentText.charAt(0);
    
    // Don't add space if current text already starts with space
    if (firstChar === ' ') return false;
    
    // Don't add space if previous text already ends with space
    if (lastChar === ' ') return false;
    
    // Don't add space for punctuation that should be connected
    if (firstChar.match(/[.,;:!?)\]}]/)) return false;
    if (lastChar.match(/[({\[]/)) return false;
    
    // IMPROVED: More conservative space detection
    // Only add space for very clear word boundaries
    if (xGap > 0.5) return true;  // Very large gaps are clearly separate words
    
    // More restrictive for medium gaps - require clear word characters
    if (xGap > 0.2 && 
        lastChar.match(/[a-zA-ZšđčćžŠĐČĆŽ]/) && 
        firstChar.match(/[a-zA-ZšđčćžŠĐČĆŽ]/) &&
        previousText.length > 1 && currentText.length > 1) {
      return true;
    }
    
    // Special case: clear number separation
    if (lastChar.match(/[0-9]/) && firstChar.match(/[0-9]/) && xGap > 0.3) {
      return true;
    }
    
    // Special case: punctuation followed by word with clear gap
    if (lastChar.match(/[.,;:!?]/) && firstChar.match(/[A-ZŠĐČĆŽ]/) && xGap > 0.2) {
      return true;
    }
    
    // Don't add space for smaller gaps (likely character rendering issues)
    return false;
  }

  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  private findAISectionContent(fullText: string, sectionTitle: string, pageStart: number, pageEnd: number): { content: string; charStart: number; charEnd: number } {
    console.log(`🔍 Looking for section "${sectionTitle}" content in processed text`);
    
    // Try multiple strategies to find the section title
    let titleMatch = this.findTitleInText(fullText, sectionTitle);
    
    if (titleMatch !== -1) {
      console.log(`✅ Found section "${sectionTitle}" at position ${titleMatch}`);
      
      // Extract content starting from the title
      const contentStart = titleMatch;
      
      // Find the end of this section by looking for the next section title
      const contentEnd = this.findSectionEnd(fullText, contentStart, sectionTitle);
      
      let content = fullText.substring(contentStart, contentEnd).trim();
      
      // Clean up the content - remove the title line if it's at the start
      const titleLines = sectionTitle.split('\n');
      const firstTitleLine = titleLines[0].trim();
      if (content.toLowerCase().startsWith(firstTitleLine.toLowerCase())) {
        const titleEndIndex = content.indexOf('\n');
        if (titleEndIndex > 0) {
          content = content.substring(titleEndIndex + 1).trim();
        }
      }
      
      // Limit content to max 6000 characters for embedding (safe token limit)
      const maxChars = 6000;
      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + '... [truncated]';
        console.log(`✂️ Section "${sectionTitle}" content truncated to ${content.length} characters`);
      }
      
      // Ensure we have meaningful content
      if (content.length < 20) {
        console.log(`⚠️ Section "${sectionTitle}" content too short (${content.length} chars), using extended extraction`);
        content = this.extractExtendedContent(fullText, contentStart, 2000);
      }
      
      console.log(`✅ Extracted section "${sectionTitle}": ${content.length} characters`);
      return {
        content,
        charStart: contentStart,
        charEnd: contentStart + content.length
      };
    }
    
    // If title not found, use intelligent fallback based on page information
    console.log(`⚠️ Section title "${sectionTitle}" not found in text, using intelligent fallback extraction`);
    
    // Try to extract based on page position and content structure
    const contentResult = this.extractContentByPagePosition(fullText, pageStart, pageEnd, sectionTitle);
    
    console.log(`📝 Intelligent fallback extraction for "${sectionTitle}": ${contentResult.content.length} characters`);
    
    return contentResult;
  }

  private findTitleInText(fullText: string, sectionTitle: string): number {
    console.log(`🎯 Trying multiple strategies to find: "${sectionTitle}"`);
    
    // Strategy 1: Exact match (case insensitive)
    const exactPattern = new RegExp(sectionTitle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i');
    let match = fullText.search(exactPattern);
    if (match !== -1) {
      console.log(`✅ Strategy 1 (exact): Found at position ${match}`);
      return match;
    }
    
    // Strategy 2: Flexible spacing and line breaks
    const flexibleTitle = sectionTitle
      .replace(/\s+/g, '\\s+')  // Allow multiple spaces/newlines
      .replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); // Escape other special chars
    const flexiblePattern = new RegExp(flexibleTitle, 'i');
    match = fullText.search(flexiblePattern);
    if (match !== -1) {
      console.log(`✅ Strategy 2 (flexible spacing): Found at position ${match}`);
      return match;
    }
    
    // Strategy 3: Word-based matching (ignore minor differences)
    const words = sectionTitle.split(/\s+/).filter(word => word.length > 2); // Only significant words
    if (words.length >= 2) {
      for (let i = 0; i <= words.length - 2; i++) {
        const wordPair = words.slice(i, i + 2).join('.*?');
        const wordPattern = new RegExp(wordPair, 'i');
        match = fullText.search(wordPattern);
        if (match !== -1) {
          // Verify this isn't a false positive by checking context
          const context = fullText.substring(Math.max(0, match - 50), match + sectionTitle.length + 50);
          if (this.isValidTitleMatch(context, sectionTitle)) {
            console.log(`✅ Strategy 3 (word-based): Found at position ${match}`);
            return match;
          }
        }
      }
    }
    
    // Strategy 4: Try without numbers and special characters
    const cleanTitle = sectionTitle.replace(/^\d+\.?\s*/, '').replace(/[^\w\sšđčćžŠĐČĆŽ]/g, '');
    if (cleanTitle.length > 3) {
      const cleanPattern = new RegExp(cleanTitle.replace(/\s+/g, '\\s+'), 'i');
      match = fullText.search(cleanPattern);
      if (match !== -1) {
        console.log(`✅ Strategy 4 (clean): Found at position ${match}`);
        return match;
      }
    }
    
    console.log(`❌ All strategies failed for: "${sectionTitle}"`);
    return -1;
  }

  private isValidTitleMatch(context: string, originalTitle: string): boolean {
    // Check if the context looks like a section title (not buried in a paragraph)
    const beforeMatch = context.substring(0, 50);
    const afterMatch = context.substring(50, 100);
    
    // Title should be at start of line or after whitespace
    const atLineStart = /\n\s*$/.test(beforeMatch) || /^\s*$/.test(beforeMatch);
    
    // After title should be a line break or significant whitespace
    const followedByBreak = /^\s*\n/.test(afterMatch) || /^\s{3,}/.test(afterMatch);
    
    return atLineStart || followedByBreak;
  }

  private findSectionEnd(fullText: string, startPos: number, currentTitle: string): number {
    const remainingText = fullText.substring(startPos);
    
    // Look for various patterns that indicate the next section
    const nextSectionPatterns = [
      // Numbered sections (1., 1.1., etc.)
      /\n\s*\d+\.\d*\s+[A-ZŠĐČĆŽ]/,
      // All caps titles
      /\n\s*[A-ZŠĐČĆŽ][A-ZŠĐČĆŽ\s]{5,}/,
      // Capitalized titles
      /\n\s*[A-ZŠĐČĆŽ][a-zšđčćž\s]{10,}/,
      // Common section indicators
      /\n\s*(ZAKLJUČAK|LITERATURA|REFERENCE|BIBLIOGRAFIJA)/i
    ];
    
    let earliestMatch = remainingText.length;
    
    for (const pattern of nextSectionPatterns) {
      const match = remainingText.substring(100).search(pattern); // Skip first 100 chars
      if (match !== -1) {
        earliestMatch = Math.min(earliestMatch, match + 100);
      }
    }
    
    // Default to 3000 characters if no next section found
    const maxLength = 3000;
    const endPos = Math.min(startPos + earliestMatch, startPos + maxLength);
    
    return endPos;
  }

  private extractExtendedContent(fullText: string, startPos: number, length: number): string {
    const endPos = Math.min(startPos + length, fullText.length);
    return fullText.substring(startPos, endPos).trim();
  }

  private extractContentByPagePosition(fullText: string, pageStart: number, pageEnd: number, sectionTitle: string): { content: string; charStart: number; charEnd: number } {
    // Estimate position based on page numbers (assuming ~2000 chars per page)
    const estimatedCharsPerPage = Math.max(1000, Math.floor(fullText.length / 50)); // Rough estimate
    
    // Calculate approximate position based on page numbers
    let estimatedStart = Math.max(0, (pageStart - 1) * estimatedCharsPerPage);
    let estimatedEnd = Math.min(fullText.length, pageEnd * estimatedCharsPerPage);
    
    // If the estimated range is too large, limit it
    const maxContentLength = 4000;
    if (estimatedEnd - estimatedStart > maxContentLength) {
      estimatedEnd = estimatedStart + maxContentLength;
    }
    
    console.log(`📍 Estimating content for "${sectionTitle}" between pages ${pageStart}-${pageEnd} (chars ${estimatedStart}-${estimatedEnd})`);
    
    // Extract content from estimated position
    let content = fullText.substring(estimatedStart, estimatedEnd).trim();
    
    // Try to find content that looks more like a section start
    const lines = content.split('\n');
    let bestStartLine = 0;
    
    // Look for lines that might be section headers
    for (let i = 0; i < Math.min(20, lines.length); i++) {
      const line = lines[i].trim();
      if (line.length > 5 && line.length < 100) {
        // Check if this line looks like a title (caps, or starts with capital)
        if (/^[A-ZŠĐČĆŽ]/.test(line) && !/\.\s/.test(line)) { // Not a sentence
          bestStartLine = i;
          console.log(`🎯 Found potential section start at line ${i}: "${line}"`);
          break;
        }
      }
    }
    
    // Start from the best line we found
    if (bestStartLine > 0) {
      const adjustedLines = lines.slice(bestStartLine);
      content = adjustedLines.join('\n').trim();
      estimatedStart += lines.slice(0, bestStartLine).join('\n').length + 1;
    }
    
    // Limit content to reasonable size
    const maxChars = 6000;
    if (content.length > maxChars) {
      content = content.substring(0, maxChars) + '... [truncated]';
      console.log(`✂️ Fallback content truncated to ${content.length} characters`);
    }
    
    // Ensure we have some meaningful content
    if (content.length < 100) {
      // If content is too short, expand the search area
      const expandedEnd = Math.min(fullText.length, estimatedEnd + 2000);
      content = fullText.substring(estimatedStart, expandedEnd).trim();
      
      if (content.length > maxChars) {
        content = content.substring(0, maxChars) + '... [truncated]';
      }
    }
    
    return {
      content,
      charStart: estimatedStart,
      charEnd: estimatedStart + content.length
    };
  }

  private generateAISectionPath(section: any, allSections: any[]): string {
    // Generate hierarchical path like "1 → 1.2 → 1.2.3"
    if (section.level === 1) {
      return section.title;
    }
    
    // Find parent sections to build path
    const pathParts = [section.title];
    // This is simplified - you'd need proper parent tracking
    return pathParts.join(' → ');
  }

  private extractStructureFromTOC(entirePdfText: string, currentPageText: string, tocPage?: number): DocumentStructure | null {
    console.log('🔍 Looking for Table of Contents...');
    
    let searchArea: string;
    
    if (tocPage && tocPage > 0) {
      // If tocPage is specified, try to extract text around that specific page
      console.log(`📍 Admin specified TOC is on page ${tocPage}, focusing search there`);
      
      // For now, we'll search in a broader area that likely includes the specified page
      // This is a simplified approach - in the future we could improve page-specific extraction
      const estimatedCharsPerPage = Math.floor(entirePdfText.length / 50); // Assuming ~50 pages
      const startChar = Math.max(0, (tocPage - 2) * estimatedCharsPerPage);
      const endChar = Math.min(entirePdfText.length, (tocPage + 2) * estimatedCharsPerPage);
      searchArea = entirePdfText.substring(startChar, endChar);
      console.log(`📄 Searching around page ${tocPage}: chars ${startChar} to ${endChar} (${searchArea.length} characters)`);
    } else {
      // Look ONLY in the first part of the document (first 20k chars) where TOC should be
      searchArea = entirePdfText.substring(0, Math.min(20000, entirePdfText.length));
      console.log('📄 Searching for TOC in first 20,000 characters');
    }
    
    // Look for Serbian TOC pattern - "Sadržaj" as standalone title
    const tocPatterns = [
      // Exact match for "Sadržaj" as title (case sensitive for Serbian)
      /(?:^|\n)\s*Sadržaj\s*(?:\n|$)/gm,
      // Also try with potential spacing variations
      /(?:^|\n)\s*S\s*a\s*d\s*r\s*ž\s*a\s*j\s*(?:\n|$)/gm,
      // Try lowercase as well
      /(?:^|\n)\s*sadržaj\s*(?:\n|$)/gm,
    ];
    
    let tocStart = -1;
    let tocPattern = '';
    
    // Find TOC start position in the search area only
    for (const pattern of tocPatterns) {
      const match = pattern.exec(searchArea);
      if (match) {
        // Validate this is likely a real TOC by checking what comes after
        const afterMatch = searchArea.substring(match.index + match[0].length, match.index + 500);
        
        // Look for typical TOC indicators (entries with page numbers)
        if (this.looksLikeTOC(afterMatch)) {
          tocStart = match.index;
          tocPattern = match[1]; // The captured group
          console.log(`✅ Found real TOC at position ${tocStart} with pattern: "${tocPattern}"`);
          break;
        } else {
          console.log(`❌ Found "${match[1]}" at ${match.index} but doesn't look like TOC`);
        }
      }
    }
    
    if (tocStart === -1) {
      console.log('❌ No real TOC found in document');
      return null;
    }
    
    // Extract TOC section (next 3000 characters should be enough for most TOCs)
    const tocEnd = Math.min(tocStart + 3000, searchArea.length);
    const tocSection = searchArea.substring(tocStart, tocEnd);
    
    // Debug: log the actual TOC section content
    console.log('TOC section content:');
    console.log('-------------------');
    console.log(tocSection.substring(0, 1000)); // First 1000 chars for debugging
    console.log('-------------------');
    
    // Parse TOC entries
    const tocEntries = this.parseTOCEntries(tocSection);
    
    if (tocEntries.length === 0) {
      console.log('No TOC entries found, trying with relaxed patterns');
      const relaxedEntries = this.parseTOCEntriesRelaxed(tocSection);
      if (relaxedEntries.length > 0) {
        console.log(`Found ${relaxedEntries.length} entries with relaxed parsing`);
        return this.createSectionsFromTOC(relaxedEntries, currentPageText);
      }
      console.log('No TOC entries found even with relaxed patterns');
      return null;
    }
    
    console.log(`Found ${tocEntries.length} TOC entries:`, tocEntries.map(e => `"${e.title}" (Page ${e.page}, Level ${e.level})`));
    
    // Create sections based on TOC entries
    return this.createSectionsFromTOC(tocEntries, currentPageText);
  }

  private parseTOCEntries(tocSection: string): Array<{
    title: string;
    page: number;
    level: number;
    indentation: number;
  }> {
    const entries: Array<{
      title: string;
      page: number;
      level: number;
      indentation: number;
    }> = [];
    
    // Split into lines and analyze each line
    const lines = tocSection.split('\n').map(line => line.trim()).filter(line => line.length > 0);
    
    for (const line of lines) {
      // Skip the "Sadržaj" title itself
      if (/^[Ss][Aa][Dd][Rr][\u017D\u017E\u017d\u017e][Aa][Jj]$/i.test(line.trim())) {
        continue;
      }
      
      // Look for Serbian TOC patterns:
      // "PREDGOVOR _____________________________________________ 5"
      // "UVOD _____________________________________________________________________ 7"
      // "1. HARDVER________________________________________________________________ 15"
      // "  Pojam informacionih i komunikacionih tehnologija _______________________ 7"
      
      const tocEntryPatterns = [
        // Pattern with underscores: "Title ______________ PageNumber"
        /^(.+?)_{3,}\s*(\d+)\s*$/,
        // Pattern with dots: "Title ........ PageNumber"  
        /^(.+?)[\s\.]{3,}(\d+)\s*$/,
        // Pattern with just spaces: "Title    PageNumber"
        /^(.+?)\s{3,}(\d+)\s*$/,
        // Pattern with number prefix: "1.2.3 Title ... PageNumber"
        /^(\d+(?:\.\d+)*\.?\s+.+?)[\s\.]{3,}(\d+)\s*$/,
      ];
      
      let match = null;
      let pattern = '';
      
      for (const tocPattern of tocEntryPatterns) {
        match = line.match(tocPattern);
        if (match) {
          pattern = tocPattern.toString();
          break;
        }
      }
      
      if (match) {
        let title = match[1].trim();
        const page = parseInt(match[2]);
        
        if (isNaN(page) || page < 1 || page > 1000) {
          continue; // Invalid page number
        }
        
        // Remove leading numbers (1., 1.2., etc.) to get clean title
        title = title.replace(/^\d+(?:\.\d+)*\.?\s*/, '').trim();
        
        // Skip empty titles or very short ones
        if (title.length < 3) {
          continue;
        }
        
        // Determine level based on original indentation and numbering
        const originalTitle = match[1].trim();
        let level = 1;
        let indentation = 0;
        
        // Check for numbered sections to determine level
        const numberMatch = originalTitle.match(/^(\d+(?:\.\d+)*)\./);
        if (numberMatch) {
          const numberParts = numberMatch[1].split('.');
          level = numberParts.length;
          indentation = (level - 1) * 2; // 2 spaces per level
        } else {
          // For non-numbered entries, assume main sections are in caps
          if (title === title.toUpperCase() && title.length > 2) {
            level = 1;
          } else {
            level = 2; // Default to subsection
          }
        }
        
        entries.push({
          title,
          page,
          level,
          indentation
        });
        
        console.log(`Parsed TOC entry: "${title}" -> Page ${page}, Level ${level}`);
      }
    }
    
    return entries;
  }

  private looksLikeTOC(textAfterSadrzaj: string): boolean {
    // Check if the text after "Sadržaj" contains Serbian TOC patterns
    const lines = textAfterSadrzaj.split('\n').slice(0, 15); // Check first 15 lines
    let tocIndicators = 0;
    
    console.log('🔍 Checking if text looks like Serbian TOC:');
    
    for (const line of lines) {
      const trimmed = line.trim();
      if (trimmed.length < 3) continue;
      
      // Serbian TOC patterns based on the actual PDF structure:
      const tocPatterns = [
        // Pattern: "PREDGOVOR _____________________________________________ 5"
        /^[A-ZŠĐČĆŽ]{2,}[A-ZŠĐČĆŽa-zšđčćž\s]*_{3,}\s*\d+\s*$/,
        // Pattern: "1. HARDVER______________________________________________ 15"
        /^\d+\.\s*[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]*_{3,}\s*\d+\s*$/,
        // Pattern for subsections with indentation
        /^\s{2,}[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]{5,}_{3,}\s*\d+\s*$/,
        // Numbered subsections: "1.1. Pojam i klasifikacija___________ 15"
        /^\s*\d+\.\d+\.\s*[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]*_{3,}\s*\d+\s*$/,
        // Pattern with dots instead of underscores
        /^[A-ZŠĐČĆŽ][A-ZŠĐČĆŽa-zšđčćž\s]{2,}\.{3,}\s*\d+\s*$/,
      ];
      
      for (const pattern of tocPatterns) {
        if (pattern.test(trimmed)) {
          tocIndicators++;
          console.log(`📋 Serbian TOC indicator found: "${trimmed.substring(0, 80)}"`);
          break;
        }
      }
    }
    
    console.log(`📊 Found ${tocIndicators} Serbian TOC indicators`);
    return tocIndicators >= 2; // Need at least 2 TOC-like entries to be confident
  }

  private parseTOCEntriesRelaxed(tocSection: string): Array<{
    title: string;
    page: number;
    level: number;
    indentation: number;
  }> {
    const entries: Array<{
      title: string;
      page: number;
      level: number;
      indentation: number;
    }> = [];
    
    console.log('Trying relaxed TOC parsing...');
    
    // Split into lines and analyze each line
    const lines = tocSection.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      
      // Skip empty lines and the "Sadržaj" title itself
      if (!line.trim() || /^[Ss][Aa][Dd][Rr][\u017D\u017E\u017d\u017e][Aa][Jj]$/i.test(line.trim())) {
        continue;
      }
      
      console.log(`Analyzing line ${i}: "${line}"`);
      
      // Very relaxed patterns for Serbian academic texts
      const relaxedPatterns = [
        // Any line ending with a number (possibly page number)
        /^(.+)\s+(\d+)\s*$/,
        // Line with dots and number
        /^(.+?)[\s\.]{2,}(\d+)\s*$/,
        // Line that looks like a title (starts with capital, contains common academic words)
        /^([A-ZŠĐČĆŽ].{5,60})\s*$/,
      ];
      
      let matched = false;
      
      for (const pattern of relaxedPatterns) {
        const match = line.match(pattern);
        if (match) {
          let title = match[1].trim();
          let page = parseInt(match[2]) || 7; // Default page if not found
          
          // Clean up the title
          title = title.replace(/[\.\s]+$/, '').trim();
          
          // Skip if title is too short or looks like noise
          if (title.length < 3 || /^\d+$/.test(title)) {
            continue;
          }
          
          // Determine level based on content and formatting
          let level = 1;
          if (title === title.toUpperCase() && title.length > 3) {
            level = 1; // Main sections in caps
          } else if (title.match(/^[A-ZŠĐČĆŽ][a-zšđčćž]/)) {
            level = 2; // Subsections start with capital
          }
          
          // Remove common prefixes like numbers
          title = title.replace(/^\d+\.?\s*/, '').trim();
          
          if (title.length >= 3) {
            entries.push({
              title,
              page,
              level,
              indentation: (level - 1) * 2
            });
            
            console.log(`Relaxed parsed: "${title}" -> Page ${page}, Level ${level}`);
            matched = true;
            break;
          }
        }
      }
      
      // If no pattern matched but line looks like it could be a title
      if (!matched && line.trim().length > 5) {
        const cleanLine = line.trim();
        // Check if it looks like a section title
        if (/^[A-ZŠĐČĆŽ]/.test(cleanLine) && cleanLine.length < 100) {
          // Look ahead for a page number in the next few lines
          let pageNum = 7; // Default
          for (let j = i + 1; j < Math.min(i + 3, lines.length); j++) {
            const nextLine = lines[j].trim();
            if (/^\d+$/.test(nextLine)) {
              pageNum = parseInt(nextLine);
              break;
            }
          }
          
          let level = cleanLine === cleanLine.toUpperCase() ? 1 : 2;
          
          entries.push({
            title: cleanLine,
            page: pageNum,
            level,
            indentation: (level - 1) * 2
          });
          
          console.log(`Inferred TOC entry: "${cleanLine}" -> Page ${pageNum}, Level ${level}`);
        }
      }
    }
    
    return entries;
  }

  private createSectionsFromTOC(tocEntries: Array<{
    title: string;
    page: number;
    level: number;
    indentation: number;
  }>, fullText: string): DocumentStructure {
    const sections: DocumentStructure['sections'] = [];
    
    // Group entries by page ranges to extract content
    for (let i = 0; i < tocEntries.length; i++) {
      const entry = tocEntries[i];
      const nextEntry = tocEntries[i + 1];
      
      // Calculate page range for this section
      const pageStart = entry.page;
      const pageEnd = nextEntry ? nextEntry.page - 1 : entry.page;
      
      // Find content for this section by searching for the title in text
      const { content, charStart, charEnd } = this.findSectionContent(entry.title, fullText, i === 0);
      
      // Determine parent section for hierarchy
      let parentSectionId: string | undefined = undefined;
      if (entry.level > 1) {
        // Find the most recent section with lower level
        for (let j = sections.length - 1; j >= 0; j--) {
          if (sections[j].level < entry.level) {
            parentSectionId = sections[j].sectionId;
            break;
          }
        }
      }
      
      // Determine semantic type
      let semanticType: 'chapter' | 'section' | 'subsection' | 'paragraph' = 'section';
      switch (entry.level) {
        case 1:
          semanticType = 'chapter';
          break;
        case 2:
          semanticType = 'section';
          break;
        case 3:
        default:
          semanticType = 'subsection';
          break;
      }
      
      // Create path (1, 1.1, 1.1.1, etc.)
      let path = this.generateSectionPath(entry.level, sections);
      
      const section = {
        sectionId: `section_${i + 1}`,
        title: entry.title,
        path: path,
        level: entry.level,
        parentSectionId,
        semanticType,
        pageStart,
        pageEnd,
        charStart,
        charEnd,
        content: content.length > 10000 ? content.substring(0, 10000) : content, // Limit content size
      };
      
      sections.push(section);
    }
    
    return { sections };
  }

  private findSectionContent(title: string, fullText: string, isFirstSection: boolean): {
    content: string;
    charStart: number;
    charEnd: number;
  } {
    // Try to find the exact title in the text
    const titlePatterns = [
      // Exact match
      new RegExp(`\\b${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'i'),
      // Match with some flexibility for spacing and punctuation
      new RegExp(title.split(/\s+/).join('\\s+'), 'i'),
      // Match key words from title
      new RegExp(title.split(/\s+/).filter(word => word.length > 3).join('.*'), 'i')
    ];
    
    let titleMatch = null;
    let titleStart = -1;
    
    for (const pattern of titlePatterns) {
      titleMatch = pattern.exec(fullText);
      if (titleMatch) {
        titleStart = titleMatch.index;
        console.log(`Found title "${title}" at position ${titleStart}`);
        break;
      }
    }
    
    if (titleStart === -1) {
      console.log(`Could not find title "${title}" in text, using fallback`);
      // Fallback: split text into equal parts based on section index
      const sectionSize = Math.floor(fullText.length / 8); // Assuming ~8 sections
      const sectionIndex = Math.max(0, Math.floor(Math.random() * 8));
      titleStart = sectionIndex * sectionSize;
    }
    
    // Extract content from title position to reasonable end
    const contentStart = titleStart;
    const maxContentLength = 8000; // Max chars per section
    const contentEnd = Math.min(contentStart + maxContentLength, fullText.length);
    
    const content = fullText.substring(contentStart, contentEnd).trim();
    
    return {
      content,
      charStart: contentStart,
      charEnd: contentEnd
    };
  }

  private generateSectionPath(level: number, existingSections: DocumentStructure['sections']): string {
    if (level === 1) {
      // Count existing level 1 sections
      const level1Count = existingSections.filter(s => s.level === 1).length;
      return `${level1Count + 1}`;
    }
    
    // Find parent path for sub-levels
    let parentPath = '';
    for (let i = existingSections.length - 1; i >= 0; i--) {
      if (existingSections[i].level < level) {
        parentPath = existingSections[i].path;
        break;
      }
    }
    
    if (!parentPath) {
      parentPath = '1'; // Default if no parent found
    }
    
    // Count siblings at same level under same parent
    const siblings = existingSections.filter(s => 
      s.level === level && s.path.startsWith(parentPath + '.')
    );
    
    return `${parentPath}.${siblings.length + 1}`;
  }
  
  private fallbackDocumentStructure(fullText: string): DocumentStructure {
    // Fallback: intelligent chunking when no clear structure is detected
    const textChunks = this.splitTextIntoSafeChunks(fullText, 3000);
    const sections: DocumentStructure['sections'] = [];
    
    let currentCharStart = 0;
    
    textChunks.forEach((chunk, index) => {
      // Try to extract a meaningful title from the beginning of each chunk
      const lines = chunk.trim().split('\n').filter(line => line.trim().length > 0);
      let title = `Deo dokumenta ${index + 1}`;
      
      // Look for potential titles in the first few lines
      for (let i = 0; i < Math.min(3, lines.length); i++) {
        const line = lines[i].trim();
        if (line.length >= 10 && line.length <= 80 && 
            (line[0] === line[0].toUpperCase() || line.includes('.'))) {
          title = line.length > 50 ? line.substring(0, 47) + '...' : line;
          break;
        }
      }
      
      sections.push({
        sectionId: `section_${index + 1}`,
        title: title,
        path: `1.${index + 1}`,
        level: 1,
        parentSectionId: undefined,
        semanticType: 'section',
        pageStart: 1,
        pageEnd: 1,
        charStart: currentCharStart,
        charEnd: currentCharStart + chunk.length,
        content: chunk,
      });
      
      currentCharStart += chunk.length;
    });
    
    return { sections };
  }

  private chunkSection(section: DocumentStructure['sections'][0], r2KeyOriginal: string): ChunkData[] {
    // MongoDB DocumentChunk has maxlength: 10000 characters for content
    // We need to respect this limit
    const chunks: ChunkData[] = [];
    const maxChunkChars = 9500; // Leave some safety margin
    
    // Skip sections with empty or whitespace-only content
    if (!section.content || section.content.trim().length === 0) {
      console.log(`⚠️ Skipping section "${section.title}" - empty content`);
      return chunks;
    }
    
    if (section.content.length <= maxChunkChars) {
      // Create a single chunk for this section
      chunks.push({
        chunkId: `${section.sectionId}_chunk_1`,
        sectionId: section.sectionId,
        title: section.title,
        path: section.path,
        page: section.pageStart,
        paragraphIdx: 1,
        charStart: section.charStart,
        charEnd: section.charEnd,
        content: section.content,
      });
    } else {
      // Split the section into smaller chunks respecting MongoDB limit
      const textChunks = this.splitTextIntoSafeChunks(section.content, 3000); // ~9k chars max, safe for MongoDB
      
      textChunks.forEach((chunkContent, index) => {
        // Double check the chunk size before creating
        const finalContent = chunkContent.length > maxChunkChars 
          ? chunkContent.substring(0, maxChunkChars) 
          : chunkContent;
          
        chunks.push({
          chunkId: `${section.sectionId}_chunk_${index + 1}`,
          sectionId: section.sectionId,
          title: `${section.title} - Part ${index + 1}`,
          path: `${section.path}.${index + 1}`,
          page: section.pageStart,
          paragraphIdx: index + 1,
          charStart: section.charStart + (index * finalContent.length),
          charEnd: section.charStart + ((index + 1) * finalContent.length),
          content: finalContent,
        });
      });
    }
    
    return chunks;
  }

  private async clearExistingData(): Promise<void> {
    try {
      // Clear DocumentSection collection
      const deletedSections = await DocumentSection.deleteMany({});
      console.log(`Deleted ${deletedSections.deletedCount} documents from DocumentSection collection`);

      // Clear DocumentChunk collection
      const deletedChunks = await DocumentChunk.deleteMany({});
      console.log(`Deleted ${deletedChunks.deletedCount} documents from DocumentChunk collection`);

      // Clear Qdrant collection
      await qdrantService.clearCollection();
    } catch (error) {
      console.error('Error clearing existing data:', error);
      throw error;
    }
  }

  async processDocument(materialId: string, tocPage?: number, tocToPage?: number): Promise<void> {
    try {
      // Check for abort signal at the start
      if ((global as any).abortProcessing) {
        await this.logProgress(materialId, 'aborted', 0, 'Processing aborted by user');
        throw new Error('Processing aborted by user');
      }
      
      await this.logProgress(materialId, 'probe', 5, 'Starting document processing');

      // Clear existing data from previous tests
      await this.logProgress(materialId, 'probe', 7, 'Clearing existing test data');
      await this.clearExistingData();

      // Get material from database
      const material = await Material.findById(materialId) as IMaterial;
      if (!material || !material.r2Key) {
        throw new Error('Material not found or missing R2 key');
      }

      // Update status to processing
      await Material.findByIdAndUpdate(materialId, {
        $set: { status: 'processing' },
      });

      // Download PDF from R2
      await this.logProgress(materialId, 'probe', 10, 'Downloading PDF from R2');
      const pdfBuffer = await this.downloadFromR2(material.r2Key);

      // Calculate file hash for deduplication
      const fileHash = this.calculateFileHash(pdfBuffer);
      
      // Check if we've already processed this file
      const existingMaterial = await Material.findOne({ 
        fileHash, 
        _id: { $ne: materialId },
        status: 'ready' 
      });
      
      if (existingMaterial) {
        await this.logProgress(materialId, 'done', 100, 'Document already processed (duplicate detected)');
        await Material.findByIdAndUpdate(materialId, {
          $set: { 
            status: 'ready',
            fileHash,
            pageCount: existingMaterial.pageCount,
            hasOCR: existingMaterial.hasOCR,
            derivatives: existingMaterial.derivatives,
          },
        });
        return;
      }

      // Calculate the actual content processing range
      let contentStartPage = 1;
      
      if (tocPage && tocToPage) {
        // If TOC pages are specified, start processing after the last TOC page
        contentStartPage = tocToPage + 1;
        console.log(`📚 TOC ends at page ${tocToPage}, starting content processing from page ${contentStartPage}`);
      }

      // Check abort signal before text extraction
      if ((global as any).abortProcessing) {
        await this.logProgress(materialId, 'aborted', 0, 'Processing aborted by user');
        throw new Error('Processing aborted by user');
      }

      // Extract text from PDF - process entire document content without any page restrictions
      await this.logProgress(materialId, 'text', 20, `Extracting text from entire PDF content (all pages from ${contentStartPage} onwards)`);
      const { pages: textPages, pageCount } = await this.extractTextFromPDF(pdfBuffer, contentStartPage);

      // Render PDF pages to images
      await this.logProgress(materialId, 'render', 35, 'Rendering PDF pages');
      const { pagesPrefix } = await this.renderPDFPages(pdfBuffer, materialId);

      let allPages = textPages;
      let hasOCR = false;
      let ocrPrefix = '';

      // If text extraction failed or returned very little text, use OCR
      const totalTextLength = textPages.reduce((sum, page) => sum + page.text.length, 0);
      if (totalTextLength < 100) {
        await this.logProgress(materialId, 'ocr', 45, 'Text extraction poor, performing OCR');
        const { pages: ocrPages, ocrPrefix: ocrPref } = await this.performOCR(pdfBuffer, materialId);
        allPages = ocrPages;
        hasOCR = true;
        ocrPrefix = ocrPref;
      }

      // Save extracted text files
      await this.logProgress(materialId, 'text', 55, 'Saving text files');
      const textPrefix = await this.savePageTexts(allPages, materialId);

      // Combine all text
      const fullText = allPages.map(page => page.text).join('\n\n');

      // Check abort signal before AI analysis
      if ((global as any).abortProcessing) {
        await this.logProgress(materialId, 'aborted', 0, 'Processing aborted by user');
        throw new Error('Processing aborted by user');
      }

      // Detect document structure
      await this.logProgress(materialId, 'sectioning', 65, 'Analyzing complete document structure with AI');
      const structure = await this.detectDocumentStructure(fullText, materialId, tocPage, tocToPage, contentStartPage);

      // Save sections to database and vector store
      await this.logProgress(materialId, 'embed', 75, 'Processing sections and creating embeddings');
      
      for (const section of structure.sections) {
        // Check abort signal during section processing
        if ((global as any).abortProcessing) {
          await this.logProgress(materialId, 'aborted', 0, 'Processing aborted by user');
          throw new Error('Processing aborted by user');
        }
        
        // Skip sections with empty or too short content
        if (!section.content || section.content.trim().length < 50) {
          console.log(`⏭️ Skipping section "${section.title}" - content too short (${section.content?.length || 0} chars)`);
          continue;
        }
        
        console.log(`💾 Saving section "${section.title}" (${section.content.length} chars)`);
        
        // Save section to MongoDB
        const documentSection = new DocumentSection({
          docId: materialId,
          subjectId: material.subjectId,
          sectionId: section.sectionId,
          title: section.title,
          path: section.path,
          level: section.level,
          parentSectionId: section.parentSectionId,
          semanticType: section.semanticType,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          charStart: section.charStart,
          charEnd: section.charEnd,
          content: section.content,
        });

        await documentSection.save();

        // Add to vector store
        const vectorId = await qdrantService.addSection(
          section.sectionId,
          section.content,
          {
            docId: materialId,
            subjectId: material.subjectId.toString(),
            title: section.title,
            path: section.path,
            level: section.level,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            type: 'section',
          }
        );

        // Update section with vector ID
        await DocumentSection.findOneAndUpdate(
          { sectionId: section.sectionId },
          { $set: { vectorId } }
        );
      }

      // Process chunks
      await this.logProgress(materialId, 'chunk', 85, 'Creating and processing chunks');
      
      let totalChunks = 0;
      for (const section of structure.sections) {
        const chunks = this.chunkSection(section, material.r2Key);
        
        for (const chunk of chunks) {
          // Save chunk to MongoDB
          const documentChunk = new DocumentChunk({
            docId: materialId,
            subjectId: material.subjectId,
            sectionId: chunk.sectionId,
            chunkId: chunk.chunkId,
            title: chunk.title,
            path: chunk.path,
            page: chunk.page,
            paragraphIdx: chunk.paragraphIdx,
            charStart: chunk.charStart,
            charEnd: chunk.charEnd,
            content: chunk.content,
            r2KeyOriginal: material.r2Key,
            r2KeyPreviewPage: undefined, // No preview pages for now
          });

          await documentChunk.save();

          // Add to vector store
          const vectorId = await qdrantService.addChunk(
            chunk.chunkId,
            chunk.content,
            {
              docId: materialId,
              subjectId: material.subjectId.toString(),
              sectionId: chunk.sectionId,
              title: chunk.title,
              path: chunk.path,
              page: chunk.page,
              paragraphIdx: chunk.paragraphIdx,
              r2KeyOriginal: material.r2Key,
              r2KeyPreviewPage: undefined, // No preview pages for now
              type: 'chunk',
            }
          );

          // Update chunk with vector ID
          await DocumentChunk.findOneAndUpdate(
            { chunkId: chunk.chunkId },
            { $set: { vectorId } }
          );

          totalChunks++;
        }
      }

      // Update material with final results
      await this.logProgress(materialId, 'done', 100, 'Document processing completed');
      
      await Material.findByIdAndUpdate(materialId, {
        $set: {
          status: 'ready',
          fileHash,
          pageCount,
          hasOCR,
          derivatives: {
            textPrefix: undefined, // Not storing in R2 anymore
            ocrPrefix: hasOCR ? ocrPrefix : undefined,
            pagesPrefix: undefined, // Not rendering pages for now
          },
          'counters.sectionsFound': structure.sections.length,
          'counters.chunksDone': totalChunks,
          'counters.pagesDone': pageCount,
        },
      });

      console.log(`Document processing completed for material ${materialId}`);
      
    } catch (error) {
      console.error('Error processing document:', error);
      await this.logError(materialId, `Processing failed: ${error instanceof Error ? error.message : 'Unknown error'}`);
      
      await Material.findByIdAndUpdate(materialId, {
        $set: { status: 'failed' },
      });
      
      throw error;
    }
  }
}

export default new DocumentIngestionService();
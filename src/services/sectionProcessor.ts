import { TocAnalysis, DocumentSection, DocumentChunk } from '../models';
import { ITocSection } from '../models/TocAnalysis';
import { findTitleInText, extractCleanTitle } from '../utils/fuzzyMatcher';
import qdrantService from './qdrantService';
import processLogger from '../utils/processLogger';

interface ProcessedSection {
  sectionId: string;
  title: string;
  cleanTitle: string;
  path: string;  // Added path property
  level: number;
  pageStart: number;
  pageEnd: number;
  charStart: number;
  charEnd: number;
  content: string;
  parentSectionId?: string;
  semanticType: 'chapter' | 'section' | 'subsection' | 'paragraph';
  followUpParts?: ProcessedSection[];  // For sections that exceed character limit
}

interface PageText {
  pageNumber: number;
  text: string;
}

class SectionProcessor {
  private readonly MAX_SECTION_CHARS = 50000;  // Maximum characters per section
  private readonly MAX_CHUNK_CHARS = 2000;     // Maximum characters per chunk
  private readonly MAX_EMBEDDING_CHARS = 10000; // Maximum characters per embedding (safe for OpenAI)
  
  /**
   * Process all sections from TOC analysis and extract their content - SIMPLIFIED VERSION
   */
  async processTocSections(
    tocAnalysis: any,
    pdfPages: PageText[],
    materialId: string,
    subjectId: string
  ): Promise<ProcessedSection[]> {
    const processedSections: ProcessedSection[] = [];
    const sections = tocAnalysis.sections;
    
    processLogger.log(`📚 SIMPLIFIED: Processing ${sections.length} sections - ONLY by pages, NO header searching`);
    
    for (let i = 0; i < sections.length; i++) {
      const section = sections[i];
      
      processLogger.log(`📄 SIMPLE: Processing section ${i + 1}/${sections.length}: "${section.title}" (pages ${section.pageStart}-${section.pageEnd})`);
      
      // Extract content ONLY by pages - no header searching
      const sectionContent = this.extractSectionByPagesOnly(
        section,
        pdfPages,
        i,
        materialId
      );
      
      if (!sectionContent || sectionContent.content.length < 50) {
        processLogger.warn(`⚠️ Section "${section.title}" has insufficient content (${sectionContent?.content?.length || 0} chars), skipping`);
        continue;
      }
      
      processLogger.log(`✅ TOC-ONLY: Extracted ${sectionContent.content.length} chars from TOC pages ${sectionContent.pageStart}-${sectionContent.pageEnd}`);
      
      // Try to refine section boundaries within TOC pages
      const nextSection = i < sections.length - 1 ? sections[i + 1] : null;
      const refinedSection = this.refineSection(sectionContent, section, nextSection, pdfPages);
      
      const finalSection = refinedSection || sectionContent;
      if (refinedSection) {
        processLogger.log(`🎯 TOC-SCOPED: Refined section within TOC pages (${refinedSection.content.length} chars)`);
      } else {
        processLogger.log(`📄 TOC-ONLY: Using complete TOC pages content`);
      }
      
      // Handle long sections that exceed the embedding character limit
      if (finalSection.content.length > this.MAX_EMBEDDING_CHARS) {
        const splitSections = this.splitSectionForEmbedding(finalSection);
        processedSections.push(...splitSections);
        processLogger.log(`📄 Split section "${section.title}" into ${splitSections.length} parts for embedding`);
      } else {
        processedSections.push(finalSection);
      }
      
      // Update TOC analysis to mark section as processed
      await this.markSectionAsProcessed(tocAnalysis._id, section.title);
    }
    
    processLogger.log(`✅ SIMPLE: Processed ${processedSections.length} sections (including split sections)`);
    return processedSections;
  }
  
  /**
   * STRICT TOC-ONLY: Extract section content using ONLY TOC pages - no global search
   */
  private extractSectionByPagesOnly(
    section: ITocSection,
    pdfPages: PageText[],
    sectionIndex: number,
    materialId: string
  ): ProcessedSection | null {
    processLogger.log(`📄 TOC-ONLY: Extracting section "${section.title}" from TOC pages ${section.pageStart}-${section.pageEnd}`);
    
    // Get pages for this section - EXACT range from TOC analysis
    const sectionPages = pdfPages.filter(
      page => page.pageNumber >= section.pageStart && page.pageNumber <= section.pageEnd
    );
    
    if (sectionPages.length === 0) {
      processLogger.error(`❌ No pages found for section "${section.title}" (TOC pages ${section.pageStart}-${section.pageEnd})`);
      processLogger.error(`❌ Available pages: ${pdfPages.map(p => p.pageNumber).join(', ')}`);
      throw new Error(`TOC pages ${section.pageStart}-${section.pageEnd} not found for section "${section.title}"`);
    }
    
    // Combine ALL text from ALL TOC pages - no filtering, no searching
    const content = sectionPages.map(p => p.text).join('\n\n').trim();
    
    processLogger.log(`✅ TOC-ONLY: Extracted ${content.length} chars from ${sectionPages.length} TOC pages (${sectionPages.map(p => p.pageNumber).join(', ')})`);
    processLogger.log(`📖 TOC-ONLY: Content preview: "${content.substring(0, 200)}..."`);
    
    // Calculate character positions relative to the entire document
    const charStart = this.calculateAbsoluteCharPosition(pdfPages, section.pageStart, 0);
    const charEnd = charStart + content.length;
    
    processLogger.log(`📊 TOC-ONLY: Character positions - Start: ${charStart}, End: ${charEnd}`);
    
    return {
      sectionId: `section_${materialId}_${sectionIndex}`,
      title: section.title,
      cleanTitle: section.cleanTitle,
      path: this.generateSectionPath(section.level, sectionIndex),
      level: section.level,
      pageStart: section.pageStart, // ALWAYS use TOC pages
      pageEnd: section.pageEnd,     // ALWAYS use TOC pages
      charStart,
      charEnd,
      content,
      parentSectionId: section.parentSectionId,
      semanticType: section.semanticType
    };
  }


  /**
   * TOC-SCOPED REFINEMENT: Try to find exact section boundaries within TOC pages only
   */
  private refineSection(
    pageBasedSection: ProcessedSection,
    section: ITocSection,
    nextSection: ITocSection | null,
    allPages: PageText[]
  ): ProcessedSection | null {
    processLogger.log(`🎯 TOC-SCOPED REFINEMENT: Refining "${section.title}" within TOC pages ${section.pageStart}-${section.pageEnd}`);
    
    // Generate cleanTitle if needed
    let cleanTitle: string = section.cleanTitle;
    if (!cleanTitle || typeof cleanTitle !== 'string') {
      const generatedCleanTitle = this.generateCleanTitle(section.title);
      if (!generatedCleanTitle) {
        processLogger.log(`❌ Cannot generate cleanTitle from "${section.title}", using whole TOC pages`);
        return null;
      }
      cleanTitle = generatedCleanTitle;
    }
    
    try {
      // Get ONLY the TOC pages for this section (not entire document)
      const tocPages = allPages.filter(
        page => page.pageNumber >= section.pageStart && page.pageNumber <= section.pageEnd
      );
      
      if (tocPages.length === 0) {
        processLogger.log(`⚠️ No TOC pages found for refinement, using whole pages`);
        return null;
      }
      
      // Get text from ONLY these TOC pages
      const tocText = tocPages.map(p => p.text).join('\n\n');
      processLogger.log(`🔍 TOC-SCOPED: Searching within TOC pages text (${tocText.length} chars)`);
      
      // Find section title within TOC pages
      const startResult = this.findTitleWithSpaceVariations(tocText, cleanTitle);
      if (!startResult.found) {
        processLogger.log(`⚠️ Section title "${cleanTitle}" not found within TOC pages, using whole pages`);
        return null;
      }
      
      processLogger.log(`✅ TOC-SCOPED: Found section start at position ${startResult.position} within TOC pages`);
      
      // Find end position within TOC pages
      let endPosition = tocText.length; // Default to end of TOC pages
      
      if (nextSection) {
        let nextCleanTitle = nextSection.cleanTitle || this.generateCleanTitle(nextSection.title);
        if (nextCleanTitle) {
          // Look for next section title within the same TOC page range
          const endResult = this.findTitleWithSpaceVariations(tocText, nextCleanTitle, startResult.position + 50);
          if (endResult.found) {
            endPosition = endResult.position;
            processLogger.log(`✅ TOC-SCOPED: Found next section "${nextCleanTitle}" at position ${endPosition} within TOC pages`);
          }
        }
      }
      
      // Extract refined content from within TOC pages
      const refinedContent = tocText.substring(startResult.position, endPosition).trim();
      
      if (refinedContent.length < 50) {
        processLogger.log(`⚠️ Refined content too short (${refinedContent.length} chars), using whole TOC pages`);
        return null;
      }
      
      processLogger.log(`✅ TOC-SCOPED REFINEMENT: Successfully refined - ${refinedContent.length} chars within TOC pages ${section.pageStart}-${section.pageEnd}`);
      
      // Return refined section with SAME TOC pages (not recalculated)
      return {
        ...pageBasedSection,
        content: refinedContent,
        pageStart: section.pageStart, // KEEP original TOC pages
        pageEnd: section.pageEnd,     // KEEP original TOC pages
        charStart: pageBasedSection.charStart + startResult.position,
        charEnd: pageBasedSection.charStart + endPosition
      };
      
    } catch (error) {
      processLogger.error(`❌ TOC-SCOPED REFINEMENT error for "${section.title}": ${error}`);
      return null;
    }
  }

  /**
   * Generate clean title by removing numbers and prefixes
   */
  private generateCleanTitle(title: string): string | null {
    if (!title || typeof title !== 'string') {
      return null;
    }
    
    try {
      const clean = title
        // Remove leading numbers and dots (e.g., "13.1.3 Ostali editori" -> "Ostali editori")
        .replace(/^[\d\.\s]+/, '')
        // Remove page numbers at the end
        .replace(/[\.\s\-_]+\d+\s*$/, '')
        // Remove separator characters
        .replace(/[\.]{2,}|\-{2,}|_{2,}/g, '')
        .trim();
      
      return clean.length > 0 ? clean : null;
    } catch (error) {
      processLogger.log(`❌ generateCleanTitle error: ${error}`);
      return null;
    }
  }

  /**
   * Enhanced title search with all possible space variations
   */
  private findTitleWithSpaceVariations(
    text: string,
    cleanTitle: string,
    startFrom: number = 0
  ): { found: boolean; position: number; matchedText: string } {
    
    processLogger.log(`🔍 SEARCH: Looking for "${cleanTitle}" in text starting from position ${startFrom}`);
    
    // Debug input parameters
    processLogger.log(`🔍 DEBUG: text exists: ${!!text}, length: ${text?.length || 0}`);
    processLogger.log(`🔍 DEBUG: cleanTitle type: ${typeof cleanTitle}, value: "${cleanTitle}"`);
    processLogger.log(`🔍 DEBUG: startFrom: ${startFrom}`);
    
    // Safety checks
    if (!text || typeof text !== 'string') {
      processLogger.log(`❌ SEARCH: Invalid text parameter`);
      return { found: false, position: -1, matchedText: '' };
    }
    
    if (!cleanTitle || typeof cleanTitle !== 'string') {
      processLogger.log(`❌ SEARCH: Invalid cleanTitle parameter`);
      return { found: false, position: -1, matchedText: '' };
    }
    
    // Remove any remaining numbers from cleanTitle and normalize
    let normalizedTitle;
    try {
      normalizedTitle = cleanTitle.replace(/^[\d\.\s]+/, '').trim();
      processLogger.log(`🔍 DEBUG: normalizedTitle after regex: "${normalizedTitle}"`);
    } catch (error) {
      processLogger.log(`❌ SEARCH: Error normalizing title: ${error}`);
      return { found: false, position: -1, matchedText: '' };
    }
    
    if (!normalizedTitle || normalizedTitle.length < 2) {
      processLogger.log(`❌ SEARCH: Title too short after normalization: "${normalizedTitle}"`);
      return { found: false, position: -1, matchedText: '' };
    }
    
    processLogger.log(`🔍 SEARCH: Normalized title: "${normalizedTitle}"`);
    
    const searchText = text.substring(startFrom).toLowerCase();
    const targetLower = normalizedTitle.toLowerCase();
    
    // Strategy 1: Exact match (case insensitive)
    let position = searchText.indexOf(targetLower);
    if (position !== -1) {
      const absolutePos = startFrom + position;
      processLogger.log(`✅ SEARCH: Found exact match at position ${absolutePos}`);
      return {
        found: true,
        position: absolutePos,
        matchedText: text.substring(absolutePos, absolutePos + targetLower.length)
      };
    }
    
    // Strategy 2: Create all possible space variations
    let chars, variations;
    try {
      chars = targetLower.split('');
      processLogger.log(`🔍 DEBUG: Split into chars: [${chars.join(', ')}]`);
      variations = this.generateSpaceVariations(chars);
      processLogger.log(`🔍 DEBUG: Generated variations: ${variations.length}`);
    } catch (variationError) {
      processLogger.log(`❌ SEARCH: Error generating variations: ${variationError}`);
      return { found: false, position: -1, matchedText: '' };
    }
    
    processLogger.log(`🔍 SEARCH: Generated ${variations.length} space variations`);
    
    for (const variation of variations) {
      try {
        if (typeof variation !== 'string') {
          processLogger.log(`⚠️ DEBUG: Invalid variation type: ${typeof variation}`);
          continue;
        }
        position = searchText.indexOf(variation);
        if (position !== -1) {
          const absolutePos = startFrom + position;
          processLogger.log(`✅ SEARCH: Found space variation match "${variation}" at position ${absolutePos}`);
          return {
            found: true,
            position: absolutePos,
            matchedText: text.substring(absolutePos, absolutePos + variation.length)
          };
        }
      } catch (variationLoopError) {
        processLogger.log(`❌ SEARCH: Error processing variation "${variation}": ${variationLoopError}`);
        continue;
      }
    }
    
    // Strategy 3: Regex with flexible spaces between each character
    try {
      if (!chars || !Array.isArray(chars) || chars.length === 0) {
        processLogger.log(`⚠️ SEARCH: Invalid chars for regex: ${chars}`);
      } else {
        const regexPattern = chars
          .map(char => {
            if (typeof char !== 'string') {
              processLogger.log(`⚠️ DEBUG: Invalid char type in regex: ${typeof char}`);
              return '';
            }
            return char.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
          })
          .filter(char => char !== '') // Remove empty chars
          .join('\\s*'); // Allow optional spaces between each character
      
        const regex = new RegExp(regexPattern, 'i');
        const match = searchText.match(regex);
        
        if (match && match.index !== undefined) {
          const absolutePos = startFrom + match.index;
          processLogger.log(`✅ SEARCH: Found regex match "${match[0]}" at position ${absolutePos}`);
          return {
            found: true,
            position: absolutePos,
            matchedText: match[0]
          };
        }
      }
    } catch (e) {
      processLogger.log(`⚠️ SEARCH: Regex error: ${e}`);
    }
    
    processLogger.log(`❌ SEARCH: No match found for "${normalizedTitle}"`);
    return { found: false, position: -1, matchedText: '' };
  }

  /**
   * Generate all possible space variations for a title
   */
  private generateSpaceVariations(chars: string[]): string[] {
    if (!chars || !Array.isArray(chars) || chars.length <= 1) {
      return chars ? [chars.join('')] : [''];
    }
    
    const variations: string[] = [];
    const maxVariations = 50; // Limit to prevent explosion
    
    // Original without spaces
    variations.push(chars.join(''));
    
    // Add single spaces at different positions
    for (let i = 1; i < chars.length && variations.length < maxVariations; i++) {
      try {
        const withSpace = [...chars];
        withSpace.splice(i, 0, ' ');
        const spaceVariation = withSpace.join('');
        if (spaceVariation && typeof spaceVariation === 'string') {
          variations.push(spaceVariation);
        }
        
        // Add double spaces
        if (variations.length < maxVariations) {
          withSpace.splice(i, 0, ' ');
          const doubleSpaceVariation = withSpace.join('');
          if (doubleSpaceVariation && typeof doubleSpaceVariation === 'string') {
            variations.push(doubleSpaceVariation);
          }
        }
      } catch (spaceError) {
        processLogger.log(`⚠️ DEBUG: Error adding space variation at position ${i}: ${spaceError}`);
        continue;
      }
    }
    
    // Add spaces between every character (for OCR errors)
    if (variations.length < maxVariations) {
      try {
        const allSpaced = chars.join(' ');
        if (allSpaced && typeof allSpaced === 'string') {
          variations.push(allSpaced);
        }
      } catch (allSpaceError) {
        processLogger.log(`⚠️ DEBUG: Error creating all-spaced variation: ${allSpaceError}`);
      }
    }
    
    // Add multiple random space insertions
    for (let attempt = 0; attempt < 10 && variations.length < maxVariations; attempt++) {
      try {
        const spaced = [...chars];
        const numSpaces = Math.min(3, Math.floor(chars.length / 2));
        
        for (let s = 0; s < numSpaces; s++) {
          const pos = Math.floor(Math.random() * (spaced.length - 1)) + 1;
          spaced.splice(pos, 0, ' ');
        }
        
        const variation = spaced.join('');
        if (variation && typeof variation === 'string' && !variations.includes(variation)) {
          variations.push(variation);
        }
      } catch (randomError) {
        processLogger.log(`⚠️ DEBUG: Error creating random space variation: ${randomError}`);
        continue;
      }
    }
    
    // Final safety filter
    return variations.filter(v => v && typeof v === 'string' && v.length > 0);
  }

  /**
   * Helper: Find which page contains a specific character position
   */
  private findPageForPosition(pages: PageText[], position: number): number {
    let currentPos = 0;
    
    for (const page of pages) {
      const pageEndPos = currentPos + page.text.length + 2; // +2 for page break (\n\n)
      
      if (position <= pageEndPos) {
        return page.pageNumber;
      }
      
      currentPos = pageEndPos;
    }
    
    // Return last page if position is beyond all pages
    return pages.length > 0 ? pages[pages.length - 1].pageNumber : 1;
  }

  /**
   * Generate section path for hierarchy display
   */
  private generateSectionPath(level: number, index: number): string {
    // Simple path generation based on section number and level
    if (level === 1) {
      return `${index + 1}`;
    } else if (level === 2) {
      return `${Math.floor(index / 10) + 1}.${(index % 10) + 1}`;
    } else {
      return `${Math.floor(index / 100) + 1}.${Math.floor((index % 100) / 10) + 1}.${(index % 10) + 1}`;
    }
  }
  
  /**
   * Split a section into multiple parts optimized for embedding (10k chars max)
   */
  private splitSectionForEmbedding(section: ProcessedSection): ProcessedSection[] {
    const parts: ProcessedSection[] = [];
    const content = section.content;
    const maxChars = this.MAX_EMBEDDING_CHARS;
    
    processLogger.log(`📄 Splitting section "${section.title}" (${content.length} chars) for embedding`);
    
    let currentPosition = 0;
    let partIndex = 1;
    
    while (currentPosition < content.length) {
      let partEnd = Math.min(currentPosition + maxChars, content.length);
      let partContent = content.substring(currentPosition, partEnd);
      
      // Try to split at natural boundaries if not the last part
      if (partEnd < content.length) {
        const searchStart = Math.max(0, partContent.length - Math.floor(maxChars * 0.3));
        const searchText = partContent.substring(searchStart);
        
        // Find the best cut point (prefer paragraph > sentence > any newline)
        const lastDoubleNewline = searchText.lastIndexOf('\n\n');
        const lastPeriod = searchText.lastIndexOf('.');
        const lastSingleNewline = searchText.lastIndexOf('\n');
        
        let cutPoint = -1;
        if (lastDoubleNewline !== -1) {
          cutPoint = searchStart + lastDoubleNewline + 2; // Include the double newline
        } else if (lastPeriod !== -1) {
          cutPoint = searchStart + lastPeriod + 1; // Include the period
        } else if (lastSingleNewline !== -1) {
          cutPoint = searchStart + lastSingleNewline + 1; // Include the newline
        }
        
        if (cutPoint > 0 && cutPoint < partContent.length) {
          partContent = partContent.substring(0, cutPoint);
        }
      }
      
      // Determine if we need part numbering
      const totalEstimatedParts = Math.ceil(content.length / maxChars);
      const partTitle = totalEstimatedParts > 1 ? `${section.title} (Part ${partIndex}/${totalEstimatedParts})` : section.title;
      
      parts.push({
        ...section,
        sectionId: `${section.sectionId}_embedpart${partIndex}`,
        title: partTitle,
        path: `${section.path}.${partIndex}`, // Add sub-path for parts
        content: partContent.trim(),
        charStart: section.charStart + currentPosition,
        charEnd: section.charStart + currentPosition + partContent.length
      });
      
      currentPosition += partContent.length;
      partIndex++;
      
      // Safety check to avoid infinite loop
      if (partIndex > 50) {
        processLogger.warn(`⚠️ Section splitting stopped at part ${partIndex} to prevent infinite loop`);
        break;
      }
    }
    
    processLogger.log(`📄 Split "${section.title}" into ${parts.length} embedding-safe parts`);
    
    // Link parts together as followUpParts in the first part
    if (parts.length > 1) {
      parts[0].followUpParts = parts.slice(1);
    }
    
    return parts;
  }
  
  /**
   * Split a long section into multiple parts (legacy - for very large sections)
   */
  private splitLongSection(section: ProcessedSection): ProcessedSection[] {
    const parts: ProcessedSection[] = [];
    const content = section.content;
    const numParts = Math.ceil(content.length / this.MAX_SECTION_CHARS);
    
    processLogger.log(`📄 Splitting section "${section.title}" into ${numParts} parts`);
    
    for (let i = 0; i < numParts; i++) {
      const start = i * this.MAX_SECTION_CHARS;
      const end = Math.min(start + this.MAX_SECTION_CHARS, content.length);
      const partContent = content.substring(start, end);
      
      // Try to split at paragraph boundaries if possible
      let adjustedContent = partContent;
      if (i < numParts - 1) {
        // Not the last part - try to find a good break point
        const lastParagraphBreak = partContent.lastIndexOf('\n\n');
        if (lastParagraphBreak > this.MAX_SECTION_CHARS * 0.8) {
          adjustedContent = partContent.substring(0, lastParagraphBreak);
        }
      }
      
      parts.push({
        ...section,
        sectionId: `${section.sectionId}_part${i + 1}`,
        title: `${section.title} (Part ${i + 1}/${numParts})`,
        path: `${section.path}.${i + 1}`,  // Add sub-path for parts
        content: adjustedContent,
        charStart: section.charStart + start,
        charEnd: section.charStart + start + adjustedContent.length
      });
    }
    
    // Link parts together
    for (let i = 1; i < parts.length; i++) {
      parts[0].followUpParts = parts[0].followUpParts || [];
      parts[0].followUpParts.push(parts[i]);
    }
    
    return parts;
  }
  
  /**
   * Calculate absolute character position in the document
   */
  private calculateAbsoluteCharPosition(
    pdfPages: PageText[],
    pageNumber: number,
    positionInPage: number
  ): number {
    let totalChars = 0;
    
    for (const page of pdfPages) {
      if (page.pageNumber < pageNumber) {
        totalChars += page.text.length + 2; // +2 for page break (\n\n)
      } else if (page.pageNumber === pageNumber) {
        return totalChars + positionInPage;
      }
    }
    
    return totalChars;
  }
  
  /**
   * Mark a section as processed in the TOC analysis
   */
  private async markSectionAsProcessed(
    tocAnalysisId: string,
    sectionTitle: string
  ): Promise<void> {
    try {
      await TocAnalysis.findOneAndUpdate(
        { 
          _id: tocAnalysisId,
          'sections.title': sectionTitle
        },
        {
          $set: { 'sections.$.processed': true },
          $inc: { processedSections: 1 }
        }
      );
    } catch (error) {
      processLogger.error(`❌ Error marking section "${sectionTitle}" as processed: ${error}`);
    }
  }
  
  /**
   * ENHANCED Relaxed title search with MANY more strategies and edge cases
   */
  private findTitleRelaxed(
    text: string, 
    cleanTitle: string, 
    fullTitle: string
  ): { found: boolean; position: number; matchedText: string } {
    const lowercaseText = text.toLowerCase();
    const lowercaseClean = cleanTitle.toLowerCase();
    const lowercaseFull = fullTitle.toLowerCase();
    
    // Strategy 1: Exact case-insensitive match
    let position = lowercaseText.indexOf(lowercaseClean);
    if (position !== -1) {
      return {
        found: true,
        position,
        matchedText: text.substring(position, position + cleanTitle.length)
      };
    }
    
    // Strategy 2: Full title match
    position = lowercaseText.indexOf(lowercaseFull);
    if (position !== -1) {
      return {
        found: true,
        position,
        matchedText: text.substring(position, position + fullTitle.length)
      };
    }
    
    // Strategy 3: Remove all special characters and spaces - match core words only
    const cleanTitleCore = cleanTitle.replace(/[^\w\sšđčćžŠĐČĆŽ]/g, '').replace(/\s+/g, ' ').trim();
    const textCore = text.replace(/[^\w\sšđčćžŠĐČĆŽ]/g, '').replace(/\s+/g, ' ');
    position = textCore.toLowerCase().indexOf(cleanTitleCore.toLowerCase());
    if (position !== -1) {
      // Find approximate position in original text
      const wordsBefore = textCore.substring(0, position).split(' ').length - 1;
      const approximatePos = this.findNthWord(text, wordsBefore);
      return {
        found: true,
        position: approximatePos,
        matchedText: cleanTitleCore
      };
    }
    
    // Strategy 4: Word-by-word flexible matching (allows some words to be missing)
    const titleWords = cleanTitle.split(/\s+/).filter(w => w.length > 2); // Ignore short words
    if (titleWords.length > 1) {
      // Try to find at least 70% of significant words
      const minWordsToFind = Math.max(1, Math.floor(titleWords.length * 0.7));
      let foundWords = 0;
      let firstFoundPos = -1;
      
      for (const word of titleWords) {
        const wordPos = lowercaseText.indexOf(word.toLowerCase());
        if (wordPos !== -1) {
          foundWords++;
          if (firstFoundPos === -1) firstFoundPos = wordPos;
        }
      }
      
      if (foundWords >= minWordsToFind && firstFoundPos !== -1) {
        return {
          found: true,
          position: firstFoundPos,
          matchedText: `Found ${foundWords}/${titleWords.length} key words`
        };
      }
    }
    
    // Strategy 5: Numeric pattern matching (for titles like "5. 6 Memorijska reprezentacija")
    const numericPattern = cleanTitle.match(/^\d+\.?\s*\d*\.?\s*/);
    if (numericPattern) {
      const numPattern = numericPattern[0].trim();
      const restOfTitle = cleanTitle.substring(numericPattern[0].length).trim();
      
      // Look for the numeric pattern first
      const numRegex = new RegExp(numPattern.replace(/\./g, '\\.').replace(/\s+/g, '\\s*'), 'i');
      const numMatch = text.match(numRegex);
      
      if (numMatch && restOfTitle.length > 3) {
        // Then look for the rest of the title nearby (within 100 chars)
        const searchStart = (numMatch.index || 0);
        const nearbyText = text.substring(searchStart, searchStart + 200);
        const restWords = restOfTitle.split(/\s+/);
        
        for (const word of restWords) {
          if (word.length > 3 && nearbyText.toLowerCase().includes(word.toLowerCase())) {
            return {
              found: true,
              position: searchStart,
              matchedText: `${numPattern} + ${word}`
            };
          }
        }
      }
    }
    
    // Strategy 6: Fuzzy matching with character substitutions (common OCR errors)
    const ocrSubstitutions = {
      'rn': 'm', 'vv': 'w', 'ii': 'll', '0': 'o', '1': 'l', '5': 's',
      'ž': 'z', 'š': 's', 'č': 'c', 'ć': 'c', 'đ': 'd'
    };
    
    let fuzzyTitle = cleanTitle.toLowerCase();
    for (const [wrong, correct] of Object.entries(ocrSubstitutions)) {
      fuzzyTitle = fuzzyTitle.replace(new RegExp(wrong, 'g'), correct);
    }
    
    position = lowercaseText.indexOf(fuzzyTitle);
    if (position !== -1) {
      return {
        found: true,
        position,
        matchedText: text.substring(position, position + fuzzyTitle.length)
      };
    }
    
    // Strategy 7: Substring matching with various lengths
    for (let pct of [0.8, 0.6, 0.5, 0.4]) {
      const subLen = Math.floor(cleanTitle.length * pct);
      if (subLen > 4) {
        const substring = cleanTitle.substring(0, subLen);
        position = lowercaseText.indexOf(substring.toLowerCase());
        if (position !== -1) {
          return {
            found: true,
            position,
            matchedText: text.substring(position, position + substring.length)
          };
        }
      }
    }
    
    return { found: false, position: -1, matchedText: '' };
  }
  
  /**
   * Helper: Find position of Nth word in text
   */
  private findNthWord(text: string, n: number): number {
    const words = text.split(/\s+/);
    if (n >= words.length) return text.length;
    
    let position = 0;
    for (let i = 0; i < n; i++) {
      const wordIndex = text.indexOf(words[i], position);
      if (wordIndex === -1) return position;
      position = wordIndex + words[i].length;
    }
    return position;
  }
  
  /**
   * SMART FALLBACK: Calculate uncovered text between sections
   */
  private calculateSmartFallback(
    currentSection: ITocSection,
    prevSection: ITocSection | null,
    nextSection: ITocSection | null,
    pdfPages: PageText[],
    coveredRanges: Array<{ start: number; end: number; sectionTitle: string }>
  ): { found: boolean; content: string; pageStart: number; pageEnd: number } {
    
    processLogger.log(`🧠 SMART FALLBACK: Calculating uncovered text for "${currentSection.title}"`);
    
    // Determine the range this section should cover
    let fallbackStartPage = currentSection.pageStart;
    let fallbackEndPage = currentSection.pageEnd;
    
    // Find where previous section ended
    let actualStartPage = fallbackStartPage;
    if (prevSection) {
      // Start where previous section likely ended
      actualStartPage = Math.max(prevSection.pageEnd, currentSection.pageStart);
      processLogger.log(`🧠 Previous section "${prevSection.title}" ended around page ${prevSection.pageEnd}`);
    }
    
    // Find where next section begins
    let actualEndPage = fallbackEndPage;
    if (nextSection) {
      // End where next section begins
      actualEndPage = Math.min(nextSection.pageStart, currentSection.pageEnd);
      processLogger.log(`🧠 Next section "${nextSection.title}" starts at page ${nextSection.pageStart}`);
    }
    
    processLogger.log(`🧠 Smart fallback range: pages ${actualStartPage}-${actualEndPage}`);
    
    // Get pages in this range
    const fallbackPages = pdfPages.filter(
      page => page.pageNumber >= actualStartPage && page.pageNumber <= actualEndPage
    );
    
    if (fallbackPages.length === 0) {
      processLogger.warn(`🧠 No pages found in smart fallback range ${actualStartPage}-${actualEndPage}`);
      return { found: false, content: '', pageStart: 0, pageEnd: 0 };
    }
    
    // Combine text from fallback pages
    const fallbackText = fallbackPages.map(p => p.text).join('\n\n');
    
    // Calculate absolute character positions for this range
    const absoluteStartChar = this.calculateAbsoluteCharPosition(pdfPages, actualStartPage, 0);
    const absoluteEndChar = absoluteStartChar + fallbackText.length;
    
    // Check what portions of this text are already covered by other sections
    let uncoveredSegments: Array<{ start: number; end: number; text: string }> = [];
    let currentPos = 0;
    
    processLogger.log(`🧠 Checking coverage: absolute range ${absoluteStartChar}-${absoluteEndChar}`);
    processLogger.log(`🧠 Already covered ranges: ${coveredRanges.length}`);
    
    // Sort covered ranges by start position
    const sortedCoveredRanges = [...coveredRanges].sort((a, b) => a.start - b.start);
    
    // Find gaps between covered ranges within our fallback text
    for (const coveredRange of sortedCoveredRanges) {
      // Check if this covered range overlaps with our fallback text
      if (coveredRange.end <= absoluteStartChar || coveredRange.start >= absoluteEndChar) {
        // No overlap, skip
        continue;
      }
      
      // There's overlap - find the uncovered part before this range
      const rangeStartInFallback = Math.max(0, coveredRange.start - absoluteStartChar);
      
      if (currentPos < rangeStartInFallback) {
        // There's uncovered text before this range
        const uncoveredText = fallbackText.substring(currentPos, rangeStartInFallback);
        if (uncoveredText.trim().length > 50) {  // Only if significant content
          uncoveredSegments.push({
            start: currentPos,
            end: rangeStartInFallback,
            text: uncoveredText
          });
          processLogger.log(`🧠 Found uncovered segment: ${uncoveredText.substring(0, 100)}...`);
        }
      }
      
      // Move past this covered range
      const rangeEndInFallback = Math.min(fallbackText.length, coveredRange.end - absoluteStartChar);
      currentPos = Math.max(currentPos, rangeEndInFallback);
    }
    
    // Check for uncovered text after all covered ranges
    if (currentPos < fallbackText.length) {
      const uncoveredText = fallbackText.substring(currentPos);
      if (uncoveredText.trim().length > 50) {
        uncoveredSegments.push({
          start: currentPos,
          end: fallbackText.length,
          text: uncoveredText
        });
        processLogger.log(`🧠 Found final uncovered segment: ${uncoveredText.substring(0, 100)}...`);
      }
    }
    
    if (uncoveredSegments.length === 0) {
      processLogger.warn(`🧠 No uncovered text found in range ${actualStartPage}-${actualEndPage}`);
      return { found: false, content: '', pageStart: actualStartPage, pageEnd: actualEndPage };
    }
    
    // Combine all uncovered segments (usually there will be just one)
    const uncoveredContent = uncoveredSegments.map(seg => seg.text).join('\n\n');
    
    processLogger.log(`🧠 SMART FALLBACK SUCCESS: Found ${uncoveredContent.length} chars of uncovered content`);
    processLogger.log(`🧠 Uncovered content preview: "${uncoveredContent.substring(0, 200)}..."`);
    
    return {
      found: true,
      content: uncoveredContent,
      pageStart: actualStartPage,
      pageEnd: actualEndPage
    };
  }
  
  /**
   * Create chunks from a processed section
   */
  createChunksFromSection(section: ProcessedSection, materialId: string): any[] {
    const chunks: any[] = [];
    const paragraphs = section.content.split('\n\n');
    let currentChunk = '';
    let chunkIndex = 0;
    let charOffset = 0;
    
    for (const paragraph of paragraphs) {
      if (currentChunk.length + paragraph.length > this.MAX_CHUNK_CHARS && currentChunk.length > 0) {
        // Save current chunk
        chunks.push({
          chunkId: `chunk_${section.sectionId}_${chunkIndex}`,
          sectionId: section.sectionId,
          title: section.title,
          path: section.path,  // Use actual path
          page: section.pageStart,
          paragraphIdx: chunkIndex,
          charStart: section.charStart + charOffset,
          charEnd: section.charStart + charOffset + currentChunk.length,
          content: currentChunk.trim()
        });
        
        chunkIndex++;
        charOffset += currentChunk.length;
        currentChunk = '';
      }
      
      currentChunk += (currentChunk ? '\n\n' : '') + paragraph;
    }
    
    // Save last chunk if any
    if (currentChunk.trim()) {
      chunks.push({
        chunkId: `chunk_${section.sectionId}_${chunkIndex}`,
        sectionId: section.sectionId,
        title: section.title,
        path: section.path,  // Use actual path
        page: section.pageStart,
        paragraphIdx: chunkIndex,
        charStart: section.charStart + charOffset,
        charEnd: section.charStart + charOffset + currentChunk.length,
        content: currentChunk.trim()
      });
    }
    
    // Handle follow-up parts if they exist
    if (section.followUpParts) {
      for (const part of section.followUpParts) {
        chunks.push(...this.createChunksFromSection(part, materialId));
      }
    }
    
    processLogger.logChunkCreation(section.title, chunks.length);
    return chunks;
  }
  
  /**
   * Save processed sections to database
   */
  async saveSectionsToDatabase(
    sections: ProcessedSection[],
    materialId: string,
    subjectId: string
  ): Promise<void> {
    // Get material info for additional fields
    const material = await require('../models').Material.findById(materialId);
    if (!material) {
      throw new Error(`Material not found: ${materialId}`);
    }
    for (const section of sections) {
      try {
        // Determine part information
        const totalParts = section.followUpParts ? section.followUpParts.length + 1 : 1;
        const partNumber = section.sectionId.includes('_embedpart') ? 
          parseInt(section.sectionId.split('_embedpart')[1]) : 1;
        const isMainPart = partNumber === 1;
        
        // Save main section
        const docSection = new DocumentSection({
          docId: materialId,
          subjectId: subjectId,
          facultyId: material.facultyId,     // Add for faster querying
          departmentId: material.departmentId, // Add for faster querying  
          year: material.year,               // Add for faster querying
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
          totalParts: totalParts,            // Total parts for this logical section
          partNumber: partNumber,            // Which part this is (1, 2, 3...)
          isMainPart: isMainPart             // True only for first part
        });
        
        await docSection.save();
        
        // Generate and save embedding
        processLogger.addLog(`  Generating embedding for section: ${section.sectionId}`, 'DEBUG');
        const vectorId = await qdrantService.addSection(
          section.sectionId,
          section.content,
          {
            docId: materialId,
            subjectId: subjectId,
            facultyId: material.facultyId,      // Add for better filtering
            departmentId: material.departmentId, // Add for better filtering
            year: material.year,                // Add for better filtering
            title: section.title,
            path: section.path,
            level: section.level,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            type: 'section'
          }
        );
        
        processLogger.logEmbedding(section.sectionId, vectorId);
        
        // Update section with vector ID
        await DocumentSection.findOneAndUpdate(
          { sectionId: section.sectionId },
          { $set: { vectorId } }
        );
        
        // Save follow-up parts if they exist
        if (section.followUpParts) {
          await this.saveSectionsToDatabase(section.followUpParts, materialId, subjectId);
        }
        
      } catch (error) {
        processLogger.error(`❌ Error saving section "${section.title}": ${error}`);
      }
    }
  }
}

export default new SectionProcessor();
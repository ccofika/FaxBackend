import OpenAI from 'openai';
import { TocAnalysis } from '../models';
import { extractCleanTitle } from '../utils/fuzzyMatcher';

interface TocAnalysisResult {
  sections: Array<{
    title: string;
    level: number;
    pageStart: number;
    pageEnd: number;
    parentSectionId?: string;
    semanticType: 'chapter' | 'section' | 'subsection' | 'paragraph';
  }>;
}

class AIAnalysisService {
  private openai: OpenAI;

  constructor() {
    this.openai = new OpenAI({
      apiKey: process.env.OPENAI_API_KEY,
    });
  }

  async analyzeTOC(tocText: string, startPage: number = 1, endPage: number = 4, materialId?: string, subjectId?: string): Promise<TocAnalysisResult> {
    console.log(`📊 Analyzing TOC: ${tocText.length} characters`);
    
    // Check if TOC is too large for single processing
    const MAX_CHARS_PER_CHUNK = 15000; // Optimal size for AI processing
    
    if (tocText.length > MAX_CHARS_PER_CHUNK) {
      console.log(`📊 TOC is large (${tocText.length} chars), splitting into chunks for processing`);
      return await this.processLargeTOC(tocText, startPage, endPage, materialId, subjectId, MAX_CHARS_PER_CHUNK);
    }
    
    // Process smaller TOCs directly
    return await this.processSingleTOC(tocText, startPage, endPage, materialId, subjectId);
  }

  private async processSingleTOC(tocText: string, startPage: number = 1, endPage: number = 4, materialId?: string, subjectId?: string): Promise<TocAnalysisResult> {
    console.log(`📊 Processing single TOC chunk: ${tocText.length} characters`);

    const prompt = `Extract ALL sections from the Table of Contents as comprehensive JSON without any limitations:

${tocText}

IMPORTANT RULES:
1. Extract EVERY section/subsection found in the TOC

2. IGNORE separator characters between title and page number:
   - Dots: "............"
   - Dashes: "------------" or "___________"
   - Mixed: "................" or "- - - - - -"
   - These are just visual separators, NOT part of the title!
   - Example: "PREDGOVOR ................... 5" → title is "PREDGOVOR" (not including dots)

3. Recognize patterns like:
   - "PREDGOVOR _____ 5" → {"title":"PREDGOVOR","level":1,"pageStart":5,"pageEnd":15,"semanticType":"chapter"}
   - "1. HARDVER _____ 15" → {"title":"1. HARDVER","level":1,"pageStart":15,"pageEnd":30,"semanticType":"chapter"}
   - "1.1. Pojam _____ 15" → {"title":"1.1. Pojam","level":2,"pageStart":15,"pageEnd":20,"semanticType":"section"}
   - "2. SOFTVER _____ 30" → {"title":"2. SOFTVER","level":1,"pageStart":30,"pageEnd":45,"semanticType":"chapter"}

4. CRITICAL PAGE END CALCULATION:
   - For level 1 sections: Find the NEXT level 1 section's pageStart
   - Set current level 1 section's pageEnd = next level 1 section's pageStart (SAME PAGE where next starts)
   - IGNORE level 2/3 sections when calculating level 1 pageEnd
   - Example: If "1. HARDVER" (level 1) starts at page 15, has subsections 1.1, 1.2, 1.3, 
     and "2. SOFTVER" (level 1) starts at page 30, then "1. HARDVER" pageEnd = 30
   
   - For level 2+ sections: Use the next section of ANY level
   - Set pageEnd = next section's pageStart (SAME PAGE where next starts)
   
   - For the LAST section at any level: estimate 10-20 pages

5. Level determination:
   - No number prefix = level 1 (e.g., "PREDGOVOR")
   - Single number = level 1 (e.g., "1. HARDVER")
   - Two numbers = level 2 (e.g., "1.1. Pojam")
   - Three numbers = level 3 (e.g., "1.1.1. Definicija")

6. Include ALL sections - do not skip or limit any entries
7. Use proper semantic types: 'chapter' for level 1, 'section' for level 2, 'subsection' for level 3+

Return comprehensive JSON with ALL sections: {"sections":[...]}`;

    try {
      console.log('🤖 Making OpenAI API call with model: gpt-5-nano');
      console.log('📋 TOC text being sent to AI:');
      console.log('--- START TOC ---');
      console.log(tocText);
      console.log('--- END TOC ---');
      console.log(`📊 TOC length: ${tocText.length} characters`);
      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          {
            role: 'system',
            content: 'Extract ALL table of contents sections as comprehensive JSON. Process the entire content without restrictions. Include every section/subsection found.'
          },
          {
            role: 'user',
            content: prompt
          }
        ],
      });

      console.log('🤖 OpenAI response received:', response.choices?.length, 'choices');
      const result = response.choices[0]?.message?.content;
      console.log('🤖 Raw AI response:', result?.substring(0, 500));
      
      // Check for empty response or token limit issues
      if (!result || result.trim() === '') {
        const finishReason = response.choices[0]?.finish_reason;
        console.error('🤖 Empty AI response. Finish reason:', finishReason);
        
        if (finishReason === 'length') {
          console.warn('🤖 Response truncated due to token limit, using fallback');
          // Don't throw error, use fallback instead
          return this.fallbackTocParsing(tocText);
        }
        
        console.error('🤖 No content in AI response:', JSON.stringify(response, null, 2));
        throw new Error('No response from AI model');
      }

      // Parse JSON response - handle potential non-JSON responses
      let parsed: TocAnalysisResult;
      try {
        // Extract JSON from response if it contains extra text
        const jsonMatch = result.match(/\{[\s\S]*\}/);
        const jsonText = jsonMatch ? jsonMatch[0] : result;
        const parsedJson = JSON.parse(jsonText);
        
        // Check if AI returned an error response
        if (parsedJson.error) {
          console.error('🤖 AI returned error:', parsedJson.error);
          throw new Error(`AI analysis error: ${parsedJson.error}`);
        }
        
        parsed = parsedJson as TocAnalysisResult;
      } catch (parseError) {
        console.error('🤖 Failed to parse AI response as JSON:', parseError);
        console.error('🤖 Raw response:', result);
        throw new Error('AI returned invalid JSON response');
      }
      
      // Validate and clean up the result
      const cleanedResult = this.validateAndCleanTocResult(parsed);
      
      // Save to database if materialId and subjectId provided
      if (materialId && subjectId) {
        await this.saveTocAnalysis(cleanedResult, materialId, subjectId, `${startPage}-${endPage}`);
      }
      
      return cleanedResult;
      
    } catch (error) {
      console.error('Error analyzing TOC with AI:', error);
      
      // Provide fallback if AI fails
      console.log('🤖 Attempting fallback TOC parsing...');
      const fallbackResult = this.fallbackTocParsing(tocText);
      
      // Save fallback result if we have IDs
      if (materialId && subjectId) {
        await this.saveTocAnalysis(fallbackResult, materialId, subjectId, `${startPage}-${endPage}`);
      }
      
      return fallbackResult;
    }
  }

  private async processLargeTOC(
    tocText: string, 
    startPage: number, 
    endPage: number, 
    materialId?: string, 
    subjectId?: string,
    maxCharsPerChunk: number = 15000
  ): Promise<TocAnalysisResult> {
    console.log(`🔄 Processing large TOC with chunking strategy`);
    
    // Split TOC into logical chunks
    const chunks = this.splitTOCIntoChunks(tocText, maxCharsPerChunk);
    console.log(`📦 Split TOC into ${chunks.length} chunks`);
    
    // Process each chunk individually
    const allResults: TocAnalysisResult[] = [];
    
    for (let i = 0; i < chunks.length; i++) {
      const chunk = chunks[i];
      console.log(`🔄 Processing chunk ${i + 1}/${chunks.length} (${chunk.text.length} chars)`);
      
      try {
        const chunkResult = await this.processSingleTOC(chunk.text, chunk.startPage, chunk.endPage);
        allResults.push(chunkResult);
        console.log(`✅ Chunk ${i + 1} processed successfully: ${chunkResult.sections.length} sections`);
      } catch (error) {
        console.error(`❌ Error processing chunk ${i + 1}:`, error);
        // Use fallback for failed chunks
        const fallbackResult = this.fallbackTocParsing(chunk.text);
        allResults.push(fallbackResult);
        console.log(`🔄 Fallback used for chunk ${i + 1}: ${fallbackResult.sections.length} sections`);
      }
      
      // Small delay between chunks to avoid rate limiting
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 500));
      }
    }
    
    // Merge all results into single TOC analysis
    const mergedResult = this.mergeChunkResults(allResults);
    console.log(`🔗 Merged ${allResults.length} chunks into ${mergedResult.sections.length} total sections`);
    
    // Save to database if IDs provided
    if (materialId && subjectId) {
      await this.saveTocAnalysis(mergedResult, materialId, subjectId, `${startPage}-${endPage}`);
    }
    
    return mergedResult;
  }

  private splitTOCIntoChunks(tocText: string, maxCharsPerChunk: number): Array<{text: string, startPage: number, endPage: number}> {
    const lines = tocText.split('\n');
    const chunks: Array<{text: string, startPage: number, endPage: number}> = [];
    
    let currentChunk = '';
    let currentChunkStartPage = 1;
    let currentChunkEndPage = 1;
    let chunkLineCount = 0;
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const potentialChunk = currentChunk + (currentChunk ? '\n' : '') + line;
      
      // Check if adding this line would exceed the chunk size
      if (potentialChunk.length > maxCharsPerChunk && currentChunk.length > 0) {
        // Save current chunk and start a new one
        chunks.push({
          text: currentChunk.trim(),
          startPage: currentChunkStartPage,
          endPage: currentChunkEndPage
        });
        
        // Start new chunk with current line
        currentChunk = line;
        currentChunkStartPage = this.extractPageFromLine(line) || currentChunkEndPage + 1;
        currentChunkEndPage = currentChunkStartPage;
        chunkLineCount = 1;
      } else {
        // Add line to current chunk
        currentChunk = potentialChunk;
        chunkLineCount++;
        
        // Update page tracking
        const linePageNum = this.extractPageFromLine(line);
        if (linePageNum) {
          if (chunkLineCount === 1) {
            currentChunkStartPage = linePageNum;
          }
          currentChunkEndPage = linePageNum;
        }
      }
    }
    
    // Add the last chunk if it has content
    if (currentChunk.trim()) {
      chunks.push({
        text: currentChunk.trim(),
        startPage: currentChunkStartPage,
        endPage: currentChunkEndPage
      });
    }
    
    return chunks;
  }

  private extractPageFromLine(line: string): number | null {
    // Extract page number from TOC line using common patterns
    const patterns = [
      /\b(\d+)\s*$/,  // Page number at end of line
      /\.{2,}\s*(\d+)\s*$/,  // Page after dots
      /_{2,}\s*(\d+)\s*$/,   // Page after underscores
      /-{2,}\s*(\d+)\s*$/    // Page after dashes
    ];
    
    for (const pattern of patterns) {
      const match = line.match(pattern);
      if (match) {
        const pageNum = parseInt(match[1]);
        if (pageNum > 0 && pageNum < 10000) { // Reasonable page number range
          return pageNum;
        }
      }
    }
    
    return null;
  }

  private mergeChunkResults(results: TocAnalysisResult[]): TocAnalysisResult {
    const allSections: any[] = [];
    
    for (const result of results) {
      if (result.sections && Array.isArray(result.sections)) {
        allSections.push(...result.sections);
      }
    }
    
    // Sort by page start to maintain proper order
    allSections.sort((a, b) => a.pageStart - b.pageStart);
    
    // Remove potential duplicates based on title and page
    const uniqueSections = allSections.filter((section, index, arr) => {
      return index === 0 || 
             section.title !== arr[index - 1].title || 
             section.pageStart !== arr[index - 1].pageStart;
    });
    
    console.log(`🔗 Merged sections: ${allSections.length} total, ${uniqueSections.length} unique`);
    
    return { sections: uniqueSections };
  }

  private validateAndCleanTocResult(result: TocAnalysisResult): TocAnalysisResult {
    if (!result.sections || !Array.isArray(result.sections)) {
      throw new Error('Invalid AI response: sections must be an array');
    }

    // First pass: filter and clean sections
    const cleanedSections = result.sections
      .filter(section => {
        // Basic validation
        return section.title && 
               typeof section.pageStart === 'number' && 
               section.pageStart > 0 &&
               typeof section.level === 'number' &&
               section.level >= 1 && section.level <= 4;
      })
      .map(section => ({
        title: section.title.trim(),
        level: Math.max(1, Math.min(4, section.level)),
        pageStart: section.pageStart,
        pageEnd: section.pageEnd || section.pageStart, // Will be recalculated
        parentSectionId: section.parentSectionId,
        semanticType: this.inferSemanticType(section.level)
      }))
      .sort((a, b) => a.pageStart - b.pageStart); // Sort by pageStart

    // Second pass: recalculate pageEnd values based on proper rules
    for (let i = 0; i < cleanedSections.length; i++) {
      const currentSection = cleanedSections[i];
      
      if (currentSection.level === 1) {
        // For level 1 sections, find the next level 1 section
        let nextLevel1Index = -1;
        for (let j = i + 1; j < cleanedSections.length; j++) {
          if (cleanedSections[j].level === 1) {
            nextLevel1Index = j;
            break;
          }
        }
        
        if (nextLevel1Index !== -1) {
          // Set pageEnd to where the next level 1 section starts (same page)
          currentSection.pageEnd = cleanedSections[nextLevel1Index].pageStart;
        } else {
          // This is the last level 1 section
          // Check if AI provided a reasonable pageEnd
          if (!currentSection.pageEnd || currentSection.pageEnd <= currentSection.pageStart) {
            // Estimate based on typical section length
            currentSection.pageEnd = currentSection.pageStart + 15;
          }
        }
      } else {
        // For level 2+ sections, use the next section of any level
        if (i < cleanedSections.length - 1) {
          currentSection.pageEnd = cleanedSections[i + 1].pageStart;
        } else {
          // Last section in the list
          if (!currentSection.pageEnd || currentSection.pageEnd <= currentSection.pageStart) {
            currentSection.pageEnd = currentSection.pageStart + 5;
          }
        }
      }
      
      // Ensure pageEnd is always at least pageStart
      if (currentSection.pageEnd < currentSection.pageStart) {
        currentSection.pageEnd = currentSection.pageStart;
      }
    }

    console.log(`✅ Validated and cleaned ${cleanedSections.length} sections with proper page ranges`);
    return { sections: cleanedSections };
  }

  private inferSemanticType(level: number): 'chapter' | 'section' | 'subsection' | 'paragraph' {
    switch (level) {
      case 1: return 'chapter';
      case 2: return 'section';
      case 3: return 'subsection';
      default: return 'paragraph';
    }
  }

  private async saveTocAnalysis(
    result: TocAnalysisResult,
    materialId: string,
    subjectId: string,
    tocPages: string
  ): Promise<void> {
    try {
      // Check if TOC analysis already exists for this document
      const existingAnalysis = await TocAnalysis.findOne({ docId: materialId });
      
      if (existingAnalysis) {
        console.log(`📝 Updating existing TOC analysis for document ${materialId}`);
        
        // Get material info for additional fields
        const Material = require('../models').Material;
        const material = await Material.findById(materialId);
        if (material) {
          existingAnalysis.facultyId = material.facultyId;
          existingAnalysis.departmentId = material.departmentId;
          existingAnalysis.year = material.year;
        }
        
        // Update existing analysis
        existingAnalysis.sections = result.sections.map(section => ({
          title: section.title,
          cleanTitle: extractCleanTitle(section.title),
          level: section.level,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          parentSectionId: section.parentSectionId,
          semanticType: section.semanticType,
          processed: false
        }));
        existingAnalysis.totalSections = result.sections.length;
        existingAnalysis.processedSections = 0;
        existingAnalysis.status = 'completed';
        existingAnalysis.tocPages = tocPages;
        
        await existingAnalysis.save();
      } else {
        console.log(`💾 Creating new TOC analysis for document ${materialId}`);
        
        // Get material info for additional fields
        const Material = require('../models').Material;
        const material = await Material.findById(materialId);
        if (!material) {
          throw new Error(`Material not found: ${materialId}`);
        }
        
        // Create new TOC analysis document
        const tocAnalysis = new TocAnalysis({
          docId: materialId,
          subjectId: subjectId,
          facultyId: material.facultyId,
          departmentId: material.departmentId,
          year: material.year,
          tocPages: tocPages,
          sections: result.sections.map(section => ({
            title: section.title,
            cleanTitle: extractCleanTitle(section.title),
            level: section.level,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            parentSectionId: section.parentSectionId,
            semanticType: section.semanticType,
            processed: false
          })),
          totalSections: result.sections.length,
          processedSections: 0,
          status: 'completed'
        });
        
        await tocAnalysis.save();
      }
      
      console.log(`✅ TOC analysis saved with ${result.sections.length} sections`);
    } catch (error) {
      console.error('❌ Error saving TOC analysis to database:', error);
      // Don't throw - we still want to continue processing even if saving fails
    }
  }

  private fallbackTocParsing(tocText: string): TocAnalysisResult {
    console.log('🔄 Using fallback TOC parsing');
    
    const sections: any[] = [];
    const lines = tocText.split('\n');
    
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i].trim();
      if (!line) continue;
      
      // Look for patterns like "TITLE ... PAGE" or "1.1 TITLE ... PAGE"
      const patterns = [
        /^([A-ZŠĐČĆŽ\s]+)\s*\.{2,}\s*(\d+)$/i,
        /^(\d+\.?\d*\.?\d*)\s+([A-ZŠĐČĆŽ\s]+)\s*\.{2,}\s*(\d+)$/i,
        /^([A-ZŠĐČĆŽ\s]+)\s+(\d+)$/i,
      ];
      
      for (const pattern of patterns) {
        const match = line.match(pattern);
        if (match) {
          const hasNumber = match[1].match(/^\d/);
          const title = hasNumber ? match[2] : match[1];
          const pageNum = hasNumber ? parseInt(match[3]) : parseInt(match[2]);
          
          if (title && pageNum && pageNum > 0) {
            const level = hasNumber ? (match[1].split('.').length) : 1;
            
            sections.push({
              title: title.trim(),
              level: Math.min(level, 3),
              pageStart: pageNum,
              pageEnd: pageNum + 3,
              semanticType: this.inferSemanticType(level)
            });
          }
          break;
        }
      }
    }
    
    console.log(`🔄 Fallback parsing extracted ${sections.length} sections`);
    return { sections };
  }
}

export default new AIAnalysisService();
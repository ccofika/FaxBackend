import OpenAI from 'openai';

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

  async analyzeTOC(tocText: string, startPage: number = 1, endPage: number = 4): Promise<TocAnalysisResult> {
    // Keep full TOC text - gpt-5-nano can handle much larger inputs
    let truncatedToc = tocText;
    console.log(`📊 Original TOC: ${tocText.length} chars - sending full text`);

    const prompt = `Extract TOC sections as JSON:

${truncatedToc}

Find patterns like:
- "PREDGOVOR _____ 5" → {"title":"PREDGOVOR","level":1,"pageStart":5,"pageEnd":6,"semanticType":"chapter"}
- "1. HARDVER _____ 15" → {"title":"1. HARDVER","level":1,"pageStart":15,"pageEnd":16,"semanticType":"chapter"}
- "1.1. Pojam _____ 15" → {"title":"1.1. Pojam","level":2,"pageStart":15,"pageEnd":16,"semanticType":"section"}

Return only JSON: {"sections":[...]}`;

    try {
      console.log('🤖 Making OpenAI API call with model: gpt-5-nano');
      console.log('📋 TOC text being sent to AI:');
      console.log('--- START TOC ---');
      console.log(truncatedToc);
      console.log('--- END TOC ---');
      console.log(`📊 TOC length: ${truncatedToc.length} characters`);
      const response = await this.openai.chat.completions.create({
        model: 'gpt-5-nano',
        messages: [
          {
            role: 'system',
            content: 'Extract TOC sections as JSON. Be precise and concise.'
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
      return this.validateAndCleanTocResult(parsed);
      
    } catch (error) {
      console.error('Error analyzing TOC with AI:', error);
      
      // Provide fallback if AI fails
      console.log('🤖 Attempting fallback TOC parsing...');
      return this.fallbackTocParsing(tocText);
    }
  }

  private validateAndCleanTocResult(result: TocAnalysisResult): TocAnalysisResult {
    if (!result.sections || !Array.isArray(result.sections)) {
      throw new Error('Invalid AI response: sections must be an array');
    }

    const cleanedSections = result.sections
      .filter(section => {
        // Basic validation
        return section.title && 
               typeof section.pageStart === 'number' && 
               section.pageStart > 0 &&
               typeof section.level === 'number' &&
               section.level >= 1 && section.level <= 4;
      })
      .map(section => {
        // Clean up and ensure proper structure
        // Fix pageEnd if it's invalid (less than pageStart)
        let validPageEnd = section.pageEnd || section.pageStart + 3;
        if (validPageEnd < section.pageStart) {
          validPageEnd = section.pageStart + 3; // Default 3 pages per section
        }
        
        return {
          title: section.title.trim(),
          level: Math.max(1, Math.min(4, section.level)),
          pageStart: section.pageStart,
          pageEnd: validPageEnd,
          parentSectionId: section.parentSectionId,
          semanticType: this.inferSemanticType(section.level)
        };
      });

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
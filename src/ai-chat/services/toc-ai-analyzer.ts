import { openai } from '../config/openai-config';

export interface TocSection {
  title: string;
  cleanTitle: string;
  level: number;
  pageStart: number;
  pageEnd: number;
  semanticType: string;
}

export interface SectionSelectionRequest {
  userQuery: string;
  materialTitle: string;
  tocSections: TocSection[];
  maxSections?: number; // Maximum number of sections to select
}

export interface SelectedSection {
  title: string;
  cleanTitle: string;
  pageStart: number;
  pageEnd: number;
  level: number;
  relevanceReason: string; // Why this section was selected
  confidence: number; // AI confidence score (0-1)
}

export interface SectionSelectionResult {
  selectedSections: SelectedSection[];
  totalSections: number;
  reasoning: string; // AI's overall reasoning for selections
  fallbackToFullMaterial: boolean; // If AI couldn't identify specific sections
  suggestedQueries?: string[]; // Alternative queries that might work better
}

export class TocAIAnalyzer {
  
  /**
   * Main method to analyze TOC and select relevant sections for user query
   */
  async selectRelevantSections(request: SectionSelectionRequest): Promise<SectionSelectionResult> {
    try {
      const { userQuery, materialTitle, tocSections, maxSections = 5 } = request;
      
      if (tocSections.length === 0) {
        return {
          selectedSections: [],
          totalSections: 0,
          reasoning: 'No table of contents available for this material.',
          fallbackToFullMaterial: true
        };
      }

      const prompt = this.buildTocAnalysisPrompt(userQuery, materialTitle, tocSections, maxSections);
      
      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          {
            role: 'system',
            content: `Ti si AI ekspert za analizu sadržaja akademskih materijala. Tvoj zadatak je da na osnovu korisničke pretrage i sadržaja knjige (Table of Contents) identifikuješ koje sekcije knjige su najrelevantnije za odgovaranje na korisničko pitanje.

VAŽNO:
- Odgovori UVEK u JSON formatu
- Budi precizan sa nazivima sekcija - koristi tačno iste nazive kao što su u TOC
- Uključi samo sekcije koje su direktno relevantne za pitanje
- Ako nisi siguran, bolje je da vratiš manje sekcija nego previše
- Ako pitanje zahteva širok pregled, možeš uključiti više sekcija na višem nivou`
          },
          {
            role: 'user', 
            content: prompt
          }
        ],
        temperature: 0.3,
        max_tokens: 1500
      });

      const aiResponse = response.choices[0]?.message?.content;
      if (!aiResponse) {
        throw new Error('No response from AI model');
      }

      // Parse AI response
      const result = this.parseAIResponse(aiResponse, tocSections);
      return result;

    } catch (error) {
      console.error('Error in TOC AI analysis:', error);
      
      // Fallback to simple text matching
      return this.fallbackTextMatching(request);
    }
  }

  /**
   * Build the prompt for AI TOC analysis
   */
  private buildTocAnalysisPrompt(
    userQuery: string, 
    materialTitle: string, 
    tocSections: TocSection[], 
    maxSections: number
  ): string {
    const tocText = this.formatTocForAI(tocSections);
    
    return `KORISNIČKO PITANJE: "${userQuery}"

MATERIJAL: "${materialTitle}"

SADRŽAJ KNJIGE (Table of Contents):
${tocText}

ZADATAK:
Analiziraj korisničko pitanje i identifikuj maksimalno ${maxSections} sekcija iz knjige koje su najrelevantnije za odgovaranje na ovo pitanje.

Za svaku selektovanu sekciju, objasni zašto je relevantna i daj ocenu pouzdanosti (0-1).

FORMAT ODGOVORA (samo JSON, bez dodatnog teksta):
{
  "selectedSections": [
    {
      "title": "Tačan naziv sekcije iz TOC",
      "pageStart": broj_početne_stranice,
      "pageEnd": broj_završne_stranice,
      "level": nivo_sekcije,
      "relevanceReason": "Objašnjenje zašto je ova sekcija relevantna",
      "confidence": 0.95
    }
  ],
  "reasoning": "Opšte objašnjenje logike selekcije",
  "fallbackToFullMaterial": false,
  "suggestedQueries": ["alternativno pitanje 1", "alternativno pitanje 2"]
}

NAPOMENE:
- Ako nijedna sekcija nije jasno relevantna, postaviti "fallbackToFullMaterial": true
- Prioritizuj sekcije koje direktno odgovaraju na pitanje
- Za široke teme, uključi više sekcija na višem nivou
- Za specifične pojmove, uključi sekcije na nižem nivou`;
  }

  /**
   * Format TOC sections for AI prompt
   */
  private formatTocForAI(sections: TocSection[]): string {
    const lines = [];
    
    for (const section of sections) {
      const indent = '  '.repeat(section.level - 1);
      lines.push(`${indent}${section.level}. ${section.title} (str. ${section.pageStart}-${section.pageEnd})`);
    }
    
    return lines.join('\n');
  }

  /**
   * Parse AI response and validate it
   */
  private parseAIResponse(aiResponse: string, originalSections: TocSection[]): SectionSelectionResult {
    try {
      // Clean the response - remove any markdown formatting
      const cleanResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
      
      const parsed = JSON.parse(cleanResponse);
      
      // Validate the structure
      if (!parsed.selectedSections || !Array.isArray(parsed.selectedSections)) {
        throw new Error('Invalid response structure');
      }

      // Map AI selections to actual TOC sections and validate
      const validatedSelections: SelectedSection[] = [];
      
      for (const selection of parsed.selectedSections) {
        // Find matching section from original TOC
        const matchingSection = originalSections.find(section => 
          section.title === selection.title ||
          section.cleanTitle === selection.title ||
          this.fuzzyMatchTitle(section.title, selection.title)
        );

        if (matchingSection) {
          validatedSelections.push({
            title: matchingSection.title,
            cleanTitle: matchingSection.cleanTitle,
            pageStart: matchingSection.pageStart,
            pageEnd: matchingSection.pageEnd,
            level: matchingSection.level,
            relevanceReason: selection.relevanceReason || 'Relevantno za korisnički upit',
            confidence: Math.min(1, Math.max(0, selection.confidence || 0.5))
          });
        }
      }

      return {
        selectedSections: validatedSelections,
        totalSections: validatedSelections.length,
        reasoning: parsed.reasoning || 'AI je selektovao relevantne sekcije na osnovu korisničkog upita.',
        fallbackToFullMaterial: parsed.fallbackToFullMaterial || validatedSelections.length === 0,
        suggestedQueries: parsed.suggestedQueries || undefined
      };

    } catch (error) {
      console.error('Error parsing AI response:', error);
      console.log('AI Response was:', aiResponse);
      
      return {
        selectedSections: [],
        totalSections: 0,
        reasoning: 'Greška u parsiranju AI odgovora',
        fallbackToFullMaterial: true
      };
    }
  }

  /**
   * Fuzzy matching for section titles
   */
  private fuzzyMatchTitle(tocTitle: string, aiTitle: string): boolean {
    const clean1 = tocTitle.toLowerCase().replace(/[^a-zšđčćž]/g, '');
    const clean2 = aiTitle.toLowerCase().replace(/[^a-zšđčćž]/g, '');
    
    // Check if one contains the other or if they're very similar
    return clean1.includes(clean2) || clean2.includes(clean1) || 
           this.levenshteinDistance(clean1, clean2) <= Math.min(clean1.length, clean2.length) * 0.3;
  }

  /**
   * Calculate Levenshtein distance for fuzzy matching
   */
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

  /**
   * Fallback method using simple text matching when AI fails
   */
  private fallbackTextMatching(request: SectionSelectionRequest): SectionSelectionResult {
    const { userQuery, tocSections, maxSections = 5 } = request;
    
    const queryWords = userQuery.toLowerCase()
      .split(/\s+/)
      .filter(word => word.length > 2)
      .map(word => word.replace(/[^a-zšđčćž]/g, ''));

    const scoredSections = tocSections.map(section => {
      let score = 0;
      const titleLower = section.cleanTitle.toLowerCase();
      
      for (const word of queryWords) {
        if (titleLower.includes(word)) {
          score += 10;
        }
        
        // Partial matches
        for (const titleWord of titleLower.split(/\s+/)) {
          if (titleWord.includes(word) || word.includes(titleWord)) {
            score += 3;
          }
        }
      }
      
      // Bonus for higher level sections
      if (section.level === 1) score += 2;
      else if (section.level === 2) score += 1;
      
      return {
        section,
        score
      };
    }).filter(item => item.score > 0)
      .sort((a, b) => b.score - a.score)
      .slice(0, maxSections);

    const selectedSections: SelectedSection[] = scoredSections.map(item => ({
      title: item.section.title,
      cleanTitle: item.section.cleanTitle,
      pageStart: item.section.pageStart,
      pageEnd: item.section.pageEnd,
      level: item.section.level,
      relevanceReason: 'Selektovano na osnovu poklapanja ključnih reči',
      confidence: Math.min(0.8, item.score / 20)
    }));

    return {
      selectedSections,
      totalSections: selectedSections.length,
      reasoning: 'Korišćena je jednostavna pretraga na osnovu poklapanja reči (AI analiza nije uspela).',
      fallbackToFullMaterial: selectedSections.length === 0
    };
  }

  /**
   * Get section recommendations based on query complexity
   */
  async getQueryComplexityAnalysis(userQuery: string): Promise<{
    complexity: 'simple' | 'moderate' | 'complex';
    recommendedSectionCount: number;
    queryType: 'factual' | 'conceptual' | 'analytical' | 'broad_overview';
    searchStrategy: string;
  }> {
    try {
      const prompt = `Analiziraj sledeće korisničko pitanje i klasifikuj ga:

PITANJE: "${userQuery}"

Odgovori u JSON formatu:
{
  "complexity": "simple|moderate|complex",
  "recommendedSectionCount": broj_preporučenih_sekcija,
  "queryType": "factual|conceptual|analytical|broad_overview", 
  "searchStrategy": "opis strategije pretrage"
}

KRITERIJUMI:
- simple: kratko pitanje, traži specifičan podatak
- moderate: pitanje traži objašnjenje koncepta  
- complex: pitanje traži analizu, poređenje, ili širok pregled

recommendedSectionCount: 1-2 za simple, 2-4 za moderate, 3-6 za complex`;

      const response = await openai.chat.completions.create({
        model: 'gpt-4o-mini',
        messages: [
          { role: 'system', content: 'Ti si AI ekspert za analizu korisničkih upita.' },
          { role: 'user', content: prompt }
        ],
        temperature: 0.2,
        max_tokens: 300
      });

      const aiResponse = response.choices[0]?.message?.content;
      if (aiResponse) {
        const cleanResponse = aiResponse.replace(/```json\n?/g, '').replace(/```\n?/g, '').trim();
        return JSON.parse(cleanResponse);
      }
    } catch (error) {
      console.error('Error in query complexity analysis:', error);
    }

    // Fallback classification
    const wordCount = userQuery.split(/\s+/).length;
    return {
      complexity: wordCount <= 5 ? 'simple' : wordCount <= 15 ? 'moderate' : 'complex',
      recommendedSectionCount: wordCount <= 5 ? 2 : wordCount <= 15 ? 3 : 5,
      queryType: userQuery.includes('šta je') || userQuery.includes('kako') ? 'factual' : 'conceptual',
      searchStrategy: 'Osnovana na broju reči u pitanju'
    };
  }
}

export const tocAIAnalyzer = new TocAIAnalyzer();
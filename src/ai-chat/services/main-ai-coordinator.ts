import { advancedSemanticSearch, SemanticSearchResult, SectionMatch } from './advanced-semantic-search';
import { tocAIAnalyzer, TocSection, SelectedSection } from './toc-ai-analyzer';
import { intelligentContentPipeline, ProcessedContent } from './intelligent-content-pipeline';
import { openai } from '../config/openai-config';

export interface MainAIRequest {
  userQuery: string;
  materialId?: string;
  subjectId?: string;
  
  // Processing preferences
  useSemanticSearch?: boolean; // Default: true
  useTocAnalysis?: boolean; // Default: true
  maxContentLength?: number; // Default: 8000
  responseStyle?: 'concise' | 'detailed' | 'educational'; // Default: 'educational'
  
  // Context preferences  
  includeSourceReferences?: boolean; // Default: true
  includeSectionContext?: boolean; // Default: true
  language?: 'serbian' | 'english'; // Default: 'serbian'
}

export interface ContentSource {
  type: 'semantic_search' | 'toc_analysis' | 'hybrid';
  sections: SectionMatch[] | SelectedSection[];
  confidence: number;
  processingTime: number;
}

export interface MainAIResponse {
  userQuery: string;
  answer: string;
  
  // Source information
  contentSources: ContentSource[];
  materialInfo: {
    materialId: string;
    materialTitle: string;
    subjectName: string;
    totalSectionsUsed: number;
  };
  
  // Processing metadata
  processingInfo: {
    totalProcessingTime: number;
    contentRetrievalTime: number;
    aiGenerationTime: number;
    strategy: 'semantic_only' | 'toc_only' | 'hybrid' | 'fallback';
    tokensUsed?: {
      prompt: number;
      completion: number;
      total: number;
    };
  };
  
  // Quality indicators
  qualityMetrics: {
    confidenceScore: number; // 0-1, how confident we are in the answer
    sourceRelevance: number; // 0-1, how relevant the found content is
    contentCoverage: number; // 0-1, how well the content covers the query
    warnings?: string[];
  };
  
  // References for user
  sourceReferences: Array<{
    sectionTitle: string;
    pageRange: string;
    relevanceScore: number;
    materialTitle: string;
  }>;
  
  success: boolean;
  errorMessage?: string;
}

export class MainAICoordinator {
  private readonly MAIN_AI_MODEL = 'gpt-4o'; // Using GPT-4o for main reasoning
  
  /**
   * Main method that coordinates all AI services to generate a comprehensive answer
   */
  async generateAnswer(request: MainAIRequest): Promise<MainAIResponse> {
    const startTime = Date.now();
    let contentRetrievalTime = 0;
    let aiGenerationTime = 0;
    
    try {
      // Step 1: Determine processing strategy
      const strategy = this.determineProcessingStrategy(request);
      
      // Step 2: Retrieve content using chosen strategy
      const contentStart = Date.now();
      const contentSources = await this.retrieveRelevantContent(request, strategy);
      contentRetrievalTime = Date.now() - contentStart;
      
      if (contentSources.length === 0) {
        return this.buildNoContentResponse(request, startTime);
      }
      
      // Step 3: Prepare content for main AI
      const aiContext = this.prepareAIContext(request, contentSources);
      
      // Step 4: Generate answer using main AI
      const aiStart = Date.now();
      const aiResponse = await this.generateAIResponse(request, aiContext);
      aiGenerationTime = Date.now() - aiStart;
      
      // Step 5: Build comprehensive response
      return this.buildSuccessResponse(
        request,
        aiResponse,
        contentSources,
        {
          totalProcessingTime: Date.now() - startTime,
          contentRetrievalTime,
          aiGenerationTime,
          strategy
        }
      );
      
    } catch (error) {
      console.error('Error in main AI coordinator:', error);
      return this.buildErrorResponse(request, error.message, startTime);
    }
  }

  /**
   * Determine the best processing strategy based on request parameters
   */
  private determineProcessingStrategy(request: MainAIRequest): 'semantic_only' | 'toc_only' | 'hybrid' | 'fallback' {
    // If user explicitly disables one method
    if (request.useSemanticSearch === false && request.useTocAnalysis !== false) {
      return 'toc_only';
    }
    if (request.useTocAnalysis === false && request.useSemanticSearch !== false) {
      return 'semantic_only';
    }
    
    // Default to hybrid approach for best results
    return 'hybrid';
  }

  /**
   * Retrieve relevant content using the chosen strategy
   */
  private async retrieveRelevantContent(
    request: MainAIRequest,
    strategy: string
  ): Promise<ContentSource[]> {
    const contentSources: ContentSource[] = [];
    
    try {
      switch (strategy) {
        case 'semantic_only':
          const semanticResult = await this.performSemanticSearch(request);
          if (semanticResult) {
            contentSources.push(semanticResult);
          }
          break;
          
        case 'toc_only':
          const tocResult = await this.performTocAnalysis(request);
          if (tocResult) {
            contentSources.push(tocResult);
          }
          break;
          
        case 'hybrid':
          // Run both in parallel for best performance
          const [semanticRes, tocRes] = await Promise.allSettled([
            this.performSemanticSearch(request),
            this.performTocAnalysis(request)
          ]);
          
          if (semanticRes.status === 'fulfilled' && semanticRes.value) {
            contentSources.push(semanticRes.value);
          }
          
          if (tocRes.status === 'fulfilled' && tocRes.value) {
            contentSources.push(tocRes.value);
          }
          break;
          
        default:
          // Fallback strategy
          const fallbackResult = await this.performSemanticSearch(request);
          if (fallbackResult) {
            contentSources.push(fallbackResult);
          }
      }
      
    } catch (error) {
      console.error('Error retrieving content:', error);
    }
    
    return contentSources;
  }

  /**
   * Perform semantic search and return as content source
   */
  private async performSemanticSearch(request: MainAIRequest): Promise<ContentSource | null> {
    try {
      const searchResult = await advancedSemanticSearch.searchSimilarSections({
        userQuery: request.userQuery,
        materialId: request.materialId,
        subjectId: request.subjectId,
        maxResults: 2,
        similarityThreshold: 0.3,
        includeContext: request.includeSectionContext !== false
      });
      
      if (searchResult.matchedSections.length === 0) {
        return null;
      }
      
      // Calculate confidence based on similarity scores
      const avgSimilarity = searchResult.matchedSections.reduce(
        (sum, section) => sum + section.similarityScore, 0
      ) / searchResult.matchedSections.length;
      
      return {
        type: 'semantic_search',
        sections: searchResult.matchedSections,
        confidence: avgSimilarity,
        processingTime: searchResult.processingTime
      };
      
    } catch (error) {
      console.error('Error in semantic search:', error);
      return null;
    }
  }

  /**
   * Perform TOC analysis and return as content source
   */
  private async performTocAnalysis(request: MainAIRequest): Promise<ContentSource | null> {
    try {
      // First, get the material's TOC structure
      const processedContent = await intelligentContentPipeline.processContentForQuery({
        userQuery: request.userQuery,
        materialId: request.materialId,
        subjectId: request.subjectId,
        year: 1, // Will be resolved automatically
        maxContentLength: request.maxContentLength || 8000,
        contextStrategy: 'adaptive'
      });
      
      if (!processedContent.success || !processedContent.tocAnalysis) {
        return null;
      }
      
      // Calculate confidence based on AI reasoning confidence
      const confidence = processedContent.tocAnalysis.selectedSections.reduce(
        (sum, section) => sum + section.confidence, 0
      ) / processedContent.tocAnalysis.selectedSections.length;
      
      return {
        type: 'toc_analysis',
        sections: processedContent.tocAnalysis.selectedSections,
        confidence: confidence,
        processingTime: processedContent.processingInfo.executionTime
      };
      
    } catch (error) {
      console.error('Error in TOC analysis:', error);
      return null;
    }
  }

  /**
   * Prepare context for the main AI model
   */
  private prepareAIContext(request: MainAIRequest, contentSources: ContentSource[]): {
    systemPrompt: string;
    userPrompt: string;
    contextLength: number;
  } {
    let combinedContent = '';
    const sourceReferences = [];
    let totalSections = 0;
    
    // Combine content from all sources
    for (const source of contentSources) {
      combinedContent += `\n\n=== ${source.type.toUpperCase()} RESULTS ===\n`;
      
      for (const section of source.sections) {
        if ('content' in section && section.content) {
          // This is a SectionMatch from semantic search
          combinedContent += `\n## ${section.title} (str. ${section.pageStart}-${section.pageEnd})\n`;
          combinedContent += `Relevantnost: ${(section.similarityScore * 100).toFixed(1)}%\n`;
          combinedContent += `${section.content}\n`;
          
          sourceReferences.push({
            title: section.title,
            pageRange: `${section.pageStart}-${section.pageEnd}`,
            relevance: section.similarityScore,
            source: source.type
          });
        } else if ('relevanceReason' in section) {
          // This is a SelectedSection from TOC analysis
          combinedContent += `\n## ${section.title} (str. ${section.pageStart}-${section.pageEnd})\n`;
          combinedContent += `Razlog selekcije: ${section.relevanceReason}\n`;
          combinedContent += `[Sadržaj sekcije bi trebalo da se izvuče iz baze podataka]\n`;
          
          sourceReferences.push({
            title: section.title,
            pageRange: `${section.pageStart}-${section.pageEnd}`,
            relevance: section.confidence,
            source: source.type
          });
        }
        
        totalSections++;
      }
    }

    // Truncate if too long
    const maxLength = request.maxContentLength || 8000;
    if (combinedContent.length > maxLength) {
      combinedContent = combinedContent.substring(0, maxLength - 100) + '\n\n[SADRŽAJ SKRAĆEN...]';
    }

    const systemPrompt = this.buildSystemPrompt(request);
    const userPrompt = this.buildUserPrompt(request, combinedContent, sourceReferences);

    return {
      systemPrompt,
      userPrompt,
      contextLength: combinedContent.length
    };
  }

  /**
   * Build system prompt for the main AI
   */
  private buildSystemPrompt(request: MainAIRequest): string {
    const responseStyle = request.responseStyle || 'educational';
    const language = request.language || 'serbian';
    
    let styleInstructions = '';
    switch (responseStyle) {
      case 'concise':
        styleInstructions = 'Daj kratak, jasan odgovor. Idi direktno na poentu bez dugačkih objašnjenja.';
        break;
      case 'detailed':
        styleInstructions = 'Daj detaljno objašnjenje sa primerima i dodatnim kontekstom gde je to potrebno.';
        break;
      case 'educational':
      default:
        styleInstructions = 'Daj edukacioni odgovor koji pomaže korisniku da razume temu. Koristi jasne objasnjenja i primere.';
    }
    
    return `Ti si ekspertni AI asistent koji pomaže studentima sa akademskim materijalima. Tvoj zadatak je da odgovoriš na korisničko pitanje na osnovu sadržaja iz njihovih udžbenika i skripti.

INSTRUKCIJE:
1. ${styleInstructions}
2. Odgovori na srpskom jeziku koristeći akademski stil prilagođen studentu.
3. Koristi SAMO informacije iz priloženog sadržaja - ne dodavaj spoljašnje znanje.
4. Ako nemaš dovoljno informacija za potpun odgovor, jasno reci šta nedostaje.
5. ${request.includeSourceReferences ? 'Na kraju odgovora uključi reference na sekcije koje si koristio.' : 'Ne navodi reference na sekcije.'}
6. Ako uočiš kontradiktorne informacije između izvora, navedi to.
7. Strukturiraj odgovor logički sa jasnim paragrafima.

KVALITET ODGOVORA:
- Budi precizan i faktičan
- Koristi terminologiju iz priloženog materijala
- Objašnjaj složene koncepte jednostavno
- Daj praktične primere kada je to moguće`;
  }

  /**
   * Build user prompt with context
   */
  private buildUserPrompt(
    request: MainAIRequest,
    content: string,
    references: any[]
  ): string {
    return `KORISNIČKO PITANJE:
${request.userQuery}

RELEVANTNI SADRŽAJ IZ MATERIJALA:
${content}

${references.length > 0 ? `\nDOSTUPNI IZVORI:
${references.map((ref, idx) => `${idx + 1}. ${ref.title} (${ref.pageRange}) - ${ref.source}`).join('\n')}` : ''}

Odgovori na korisničko pitanje koristeći isključivo gore navedeni sadržaj.`;
  }

  /**
   * Generate AI response using the main AI model
   */
  private async generateAIResponse(
    request: MainAIRequest,
    context: { systemPrompt: string; userPrompt: string; contextLength: number }
  ): Promise<{ answer: string; tokensUsed?: any }> {
    try {
      const response = await openai.chat.completions.create({
        model: this.MAIN_AI_MODEL,
        messages: [
          { role: 'system', content: context.systemPrompt },
          { role: 'user', content: context.userPrompt }
        ],
        temperature: 0.3, // Lower temperature for more consistent educational responses
        max_tokens: 2000, // Adjust based on response style
      });

      const answer = response.choices[0]?.message?.content;
      if (!answer) {
        throw new Error('No response generated from AI model');
      }

      return {
        answer,
        tokensUsed: response.usage ? {
          prompt: response.usage.prompt_tokens,
          completion: response.usage.completion_tokens,
          total: response.usage.total_tokens
        } : undefined
      };

    } catch (error) {
      console.error('Error generating AI response:', error);
      throw error;
    }
  }

  /**
   * Build successful response
   */
  private buildSuccessResponse(
    request: MainAIRequest,
    aiResponse: { answer: string; tokensUsed?: any },
    contentSources: ContentSource[],
    processingInfo: any
  ): MainAIResponse {
    // Calculate quality metrics
    const avgConfidence = contentSources.reduce((sum, source) => sum + source.confidence, 0) / contentSources.length;
    const totalSections = contentSources.reduce((sum, source) => sum + source.sections.length, 0);
    
    // Extract source references
    const sourceReferences = [];
    for (const source of contentSources) {
      for (const section of source.sections) {
        if ('title' in section) {
          sourceReferences.push({
            sectionTitle: section.title,
            pageRange: `${section.pageStart}-${section.pageEnd}`,
            relevanceScore: 'similarityScore' in section ? section.similarityScore : 
                           'confidence' in section ? section.confidence : 0,
            materialTitle: 'materialTitle' in section ? section.materialTitle : 'Unknown Material'
          });
        }
      }
    }

    return {
      userQuery: request.userQuery,
      answer: aiResponse.answer,
      contentSources,
      materialInfo: {
        materialId: request.materialId || 'unknown',
        materialTitle: sourceReferences[0]?.materialTitle || 'Unknown Material',
        subjectName: 'Unknown Subject', // Would be filled from database
        totalSectionsUsed: totalSections
      },
      processingInfo: {
        ...processingInfo,
        tokensUsed: aiResponse.tokensUsed
      },
      qualityMetrics: {
        confidenceScore: avgConfidence,
        sourceRelevance: avgConfidence,
        contentCoverage: Math.min(1, totalSections / 3), // Assume 3 sections provide good coverage
      },
      sourceReferences,
      success: true
    };
  }

  /**
   * Build response when no content is found
   */
  private buildNoContentResponse(request: MainAIRequest, startTime: number): MainAIResponse {
    return {
      userQuery: request.userQuery,
      answer: 'Izvinjavam se, nisam mogao da pronađem relevantan sadržaj u dostupnim materijalima za vaše pitanje. Molim vas da reformulišete pitanje ili proverite da li je materijal potpuno učitan i obrađen.',
      contentSources: [],
      materialInfo: {
        materialId: request.materialId || 'unknown',
        materialTitle: 'Unknown Material',
        subjectName: 'Unknown Subject',
        totalSectionsUsed: 0
      },
      processingInfo: {
        totalProcessingTime: Date.now() - startTime,
        contentRetrievalTime: 0,
        aiGenerationTime: 0,
        strategy: 'fallback'
      },
      qualityMetrics: {
        confidenceScore: 0,
        sourceRelevance: 0,
        contentCoverage: 0,
        warnings: ['No relevant content found in available materials']
      },
      sourceReferences: [],
      success: false,
      errorMessage: 'No relevant content found'
    };
  }

  /**
   * Build error response
   */
  private buildErrorResponse(request: MainAIRequest, error: string, startTime: number): MainAIResponse {
    return {
      userQuery: request.userQuery,
      answer: 'Izvinjavam se, došlo je do greške prilikom obrade vašeg pitanja. Molim vas pokušajte ponovo.',
      contentSources: [],
      materialInfo: {
        materialId: request.materialId || 'unknown',
        materialTitle: 'Unknown Material',
        subjectName: 'Unknown Subject',
        totalSectionsUsed: 0
      },
      processingInfo: {
        totalProcessingTime: Date.now() - startTime,
        contentRetrievalTime: 0,
        aiGenerationTime: 0,
        strategy: 'fallback'
      },
      qualityMetrics: {
        confidenceScore: 0,
        sourceRelevance: 0,
        contentCoverage: 0,
        warnings: [error]
      },
      sourceReferences: [],
      success: false,
      errorMessage: error
    };
  }

  /**
   * Quick method for admin panel testing
   */
  async quickAnswer(
    subjectId: string,
    userQuery: string,
    options: {
      useSemanticSearch?: boolean;
      useTocAnalysis?: boolean;
      responseStyle?: 'concise' | 'detailed' | 'educational';
    } = {}
  ): Promise<MainAIResponse> {
    return this.generateAnswer({
      userQuery,
      subjectId,
      useSemanticSearch: options.useSemanticSearch !== false,
      useTocAnalysis: options.useTocAnalysis !== false,
      responseStyle: options.responseStyle || 'educational',
      includeSourceReferences: true,
      includeSectionContext: true
    });
  }
}

export const mainAICoordinator = new MainAICoordinator();
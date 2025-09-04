import { contentRetrievalService } from './content-retrieval';
import { tocAIAnalyzer, TocSection, SectionSelectionRequest } from './toc-ai-analyzer';
import { sectionContentExtractor, SectionContentRequest } from './section-content-extractor';
import { MaterialSearchParams } from './material-finder';

export interface IntelligentContentRequest extends MaterialSearchParams {
  userQuery: string;
  maxContentLength?: number;
  includeFullTOC?: boolean; // Include full TOC for context even when using specific sections
  forceFullMaterial?: boolean; // Skip TOC analysis and use full material
  contextStrategy?: 'focused' | 'comprehensive' | 'adaptive'; // How much context to include
}

export interface ProcessedContent {
  // Original query and material info
  userQuery: string;
  materialInfo: {
    materialId: string;
    materialTitle: string;
    subjectName: string;
    facultyName: string;
    departmentName: string;
    year: number;
  };

  // TOC analysis results
  tocAnalysis?: {
    selectedSections: Array<{
      title: string;
      pageStart: number;
      pageEnd: number;
      relevanceReason: string;
      confidence: number;
    }>;
    aiReasoning: string;
    queryComplexity: string;
    fallbackUsed: boolean;
  };

  // Extracted content ready for main AI
  contentForAI: {
    mainContent: string; // Primary content from selected sections
    structuralContext: string; // TOC and material structure
    contentSummary: string; // Summary of what content was included
    totalLength: number;
    truncated: boolean;
  };

  // Processing metadata
  processingInfo: {
    strategy: 'toc_based' | 'full_material' | 'semantic_search' | 'hybrid';
    sectionsUsed: number;
    executionTime: number;
    warnings?: string[];
  };

  // Status
  success: boolean;
  errorMessage?: string;
}

export class IntelligentContentPipeline {
  
  /**
   * Main method that orchestrates the intelligent content retrieval process
   * This decides whether to use TOC analysis or fall back to other methods
   */
  async processContentForQuery(request: IntelligentContentRequest): Promise<ProcessedContent> {
    const startTime = Date.now();
    
    try {
      // Step 1: Get basic material and subject information
      const materialInfo = await this.getMaterialInfo(request);
      
      if (!materialInfo.success) {
        return this.buildErrorResponse(request.userQuery, materialInfo.error!, startTime);
      }

      // Step 2: Decide on processing strategy
      const strategy = await this.determineProcessingStrategy(request, materialInfo.data!);
      
      // Step 3: Process content based on strategy
      let processedContent: ProcessedContent;
      
      switch (strategy) {
        case 'toc_based':
          processedContent = await this.processTOCBasedContent(request, materialInfo.data!, startTime);
          break;
          
        case 'full_material':
          processedContent = await this.processFullMaterialContent(request, materialInfo.data!, startTime);
          break;
          
        case 'semantic_search':
          processedContent = await this.processSemanticSearchContent(request, materialInfo.data!, startTime);
          break;
          
        case 'hybrid':
          processedContent = await this.processHybridContent(request, materialInfo.data!, startTime);
          break;
          
        default:
          processedContent = await this.processTOCBasedContent(request, materialInfo.data!, startTime);
      }

      return processedContent;

    } catch (error) {
      console.error('Error in intelligent content pipeline:', error);
      return this.buildErrorResponse(request.userQuery, `Pipeline error: ${error.message}`, startTime);
    }
  }

  /**
   * Get material information and check availability
   */
  private async getMaterialInfo(request: IntelligentContentRequest): Promise<{
    success: boolean;
    data?: any;
    error?: string;
  }> {
    try {
      const contentResult = await contentRetrievalService.retrieveContent({
        ...request,
        includeTocContext: true,
        maxContextLength: 1000 // Just for material info, not full content
      });

      if (contentResult.status !== 'success') {
        return {
          success: false,
          error: contentResult.message || 'Could not retrieve material information'
        };
      }

      return {
        success: true,
        data: {
          materialId: contentResult.materials[0]?.materialId,
          materialTitle: contentResult.materials[0]?.title,
          subjectInfo: contentResult.subjectInfo,
          tocContext: contentResult.tocContext,
          hasReadyMaterials: contentResult.subjectInfo.readyMaterials > 0
        }
      };

    } catch (error) {
      return {
        success: false,
        error: `Failed to get material info: ${error.message}`
      };
    }
  }

  /**
   * Determine the best processing strategy based on request and material state
   */
  private async determineProcessingStrategy(
    request: IntelligentContentRequest,
    materialInfo: any
  ): Promise<'toc_based' | 'full_material' | 'semantic_search' | 'hybrid'> {
    
    // Force full material if requested
    if (request.forceFullMaterial) {
      return 'full_material';
    }

    // Check if TOC is available and useful
    if (!materialInfo.tocContext || materialInfo.tocContext.totalSections === 0) {
      return 'semantic_search'; // No TOC available, use semantic search
    }

    // Analyze query complexity
    try {
      const complexity = await tocAIAnalyzer.getQueryComplexityAnalysis(request.userQuery);
      
      // Simple queries can benefit from focused TOC analysis
      if (complexity.complexity === 'simple' && materialInfo.tocContext.totalSections > 5) {
        return 'toc_based';
      }
      
      // Complex queries might need hybrid approach
      if (complexity.complexity === 'complex' && request.contextStrategy === 'comprehensive') {
        return 'hybrid';
      }
      
    } catch (error) {
      console.warn('Could not analyze query complexity, defaulting to TOC-based approach');
    }

    // Default to TOC-based if TOC is available
    return materialInfo.tocContext.totalSections > 0 ? 'toc_based' : 'semantic_search';
  }

  /**
   * Process content using TOC-based intelligent section selection
   */
  private async processTOCBasedContent(
    request: IntelligentContentRequest,
    materialInfo: any,
    startTime: number
  ): Promise<ProcessedContent> {
    try {
      // Step 1: Convert TOC format for AI analyzer
      const tocSections: TocSection[] = materialInfo.tocContext.keyTopics.map((topic: string, index: number) => ({
        title: topic,
        cleanTitle: topic,
        level: 1, // Simplified for now - would need proper TOC structure
        pageStart: index * 10 + 1, // Placeholder - would need real page info
        pageEnd: index * 10 + 10,
        semanticType: 'section'
      }));

      // For now, get proper TOC from the material
      // TODO: This should use the actual TOC from TocAnalysis collection
      const tocRequest: SectionSelectionRequest = {
        userQuery: request.userQuery,
        materialTitle: materialInfo.materialTitle,
        tocSections: tocSections, // This should come from proper TOC extraction
        maxSections: 5
      };

      // Step 2: Use AI to select relevant sections
      const sectionSelection = await tocAIAnalyzer.selectRelevantSections(tocRequest);

      if (sectionSelection.fallbackToFullMaterial) {
        // AI couldn't identify specific sections, use full material approach
        return this.processFullMaterialContent(request, materialInfo, startTime);
      }

      // Step 3: Extract content from selected sections
      const extractionRequest: SectionContentRequest = {
        materialId: materialInfo.materialId,
        selectedSections: sectionSelection.selectedSections,
        includeChunks: true,
        maxContentLength: request.maxContentLength || 6000
      };

      const extractedContent = await sectionContentExtractor.extractSectionContent(extractionRequest);

      // Step 4: Build final content for AI
      const mainContent = extractedContent.extractedContent
        .map(section => `## ${section.title} (str. ${section.pageStart}-${section.pageEnd})\n${section.content}`)
        .join('\n\n');

      const structuralContext = request.includeFullTOC ? 
        `STRUKTURA MATERIJALA:\n${materialInfo.tocContext.structure}\n\n` : '';

      const contentSummary = `Analiziran je sadržaj ${extractedContent.sectionsFound} sekcija od ukupno ${extractedContent.totalSectionsRequested} traženih. ` +
        `Razlog selekcije: ${sectionSelection.reasoning}`;

      const executionTime = Date.now() - startTime;

      return {
        userQuery: request.userQuery,
        materialInfo: {
          materialId: materialInfo.materialId,
          materialTitle: materialInfo.materialTitle,
          subjectName: materialInfo.subjectInfo.subjectName,
          facultyName: materialInfo.subjectInfo.facultyName,
          departmentName: materialInfo.subjectInfo.departmentName,
          year: materialInfo.subjectInfo.year
        },
        tocAnalysis: {
          selectedSections: sectionSelection.selectedSections.map(section => ({
            title: section.title,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            relevanceReason: section.relevanceReason,
            confidence: section.confidence
          })),
          aiReasoning: sectionSelection.reasoning,
          queryComplexity: 'analyzed', // Would come from complexity analysis
          fallbackUsed: false
        },
        contentForAI: {
          mainContent: structuralContext + mainContent,
          structuralContext,
          contentSummary,
          totalLength: mainContent.length + structuralContext.length,
          truncated: extractedContent.truncated
        },
        processingInfo: {
          strategy: 'toc_based',
          sectionsUsed: extractedContent.sectionsFound,
          executionTime,
          warnings: extractedContent.missingContent ? 
            extractedContent.missingContent.map(mc => `Missing: ${mc.sectionTitle} - ${mc.reason}`) : 
            undefined
        },
        success: true
      };

    } catch (error) {
      console.error('Error in TOC-based processing:', error);
      return this.buildErrorResponse(request.userQuery, `TOC processing failed: ${error.message}`, startTime);
    }
  }

  /**
   * Process content using full material (when TOC analysis fails or is not available)
   */
  private async processFullMaterialContent(
    request: IntelligentContentRequest,
    materialInfo: any,
    startTime: number
  ): Promise<ProcessedContent> {
    try {
      // Use the existing content retrieval service for full material processing
      const contentResult = await contentRetrievalService.retrieveContent({
        ...request,
        includeTocContext: true,
        maxContextLength: request.maxContentLength || 6000
      });

      const executionTime = Date.now() - startTime;

      return {
        userQuery: request.userQuery,
        materialInfo: {
          materialId: materialInfo.materialId,
          materialTitle: materialInfo.materialTitle,
          subjectName: materialInfo.subjectInfo.subjectName,
          facultyName: materialInfo.subjectInfo.facultyName,
          departmentName: materialInfo.subjectInfo.departmentName,
          year: materialInfo.subjectInfo.year
        },
        contentForAI: {
          mainContent: contentResult.aiContext.relevantContent.map(content => 
            `## ${content.title}\n${content.content}`
          ).join('\n\n'),
          structuralContext: contentResult.aiContext.materialStructure || '',
          contentSummary: contentResult.aiContext.contextSummary,
          totalLength: contentResult.aiContext.totalCharacters,
          truncated: contentResult.aiContext.totalCharacters >= (request.maxContentLength || 6000)
        },
        processingInfo: {
          strategy: 'full_material',
          sectionsUsed: contentResult.aiContext.relevantContent.length,
          executionTime
        },
        success: true
      };

    } catch (error) {
      console.error('Error in full material processing:', error);
      return this.buildErrorResponse(request.userQuery, `Full material processing failed: ${error.message}`, startTime);
    }
  }

  /**
   * Process content using semantic search (when TOC is not available)
   */
  private async processSemanticSearchContent(
    request: IntelligentContentRequest,
    materialInfo: any,
    startTime: number
  ): Promise<ProcessedContent> {
    try {
      // Use semantic search through existing content retrieval service
      const contentResult = await contentRetrievalService.retrieveContent({
        ...request,
        query: request.userQuery,
        maxContextLength: request.maxContentLength || 6000,
        searchOptions: {
          maxResults: 8,
          includeContent: true
        }
      });

      const executionTime = Date.now() - startTime;

      return {
        userQuery: request.userQuery,
        materialInfo: {
          materialId: materialInfo.materialId,
          materialTitle: materialInfo.materialTitle,
          subjectName: materialInfo.subjectInfo.subjectName,
          facultyName: materialInfo.subjectInfo.facultyName,
          departmentName: materialInfo.subjectInfo.departmentName,
          year: materialInfo.subjectInfo.year
        },
        contentForAI: {
          mainContent: contentResult.aiContext.relevantContent.map(content => 
            `## ${content.title} (Relevance: ${content.relevance})\n${content.content}`
          ).join('\n\n'),
          structuralContext: contentResult.aiContext.materialStructure || '',
          contentSummary: contentResult.aiContext.contextSummary,
          totalLength: contentResult.aiContext.totalCharacters,
          truncated: contentResult.aiContext.totalCharacters >= (request.maxContentLength || 6000)
        },
        processingInfo: {
          strategy: 'semantic_search',
          sectionsUsed: contentResult.aiContext.relevantContent.length,
          executionTime,
          warnings: contentResult.searchResults?.suggestions ? 
            [`Search suggestions: ${contentResult.searchResults.suggestions.join(', ')}`] : 
            undefined
        },
        success: true
      };

    } catch (error) {
      console.error('Error in semantic search processing:', error);
      return this.buildErrorResponse(request.userQuery, `Semantic search processing failed: ${error.message}`, startTime);
    }
  }

  /**
   * Process content using hybrid approach (combines TOC analysis with semantic search)
   */
  private async processHybridContent(
    request: IntelligentContentRequest,
    materialInfo: any,
    startTime: number
  ): Promise<ProcessedContent> {
    try {
      // For now, delegate to TOC-based approach with fallback
      // TODO: Implement true hybrid approach that combines both methods
      const tocResult = await this.processTOCBasedContent(request, materialInfo, startTime);
      
      if (!tocResult.success) {
        return this.processSemanticSearchContent(request, materialInfo, startTime);
      }

      // Mark as hybrid strategy
      tocResult.processingInfo.strategy = 'hybrid';
      return tocResult;

    } catch (error) {
      console.error('Error in hybrid processing:', error);
      return this.buildErrorResponse(request.userQuery, `Hybrid processing failed: ${error.message}`, startTime);
    }
  }

  /**
   * Build error response
   */
  private buildErrorResponse(userQuery: string, errorMessage: string, startTime: number): ProcessedContent {
    return {
      userQuery,
      materialInfo: {
        materialId: '',
        materialTitle: 'Unknown',
        subjectName: 'Unknown',
        facultyName: 'Unknown',
        departmentName: 'Unknown',
        year: 0
      },
      contentForAI: {
        mainContent: '',
        structuralContext: '',
        contentSummary: `Error: ${errorMessage}`,
        totalLength: 0,
        truncated: false
      },
      processingInfo: {
        strategy: 'toc_based',
        sectionsUsed: 0,
        executionTime: Date.now() - startTime,
        warnings: [errorMessage]
      },
      success: false,
      errorMessage
    };
  }

  /**
   * Quick method for admin panel testing
   */
  async quickProcessForTesting(
    subjectId: string,
    userQuery: string,
    strategy: 'toc_based' | 'full_material' | 'semantic_search' = 'toc_based'
  ): Promise<ProcessedContent> {
    return this.processContentForQuery({
      subjectId,
      userQuery,
      year: 1, // Placeholder, will be resolved from subject
      maxContentLength: 5000,
      forceFullMaterial: strategy === 'full_material',
      contextStrategy: 'adaptive'
    });
  }
}

export const intelligentContentPipeline = new IntelligentContentPipeline();
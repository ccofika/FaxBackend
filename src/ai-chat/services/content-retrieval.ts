import { MaterialFinder, MaterialSearchParams, SubjectMaterials } from './material-finder';
import { TocExtractor, TocExtractionResult } from './toc-extractor';
import { SemanticSearchService, SemanticSearchOptions, SemanticSearchResult } from './semantic-search';

export interface ContentRetrievalParams extends MaterialSearchParams {
  query?: string; // User's question or search query
  searchOptions?: SemanticSearchOptions;
  includeTocContext?: boolean; // Whether to include ToC structure in response
  maxContextLength?: number; // Maximum characters for AI context
}

export interface ContentRetrievalResult {
  // Subject and material information
  subjectInfo: {
    subjectId: string;
    subjectName: string;
    facultyName: string;
    departmentName: string;
    year: number;
    totalMaterials: number;
    readyMaterials: number;
  };
  
  // Available materials
  materials: Array<{
    materialId: string;
    title: string;
    status: string;
    hasToC: boolean;
    sectionsCount?: number;
  }>;

  // Table of Contents context (when requested)
  tocContext?: {
    materialId: string;
    materialTitle: string;
    structure: string;
    keyTopics: string[];
    totalSections: number;
  };

  // Search results (when query is provided)
  searchResults?: SemanticSearchResult;

  // AI-ready context
  aiContext: {
    contextSummary: string;
    relevantContent: Array<{
      title: string;
      content: string;
      source: string;
      relevance?: number;
    }>;
    materialStructure?: string;
    totalCharacters: number;
  };

  // Processing status
  status: 'success' | 'no_materials' | 'materials_not_ready' | 'no_search_results';
  message?: string;
}

export class ContentRetrievalService {
  private materialFinder: MaterialFinder;
  private tocExtractor: TocExtractor;
  private semanticSearch: SemanticSearchService;

  constructor() {
    this.materialFinder = new MaterialFinder();
    this.tocExtractor = new TocExtractor();
    this.semanticSearch = new SemanticSearchService();
  }

  /**
   * Main method to retrieve content for AI processing
   * This orchestrates the entire process of finding materials, extracting ToC, and performing search
   */
  async retrieveContent(params: ContentRetrievalParams): Promise<ContentRetrievalResult> {
    try {
      // Step 1: Find materials for the given subject/faculty/department/year
      const subjectMaterials = await this.materialFinder.findMaterials(params);
      
      if (!subjectMaterials) {
        return {
          subjectInfo: {
            subjectId: '',
            subjectName: 'Unknown',
            facultyName: 'Unknown',
            departmentName: 'Unknown',
            year: params.year,
            totalMaterials: 0,
            readyMaterials: 0
          },
          materials: [],
          aiContext: {
            contextSummary: 'No materials found for the specified parameters.',
            relevantContent: [],
            totalCharacters: 0
          },
          status: 'no_materials',
          message: 'Could not find any materials for the specified faculty, department, year, and subject combination.'
        };
      }

      // Step 2: Check if materials are ready for processing
      if (subjectMaterials.readyMaterials === 0) {
        return {
          subjectInfo: {
            subjectId: subjectMaterials.subjectId,
            subjectName: subjectMaterials.subjectName,
            facultyName: subjectMaterials.facultyName,
            departmentName: subjectMaterials.departmentName,
            year: subjectMaterials.year,
            totalMaterials: subjectMaterials.totalMaterials,
            readyMaterials: subjectMaterials.readyMaterials
          },
          materials: subjectMaterials.materials.map(m => ({
            materialId: m.materialId,
            title: m.title,
            status: m.status,
            hasToC: m.hasToC,
            sectionsCount: m.sectionsCount
          })),
          aiContext: {
            contextSummary: 'Materials found but none are ready for search yet. Please wait for processing to complete.',
            relevantContent: [],
            totalCharacters: 0
          },
          status: 'materials_not_ready',
          message: `Found ${subjectMaterials.totalMaterials} materials, but they are still being processed. Please try again later.`
        };
      }

      // Step 3: Get ToC context for the primary material (for now, assuming single material)
      // TODO: Modify this when handling multiple materials per subject
      const primaryMaterial = subjectMaterials.materials.find(m => m.status === 'ready' || m.status === 'toc_ready');
      let tocContext: any = undefined;
      
      if (primaryMaterial && (params.includeTocContext || !params.query)) {
        try {
          const tocSummary = await this.tocExtractor.getTocSummaryForAI(primaryMaterial.materialId, 2);
          tocContext = {
            materialId: primaryMaterial.materialId,
            materialTitle: tocSummary.materialTitle,
            structure: tocSummary.structure,
            keyTopics: tocSummary.keyTopics,
            totalSections: tocSummary.totalSections
          };
        } catch (error) {
          console.error('Error getting ToC context:', error);
          // Continue without ToC context
        }
      }

      // Step 4: Perform semantic search if query is provided
      let searchResults: SemanticSearchResult | undefined = undefined;
      
      if (params.query && params.query.trim().length > 0) {
        try {
          searchResults = await this.semanticSearch.searchInSubject(
            subjectMaterials.subjectId,
            params.query,
            params.searchOptions || {}
          );

          if (searchResults.totalResults === 0) {
            return {
              subjectInfo: {
                subjectId: subjectMaterials.subjectId,
                subjectName: subjectMaterials.subjectName,
                facultyName: subjectMaterials.facultyName,
                departmentName: subjectMaterials.departmentName,
                year: subjectMaterials.year,
                totalMaterials: subjectMaterials.totalMaterials,
                readyMaterials: subjectMaterials.readyMaterials
              },
              materials: subjectMaterials.materials.map(m => ({
                materialId: m.materialId,
                title: m.title,
                status: m.status,
                hasToC: m.hasToC,
                sectionsCount: m.sectionsCount
              })),
              tocContext,
              searchResults,
              aiContext: {
                contextSummary: `No relevant content found for query: "${params.query}". ${tocContext ? 'Material structure is available for general questions.' : ''}`,
                relevantContent: [],
                materialStructure: tocContext?.structure,
                totalCharacters: tocContext?.structure?.length || 0
              },
              status: 'no_search_results',
              message: `No relevant content found for your query. ${searchResults.suggestions ? `Suggestions: ${searchResults.suggestions.join(', ')}` : ''}`
            };
          }
        } catch (error) {
          console.error('Error performing semantic search:', error);
          // Continue without search results, may still provide ToC context
        }
      }

      // Step 5: Build AI context
      const aiContext = await this.buildAIContext(
        subjectMaterials,
        tocContext,
        searchResults,
        params.maxContextLength || 4000
      );

      return {
        subjectInfo: {
          subjectId: subjectMaterials.subjectId,
          subjectName: subjectMaterials.subjectName,
          facultyName: subjectMaterials.facultyName,
          departmentName: subjectMaterials.departmentName,
          year: subjectMaterials.year,
          totalMaterials: subjectMaterials.totalMaterials,
          readyMaterials: subjectMaterials.readyMaterials
        },
        materials: subjectMaterials.materials.map(m => ({
          materialId: m.materialId,
          title: m.title,
          status: m.status,
          hasToC: m.hasToC,
          sectionsCount: m.sectionsCount
        })),
        tocContext,
        searchResults,
        aiContext,
        status: 'success'
      };

    } catch (error) {
      console.error('Error in content retrieval:', error);
      throw error;
    }
  }

  /**
   * Quick retrieval for admin panel testing
   * Simplified version for testing the system
   */
  async quickRetrieveForTesting(
    subjectId: string, 
    query?: string
  ): Promise<ContentRetrievalResult> {
    try {
      const subjectMaterials = await this.materialFinder.findMaterialsBySubjectId(subjectId);
      
      if (!subjectMaterials) {
        throw new Error(`Subject not found: ${subjectId}`);
      }

      return this.retrieveContent({
        subjectId,
        year: subjectMaterials.year,
        query,
        includeTocContext: true,
        maxContextLength: 3000,
        searchOptions: {
          maxResults: 5,
          includeContent: true
        }
      });

    } catch (error) {
      console.error('Error in quick retrieve for testing:', error);
      throw error;
    }
  }

  /**
   * Build AI-ready context from all available information
   */
  private async buildAIContext(
    subjectMaterials: SubjectMaterials,
    tocContext: any,
    searchResults?: SemanticSearchResult,
    maxLength: number = 4000
  ): Promise<{
    contextSummary: string;
    relevantContent: Array<{
      title: string;
      content: string;
      source: string;
      relevance?: number;
    }>;
    materialStructure?: string;
    totalCharacters: number;
  }> {
    const relevantContent: Array<{
      title: string;
      content: string;
      source: string;
      relevance?: number;
    }> = [];

    let totalChars = 0;
    let contextSummary = '';

    // Add search results first (highest priority)
    if (searchResults && searchResults.results.length > 0) {
      contextSummary = `Found ${searchResults.totalResults} relevant sections for query: "${searchResults.query}". `;
      
      for (const result of searchResults.results) {
        if (totalChars >= maxLength * 0.8) break; // Reserve 20% for structure
        
        const contentToAdd = result.content.substring(0, Math.min(800, maxLength - totalChars));
        
        relevantContent.push({
          title: result.title,
          content: contentToAdd,
          source: `${result.materialTitle}, ${result.path}, Page ${result.pageStart}`,
          relevance: Math.round(result.relevanceScore * 10) / 10
        });
        
        totalChars += contentToAdd.length;
      }
    }

    // Add ToC structure if there's space and it's available
    let materialStructure: string | undefined = undefined;
    if (tocContext && totalChars < maxLength * 0.9) {
      materialStructure = tocContext.structure.substring(0, maxLength - totalChars);
      totalChars += materialStructure?.length || 0;
      
      if (!contextSummary) {
        contextSummary = `Material structure available for ${tocContext.materialTitle} with ${tocContext.totalSections} sections. Key topics: ${tocContext.keyTopics.slice(0, 5).join(', ')}.`;
      }
    }

    // Default context if nothing else is available
    if (!contextSummary) {
      contextSummary = `Subject: ${subjectMaterials.subjectName} (${subjectMaterials.facultyName}, ${subjectMaterials.departmentName}, Year ${subjectMaterials.year}). ${subjectMaterials.readyMaterials}/${subjectMaterials.totalMaterials} materials ready.`;
    }

    return {
      contextSummary,
      relevantContent,
      materialStructure,
      totalCharacters: totalChars
    };
  }

  /**
   * Get available subjects for admin panel dropdown
   * TODO: This will be useful for the admin panel UI
   */
  async getAvailableSubjectsForAdmin(facultyId: string, departmentId: string, year: number): Promise<Array<{
    subjectId: string;
    subjectName: string;
    materialsCount: number;
    readyMaterialsCount: number;
  }>> {
    return this.materialFinder.getAvailableSubjects(facultyId, departmentId, year);
  }
}

export const contentRetrievalService = new ContentRetrievalService();
import mongoose from 'mongoose';
import DocumentSection from '../../models/DocumentSection';
import DocumentChunk from '../../models/DocumentChunk';
import Material from '../../models/Material';

export interface SemanticSearchOptions {
  maxResults?: number;
  minRelevanceScore?: number;
  includeContent?: boolean;
  preferredLevels?: number[]; // e.g., [1, 2] to prefer chapters and major sections
  semanticTypes?: Array<'chapter' | 'section' | 'subsection' | 'paragraph'>;
  pageRange?: {
    start: number;
    end: number;
  };
}

export interface SearchResult {
  type: 'section' | 'chunk';
  id: string;
  materialId: string;
  materialTitle: string;
  title: string;
  content: string;
  relevanceScore: number;
  pageStart: number;
  pageEnd?: number;
  path: string;
  level?: number;
  semanticType?: string;
  contentPreview: string;
  chunkInfo?: {
    sectionId: string;
    chunkId: string;
    paragraphIdx: number;
  };
  sectionInfo?: {
    sectionId: string;
    parentSectionId?: string;
    totalParts?: number;
    partNumber?: number;
  };
}

export interface SemanticSearchResult {
  query: string;
  totalResults: number;
  results: SearchResult[];
  materialsSearched: string[];
  searchStrategy: 'text_only' | 'semantic_ready' | 'hybrid';
  suggestions?: string[];
}

export class SemanticSearchService {
  
  /**
   * Perform semantic search within materials for a specific subject
   * Currently uses text-based search, ready to be upgraded to vector search
   */
  async searchInSubject(
    subjectId: string, 
    query: string, 
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult> {
    try {
      const {
        maxResults = 10,
        minRelevanceScore = 0.1,
        includeContent = true,
        preferredLevels,
        semanticTypes,
        pageRange
      } = options;

      // Find all ready materials in the subject
      const materials = await Material.find({
        subjectId,
        status: { $in: ['ready', 'toc_ready'] }
      })
      .select('_id title')
      .lean();

      if (materials.length === 0) {
        return {
          query,
          totalResults: 0,
          results: [],
          materialsSearched: [],
          searchStrategy: 'text_only',
          suggestions: ['No materials are ready for search in this subject.']
        };
      }

      const materialIds = materials.map(m => m._id.toString());
      const materialTitles = new Map(materials.map(m => [m._id.toString(), m.title]));

      // Search in sections first (usually more structured and relevant)
      const sectionResults = await this.searchInSections(materialIds, query, {
        ...options,
        maxResults: Math.ceil(maxResults * 0.7) // 70% of results from sections
      });

      // Search in chunks for more detailed content
      const chunkResults = await this.searchInChunks(materialIds, query, {
        ...options,
        maxResults: Math.ceil(maxResults * 0.3) // 30% of results from chunks
      });

      // Combine and rank results
      const allResults = [...sectionResults, ...chunkResults];
      
      // Add material titles to results
      const enrichedResults = allResults.map(result => ({
        ...result,
        materialTitle: materialTitles.get(result.materialId) || 'Unknown Material'
      }));

      // Sort by relevance score
      enrichedResults.sort((a, b) => b.relevanceScore - a.relevanceScore);

      // Apply final filtering
      const filteredResults = enrichedResults
        .filter(result => result.relevanceScore >= minRelevanceScore)
        .slice(0, maxResults);

      // Generate suggestions for better search
      const suggestions = this.generateSearchSuggestions(query, filteredResults);

      return {
        query,
        totalResults: filteredResults.length,
        results: filteredResults,
        materialsSearched: materialIds,
        searchStrategy: 'text_only', // TODO: Change to 'semantic_ready' or 'hybrid' when vector search is implemented
        suggestions: suggestions.length > 0 ? suggestions : undefined
      };

    } catch (error) {
      console.error('Error in semantic search:', error);
      throw error;
    }
  }

  /**
   * Search within specific material
   * TODO: This can be used when user wants to focus on a specific document
   */
  async searchInMaterial(
    materialId: string, 
    query: string, 
    options: SemanticSearchOptions = {}
  ): Promise<SemanticSearchResult> {
    try {
      const material = await Material.findById(materialId).select('title subjectId').lean();
      if (!material) {
        throw new Error(`Material not found: ${materialId}`);
      }

      return this.searchInSubject(material.subjectId.toString(), query, {
        ...options,
        // Filter to only this material by using material-specific search
      });

    } catch (error) {
      console.error('Error searching in material:', error);
      throw error;
    }
  }

  /**
   * Search within document sections
   */
  private async searchInSections(
    materialIds: string[], 
    query: string, 
    options: SemanticSearchOptions
  ): Promise<SearchResult[]> {
    try {
      // Build MongoDB query
      const searchQuery: any = {
        docId: { $in: materialIds.map(id => new mongoose.Types.ObjectId(id)) }
      };

      // Apply filters
      if (options.preferredLevels && options.preferredLevels.length > 0) {
        searchQuery.level = { $in: options.preferredLevels };
      }

      if (options.semanticTypes && options.semanticTypes.length > 0) {
        searchQuery.semanticType = { $in: options.semanticTypes };
      }

      if (options.pageRange) {
        searchQuery.$and = [
          { pageStart: { $gte: options.pageRange.start } },
          { pageEnd: { $lte: options.pageRange.end } }
        ];
      }

      // Use text search if available, otherwise use regex
      const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
      
      // For now, use simple text matching
      // TODO: Replace with vector similarity search when embeddings are available
      const orConditions = queryWords.map(word => ({
        $or: [
          { title: { $regex: word, $options: 'i' } },
          { content: { $regex: word, $options: 'i' } },
          { shortAbstract: { $regex: word, $options: 'i' } },
          { keywords: { $elemMatch: { $regex: word, $options: 'i' } } }
        ]
      }));

      if (orConditions.length > 0) {
        searchQuery.$and = searchQuery.$and || [];
        searchQuery.$and.push({ $or: orConditions });
      }

      const sections = await DocumentSection.find(searchQuery)
        .sort({ level: 1, pageStart: 1 })
        .limit(options.maxResults || 10)
        .lean();

      const results: SearchResult[] = [];

      for (const section of sections) {
        const relevanceScore = this.calculateTextRelevanceScore(
          query, 
          section.title, 
          section.content || '', 
          section.shortAbstract || ''
        );

        if (relevanceScore > (options.minRelevanceScore || 0)) {
          results.push({
            type: 'section',
            id: section._id.toString(),
            materialId: section.docId.toString(),
            materialTitle: '', // Will be filled later
            title: section.title,
            content: section.content || '',
            relevanceScore,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            path: section.path,
            level: section.level,
            semanticType: section.semanticType,
            contentPreview: this.generateContentPreview(section.content || '', query, 200),
            sectionInfo: {
              sectionId: section.sectionId,
              parentSectionId: section.parentSectionId,
              totalParts: section.totalParts,
              partNumber: section.partNumber
            }
          });
        }
      }

      return results;

    } catch (error) {
      console.error('Error searching in sections:', error);
      return [];
    }
  }

  /**
   * Search within document chunks for more granular results
   */
  private async searchInChunks(
    materialIds: string[], 
    query: string, 
    options: SemanticSearchOptions
  ): Promise<SearchResult[]> {
    try {
      const searchQuery: any = {
        docId: { $in: materialIds.map(id => new mongoose.Types.ObjectId(id)) }
      };

      if (options.pageRange) {
        searchQuery.page = { 
          $gte: options.pageRange.start, 
          $lte: options.pageRange.end 
        };
      }

      // Simple text search in chunks
      const queryWords = query.toLowerCase().split(/\s+/).filter(word => word.length > 2);
      
      const orConditions = queryWords.map(word => ({
        $or: [
          { title: { $regex: word, $options: 'i' } },
          { content: { $regex: word, $options: 'i' } }
        ]
      }));

      if (orConditions.length > 0) {
        searchQuery.$and = orConditions;
      }

      const chunks = await DocumentChunk.find(searchQuery)
        .sort({ page: 1, paragraphIdx: 1 })
        .limit(options.maxResults || 5)
        .lean();

      const results: SearchResult[] = [];

      for (const chunk of chunks) {
        const relevanceScore = this.calculateTextRelevanceScore(
          query, 
          chunk.title || '', 
          chunk.content
        );

        if (relevanceScore > (options.minRelevanceScore || 0)) {
          results.push({
            type: 'chunk',
            id: chunk._id.toString(),
            materialId: chunk.docId.toString(),
            materialTitle: '', // Will be filled later
            title: chunk.title || `Paragraph ${chunk.paragraphIdx + 1}`,
            content: chunk.content,
            relevanceScore: relevanceScore * 0.8, // Slightly lower priority than sections
            pageStart: chunk.page,
            path: chunk.path,
            contentPreview: this.generateContentPreview(chunk.content, query, 150),
            chunkInfo: {
              sectionId: chunk.sectionId,
              chunkId: chunk.chunkId,
              paragraphIdx: chunk.paragraphIdx
            }
          });
        }
      }

      return results;

    } catch (error) {
      console.error('Error searching in chunks:', error);
      return [];
    }
  }

  /**
   * Calculate text-based relevance score
   * TODO: Replace with proper semantic similarity when vector search is implemented
   */
  private calculateTextRelevanceScore(
    query: string, 
    title: string, 
    content: string, 
    abstract?: string
  ): number {
    const queryLower = query.toLowerCase();
    const titleLower = title.toLowerCase();
    const contentLower = content.toLowerCase();
    const abstractLower = abstract?.toLowerCase() || '';

    let score = 0;

    // Exact phrase match (highest score)
    if (titleLower.includes(queryLower)) score += 10;
    if (contentLower.includes(queryLower)) score += 8;
    if (abstractLower.includes(queryLower)) score += 6;

    // Individual word matches
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
    
    for (const word of queryWords) {
      if (titleLower.includes(word)) score += 3;
      if (contentLower.includes(word)) score += 1;
      if (abstractLower.includes(word)) score += 2;
    }

    // Normalize score based on content length
    const contentLength = content.length;
    if (contentLength > 0) {
      score = score / Math.log(contentLength / 100 + 1);
    }

    return Math.min(score, 20); // Cap at 20 for normalization
  }

  /**
   * Generate content preview with highlighted query terms
   */
  private generateContentPreview(content: string, query: string, maxLength: number = 200): string {
    if (!content) return '';
    
    const queryLower = query.toLowerCase();
    const contentLower = content.toLowerCase();
    
    // Find the first occurrence of any query word
    const queryWords = queryLower.split(/\s+/).filter(word => word.length > 2);
    let firstIndex = content.length;
    
    for (const word of queryWords) {
      const index = contentLower.indexOf(word);
      if (index !== -1 && index < firstIndex) {
        firstIndex = index;
      }
    }

    // Extract preview around the first match
    const start = Math.max(0, firstIndex - 50);
    const end = Math.min(content.length, start + maxLength);
    let preview = content.substring(start, end);

    // Clean up the preview
    if (start > 0) preview = '...' + preview;
    if (end < content.length) preview = preview + '...';

    return preview.trim();
  }

  /**
   * Generate search suggestions based on results
   */
  private generateSearchSuggestions(query: string, results: SearchResult[]): string[] {
    const suggestions: string[] = [];

    if (results.length === 0) {
      suggestions.push('Try using different keywords or synonyms');
      suggestions.push('Check if the material has been fully processed');
    } else if (results.length < 3) {
      suggestions.push('Try broader search terms to find more results');
      
      // Suggest related topics from section titles
      const relatedTopics = results
        .map(r => r.title)
        .filter(title => !title.toLowerCase().includes(query.toLowerCase()))
        .slice(0, 2);
      
      if (relatedTopics.length > 0) {
        suggestions.push(`Related topics you might search: ${relatedTopics.join(', ')}`);
      }
    }

    return suggestions;
  }

  /**
   * Get search context for AI model
   * This prepares the search results in a format suitable for AI processing
   */
  async getSearchContextForAI(searchResult: SemanticSearchResult): Promise<{
    query: string;
    contextSummary: string;
    relevantSections: Array<{
      title: string;
      content: string;
      source: string;
      relevance: number;
    }>;
    totalSources: number;
  }> {
    try {
      const relevantSections = searchResult.results.map(result => ({
        title: result.title,
        content: result.type === 'section' ? 
          result.content.substring(0, 1000) + (result.content.length > 1000 ? '...' : '') :
          result.content,
        source: `${result.materialTitle}, ${result.path}, Page ${result.pageStart}${result.pageEnd ? `-${result.pageEnd}` : ''}`,
        relevance: Math.round(result.relevanceScore * 10) / 10
      }));

      const contextSummary = `Found ${searchResult.totalResults} relevant sections across ${searchResult.materialsSearched.length} materials. ` +
        `Search strategy: ${searchResult.searchStrategy}. ` +
        `Top results cover: ${relevantSections.slice(0, 3).map(s => s.title).join(', ')}.`;

      return {
        query: searchResult.query,
        contextSummary,
        relevantSections,
        totalSources: searchResult.materialsSearched.length
      };

    } catch (error) {
      console.error('Error preparing search context for AI:', error);
      throw error;
    }
  }
}

export const semanticSearchService = new SemanticSearchService();
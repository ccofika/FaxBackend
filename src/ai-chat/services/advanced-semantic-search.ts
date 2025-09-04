import { openai } from '../config/openai-config';
import mongoose from 'mongoose';
import DocumentSection from '../../models/DocumentSection';
import DocumentChunk from '../../models/DocumentChunk';
import Material from '../../models/Material';

export interface SemanticSearchQuery {
  userQuery: string;
  materialId?: string;
  subjectId?: string;
  maxResults?: number;
  similarityThreshold?: number; // Minimum cosine similarity score (0-1)
  includeContext?: boolean; // Include neighboring sections for context
}

export interface EmbeddingVector {
  embedding: number[];
  text: string;
  metadata: {
    source: 'query' | 'section_title' | 'section_content' | 'section_abstract';
    length: number;
  };
}

export interface SectionMatch {
  sectionId: string;
  title: string;
  cleanTitle: string;
  level: number;
  path: string;
  pageStart: number;
  pageEnd: number;
  materialId: string;
  materialTitle: string;
  
  // Similarity scoring
  similarityScore: number;
  matchReason: string; // Why this section was matched
  
  // Multi-part handling
  isMainPart: boolean;
  totalParts: number;
  partNumber: number;
  allParts: SectionPart[]; // All parts if this is a multi-part section
  
  // Content
  content: string;
  contentLength: number;
  hasFullContent: boolean;
  
  // Context
  contextSections?: ContextSection[];
}

export interface SectionPart {
  partNumber: number;
  isMainPart: boolean;
  content: string;
  contentLength: number;
  sectionId: string;
}

export interface ContextSection {
  sectionId: string;
  title: string;
  relationship: 'parent' | 'child' | 'sibling' | 'previous' | 'next';
  level: number;
  pageRange: string;
}

export interface SemanticSearchResult {
  query: string;
  matchedSections: SectionMatch[];
  totalMatches: number;
  searchStrategy: 'embedding_similarity' | 'hybrid_text_embedding' | 'fallback_text';
  processingTime: number;
  embeddingStats?: {
    queryEmbeddingTime: number;
    vectorSearchTime: number;
    contentProcessingTime: number;
  };
}

export class AdvancedSemanticSearch {
  private embeddingCache = new Map<string, number[]>();
  private readonly EMBEDDING_MODEL = 'text-embedding-3-small'; // Using OpenAI's most cost-effective embedding model
  
  /**
   * Main semantic search method that finds the most similar sections
   */
  async searchSimilarSections(query: SemanticSearchQuery): Promise<SemanticSearchResult> {
    const startTime = Date.now();
    
    try {
      // Step 1: Generate query embedding
      const queryEmbeddingStart = Date.now();
      const queryEmbedding = await this.generateEmbedding(query.userQuery, 'query');
      const queryEmbeddingTime = Date.now() - queryEmbeddingStart;

      // Step 2: Find candidate sections
      const candidates = await this.findCandidateSections(query);
      
      if (candidates.length === 0) {
        return {
          query: query.userQuery,
          matchedSections: [],
          totalMatches: 0,
          searchStrategy: 'fallback_text',
          processingTime: Date.now() - startTime
        };
      }

      // Step 3: Calculate similarities using embeddings
      const vectorSearchStart = Date.now();
      const scoredSections = await this.calculateSectionSimilarities(
        queryEmbedding,
        candidates,
        query.similarityThreshold || 0.3
      );
      const vectorSearchTime = Date.now() - vectorSearchStart;

      // Step 4: Process and aggregate multi-part sections
      const contentProcessingStart = Date.now();
      const processedSections = await this.processMultiPartSections(scoredSections);
      const contentProcessingTime = Date.now() - contentProcessingStart;

      // Step 5: Add context if requested
      const finalSections = query.includeContext ? 
        await this.addContextToSections(processedSections) : 
        processedSections;

      // Step 6: Sort and limit results
      const sortedSections = finalSections
        .sort((a, b) => b.similarityScore - a.similarityScore)
        .slice(0, query.maxResults || 2);

      const totalTime = Date.now() - startTime;

      return {
        query: query.userQuery,
        matchedSections: sortedSections,
        totalMatches: sortedSections.length,
        searchStrategy: 'embedding_similarity',
        processingTime: totalTime,
        embeddingStats: {
          queryEmbeddingTime,
          vectorSearchTime,
          contentProcessingTime
        }
      };

    } catch (error) {
      console.error('Error in semantic search:', error);
      
      // Fallback to simple text search
      return this.fallbackTextSearch(query, startTime);
    }
  }

  /**
   * Generate embedding for text using OpenAI
   */
  private async generateEmbedding(
    text: string, 
    source: 'query' | 'section_title' | 'section_content' | 'section_abstract'
  ): Promise<EmbeddingVector> {
    try {
      // Check cache first
      const cacheKey = `${source}:${text.substring(0, 100)}`;
      const cached = this.embeddingCache.get(cacheKey);
      
      if (cached) {
        return {
          embedding: cached,
          text,
          metadata: { source, length: text.length }
        };
      }

      // Prepare text for embedding (clean and truncate if needed)
      const cleanText = this.prepareTextForEmbedding(text, source);

      const response = await openai.embeddings.create({
        model: this.EMBEDDING_MODEL,
        input: cleanText
      });

      const embedding = response.data[0].embedding;
      
      // Cache the embedding
      this.embeddingCache.set(cacheKey, embedding);

      return {
        embedding,
        text: cleanText,
        metadata: { source, length: cleanText.length }
      };

    } catch (error) {
      console.error('Error generating embedding:', error);
      throw error;
    }
  }

  /**
   * Prepare text for embedding generation
   */
  private prepareTextForEmbedding(text: string, source: string): string {
    // Clean the text
    let cleaned = text
      .replace(/\s+/g, ' ') // Normalize whitespace
      .replace(/[^\w\sšđčćžŠĐČĆŽ.,!?()-]/g, '') // Keep only relevant characters
      .trim();

    // Truncate if too long (embedding models have token limits)
    const maxLength = source === 'query' ? 500 : 
                     source === 'section_title' ? 200 : 
                     2000; // For content and abstracts

    if (cleaned.length > maxLength) {
      cleaned = cleaned.substring(0, maxLength) + '...';
    }

    // Add context based on source
    switch (source) {
      case 'query':
        return `Korisničko pitanje: ${cleaned}`;
      case 'section_title':
        return `Naslov sekcije: ${cleaned}`;
      case 'section_content':
        return `Sadržaj sekcije: ${cleaned}`;
      case 'section_abstract':
        return `Sažetak sekcije: ${cleaned}`;
      default:
        return cleaned;
    }
  }

  /**
   * Find candidate sections from database
   */
  private async findCandidateSections(query: SemanticSearchQuery): Promise<any[]> {
    try {
      const searchQuery: any = {};

      // Filter by material or subject
      if (query.materialId) {
        searchQuery.docId = new mongoose.Types.ObjectId(query.materialId);
      } else if (query.subjectId) {
        searchQuery.subjectId = new mongoose.Types.ObjectId(query.subjectId);
      }

      // Only get sections that have content or are main parts
      searchQuery.$or = [
        { content: { $exists: true, $ne: '', $ne: null } },
        { isMainPart: true }
      ];

      const sections = await DocumentSection.find(searchQuery)
        .sort({ level: 1, pageStart: 1 })
        .limit(50) // Limit to avoid processing too many sections
        .lean();

      return sections;

    } catch (error) {
      console.error('Error finding candidate sections:', error);
      return [];
    }
  }

  /**
   * Calculate similarity scores between query and sections
   */
  private async calculateSectionSimilarities(
    queryEmbedding: EmbeddingVector,
    candidates: any[],
    threshold: number
  ): Promise<Array<{
    section: any;
    similarityScore: number;
    matchReason: string;
  }>> {
    const scoredSections = [];

    for (const section of candidates) {
      try {
        // Generate embeddings for different parts of the section
        const titleEmbedding = await this.generateEmbedding(section.title, 'section_title');
        
        let contentEmbedding: EmbeddingVector | null = null;
        if (section.content && section.content.length > 50) {
          contentEmbedding = await this.generateEmbedding(section.content, 'section_content');
        }

        let abstractEmbedding: EmbeddingVector | null = null;
        if (section.shortAbstract && section.shortAbstract.length > 20) {
          abstractEmbedding = await this.generateEmbedding(section.shortAbstract, 'section_abstract');
        }

        // Calculate similarity scores
        const titleSimilarity = this.cosineSimilarity(queryEmbedding.embedding, titleEmbedding.embedding);
        const contentSimilarity = contentEmbedding ? 
          this.cosineSimilarity(queryEmbedding.embedding, contentEmbedding.embedding) : 0;
        const abstractSimilarity = abstractEmbedding ?
          this.cosineSimilarity(queryEmbedding.embedding, abstractEmbedding.embedding) : 0;

        // Weighted combination of similarities
        const combinedScore = (titleSimilarity * 0.4) + 
                             (contentSimilarity * 0.4) + 
                             (abstractSimilarity * 0.2);

        // Determine match reason
        let matchReason = '';
        const maxScore = Math.max(titleSimilarity, contentSimilarity, abstractSimilarity);
        
        if (maxScore === titleSimilarity && titleSimilarity > 0.4) {
          matchReason = `Visoka sličnost sa naslovom sekcije (${(titleSimilarity * 100).toFixed(1)}%)`;
        } else if (maxScore === contentSimilarity && contentSimilarity > 0.3) {
          matchReason = `Visoka sličnost sa sadržajem sekcije (${(contentSimilarity * 100).toFixed(1)}%)`;
        } else if (maxScore === abstractSimilarity && abstractSimilarity > 0.3) {
          matchReason = `Visoka sličnost sa sažetkom sekcije (${(abstractSimilarity * 100).toFixed(1)}%)`;
        } else {
          matchReason = `Kombinovana sličnost (${(combinedScore * 100).toFixed(1)}%)`;
        }

        if (combinedScore >= threshold) {
          scoredSections.push({
            section,
            similarityScore: combinedScore,
            matchReason
          });
        }

      } catch (error) {
        console.error(`Error processing section ${section.sectionId}:`, error);
        continue;
      }
    }

    return scoredSections;
  }

  /**
   * Calculate cosine similarity between two embedding vectors
   */
  private cosineSimilarity(vectorA: number[], vectorB: number[]): number {
    if (vectorA.length !== vectorB.length) {
      throw new Error('Vectors must have the same length');
    }

    let dotProduct = 0;
    let normA = 0;
    let normB = 0;

    for (let i = 0; i < vectorA.length; i++) {
      dotProduct += vectorA[i] * vectorB[i];
      normA += vectorA[i] * vectorA[i];
      normB += vectorB[i] * vectorB[i];
    }

    const similarity = dotProduct / (Math.sqrt(normA) * Math.sqrt(normB));
    return Math.max(0, Math.min(1, similarity)); // Clamp between 0 and 1
  }

  /**
   * Process multi-part sections and aggregate all parts
   */
  private async processMultiPartSections(
    scoredSections: Array<{
      section: any;
      similarityScore: number;
      matchReason: string;
    }>
  ): Promise<SectionMatch[]> {
    const processedSections: SectionMatch[] = [];
    const processedSectionIds = new Set<string>();

    for (const scored of scoredSections) {
      const section = scored.section;
      
      // Skip if we already processed this section group
      const baseSectionId = section.sectionId.split('_part_')[0];
      if (processedSectionIds.has(baseSectionId)) {
        continue;
      }

      // Find all parts of this section
      const allParts = await this.getAllSectionParts(section.docId, baseSectionId);
      
      // Get material info
      const material = await Material.findById(section.docId).select('title').lean();

      // Aggregate content from all parts
      const aggregatedContent = allParts
        .sort((a, b) => a.partNumber - b.partNumber)
        .map(part => part.content)
        .join('\n\n');

      const sectionMatch: SectionMatch = {
        sectionId: section.sectionId,
        title: section.title,
        cleanTitle: section.title.replace(/^[\d\.\s]+/, '').trim(),
        level: section.level,
        path: section.path,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        materialId: section.docId.toString(),
        materialTitle: material?.title || 'Unknown Material',
        
        similarityScore: scored.similarityScore,
        matchReason: scored.matchReason,
        
        isMainPart: section.isMainPart || true,
        totalParts: allParts.length,
        partNumber: section.partNumber || 1,
        allParts: allParts.map(part => ({
          partNumber: part.partNumber,
          isMainPart: part.isMainPart,
          content: part.content,
          contentLength: part.content.length,
          sectionId: part.sectionId
        })),
        
        content: aggregatedContent,
        contentLength: aggregatedContent.length,
        hasFullContent: aggregatedContent.length > 0
      };

      processedSections.push(sectionMatch);
      processedSectionIds.add(baseSectionId);
    }

    return processedSections;
  }

  /**
   * Get all parts of a multi-part section
   */
  private async getAllSectionParts(docId: mongoose.Types.ObjectId, baseSectionId: string): Promise<Array<{
    sectionId: string;
    partNumber: number;
    isMainPart: boolean;
    content: string;
  }>> {
    try {
      // Find all sections that belong to the same base section
      const allParts = await DocumentSection.find({
        docId: docId,
        $or: [
          { sectionId: baseSectionId }, // Main part
          { sectionId: { $regex: `^${baseSectionId}_part_` } } // Additional parts
        ]
      })
      .sort({ partNumber: 1 })
      .select('sectionId partNumber isMainPart content')
      .lean();

      return allParts.map(part => ({
        sectionId: part.sectionId,
        partNumber: part.partNumber || 1,
        isMainPart: part.isMainPart || false,
        content: part.content || ''
      }));

    } catch (error) {
      console.error('Error getting section parts:', error);
      return [];
    }
  }

  /**
   * Add contextual sections (neighboring sections)
   */
  private async addContextToSections(sections: SectionMatch[]): Promise<SectionMatch[]> {
    for (const section of sections) {
      try {
        const contextSections = await this.findContextSections(
          new mongoose.Types.ObjectId(section.materialId),
          section.sectionId,
          section.level,
          section.pageStart
        );
        
        section.contextSections = contextSections;
      } catch (error) {
        console.error(`Error adding context to section ${section.sectionId}:`, error);
      }
    }

    return sections;
  }

  /**
   * Find contextual sections around a given section
   */
  private async findContextSections(
    materialId: mongoose.Types.ObjectId,
    sectionId: string,
    level: number,
    pageStart: number
  ): Promise<ContextSection[]> {
    try {
      const contextSections: ContextSection[] = [];

      // Find parent section (one level up)
      if (level > 1) {
        const parentSection = await DocumentSection.findOne({
          docId: materialId,
          level: level - 1,
          pageStart: { $lte: pageStart },
          pageEnd: { $gte: pageStart }
        })
        .select('sectionId title level pageStart pageEnd')
        .lean();

        if (parentSection) {
          contextSections.push({
            sectionId: parentSection.sectionId,
            title: parentSection.title,
            relationship: 'parent',
            level: parentSection.level,
            pageRange: `${parentSection.pageStart}-${parentSection.pageEnd}`
          });
        }
      }

      // Find child sections (one level down)
      const childSections = await DocumentSection.find({
        docId: materialId,
        level: level + 1,
        pageStart: { $gte: pageStart },
        pageEnd: { $lte: pageStart + 20 } // Within reasonable range
      })
      .limit(3)
      .select('sectionId title level pageStart pageEnd')
      .lean();

      childSections.forEach(child => {
        contextSections.push({
          sectionId: child.sectionId,
          title: child.title,
          relationship: 'child',
          level: child.level,
          pageRange: `${child.pageStart}-${child.pageEnd}`
        });
      });

      // Find previous and next sibling sections
      const [previousSection, nextSection] = await Promise.all([
        DocumentSection.findOne({
          docId: materialId,
          level: level,
          pageStart: { $lt: pageStart }
        })
        .sort({ pageStart: -1 })
        .select('sectionId title level pageStart pageEnd')
        .lean(),
        
        DocumentSection.findOne({
          docId: materialId,
          level: level,
          pageStart: { $gt: pageStart }
        })
        .sort({ pageStart: 1 })
        .select('sectionId title level pageStart pageEnd')
        .lean()
      ]);

      if (previousSection) {
        contextSections.push({
          sectionId: previousSection.sectionId,
          title: previousSection.title,
          relationship: 'previous',
          level: previousSection.level,
          pageRange: `${previousSection.pageStart}-${previousSection.pageEnd}`
        });
      }

      if (nextSection) {
        contextSections.push({
          sectionId: nextSection.sectionId,
          title: nextSection.title,
          relationship: 'next',
          level: nextSection.level,
          pageRange: `${nextSection.pageStart}-${nextSection.pageEnd}`
        });
      }

      return contextSections;

    } catch (error) {
      console.error('Error finding context sections:', error);
      return [];
    }
  }

  /**
   * Fallback to simple text search when embedding search fails
   */
  private async fallbackTextSearch(
    query: SemanticSearchQuery,
    startTime: number
  ): Promise<SemanticSearchResult> {
    try {
      console.warn('Falling back to text search due to embedding error');

      const searchQuery: any = {};
      
      if (query.materialId) {
        searchQuery.docId = new mongoose.Types.ObjectId(query.materialId);
      } else if (query.subjectId) {
        searchQuery.subjectId = new mongoose.Types.ObjectId(query.subjectId);
      }

      // Simple text search
      const queryWords = query.userQuery.toLowerCase().split(/\s+/).filter(w => w.length > 2);
      const regexPatterns = queryWords.map(word => new RegExp(word, 'i'));
      
      searchQuery.$or = [
        { title: { $in: regexPatterns } },
        { content: { $in: regexPatterns } },
        { shortAbstract: { $in: regexPatterns } }
      ];

      const sections = await DocumentSection.find(searchQuery)
        .sort({ level: 1, pageStart: 1 })
        .limit(query.maxResults || 2)
        .lean();

      const matches: SectionMatch[] = [];

      for (const section of sections) {
        const material = await Material.findById(section.docId).select('title').lean();
        
        matches.push({
          sectionId: section.sectionId,
          title: section.title,
          cleanTitle: section.title.replace(/^[\d\.\s]+/, '').trim(),
          level: section.level,
          path: section.path,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          materialId: section.docId.toString(),
          materialTitle: material?.title || 'Unknown Material',
          
          similarityScore: 0.5, // Default score for text matching
          matchReason: 'Pronađeno preko jednostavne pretrage teksta',
          
          isMainPart: section.isMainPart || true,
          totalParts: 1,
          partNumber: 1,
          allParts: [{
            partNumber: 1,
            isMainPart: true,
            content: section.content || '',
            contentLength: (section.content || '').length,
            sectionId: section.sectionId
          }],
          
          content: section.content || '',
          contentLength: (section.content || '').length,
          hasFullContent: !!(section.content && section.content.length > 0)
        });
      }

      return {
        query: query.userQuery,
        matchedSections: matches,
        totalMatches: matches.length,
        searchStrategy: 'fallback_text',
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      console.error('Error in fallback text search:', error);
      return {
        query: query.userQuery,
        matchedSections: [],
        totalMatches: 0,
        searchStrategy: 'fallback_text',
        processingTime: Date.now() - startTime
      };
    }
  }

  /**
   * Clear embedding cache (useful for testing or memory management)
   */
  clearCache(): void {
    this.embeddingCache.clear();
  }

  /**
   * Get cache statistics
   */
  getCacheStats(): { size: number; keys: string[] } {
    return {
      size: this.embeddingCache.size,
      keys: Array.from(this.embeddingCache.keys()).slice(0, 10) // First 10 keys for debugging
    };
  }
}

export const advancedSemanticSearch = new AdvancedSemanticSearch();
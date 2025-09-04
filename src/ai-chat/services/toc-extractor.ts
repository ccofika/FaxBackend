import mongoose from 'mongoose';
import TocAnalysis, { ITocAnalysis, ITocSection } from '../../models/TocAnalysis';
import Material from '../../models/Material';
import DocumentSection from '../../models/DocumentSection';

export interface TocExtractionResult {
  materialId: string;
  materialTitle: string;
  tocAnalysis: ITocAnalysis | null;
  sections: Array<{
    sectionId: string;
    title: string;
    cleanTitle: string;
    level: number;
    path: string;
    pageStart: number;
    pageEnd: number;
    semanticType: string;
    parentSectionId?: string;
    hasContent: boolean;
    contentLength?: number;
  }>;
  totalSections: number;
  processedSections: number;
  status: 'no_toc' | 'toc_pending' | 'toc_ready' | 'sections_ready';
}

export interface TocSearchOptions {
  includeContent?: boolean;
  maxLevel?: number;
  semanticTypes?: Array<'chapter' | 'section' | 'subsection' | 'paragraph'>;
}

export class TocExtractor {
  
  /**
   * Get ToC information for a specific material
   * This will return the ToC analysis and processed sections if available
   */
  async extractTocForMaterial(materialId: string, options: TocSearchOptions = {}): Promise<TocExtractionResult> {
    try {
      // Get material info
      const material = await Material.findById(materialId).lean();
      if (!material) {
        throw new Error(`Material not found: ${materialId}`);
      }

      // Get ToC analysis
      const tocAnalysis = await TocAnalysis.findOne({ docId: materialId }).lean();
      
      if (!tocAnalysis) {
        return {
          materialId,
          materialTitle: material.title,
          tocAnalysis: null,
          sections: [],
          totalSections: 0,
          processedSections: 0,
          status: 'no_toc'
        };
      }

      // Build query for document sections based on options
      const sectionQuery: any = { docId: materialId };
      
      if (options.maxLevel) {
        sectionQuery.level = { $lte: options.maxLevel };
      }
      
      if (options.semanticTypes && options.semanticTypes.length > 0) {
        sectionQuery.semanticType = { $in: options.semanticTypes };
      }

      // Get processed document sections
      const documentSections = await DocumentSection.find(sectionQuery)
        .sort({ level: 1, pageStart: 1 })
        .lean();

      // Map sections with content information
      const sections = documentSections.map(section => ({
        sectionId: section.sectionId,
        title: section.title,
        cleanTitle: this.cleanSectionTitle(section.title),
        level: section.level,
        path: section.path,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        semanticType: section.semanticType || 'section',
        parentSectionId: section.parentSectionId,
        hasContent: !!section.content && section.content.length > 0,
        contentLength: section.content ? section.content.length : 0
      }));

      let status: 'no_toc' | 'toc_pending' | 'toc_ready' | 'sections_ready';
      
      if (tocAnalysis.status === 'completed' && documentSections.length > 0) {
        status = 'sections_ready';
      } else if (tocAnalysis.status === 'completed') {
        status = 'toc_ready';
      } else if (tocAnalysis.status === 'processing' || tocAnalysis.status === 'pending') {
        status = 'toc_pending';
      } else {
        status = 'no_toc';
      }

      return {
        materialId,
        materialTitle: material.title,
        tocAnalysis,
        sections,
        totalSections: tocAnalysis.totalSections,
        processedSections: tocAnalysis.processedSections,
        status
      };

    } catch (error) {
      console.error('Error extracting ToC for material:', error);
      throw error;
    }
  }

  /**
   * Get ToC information for multiple materials in a subject
   * TODO: This will be used when there are multiple materials per subject
   */
  async extractTocForSubject(subjectId: string, options: TocSearchOptions = {}): Promise<TocExtractionResult[]> {
    try {
      // Find all materials for the subject that are ready or have ToC
      const materials = await Material.find({
        subjectId,
        status: { $in: ['ready', 'toc_ready', 'processing'] }
      })
      .sort({ order: 1, title: 1 })
      .lean();

      const results: TocExtractionResult[] = [];
      
      for (const material of materials) {
        const tocResult = await this.extractTocForMaterial(material._id.toString(), options);
        results.push(tocResult);
      }

      return results;

    } catch (error) {
      console.error('Error extracting ToC for subject:', error);
      throw error;
    }
  }

  /**
   * Get hierarchical ToC structure for a material
   * Returns sections organized in a tree structure
   */
  async getHierarchicalToc(materialId: string, maxLevel: number = 3): Promise<Array<{
    section: any;
    children: any[];
  }>> {
    try {
      const tocResult = await this.extractTocForMaterial(materialId, { maxLevel });
      
      if (tocResult.status === 'no_toc' || tocResult.sections.length === 0) {
        return [];
      }

      // Build hierarchical structure
      const sectionMap = new Map();
      const rootSections = [];

      // First pass: create all sections
      for (const section of tocResult.sections) {
        const sectionNode = {
          section,
          children: []
        };
        sectionMap.set(section.sectionId, sectionNode);
      }

      // Second pass: build hierarchy
      for (const section of tocResult.sections) {
        const sectionNode = sectionMap.get(section.sectionId);
        
        if (section.parentSectionId) {
          const parentNode = sectionMap.get(section.parentSectionId);
          if (parentNode) {
            parentNode.children.push(sectionNode);
          } else {
            // Parent not found, treat as root
            rootSections.push(sectionNode);
          }
        } else {
          rootSections.push(sectionNode);
        }
      }

      return rootSections;

    } catch (error) {
      console.error('Error getting hierarchical ToC:', error);
      throw error;
    }
  }

  /**
   * Find sections that match a specific query or topic
   * This will be used for semantic search later
   */
  async findRelevantSections(
    materialId: string, 
    query: string, 
    options: {
      maxResults?: number;
      minLevel?: number;
      maxLevel?: number;
      semanticTypes?: Array<'chapter' | 'section' | 'subsection' | 'paragraph'>;
    } = {}
  ): Promise<Array<{
    sectionId: string;
    title: string;
    level: number;
    path: string;
    relevanceScore: number;
    pageStart: number;
    pageEnd: number;
    contentPreview?: string;
  }>> {
    try {
      const tocResult = await this.extractTocForMaterial(materialId, options);
      
      if (tocResult.sections.length === 0) {
        return [];
      }

      // Simple text-based relevance scoring for now
      // TODO: Replace with proper semantic search using embeddings
      const queryLower = query.toLowerCase();
      const relevantSections = [];

      for (const section of tocResult.sections) {
        let relevanceScore = 0;
        
        // Check title match
        if (section.cleanTitle.toLowerCase().includes(queryLower)) {
          relevanceScore += 10;
        }
        
        // Check for partial word matches
        const titleWords = section.cleanTitle.toLowerCase().split(/\s+/);
        const queryWords = queryLower.split(/\s+/);
        
        for (const queryWord of queryWords) {
          for (const titleWord of titleWords) {
            if (titleWord.includes(queryWord) || queryWord.includes(titleWord)) {
              relevanceScore += 3;
            }
          }
        }

        // Bonus for higher-level sections (chapters get priority)
        if (section.level === 1) relevanceScore += 2;
        else if (section.level === 2) relevanceScore += 1;

        if (relevanceScore > 0) {
          relevantSections.push({
            sectionId: section.sectionId,
            title: section.title,
            level: section.level,
            path: section.path,
            relevanceScore,
            pageStart: section.pageStart,
            pageEnd: section.pageEnd,
            contentPreview: section.hasContent ? 
              `Content available (${section.contentLength} chars)` : 
              'No content processed yet'
          });
        }
      }

      // Sort by relevance score and limit results
      relevantSections.sort((a, b) => b.relevanceScore - a.relevanceScore);
      
      if (options.maxResults) {
        return relevantSections.slice(0, options.maxResults);
      }

      return relevantSections;

    } catch (error) {
      console.error('Error finding relevant sections:', error);
      throw error;
    }
  }

  /**
   * Get section content for AI model
   * Returns the actual content of sections for AI processing
   */
  async getSectionContent(materialId: string, sectionIds: string[]): Promise<Array<{
    sectionId: string;
    title: string;
    path: string;
    content: string;
    pageRange: string;
    level: number;
  }>> {
    try {
      const sections = await DocumentSection.find({
        docId: materialId,
        sectionId: { $in: sectionIds }
      })
      .sort({ level: 1, pageStart: 1 })
      .lean();

      return sections.map(section => ({
        sectionId: section.sectionId,
        title: section.title,
        path: section.path,
        content: section.content || '',
        pageRange: `${section.pageStart}-${section.pageEnd}`,
        level: section.level
      }));

    } catch (error) {
      console.error('Error getting section content:', error);
      throw error;
    }
  }

  /**
   * Clean section title by removing numbering
   */
  private cleanSectionTitle(title: string): string {
    // Remove leading numbers and dots (e.g., "1.1.1 Hardver" -> "Hardver")
    return title.replace(/^[\d\.\s]+/, '').trim();
  }

  /**
   * Get ToC summary for AI context
   * Returns a condensed view of the material's structure for AI model
   */
  async getTocSummaryForAI(materialId: string, maxLevel: number = 2): Promise<{
    materialTitle: string;
    totalSections: number;
    structure: string;
    keyTopics: string[];
  }> {
    try {
      const tocResult = await this.extractTocForMaterial(materialId, { maxLevel });
      
      if (tocResult.status === 'no_toc') {
        return {
          materialTitle: tocResult.materialTitle,
          totalSections: 0,
          structure: 'No table of contents available for this material.',
          keyTopics: []
        };
      }

      // Build structure string
      const structureLines = [];
      const keyTopics = new Set<string>();

      for (const section of tocResult.sections) {
        const indent = '  '.repeat(section.level - 1);
        structureLines.push(`${indent}${section.level}.${section.level} ${section.cleanTitle} (pages ${section.pageStart}-${section.pageEnd})`);
        keyTopics.add(section.cleanTitle);
      }

      return {
        materialTitle: tocResult.materialTitle,
        totalSections: tocResult.totalSections,
        structure: structureLines.join('\n'),
        keyTopics: Array.from(keyTopics)
      };

    } catch (error) {
      console.error('Error getting ToC summary for AI:', error);
      throw error;
    }
  }
}

export const tocExtractor = new TocExtractor();
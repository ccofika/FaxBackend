import mongoose from 'mongoose';
import DocumentSection from '../../models/DocumentSection';
import DocumentChunk from '../../models/DocumentChunk';
import { SelectedSection } from './toc-ai-analyzer';

export interface SectionContentRequest {
  materialId: string;
  selectedSections: SelectedSection[];
  includeChunks?: boolean; // Whether to include detailed chunks
  maxContentLength?: number; // Maximum total content length
  contextWindow?: number; // Number of pages before/after to include for context
}

export interface ExtractedSectionContent {
  sectionId: string;
  title: string;
  cleanTitle: string;
  level: number;
  pageStart: number;
  pageEnd: number;
  path: string;
  content: string;
  contentLength: number;
  hasFullContent: boolean;
  chunks?: ExtractedChunkContent[];
  childSections?: ExtractedSectionContent[];
  contextInfo?: {
    previousSection?: string;
    nextSection?: string;
    parentSection?: string;
  };
}

export interface ExtractedChunkContent {
  chunkId: string;
  page: number;
  paragraphIdx: number;
  content: string;
  title?: string;
}

export interface SectionExtractionResult {
  materialId: string;
  totalSectionsRequested: number;
  sectionsFound: number;
  sectionsWithContent: number;
  extractedContent: ExtractedSectionContent[];
  totalContentLength: number;
  truncated: boolean;
  extractionSummary: string;
  missingContent?: Array<{
    sectionTitle: string;
    reason: string;
  }>;
}

export class SectionContentExtractor {
  
  /**
   * Main method to extract content from selected sections
   */
  async extractSectionContent(request: SectionContentRequest): Promise<SectionExtractionResult> {
    try {
      const {
        materialId,
        selectedSections,
        includeChunks = false,
        maxContentLength = 8000,
        contextWindow = 0
      } = request;

      const extractedContent: ExtractedSectionContent[] = [];
      const missingContent: Array<{sectionTitle: string; reason: string}> = [];
      let totalContentLength = 0;
      let sectionsWithContent = 0;
      let truncated = false;

      // Process each selected section
      for (const selectedSection of selectedSections) {
        if (totalContentLength >= maxContentLength) {
          truncated = true;
          break;
        }

        const sectionContent = await this.extractSingleSection(
          materialId,
          selectedSection,
          includeChunks,
          contextWindow,
          maxContentLength - totalContentLength
        );

        if (sectionContent) {
          extractedContent.push(sectionContent);
          totalContentLength += sectionContent.contentLength;
          
          if (sectionContent.hasFullContent) {
            sectionsWithContent++;
          }
        } else {
          missingContent.push({
            sectionTitle: selectedSection.title,
            reason: 'Sekcija nije pronađena u bazi podataka ili nema sadržaj'
          });
        }
      }

      const extractionSummary = this.buildExtractionSummary(
        selectedSections.length,
        extractedContent.length,
        sectionsWithContent,
        totalContentLength,
        truncated
      );

      return {
        materialId,
        totalSectionsRequested: selectedSections.length,
        sectionsFound: extractedContent.length,
        sectionsWithContent,
        extractedContent,
        totalContentLength,
        truncated,
        extractionSummary,
        missingContent: missingContent.length > 0 ? missingContent : undefined
      };

    } catch (error) {
      console.error('Error extracting section content:', error);
      throw error;
    }
  }

  /**
   * Extract content from a single section
   */
  private async extractSingleSection(
    materialId: string,
    selectedSection: SelectedSection,
    includeChunks: boolean,
    contextWindow: number,
    remainingLength: number
  ): Promise<ExtractedSectionContent | null> {
    try {
      // Find the section in database by matching title and page range
      const section = await DocumentSection.findOne({
        docId: new mongoose.Types.ObjectId(materialId),
        $or: [
          { title: selectedSection.title },
          { title: { $regex: this.escapeRegex(selectedSection.cleanTitle), $options: 'i' } }
        ],
        pageStart: selectedSection.pageStart,
        pageEnd: selectedSection.pageEnd
      }).lean();

      if (!section) {
        // Try broader search by page range only
        const sectionByPage = await DocumentSection.findOne({
          docId: new mongoose.Types.ObjectId(materialId),
          pageStart: { $lte: selectedSection.pageStart + 1, $gte: selectedSection.pageStart - 1 },
          pageEnd: { $lte: selectedSection.pageEnd + 1, $gte: selectedSection.pageEnd - 1 }
        }).lean();

        if (!sectionByPage) {
          console.warn(`Section not found: ${selectedSection.title} (pages ${selectedSection.pageStart}-${selectedSection.pageEnd})`);
          return null;
        }

        // Use the found section
        return this.buildSectionContent(sectionByPage, includeChunks, contextWindow, remainingLength);
      }

      return this.buildSectionContent(section, includeChunks, contextWindow, remainingLength);

    } catch (error) {
      console.error(`Error extracting section ${selectedSection.title}:`, error);
      return null;
    }
  }

  /**
   * Build section content structure
   */
  private async buildSectionContent(
    section: any,
    includeChunks: boolean,
    contextWindow: number,
    remainingLength: number
  ): Promise<ExtractedSectionContent> {
    let content = section.content || '';
    let hasFullContent = !!section.content && section.content.length > 0;
    let chunks: ExtractedChunkContent[] | undefined = undefined;
    let childSections: ExtractedSectionContent[] | undefined = undefined;

    // If no content in section, try to get chunks
    if (!hasFullContent && includeChunks) {
      chunks = await this.getSectionChunks(section.docId, section.sectionId, remainingLength * 0.8);
      content = chunks.map(chunk => chunk.content).join('\n\n');
      hasFullContent = chunks.length > 0;
    }

    // Get child sections if this is a high-level section
    if (section.level <= 2 && remainingLength > 2000) {
      childSections = await this.getChildSections(section.docId, section.sectionId, remainingLength * 0.3);
      
      // Add child section content if main section content is empty
      if (!hasFullContent && childSections.length > 0) {
        const childContent = childSections
          .filter(child => child.hasFullContent)
          .map(child => `## ${child.title}\n${child.content}`)
          .join('\n\n');
        
        if (childContent) {
          content = childContent;
          hasFullContent = true;
        }
      }
    }

    // Truncate content if needed
    if (content.length > remainingLength) {
      content = content.substring(0, remainingLength - 100) + '\n\n[SADRŽAJ SKRAĆEN...]';
    }

    // Get context information
    const contextInfo = await this.getSectionContext(section.docId, section.sectionId);

    return {
      sectionId: section.sectionId,
      title: section.title,
      cleanTitle: section.title.replace(/^[\d\.\s]+/, '').trim(),
      level: section.level,
      pageStart: section.pageStart,
      pageEnd: section.pageEnd,
      path: section.path,
      content,
      contentLength: content.length,
      hasFullContent,
      chunks: chunks?.length ? chunks : undefined,
      childSections: childSections?.length ? childSections : undefined,
      contextInfo
    };
  }

  /**
   * Get chunks for a section
   */
  private async getSectionChunks(
    materialId: mongoose.Types.ObjectId,
    sectionId: string,
    maxLength: number
  ): Promise<ExtractedChunkContent[]> {
    try {
      const chunks = await DocumentChunk.find({
        docId: materialId,
        sectionId: sectionId
      })
      .sort({ page: 1, paragraphIdx: 1 })
      .limit(20) // Limit chunks to avoid overwhelming
      .lean();

      const extractedChunks: ExtractedChunkContent[] = [];
      let currentLength = 0;

      for (const chunk of chunks) {
        if (currentLength + chunk.content.length > maxLength) {
          break;
        }

        extractedChunks.push({
          chunkId: chunk.chunkId,
          page: chunk.page,
          paragraphIdx: chunk.paragraphIdx,
          content: chunk.content,
          title: chunk.title
        });

        currentLength += chunk.content.length;
      }

      return extractedChunks;

    } catch (error) {
      console.error('Error getting section chunks:', error);
      return [];
    }
  }

  /**
   * Get child sections
   */
  private async getChildSections(
    materialId: mongoose.Types.ObjectId,
    parentSectionId: string,
    maxLength: number
  ): Promise<ExtractedSectionContent[]> {
    try {
      const childSections = await DocumentSection.find({
        docId: materialId,
        parentSectionId: parentSectionId
      })
      .sort({ pageStart: 1 })
      .limit(10)
      .lean();

      const extractedChildren: ExtractedSectionContent[] = [];
      let currentLength = 0;

      for (const child of childSections) {
        if (currentLength > maxLength) break;

        const childContent = await this.buildSectionContent(child, false, 0, maxLength - currentLength);
        extractedChildren.push(childContent);
        currentLength += childContent.contentLength;
      }

      return extractedChildren;

    } catch (error) {
      console.error('Error getting child sections:', error);
      return [];
    }
  }

  /**
   * Get section context (neighboring sections)
   */
  private async getSectionContext(
    materialId: mongoose.Types.ObjectId,
    sectionId: string
  ): Promise<{
    previousSection?: string;
    nextSection?: string;
    parentSection?: string;
  }> {
    try {
      const currentSection = await DocumentSection.findOne({
        docId: materialId,
        sectionId: sectionId
      }).lean();

      if (!currentSection) return {};

      // Get previous and next sections at the same level
      const [previousSection, nextSection, parentSection] = await Promise.all([
        // Previous section
        DocumentSection.findOne({
          docId: materialId,
          level: currentSection.level,
          pageStart: { $lt: currentSection.pageStart }
        })
        .sort({ pageStart: -1 })
        .select('title')
        .lean(),
        
        // Next section
        DocumentSection.findOne({
          docId: materialId,
          level: currentSection.level,
          pageStart: { $gt: currentSection.pageStart }
        })
        .sort({ pageStart: 1 })
        .select('title')
        .lean(),
        
        // Parent section
        currentSection.parentSectionId ? 
          DocumentSection.findOne({
            docId: materialId,
            sectionId: currentSection.parentSectionId
          })
          .select('title')
          .lean() : null
      ]);

      return {
        previousSection: previousSection?.title,
        nextSection: nextSection?.title,
        parentSection: parentSection?.title
      };

    } catch (error) {
      console.error('Error getting section context:', error);
      return {};
    }
  }

  /**
   * Build extraction summary
   */
  private buildExtractionSummary(
    totalRequested: number,
    found: number,
    withContent: number,
    totalLength: number,
    truncated: boolean
  ): string {
    let summary = `Izvukao je sadržaj iz ${found}/${totalRequested} traženih sekcija. `;
    
    if (withContent < found) {
      summary += `${withContent} sekcija ima pun sadržaj, ${found - withContent} ima ograničen sadržaj. `;
    }
    
    summary += `Ukupna dužina sadržaja: ${totalLength} karaktera.`;
    
    if (truncated) {
      summary += ` Sadržaj je skraćen zbog ograničenja dužine.`;
    }

    return summary;
  }

  /**
   * Escape regex special characters
   */
  private escapeRegex(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  /**
   * Quick method to get section content by page range
   * Used when exact section matching fails
   */
  async extractContentByPageRange(
    materialId: string,
    pageStart: number,
    pageEnd: number,
    maxLength: number = 4000
  ): Promise<{
    content: string;
    sections: Array<{title: string; pageStart: number; pageEnd: number;}>;
    totalLength: number;
  }> {
    try {
      const sections = await DocumentSection.find({
        docId: new mongoose.Types.ObjectId(materialId),
        $or: [
          { pageStart: { $gte: pageStart, $lte: pageEnd } },
          { pageEnd: { $gte: pageStart, $lte: pageEnd } },
          { $and: [{ pageStart: { $lte: pageStart } }, { pageEnd: { $gte: pageEnd } }] }
        ]
      })
      .sort({ pageStart: 1 })
      .lean();

      let content = '';
      let totalLength = 0;
      const sectionInfo = [];

      for (const section of sections) {
        if (totalLength >= maxLength) break;

        const sectionContent = section.content || '';
        const remainingLength = maxLength - totalLength;
        
        if (sectionContent.length > remainingLength) {
          content += `\n\n## ${section.title}\n${sectionContent.substring(0, remainingLength - 100)}[...]`;
          totalLength = maxLength;
          break;
        } else {
          content += `\n\n## ${section.title}\n${sectionContent}`;
          totalLength += sectionContent.length;
        }

        sectionInfo.push({
          title: section.title,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd
        });
      }

      return {
        content: content.trim(),
        sections: sectionInfo,
        totalLength
      };

    } catch (error) {
      console.error('Error extracting content by page range:', error);
      throw error;
    }
  }
}

export const sectionContentExtractor = new SectionContentExtractor();
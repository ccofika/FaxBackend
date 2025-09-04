import Material  from '../../models/Material';
import DocumentSection  from '../../models/DocumentSection';
import  DocumentChunk from '../../models/DocumentChunk';
import  TocAnalysis from '../../models/TocAnalysis';
import { semanticSearchService } from './semanticSearchService';
import { RelevantSection } from './gptService';
import { IDocumentChunk } from '../../models/DocumentChunk';

export interface MaterialDocument {
  _id: string;
  title: string;
  subjectId: string;
}

class DocumentAnalysisService {
  async findRelevantSections(
    userMessage: string,
    materials: MaterialDocument[],
    mode: string
  ): Promise<RelevantSection[]> {
    try {
      const allRelevantSections: RelevantSection[] = [];

      for (const material of materials) {
        // Step 1: Use TOC analysis to find potentially relevant sections
        const tocRelevantSections = await this.findTocRelevantSections(
          material._id,
          userMessage,
          mode
        );

        // Step 2: Perform semantic search on document chunks for more precise matching
        const semanticRelevantSections = await this.performSemanticSearch(
          material._id,
          userMessage,
          tocRelevantSections
        );

        // Step 3: Combine and score results
        const combinedSections = await this.combineAndScoreSections(
          material,
          tocRelevantSections,
          semanticRelevantSections,
          userMessage
        );

        allRelevantSections.push(...combinedSections);
      }

      // Step 4: Sort by relevance and return top results
      return allRelevantSections
        .sort((a, b) => b.relevanceScore - a.relevanceScore)
        .slice(0, 5); // Top 5 most relevant sections

    } catch (error) {
      console.error('Document Analysis Error:', error);
      return [];
    }
  }

  private async findTocRelevantSections(
    materialId: string,
    userMessage: string,
    mode: string
  ): Promise<string[]> {
    try {
      // Get TOC analysis for the material
      const tocAnalysis = await TocAnalysis.findOne({ docId: materialId });
      if (!tocAnalysis || !tocAnalysis.sections) {
        return [];
      }

      const relevantSectionIds: string[] = [];
      const messageLower = userMessage.toLowerCase();

      // Simple keyword matching for now - can be improved with more sophisticated NLP
      for (let i = 0; i < tocAnalysis.sections.length; i++) {
        const section = tocAnalysis.sections[i];
        if (!section.title) continue;
        
        // Skip generating synthetic section IDs for now - we need real ObjectIds
        // This would require actual DocumentSection records in database
        // For now, just skip TOC matching until proper section records exist
        console.log('Skipping TOC section matching - no valid ObjectIds available for sections');
      }

      return relevantSectionIds;

    } catch (error) {
      console.error('TOC Analysis Error:', error);
      return [];
    }
  }

  private isSemanticallySimilar(message: string, title: string): boolean {
    // Simple semantic similarity check - can be improved with embeddings
    const synonyms = {
      'objasni': ['objašnjava', 'definiše', 'opisuje'],
      'šta': ['kako', 'zašto', 'kada'],
      'primer': ['slučaj', 'situacija', 'scenario'],
      'razlika': ['različito', 'razlikuje', 'poređenje'],
      'formula': ['jednačina', 'izraz', 'kalkulacija']
    };

    for (const [key, values] of Object.entries(synonyms)) {
      if (message.includes(key) && values.some(synonym => title.includes(synonym))) {
        return true;
      }
    }

    return false;
  }

  private async performSemanticSearch(
    materialId: string,
    userMessage: string,
    tocRelevantSections: string[]
  ): Promise<IDocumentChunk[]> {
    try {
      // If we have TOC-identified sections, focus search on those
      const filter = tocRelevantSections.length > 0 
        ? { docId: materialId, sectionId: { $in: tocRelevantSections } }
        : { docId: materialId };

      // Get document chunks for semantic search
      const chunks = await DocumentChunk.find(filter).limit(100);

      if (chunks.length === 0) {
        return [];
      }

      // Use semantic search service to find most relevant chunks
      return await semanticSearchService.searchSimilarChunks(userMessage, chunks);

    } catch (error) {
      console.error('Semantic Search Error:', error);
      return [];
    }
  }

  private async combineAndScoreSections(
    material: MaterialDocument,
    tocRelevantSections: string[],
    semanticResults: IDocumentChunk[],
    userMessage: string
  ): Promise<RelevantSection[]> {
    try {
      const sectionsMap = new Map<string, RelevantSection>();

      // Process semantic search results
      for (const chunk of semanticResults) {
        const sectionId = chunk.sectionId?.toString();
        if (!sectionId) continue;

        // Skip invalid section IDs that are not proper ObjectIds
        if (!sectionId.match(/^[0-9a-fA-F]{24}$/)) {
          console.log('Skipping invalid sectionId:', sectionId);
          continue;
        }
        
        const section = await DocumentSection.findById(sectionId);
        if (!section) continue;

        const existingSection = sectionsMap.get(sectionId);
        const chunkRelevance = chunk.vectorId ? 0.8 : 0.5; // Higher if has vector embeddings

        if (existingSection) {
          // Combine content and update relevance
          existingSection.content += '\n\n' + (chunk.content || '');
          existingSection.relevanceScore = Math.max(existingSection.relevanceScore, chunkRelevance);
        } else {
          sectionsMap.set(sectionId, {
            materialId: material._id,
            materialName: material.title,
            sectionTitle: section.title || 'Untitled Section',
            content: chunk.content || '',
            relevanceScore: chunkRelevance
          });
        }
      }

      // Add bonus score for TOC-identified sections
      for (const sectionId of tocRelevantSections) {
        // Skip invalid section IDs that are not proper ObjectIds
        if (!sectionId.match(/^[0-9a-fA-F]{24}$/)) {
          console.log('Skipping invalid TOC sectionId:', sectionId);
          continue;
        }
        
        const existingSection = sectionsMap.get(sectionId);
        if (existingSection) {
          existingSection.relevanceScore = Math.min(1.0, existingSection.relevanceScore + 0.2);
        } else {
          // Add TOC-identified section even if not found in semantic search
          const section = await DocumentSection.findById(sectionId);
          if (section) {
            // Get some content from chunks in this section
            const sectionChunks = await DocumentChunk.find({ 
              sectionId: sectionId,
              docId: material._id 
            }).limit(3);

            const content = sectionChunks.map(chunk => chunk.content).join('\n\n');

            sectionsMap.set(sectionId, {
              materialId: material._id,
              materialName: material.title,
              sectionTitle: section.title || 'Untitled Section',
              content: content || section.title || '',
              relevanceScore: 0.6 // TOC match bonus
            });
          }
        }
      }

      return Array.from(sectionsMap.values());

    } catch (error) {
      console.error('Section Combination Error:', error);
      return [];
    }
  }
}

export const documentAnalysisService = new DocumentAnalysisService();
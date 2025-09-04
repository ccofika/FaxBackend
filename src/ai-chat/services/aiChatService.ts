import { ChatRequest } from '../controllers/aiChatController';
import { documentAnalysisService } from './documentAnalysisService';
import { gptService } from './gptService';
import Subject from '../../models/Subject';
import Material from '../../models/Material';

export interface ChatResponse {
  message: string;
  mode: string;
  sources: Array<{
    materialId: string;
    materialName: string;
    section: string;
    relevanceScore: number;
  }>;
  processingTime: number;
}

class AIChatService {
  async processChat(request: ChatRequest): Promise<ChatResponse> {
    const startTime = Date.now();

    try {
      // Step 1: Validate subject exists and get related materials
      const subject = await Subject.findById(request.context.subjectId);
      if (!subject) {
        throw new Error('Subject not found');
      }

      // Step 2: Find materials for the subject
      const materials = await Material.find({ subjectId: subject._id });
      if (materials.length === 0) {
        return {
          message: 'Nema dostupnih materijala za odabrani predmet.',
          mode: request.mode,
          sources: [],
          processingTime: Date.now() - startTime
        };
      }

      // Step 3: Analyze documents and find relevant sections
      const materialsForAnalysis = materials.map(material => ({
        _id: (material._id as any).toString(),
        title: material.title,
        subjectId: (material.subjectId as any).toString()
      }));
      
      const relevantSections = await documentAnalysisService.findRelevantSections(
        request.message,
        materialsForAnalysis,
        request.mode
      );

      // Step 4: Generate AI response using GPT with relevant context
      const aiResponse = await gptService.generateResponse({
        userMessage: request.message,
        mode: request.mode,
        relevantSections,
        subject: subject.name
      });

      return {
        message: aiResponse.content,
        mode: request.mode,
        sources: relevantSections.map(section => ({
          materialId: section.materialId,
          materialName: section.materialName,
          section: section.sectionTitle,
          relevanceScore: section.relevanceScore
        })),
        processingTime: Date.now() - startTime
      };

    } catch (error) {
      console.error('AI Chat Service Error:', error);
      throw error;
    }
  }
}

export const aiChatService = new AIChatService();
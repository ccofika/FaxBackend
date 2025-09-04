import ChatHistory, { IChatHistory, IChatMessage } from '../models/ChatHistory';
import { v4 as uuidv4 } from 'uuid';

export interface ChatContext {
  subjectId: string;
  facultyId: string;
  departmentId: string;
  year: number;
}

export interface SaveMessageRequest {
  sessionId: string;
  adminId: string;
  type: 'user' | 'ai';
  content: string;
  mode?: string;
  sources?: Array<{
    materialId: string;
    materialName: string;
    section: string;
    relevanceScore: number;
  }>;
  processingTime?: number;
}

class ChatHistoryService {
  /**
   * Generate a unique session ID
   */
  generateSessionId(adminId: string, context: ChatContext): string {
    const timestamp = Date.now();
    const contextString = `${context.subjectId}_${context.facultyId}_${context.departmentId}_${context.year}`;
    return `${adminId}_${contextString}_${timestamp}`;
  }

  /**
   * Create or get existing chat session
   */
  async getOrCreateSession(
    adminId: string, 
    sessionId: string, 
    context: ChatContext
  ): Promise<IChatHistory> {
    try {
      // Try to find existing session
      let chatHistory = await ChatHistory.findOne({ sessionId });

      if (!chatHistory) {
        // Create new session
        chatHistory = new ChatHistory({
          adminId,
          sessionId,
          context: {
            subjectId: context.subjectId,
            facultyId: context.facultyId,
            departmentId: context.departmentId,
            year: context.year
          },
          messages: []
        });
        await chatHistory.save();
      }

      return chatHistory;
    } catch (error) {
      console.error('Error getting or creating chat session:', error);
      throw error;
    }
  }

  /**
   * Save a new message to chat history
   */
  async saveMessage(request: SaveMessageRequest): Promise<IChatMessage> {
    try {
      const chatHistory = await ChatHistory.findOne({ sessionId: request.sessionId });
      
      if (!chatHistory) {
        throw new Error('Chat session not found');
      }

      const newMessage: IChatMessage = {
        id: uuidv4(),
        type: request.type,
        content: request.content,
        mode: request.mode,
        sources: request.sources || [],
        timestamp: new Date(),
        processingTime: request.processingTime
      };

      // Add message directly to array
      chatHistory.messages.push(newMessage);
      await chatHistory.save();

      return newMessage;
    } catch (error) {
      console.error('Error saving chat message:', error);
      throw error;
    }
  }

  /**
   * Get chat history for a session
   */
  async getChatHistory(sessionId: string): Promise<IChatHistory | null> {
    try {
      const chatHistory = await ChatHistory.findOne({ sessionId })
        .populate('context.subjectId', 'name')
        .populate('context.facultyId', 'name')
        .populate('context.departmentId', 'name')
        .sort({ 'messages.timestamp': 1 }); // Sort messages chronologically

      return chatHistory;
    } catch (error) {
      console.error('Error getting chat history:', error);
      throw error;
    }
  }

  /**
   * Get all chat sessions for an admin
   */
  async getAdminChatSessions(
    adminId: string, 
    limit: number = 10, 
    skip: number = 0
  ): Promise<IChatHistory[]> {
    try {
      const sessions = await ChatHistory.find({ adminId })
        .populate('context.subjectId', 'name')
        .populate('context.facultyId', 'name')
        .populate('context.departmentId', 'name')
        .sort({ updatedAt: -1 })
        .limit(limit)
        .skip(skip)
        .select('sessionId context messages.length createdAt updatedAt'); // Only essential fields

      return sessions;
    } catch (error) {
      console.error('Error getting admin chat sessions:', error);
      throw error;
    }
  }

  /**
   * Clear all messages in a chat session
   */
  async clearChatHistory(sessionId: string, adminId: string): Promise<boolean> {
    try {
      const chatHistory = await ChatHistory.findOne({ 
        sessionId, 
        adminId // Security check - only owner can clear
      });

      if (!chatHistory) {
        throw new Error('Chat session not found or access denied');
      }

      // Clear messages directly
      chatHistory.messages = [];
      await chatHistory.save();

      return true;
    } catch (error) {
      console.error('Error clearing chat history:', error);
      throw error;
    }
  }

  /**
   * Delete entire chat session
   */
  async deleteChatSession(sessionId: string, adminId: string): Promise<boolean> {
    try {
      const result = await ChatHistory.deleteOne({ 
        sessionId, 
        adminId // Security check - only owner can delete
      });

      return result.deletedCount > 0;
    } catch (error) {
      console.error('Error deleting chat session:', error);
      throw error;
    }
  }

  /**
   * Get chat statistics for an admin
   */
  async getChatStats(adminId: string): Promise<{
    totalSessions: number;
    totalMessages: number;
    averageMessagesPerSession: number;
    lastActivity: Date | null;
  }> {
    try {
      const stats = await ChatHistory.aggregate([
        { $match: { adminId: adminId } },
        {
          $group: {
            _id: null,
            totalSessions: { $sum: 1 },
            totalMessages: { $sum: { $size: '$messages' } },
            lastActivity: { $max: '$updatedAt' }
          }
        }
      ]);

      const result = stats[0] || {
        totalSessions: 0,
        totalMessages: 0,
        lastActivity: null
      };

      return {
        ...result,
        averageMessagesPerSession: result.totalSessions > 0 
          ? Math.round(result.totalMessages / result.totalSessions * 100) / 100
          : 0
      };
    } catch (error) {
      console.error('Error getting chat statistics:', error);
      throw error;
    }
  }
}

export const chatHistoryService = new ChatHistoryService();
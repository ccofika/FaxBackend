import { Request, Response } from 'express';
import { aiChatService } from '../services/aiChatService';
import { chatHistoryService, ChatContext } from '../services/chatHistoryService';

export interface ChatRequest {
  message: string;
  mode: 'Explain' | 'Learn' | 'Test' | 'Summary' | 'Solve';
  sessionId?: string;
  context: {
    subjectId: string;
    facultyId: string;
    departmentId: string;
    year: number;
  };
}

export interface ChatHistoryRequest {
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

export const chatWithAI = async (req: Request, res: Response) => {
  try {
    console.log('=== AI Chat Request ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { message, mode, sessionId, context }: ChatRequest = req.body;
    const adminId = (req as any).admin?.adminId || (req as any).user?.id;
    
    console.log('Extracted adminId:', adminId);
    console.log('Message:', message);
    console.log('Mode:', mode);
    console.log('SessionId:', sessionId);
    console.log('Context:', context);

    if (!message || !mode || !context) {
      console.log('Missing required fields - message:', !!message, 'mode:', !!mode, 'context:', !!context);
      return res.status(400).json({
        success: false,
        error: 'Message, mode, and context are required'
      });
    }

    if (!context.subjectId) {
      console.log('Missing subjectId in context');
      return res.status(400).json({
        success: false,
        error: 'Subject ID is required in context'
      });
    }

    if (!adminId) {
      console.log('Missing adminId - authentication failed');
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    // Generate or use provided session ID
    const actualSessionId = sessionId || chatHistoryService.generateSessionId(adminId, context);
    console.log('Generated sessionId:', actualSessionId);

    // Get or create chat session
    console.log('Creating/getting chat session...');
    await chatHistoryService.getOrCreateSession(adminId, actualSessionId, context);
    console.log('Chat session created/retrieved successfully');

    // Save user message first
    console.log('Saving user message...');
    await chatHistoryService.saveMessage({
      sessionId: actualSessionId,
      adminId,
      type: 'user',
      content: message,
      mode
    });
    console.log('User message saved successfully');

    // Process AI response
    console.log('Processing AI response...');
    const response = await aiChatService.processChat({
      message,
      mode,
      context
    });
    console.log('AI response processed:', response);

    // Save AI response
    await chatHistoryService.saveMessage({
      sessionId: actualSessionId,
      adminId,
      type: 'ai',
      content: response.message,
      mode,
      sources: response.sources,
      processingTime: response.processingTime
    });

    res.json({
      success: true,
      data: {
        ...response,
        sessionId: actualSessionId
      }
    });

  } catch (error) {
    console.error('=== AI Chat ERROR ===');
    console.error('Error details:', error);
    console.error('Stack trace:', (error as Error).stack);
    res.status(500).json({
      success: false,
      error: 'Internal server error during AI processing'
    });
  }
};

// Get chat history for a session
export const getChatHistory = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const adminId = (req as any).admin?.adminId || (req as any).user?.id;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    const chatHistory = await chatHistoryService.getChatHistory(sessionId);

    if (!chatHistory) {
      return res.status(404).json({
        success: false,
        error: 'Chat session not found'
      });
    }

    // Security check - only owner can view chat history
    if (chatHistory.adminId.toString() !== adminId) {
      return res.status(403).json({
        success: false,
        error: 'Access denied'
      });
    }

    res.json({
      success: true,
      data: chatHistory
    });

  } catch (error) {
    console.error('Get Chat History Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching chat history'
    });
  }
};

// Clear chat history for a session
export const clearChatHistory = async (req: Request, res: Response) => {
  try {
    const { sessionId } = req.params;
    const adminId = (req as any).admin?.adminId || (req as any).user?.id;

    if (!sessionId) {
      return res.status(400).json({
        success: false,
        error: 'Session ID is required'
      });
    }

    if (!adminId) {
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    const success = await chatHistoryService.clearChatHistory(sessionId, adminId);

    if (!success) {
      return res.status(404).json({
        success: false,
        error: 'Chat session not found or access denied'
      });
    }

    res.json({
      success: true,
      message: 'Chat history cleared successfully'
    });

  } catch (error) {
    console.error('Clear Chat History Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while clearing chat history'
    });
  }
};

// Get admin's chat sessions
export const getAdminChatSessions = async (req: Request, res: Response) => {
  try {
    const adminId = (req as any).admin?.adminId || (req as any).user?.id;
    const limit = parseInt(req.query.limit as string) || 10;
    const skip = parseInt(req.query.skip as string) || 0;

    if (!adminId) {
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    const sessions = await chatHistoryService.getAdminChatSessions(adminId, limit, skip);
    const stats = await chatHistoryService.getChatStats(adminId);

    res.json({
      success: true,
      data: {
        sessions,
        stats,
        pagination: {
          limit,
          skip,
          total: stats.totalSessions
        }
      }
    });

  } catch (error) {
    console.error('Get Admin Chat Sessions Error:', error);
    res.status(500).json({
      success: false,
      error: 'Internal server error while fetching chat sessions'
    });
  }
};

// Save individual message to chat history
export const saveMessage = async (req: Request, res: Response) => {
  try {
    console.log('=== Save Message Request ===');
    console.log('Request body:', JSON.stringify(req.body, null, 2));
    
    const { sessionId, type, content, mode, context } = req.body;
    const adminId = (req as any).admin?.adminId || (req as any).user?.id;
    
    console.log('Extracted adminId:', adminId);
    console.log('SessionId:', sessionId);
    console.log('Type:', type);
    console.log('Content:', content);
    console.log('Mode:', mode);
    console.log('Context:', context);

    if (!sessionId || !type || !content) {
      console.log('Missing required fields - sessionId:', !!sessionId, 'type:', !!type, 'content:', !!content);
      return res.status(400).json({
        success: false,
        error: 'SessionId, type, and content are required'
      });
    }

    if (!adminId) {
      console.log('Missing adminId - authentication failed');
      return res.status(401).json({
        success: false,
        error: 'Admin authentication required'
      });
    }

    // First check if session exists, if not create it with context if provided
    console.log('Checking if session exists...');
    let chatHistory = await chatHistoryService.getChatHistory(sessionId);
    console.log('Session exists:', !!chatHistory);
    
    if (!chatHistory && context && context.subjectId && context.facultyId && context.departmentId && context.year) {
      console.log('Creating new session with context...');
      // Create session if it doesn't exist and we have context
      await chatHistoryService.getOrCreateSession(adminId, sessionId, {
        subjectId: context.subjectId,
        facultyId: context.facultyId,
        departmentId: context.departmentId,
        year: context.year
      });
      console.log('Session created successfully');
    }

    console.log('Saving message to database...');
    const savedMessage = await chatHistoryService.saveMessage({
      sessionId,
      adminId,
      type,
      content,
      mode
    });
    console.log('Message saved successfully:', savedMessage);

    res.json({
      success: true,
      data: savedMessage
    });

  } catch (error) {
    console.error('=== Save Message ERROR ===');
    console.error('Error details:', error);
    console.error('Stack trace:', (error as Error).stack);
    res.status(500).json({
      success: false,
      error: 'Internal server error while saving message'
    });
  }
};
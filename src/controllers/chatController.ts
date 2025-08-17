import { Request, Response } from 'express';
import { Types } from 'mongoose';
import { Chat, Message, User } from '../models';
import { AuthRequest } from '../middleware/auth';

interface CreateChatBody {
  title: string;
  mode: 'explain' | 'solve' | 'summary' | 'tests' | 'learning';
  subject?: {
    id: string;
    name: string;
    code: string;
    faculty: string;
  };
  lessons?: Array<{
    id: string;
    title: string;
    description: string;
  }>;
  initialMessage?: string;
}

interface SendMessageBody {
  content: string;
  attachments?: Array<{
    type: 'image' | 'document' | 'link';
    url: string;
    name: string;
    size?: number;
  }>;
}

export const createChat = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { title, mode, subject, lessons, initialMessage }: CreateChatBody = req.body;

    if (!title || !mode) {
      return res.status(400).json({ error: 'Title and mode are required' });
    }

    // Create the chat
    const chat = new Chat({
      userId,
      title: title.trim(),
      mode,
      subject,
      lessons: lessons || [],
      lastMessageAt: new Date(),
      messageCount: 0
    });

    await chat.save();

    // If there's an initial message, create it
    if (initialMessage && initialMessage.trim()) {
      const userMessage = new Message({
        chatId: chat._id,
        userId,
        content: initialMessage.trim(),
        type: 'user'
      });

      await userMessage.save();

      // Create bot response
      const botMessage = new Message({
        chatId: chat._id,
        userId,
        content: 'Sačuvano na bazi', // Temporary response as requested
        type: 'bot',
        metadata: {
          processingTime: 100,
          model: 'temp-bot-v1'
        }
      });

      await botMessage.save();

      // Update chat message count and last message time
      await chat.updateLastMessage();
      await chat.updateLastMessage(); // Called twice for both messages
    }

    // Update user conversation count
    await User.findByIdAndUpdate(userId, { 
      $inc: { totalConversations: 1 } 
    });

    res.status(201).json({
      message: 'Chat created successfully',
      chat: {
        id: chat._id,
        title: chat.title,
        mode: chat.mode,
        subject: chat.subject,
        lessons: chat.lessons,
        messageCount: chat.messageCount,
        lastMessageAt: chat.lastMessageAt,
        createdAt: chat.createdAt
      }
    });
  } catch (error: any) {
    console.error('Create chat error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({ error: messages.join(', ') });
    }

    res.status(500).json({ error: 'Internal server error while creating chat' });
  }
};

export const getUserChats = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 20;
    const isArchived = req.query.archived === 'true';

    const skip = (page - 1) * limit;

    const chats = await Chat.find({ 
      userId, 
      isArchived 
    })
    .sort({ lastMessageAt: -1 })
    .skip(skip)
    .limit(limit)
    .lean();

    const totalChats = await Chat.countDocuments({ userId, isArchived });
    const totalPages = Math.ceil(totalChats / limit);

    res.json({
      chats: chats.map(chat => ({
        id: chat._id,
        title: chat.title,
        mode: chat.mode,
        subject: chat.subject,
        messageCount: chat.messageCount,
        lastMessageAt: chat.lastMessageAt,
        createdAt: chat.createdAt
      })),
      pagination: {
        currentPage: page,
        totalPages,
        totalChats,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('Get user chats error:', error);
    res.status(500).json({ error: 'Internal server error while fetching chats' });
  }
};

export const getChatById = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { chatId } = req.params;

    if (!Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ error: 'Invalid chat ID' });
    }

    const chat = await Chat.findOne({ 
      _id: chatId, 
      userId 
    }).lean();

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({
      chat: {
        id: chat._id,
        title: chat.title,
        mode: chat.mode,
        subject: chat.subject,
        lessons: chat.lessons,
        messageCount: chat.messageCount,
        lastMessageAt: chat.lastMessageAt,
        isArchived: chat.isArchived,
        createdAt: chat.createdAt
      }
    });
  } catch (error) {
    console.error('Get chat by ID error:', error);
    res.status(500).json({ error: 'Internal server error while fetching chat' });
  }
};

export const getChatMessages = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { chatId } = req.params;
    const page = parseInt(req.query.page as string) || 1;
    const limit = parseInt(req.query.limit as string) || 50;

    if (!Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ error: 'Invalid chat ID' });
    }

    // Verify chat belongs to user
    const chat = await Chat.findOne({ _id: chatId, userId });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    const skip = (page - 1) * limit;

    const messages = await Message.find({ 
      chatId, 
      isDeleted: false 
    })
    .sort({ createdAt: 1 }) // Oldest first for chat messages
    .skip(skip)
    .limit(limit)
    .lean();

    const totalMessages = await Message.countDocuments({ chatId, isDeleted: false });
    const totalPages = Math.ceil(totalMessages / limit);

    res.json({
      messages: messages.map(message => ({
        id: message._id,
        type: message.type,
        content: message.content,
        attachments: message.attachments,
        metadata: message.metadata,
        isEdited: message.isEdited,
        editedAt: message.editedAt,
        reactionEmoji: message.reactionEmoji,
        createdAt: message.createdAt
      })),
      pagination: {
        currentPage: page,
        totalPages,
        totalMessages,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('Get chat messages error:', error);
    res.status(500).json({ error: 'Internal server error while fetching messages' });
  }
};

export const sendMessage = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { chatId } = req.params;
    const { content, attachments }: SendMessageBody = req.body;

    if (!Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ error: 'Invalid chat ID' });
    }

    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'Message content is required' });
    }

    // Verify chat belongs to user
    const chat = await Chat.findOne({ _id: chatId, userId });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    if (chat.isArchived) {
      return res.status(400).json({ error: 'Cannot send messages to archived chat' });
    }

    // Create user message
    const userMessage = new Message({
      chatId,
      userId,
      content: content.trim(),
      type: 'user',
      attachments: attachments || []
    });

    await userMessage.save();

    // Update chat last message time and count
    await chat.updateLastMessage();

    // Create bot response (for now just the temporary response)
    const botMessage = new Message({
      chatId,
      userId,
      content: 'Sačuvano na bazi', // Temporary response as requested
      type: 'bot',
      metadata: {
        processingTime: Math.floor(Math.random() * 1000) + 500, // Random processing time 500-1500ms
        model: 'temp-bot-v1'
      }
    });

    await botMessage.save();
    await chat.updateLastMessage();

    res.status(201).json({
      message: 'Message sent successfully',
      userMessage: {
        id: userMessage._id,
        type: userMessage.type,
        content: userMessage.content,
        attachments: userMessage.attachments,
        createdAt: userMessage.createdAt
      },
      botMessage: {
        id: botMessage._id,
        type: botMessage.type,
        content: botMessage.content,
        metadata: botMessage.metadata,
        createdAt: botMessage.createdAt
      }
    });
  } catch (error: any) {
    console.error('Send message error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({ error: messages.join(', ') });
    }

    res.status(500).json({ error: 'Internal server error while sending message' });
  }
};

export const updateChat = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { chatId } = req.params;
    const { title, isArchived } = req.body;

    if (!Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ error: 'Invalid chat ID' });
    }

    const updateData: any = {};
    if (title !== undefined) updateData.title = title.trim();
    if (isArchived !== undefined) updateData.isArchived = isArchived;

    const chat = await Chat.findOneAndUpdate(
      { _id: chatId, userId },
      updateData,
      { new: true, runValidators: true }
    );

    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    res.json({
      message: 'Chat updated successfully',
      chat: {
        id: chat._id,
        title: chat.title,
        mode: chat.mode,
        subject: chat.subject,
        messageCount: chat.messageCount,
        lastMessageAt: chat.lastMessageAt,
        isArchived: chat.isArchived,
        createdAt: chat.createdAt,
        updatedAt: chat.updatedAt
      }
    });
  } catch (error: any) {
    console.error('Update chat error:', error);
    
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map((err: any) => err.message);
      return res.status(400).json({ error: messages.join(', ') });
    }

    res.status(500).json({ error: 'Internal server error while updating chat' });
  }
};

export const deleteChat = async (req: AuthRequest, res: Response) => {
  try {
    const userId = req.user!._id;
    const { chatId } = req.params;

    if (!Types.ObjectId.isValid(chatId)) {
      return res.status(400).json({ error: 'Invalid chat ID' });
    }

    const chat = await Chat.findOne({ _id: chatId, userId });
    if (!chat) {
      return res.status(404).json({ error: 'Chat not found' });
    }

    // Delete all messages in the chat
    await Message.deleteMany({ chatId });
    
    // Delete the chat
    await Chat.findByIdAndDelete(chatId);

    // Update user conversation count
    await User.findByIdAndUpdate(userId, { 
      $inc: { totalConversations: -1 } 
    });

    res.json({ message: 'Chat deleted successfully' });
  } catch (error) {
    console.error('Delete chat error:', error);
    res.status(500).json({ error: 'Internal server error while deleting chat' });
  }
};
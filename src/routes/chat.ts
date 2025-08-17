import express from 'express';
import { authenticateToken } from '../middleware/auth';
import {
  createChat,
  getUserChats,
  getChatById,
  getChatMessages,
  sendMessage,
  updateChat,
  deleteChat
} from '../controllers/chatController';

const router = express.Router();

// All routes require authentication
router.use(authenticateToken);

// Chat CRUD operations
router.post('/', createChat);
router.get('/', getUserChats);
router.get('/:chatId', getChatById);
router.put('/:chatId', updateChat);
router.delete('/:chatId', deleteChat);

// Message operations
router.get('/:chatId/messages', getChatMessages);
router.post('/:chatId/messages', sendMessage);

export default router;
import { Router } from 'express';
import { 
  chatWithAI, 
  getChatHistory, 
  clearChatHistory, 
  getAdminChatSessions,
  saveMessage
} from '../controllers/aiChatController';
import { adminAuth } from '../../middleware/adminAuth';

const router = Router();

router.use(adminAuth);

// Chat endpoints
router.post('/chat', chatWithAI);
router.get('/chat/history/:sessionId', getChatHistory);
router.delete('/chat/clear/:sessionId', clearChatHistory);
router.get('/chat/sessions', getAdminChatSessions);
router.post('/chat/save', saveMessage);

export default router;
import express from 'express';
import authRoutes from './auth';
import profileRoutes from './profile';
import chatRoutes from './chat';

const router = express.Router();

router.use('/auth', authRoutes);
router.use('/profile', profileRoutes);
router.use('/chats', chatRoutes);

export default router;

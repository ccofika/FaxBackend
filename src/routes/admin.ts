import { Router } from 'express';
import { adminLogin, adminLogout, adminMe } from '../controllers/adminController';
import { adminAuth } from '../middleware/adminAuth';

const router = Router();

// Public admin routes
router.post('/login', adminLogin);

// Protected admin routes
router.post('/logout', adminAuth, adminLogout);
router.get('/me', adminAuth, adminMe);

export default router;
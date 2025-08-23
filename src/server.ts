import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import mongoose from 'mongoose';
import authRoutes from './routes/auth';
import profileRoutes from './routes/profile';
import chatRoutes from './routes/chat';
import adminRoutes from './routes/admin';
import materialsRoutes from './routes/materials';
import uploadRoutes from './routes/upload';
import ingestionRoutes from './routes/ingestion';
import { resetMonthlyPrompts } from './middleware/monthlyReset';

const app = express();
const PORT = process.env.PORT || 5000;

// TESTING: Increased rate limit to prevent logout issues during development
// TODO: Reduce these limits for production deployment
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10000, // Increased from 100 to 10000 requests per window
  message: 'Too many requests from this IP, please try again later.'
});

app.use(helmet());
app.use(limiter);

app.use(cors({
  origin: process.env.FRONTEND_URL || 'http://localhost:3000',
  credentials: true
}));

app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

mongoose.connect(process.env.MONGODB_URI!)
  .then(() => {
    console.log('Connected to MongoDB');
    // Run monthly reset check on startup
    resetMonthlyPrompts();
  })
  .catch((error) => console.error('MongoDB connection error:', error));

app.use('/api/auth', authRoutes);
app.use('/api/profile', profileRoutes);
app.use('/api/chats', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/materials', materialsRoutes);
app.use('/api/upload', uploadRoutes);
app.use('/api/ingestion', ingestionRoutes);

app.get('/', (req, res) => {
  res.json({ message: 'FAXit Backend Server is running!' });
});

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', timestamp: new Date().toISOString() });
});

const server = app.listen(PORT, () => {
  console.log(`Server is running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || 'development'}`);
  
  // Set up daily check for monthly reset (runs at midnight)
  setInterval(() => {
    const now = new Date();
    if (now.getHours() === 0 && now.getMinutes() === 0) {
      resetMonthlyPrompts();
    }
  }, 60000); // Check every minute
});

process.on('SIGTERM', () => {
  console.log('SIGTERM received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, shutting down gracefully');
  server.close(() => {
    console.log('Process terminated');
  });
});
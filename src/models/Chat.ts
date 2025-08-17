import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IChat extends Document {
  _id: Types.ObjectId;
  userId: Types.ObjectId;
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
  lastMessageAt: Date;
  messageCount: number;
  isArchived: boolean;
  createdAt: Date;
  updatedAt: Date;
  updateLastMessage(): Promise<IChat>;
}

const ChatSchema = new Schema<IChat>({
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  title: {
    type: String,
    required: true,
    trim: true,
    maxlength: [200, 'Chat title cannot exceed 200 characters']
  },
  mode: {
    type: String,
    enum: ['explain', 'solve', 'summary', 'tests', 'learning'],
    required: true,
    index: true
  },
  subject: {
    id: {
      type: String,
      trim: true
    },
    name: {
      type: String,
      trim: true,
      maxlength: [100, 'Subject name cannot exceed 100 characters']
    },
    code: {
      type: String,
      trim: true,
      maxlength: [20, 'Subject code cannot exceed 20 characters']
    },
    faculty: {
      type: String,
      trim: true,
      maxlength: [100, 'Faculty name cannot exceed 100 characters']
    }
  },
  lessons: [{
    id: {
      type: String,
      required: true,
      trim: true
    },
    title: {
      type: String,
      required: true,
      trim: true,
      maxlength: [200, 'Lesson title cannot exceed 200 characters']
    },
    description: {
      type: String,
      trim: true,
      maxlength: [500, 'Lesson description cannot exceed 500 characters']
    }
  }],
  lastMessageAt: {
    type: Date,
    default: Date.now,
    index: true
  },
  messageCount: {
    type: Number,
    default: 0,
    min: 0
  },
  isArchived: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for efficient queries
ChatSchema.index({ userId: 1, lastMessageAt: -1 });
ChatSchema.index({ userId: 1, isArchived: 1, lastMessageAt: -1 });
ChatSchema.index({ userId: 1, mode: 1, lastMessageAt: -1 });

// Update lastMessageAt when a new message is added
ChatSchema.methods.updateLastMessage = function() {
  this.lastMessageAt = new Date();
  this.messageCount += 1;
  return this.save();
};

export default mongoose.model<IChat>('Chat', ChatSchema);
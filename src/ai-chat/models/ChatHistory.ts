import mongoose, { Document, Schema } from 'mongoose';

export interface IChatMessage {
  id: string;
  type: 'user' | 'ai';
  content: string;
  mode?: string;
  sources?: Array<{
    materialId: string;
    materialName: string;
    section: string;
    relevanceScore: number;
  }>;
  timestamp: Date;
  processingTime?: number;
}

export interface IChatHistory extends Document {
  adminId: mongoose.Types.ObjectId;
  sessionId: string;
  context: {
    subjectId: mongoose.Types.ObjectId;
    facultyId: mongoose.Types.ObjectId;
    departmentId: mongoose.Types.ObjectId;
    year: number;
  };
  messages: IChatMessage[];
  createdAt: Date;
  updatedAt: Date;
}

const ChatMessageSchema = new Schema({
  id: {
    type: String,
    required: true,
    trim: true
  },
  type: {
    type: String,
    enum: ['user', 'ai'],
    required: true
  },
  content: {
    type: String,
    required: true,
    trim: true,
    maxlength: [10000, 'Message content cannot exceed 10000 characters']
  },
  mode: {
    type: String,
    enum: ['Explain', 'Learn', 'Test', 'Summary', 'Solve'],
    trim: true
  },
  sources: [{
    materialId: {
      type: String,
      required: true,
      trim: true
    },
    materialName: {
      type: String,
      required: true,
      trim: true
    },
    section: {
      type: String,
      required: true,
      trim: true
    },
    relevanceScore: {
      type: Number,
      required: true,
      min: 0,
      max: 1
    }
  }],
  timestamp: {
    type: Date,
    default: Date.now,
    required: true
  },
  processingTime: {
    type: Number,
    min: 0
  }
}, { _id: false });

const ChatHistorySchema = new Schema<IChatHistory>({
  adminId: {
    type: Schema.Types.ObjectId,
    ref: 'Admin',
    required: [true, 'Admin ID is required']
  },
  sessionId: {
    type: String,
    required: [true, 'Session ID is required'],
    trim: true,
    unique: true,
    maxlength: [100, 'Session ID cannot exceed 100 characters']
  },
  context: {
    subjectId: {
      type: Schema.Types.ObjectId,
      ref: 'Subject',
      required: [true, 'Subject ID is required']
    },
    facultyId: {
      type: Schema.Types.ObjectId,
      ref: 'Faculty',
      required: [true, 'Faculty ID is required']
    },
    departmentId: {
      type: Schema.Types.ObjectId,
      ref: 'Department',
      required: [true, 'Department ID is required']
    },
    year: {
      type: Number,
      required: [true, 'Year is required'],
      min: 1,
      max: 8
    }
  },
  messages: {
    type: [ChatMessageSchema],
    default: [],
    validate: {
      validator: function(messages: IChatMessage[]) {
        return messages.length <= 1000; // Max 1000 messages per session
      },
      message: 'Cannot exceed 1000 messages per chat session'
    }
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
ChatHistorySchema.index({ adminId: 1, sessionId: 1 });
ChatHistorySchema.index({ sessionId: 1 }, { unique: true });
ChatHistorySchema.index({ adminId: 1, 'context.subjectId': 1 });
ChatHistorySchema.index({ 'messages.timestamp': -1 });
ChatHistorySchema.index({ createdAt: -1 });

// Method to add a new message
ChatHistorySchema.methods.addMessage = function(message: Omit<IChatMessage, 'timestamp'>) {
  const messageWithTimestamp: IChatMessage = {
    ...message,
    timestamp: new Date()
  };
  this.messages.push(messageWithTimestamp);
  return this.save();
};

// Method to clear all messages
ChatHistorySchema.methods.clearMessages = function() {
  this.messages = [];
  return this.save();
};

// Static method to generate session ID
ChatHistorySchema.statics.generateSessionId = function(adminId: string, context: any): string {
  const timestamp = Date.now();
  const contextString = `${context.subjectId}_${context.facultyId}_${context.departmentId}_${context.year}`;
  return `${adminId}_${contextString}_${timestamp}`;
};

export default mongoose.model<IChatHistory>('ChatHistory', ChatHistorySchema);
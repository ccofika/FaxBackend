import mongoose, { Document, Schema, Types } from 'mongoose';

export interface IMessage extends Document {
  _id: Types.ObjectId;
  chatId: Types.ObjectId;
  userId: Types.ObjectId;
  content: string;
  type: 'user' | 'bot';
  attachments?: Array<{
    type: 'image' | 'document' | 'link';
    url: string;
    name: string;
    size?: number;
  }>;
  metadata?: {
    tokenCount?: number;
    processingTime?: number;
    model?: string;
    temperature?: number;
  };
  isEdited: boolean;
  editedAt?: Date;
  reactionEmoji?: string;
  isDeleted: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const MessageSchema = new Schema<IMessage>({
  chatId: {
    type: Schema.Types.ObjectId,
    ref: 'Chat',
    required: true,
    index: true
  },
  userId: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  content: {
    type: String,
    required: true,
    trim: true,
    maxlength: [10000, 'Message content cannot exceed 10000 characters']
  },
  type: {
    type: String,
    enum: ['user', 'bot'],
    required: true,
    index: true
  },
  attachments: [{
    type: {
      type: String,
      enum: ['image', 'document', 'link'],
      required: true
    },
    url: {
      type: String,
      required: true,
      trim: true
    },
    name: {
      type: String,
      required: true,
      trim: true,
      maxlength: [255, 'Attachment name cannot exceed 255 characters']
    },
    size: {
      type: Number,
      min: 0
    }
  }],
  metadata: {
    tokenCount: {
      type: Number,
      min: 0
    },
    processingTime: {
      type: Number,
      min: 0
    },
    model: {
      type: String,
      trim: true,
      maxlength: [50, 'Model name cannot exceed 50 characters']
    },
    temperature: {
      type: Number,
      min: 0,
      max: 2
    }
  },
  isEdited: {
    type: Boolean,
    default: false
  },
  editedAt: {
    type: Date
  },
  reactionEmoji: {
    type: String,
    maxlength: [10, 'Reaction emoji cannot exceed 10 characters']
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  }
}, {
  timestamps: true
});

// Compound indexes for efficient pagination and querying
MessageSchema.index({ chatId: 1, createdAt: -1 });
MessageSchema.index({ chatId: 1, isDeleted: 1, createdAt: -1 });
MessageSchema.index({ userId: 1, type: 1, createdAt: -1 });

// Pre-save middleware to set editedAt when message is edited
MessageSchema.pre('save', function(next) {
  if (this.isModified('content') && !this.isNew) {
    this.isEdited = true;
    this.editedAt = new Date();
  }
  next();
});

// Method to soft delete a message
MessageSchema.methods.softDelete = function() {
  this.isDeleted = true;
  return this.save();
};

export default mongoose.model<IMessage>('Message', MessageSchema);
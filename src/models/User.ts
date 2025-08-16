import mongoose, { Document, Schema } from 'mongoose';
import bcrypt from 'bcryptjs';

export interface IUser extends Document {
  username: string;
  email: string;
  password: string;
  firstName: string;
  lastName: string;
  dateOfBirth?: Date;
  phone?: string;
  faculty?: string;
  academicYear?: string;
  major?: string;
  semester?: string;
  selectedPlan?: string;
  weakPoints?: string[];
  profilePicture?: string;
  isVerified: boolean;
  // Appearance settings
  colorMode?: 'dark' | 'light' | 'auto';
  chatFont?: 'system' | 'mono' | 'serif';
  // Privacy settings
  dataCollection?: boolean;
  chatHistory?: boolean;
  analytics?: boolean;
  marketingEmails?: boolean;
  // Account stats
  totalConversations?: number;
  promptsUsedThisMonth?: number;
  monthlyPromptLimit?: number;
  lastMonthlyReset?: Date;
  createdAt: Date;
  updatedAt: Date;
  comparePassword(candidatePassword: string): Promise<boolean>;
}

const UserSchema = new Schema<IUser>({
  username: {
    type: String,
    required: [true, 'Username is required'],
    unique: true,
    trim: true,
    minlength: [3, 'Username must be at least 3 characters'],
    maxlength: [30, 'Username cannot exceed 30 characters'],
    match: [/^[a-zA-Z0-9_]+$/, 'Username can only contain letters, numbers, and underscores']
  },
  email: {
    type: String,
    required: [true, 'Email is required'],
    unique: true,
    lowercase: true,
    trim: true,
    match: [/^\w+([.-]?\w+)*@\w+([.-]?\w+)*(\.\w{2,3})+$/, 'Please enter a valid email']
  },
  password: {
    type: String,
    required: [true, 'Password is required'],
    minlength: [6, 'Password must be at least 6 characters'],
    select: false
  },
  firstName: {
    type: String,
    required: [true, 'First name is required'],
    trim: true,
    maxlength: [50, 'First name cannot exceed 50 characters']
  },
  lastName: {
    type: String,
    required: [true, 'Last name is required'],
    trim: true,
    maxlength: [50, 'Last name cannot exceed 50 characters']
  },
  dateOfBirth: {
    type: Date,
    validate: {
      validator: function(date: Date) {
        return date < new Date();
      },
      message: 'Date of birth must be in the past'
    }
  },
  phone: {
    type: String,
    trim: true,
    maxlength: [20, 'Phone number cannot exceed 20 characters']
  },
  faculty: {
    type: String,
    trim: true,
    maxlength: [100, 'Faculty name cannot exceed 100 characters']
  },
  academicYear: {
    type: String,
    trim: true,
    maxlength: [50, 'Academic year cannot exceed 50 characters']
  },
  major: {
    type: String,
    trim: true,
    maxlength: [100, 'Major cannot exceed 100 characters']
  },
  semester: {
    type: String,
    trim: true,
    maxlength: [50, 'Semester cannot exceed 50 characters']
  },
  selectedPlan: {
    type: String,
    enum: ['basic', 'premium', 'pro', 'free', 'max'],
    default: 'free',
    trim: true
  },
  weakPoints: [{
    type: String,
    trim: true
  }],
  profilePicture: {
    type: String,
    default: null
  },
  isVerified: {
    type: Boolean,
    default: false
  },
  // Appearance settings
  colorMode: {
    type: String,
    enum: ['dark', 'light', 'auto'],
    default: 'dark'
  },
  chatFont: {
    type: String,
    enum: ['system', 'mono', 'serif'],
    default: 'system'
  },
  // Privacy settings
  dataCollection: {
    type: Boolean,
    default: true
  },
  chatHistory: {
    type: Boolean,
    default: true
  },
  analytics: {
    type: Boolean,
    default: false
  },
  marketingEmails: {
    type: Boolean,
    default: false
  },
  // Account stats
  totalConversations: {
    type: Number,
    default: 0,
    min: 0
  },
  promptsUsedThisMonth: {
    type: Number,
    default: 0,
    min: 0
  },
  monthlyPromptLimit: {
    type: Number,
    default: 10,
    min: 0
  },
  lastMonthlyReset: {
    type: Date,
    default: Date.now
  }
}, {
  timestamps: true
});

UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(12);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error as Error);
  }
});

UserSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    throw error;
  }
};

UserSchema.index({ email: 1 });
UserSchema.index({ username: 1 });

export default mongoose.model<IUser>('User', UserSchema);
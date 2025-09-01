import mongoose, { Document, Schema } from 'mongoose';

export interface IMaterial extends Document {
  title: string;
  type: 'book' | 'pdf' | 'link' | 'video' | 'notes';
  r2Key?: string;
  bucket?: string;
  url?: string;
  note?: string;
  subjectId: mongoose.Types.ObjectId;
  facultyId: mongoose.Types.ObjectId;
  departmentId: mongoose.Types.ObjectId;
  year: number;
  order: number;
  
  // Document processing fields
  status: 'uploaded' | 'processing' | 'ready' | 'failed' | 'toc_ready';
  pageCount?: number;
  hasOCR?: boolean;
  fileHash?: string;
  jobId?: string;
  
  progress?: {
    step: 'probe' | 'render' | 'ocr' | 'text' | 'toc_analysis' | 'sectioning' | 'chunk' | 'embed' | 'index' | 'done';
    percent: number;
  };
  
  counters?: {
    pagesDone: number;
    sectionsFound: number;
    chunksDone: number;
  };
  
  derivatives?: {
    textPrefix?: string;    // R2 prefix for text files
    ocrPrefix?: string;     // R2 prefix for OCR JSON files
    pagesPrefix?: string;   // R2 prefix for page previews
  };
  
  logs?: Array<{
    timestamp: Date;
    level: 'info' | 'warn' | 'error';
    message: string;
  }>;
  
  createdAt: Date;
  updatedAt: Date;
}

const MaterialSchema = new Schema<IMaterial>({
  title: {
    type: String,
    required: [true, 'Material title is required'],
    trim: true,
    maxlength: [300, 'Material title cannot exceed 300 characters']
  },
  type: {
    type: String,
    enum: ['book', 'pdf', 'link', 'video', 'notes'],
    required: [true, 'Material type is required']
  },
  r2Key: {
    type: String,
    trim: true,
    maxlength: [500, 'R2 key cannot exceed 500 characters']
  },
  bucket: {
    type: String,
    trim: true,
    maxlength: [100, 'Bucket name cannot exceed 100 characters']
  },
  url: {
    type: String,
    trim: true,
    maxlength: [500, 'URL cannot exceed 500 characters']
  },
  note: {
    type: String,
    trim: true,
    maxlength: [1000, 'Note cannot exceed 1000 characters']
  },
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
  },
  order: {
    type: Number,
    default: 0
  },
  
  // Document processing fields
  status: {
    type: String,
    enum: ['uploaded', 'processing', 'ready', 'failed', 'toc_ready'],
    default: 'uploaded'
  },
  pageCount: {
    type: Number,
    min: 0
  },
  hasOCR: {
    type: Boolean,
    default: false
  },
  fileHash: {
    type: String,
    trim: true
  },
  jobId: {
    type: String,
    trim: true
  },
  
  progress: {
    step: {
      type: String,
      enum: ['probe', 'render', 'ocr', 'text', 'toc_analysis', 'sectioning', 'chunk', 'embed', 'index', 'done']
    },
    percent: {
      type: Number,
      min: 0,
      max: 100,
      default: 0
    }
  },
  
  counters: {
    pagesDone: {
      type: Number,
      default: 0
    },
    sectionsFound: {
      type: Number,
      default: 0
    },
    chunksDone: {
      type: Number,
      default: 0
    }
  },
  
  derivatives: {
    textPrefix: String,
    ocrPrefix: String,
    pagesPrefix: String
  },
  
  logs: [{
    timestamp: {
      type: Date,
      default: Date.now
    },
    level: {
      type: String,
      enum: ['info', 'warn', 'error'],
      required: true
    },
    message: {
      type: String,
      required: true
    }
  }]
}, {
  timestamps: true
});

MaterialSchema.index({ subjectId: 1, order: 1 });
MaterialSchema.index({ facultyId: 1, departmentId: 1, year: 1 });

export default mongoose.model<IMaterial>('Material', MaterialSchema);
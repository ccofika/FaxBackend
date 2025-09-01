import mongoose, { Document, Schema } from 'mongoose';

export interface ITocSection {
  title: string;
  cleanTitle: string;           // Title without numbers (e.g., "Hardver" instead of "1.1.1 Hardver")
  level: number;
  pageStart: number;
  pageEnd: number;
  parentSectionId?: string;
  semanticType: 'chapter' | 'section' | 'subsection' | 'paragraph';
  processed?: boolean;           // Whether this section has been processed and saved
}

export interface ITocAnalysis extends Document {
  docId: mongoose.Types.ObjectId;        // References Material._id
  subjectId: mongoose.Types.ObjectId;    // References Subject._id
  facultyId: mongoose.Types.ObjectId;    // References Faculty._id (for faster querying)
  departmentId: mongoose.Types.ObjectId; // References Department._id (for faster querying)
  year: number;                          // Academic year (for faster querying)
  tocPages: string;                      // e.g., "2-4" - pages that contain TOC
  sections: ITocSection[];               // All sections extracted from TOC
  totalSections: number;
  processedSections: number;
  status: 'pending' | 'processing' | 'completed' | 'failed';
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

const TocSectionSchema = new Schema({
  title: {
    type: String,
    required: true,
    trim: true
  },
  cleanTitle: {
    type: String,
    required: true,
    trim: true
  },
  level: {
    type: Number,
    required: true,
    min: 1,
    max: 10
  },
  pageStart: {
    type: Number,
    required: true,
    min: 1
  },
  pageEnd: {
    type: Number,
    required: true,
    min: 1
  },
  parentSectionId: {
    type: String,
    trim: true
  },
  semanticType: {
    type: String,
    enum: ['chapter', 'section', 'subsection', 'paragraph'],
    required: true
  },
  processed: {
    type: Boolean,
    default: false
  }
}, { _id: false });

const TocAnalysisSchema = new Schema<ITocAnalysis>({
  docId: {
    type: Schema.Types.ObjectId,
    ref: 'Material',
    required: [true, 'Document ID is required']
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
  tocPages: {
    type: String,
    required: [true, 'TOC pages are required'],
    trim: true
  },
  sections: {
    type: [TocSectionSchema],
    required: true,
    default: []
  },
  totalSections: {
    type: Number,
    required: true,
    default: 0
  },
  processedSections: {
    type: Number,
    required: true,
    default: 0
  },
  status: {
    type: String,
    enum: ['pending', 'processing', 'completed', 'failed'],
    default: 'pending'
  },
  error: {
    type: String,
    trim: true
  }
}, {
  timestamps: true
});

// Indexes for efficient querying with large-scale data
TocAnalysisSchema.index({ docId: 1 }, { unique: true });
TocAnalysisSchema.index({ subjectId: 1, status: 1 });
TocAnalysisSchema.index({ facultyId: 1, departmentId: 1, year: 1 });
TocAnalysisSchema.index({ status: 1, updatedAt: 1 });

// Method to clean title (remove numbering)
TocAnalysisSchema.methods.cleanSectionTitle = function(title: string): string {
  // Remove leading numbers and dots (e.g., "1.1.1 Hardver" -> "Hardver")
  return title.replace(/^[\d\.\s]+/, '').trim();
};

export default mongoose.model<ITocAnalysis>('TocAnalysis', TocAnalysisSchema);
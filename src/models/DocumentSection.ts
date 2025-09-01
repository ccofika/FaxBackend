import mongoose, { Document, Schema } from 'mongoose';

export interface IDocumentSection extends Document {
  docId: mongoose.Types.ObjectId;      // References Material._id
  subjectId: mongoose.Types.ObjectId;  // References Subject._id
  facultyId: mongoose.Types.ObjectId;  // References Faculty._id (for faster querying)
  departmentId: mongoose.Types.ObjectId; // References Department._id (for faster querying)
  year: number;                        // Academic year (for faster querying)
  sectionId: string;                   // Unique identifier for this section
  title: string;
  path: string;                        // e.g., "1 → 1.2 → 1.2.3"
  level: number;                       // 1, 2, 3, etc.
  parentSectionId?: string;            // ID of parent section for hierarchical structure
  semanticType?: 'chapter' | 'section' | 'subsection' | 'paragraph';
  pageStart: number;
  pageEnd: number;
  charStart: number;
  charEnd: number;
  content?: string;                    // Full text content of the section
  vectorId?: string;                   // ID in vector database
  totalParts?: number;                 // Total parts if section was split for embedding
  partNumber?: number;                 // Part number if this is a split section (1, 2, 3...)
  isMainPart?: boolean;                // True for the first part, false for follow-up parts
  shortAbstract?: string;              // AI-generated 3-8 sentence summary
  keywords?: string[];                 // AI-extracted keywords for lexical search
  queries?: string[];                  // AI-generated potential user questions
  analyzed?: boolean;                  // Whether AI analysis has been performed
  createdAt: Date;
  updatedAt: Date;
}

const DocumentSectionSchema = new Schema<IDocumentSection>({
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
  sectionId: {
    type: String,
    required: [true, 'Section ID is required'],
    trim: true
  },
  title: {
    type: String,
    required: [true, 'Section title is required'],
    trim: true,
    maxlength: [500, 'Section title cannot exceed 500 characters']
  },
  path: {
    type: String,
    required: [true, 'Section path is required'],
    trim: true
  },
  level: {
    type: Number,
    required: [true, 'Section level is required'],
    min: 1,
    max: 10
  },
  pageStart: {
    type: Number,
    required: [true, 'Page start is required'],
    min: 1
  },
  pageEnd: {
    type: Number,
    required: [true, 'Page end is required'],
    min: 1
  },
  charStart: {
    type: Number,
    required: [true, 'Character start position is required'],
    min: 0
  },
  charEnd: {
    type: Number,
    required: [true, 'Character end position is required'],
    min: 0
  },
  content: {
    type: String,
    trim: true
  },
  parentSectionId: {
    type: String,
    trim: true
  },
  semanticType: {
    type: String,
    enum: ['chapter', 'section', 'subsection', 'paragraph'],
    trim: true
  },
  vectorId: {
    type: String,
    trim: true
  },
  totalParts: {
    type: Number,
    min: 1,
    default: 1
  },
  partNumber: {
    type: Number,
    min: 1,
    default: 1
  },
  isMainPart: {
    type: Boolean,
    default: true
  },
  shortAbstract: {
    type: String,
    trim: true,
    maxlength: [1000, 'Short abstract cannot exceed 1000 characters']
  },
  keywords: {
    type: [String],
    default: []
  },
  queries: {
    type: [String],
    default: []
  },
  analyzed: {
    type: Boolean,
    default: false
  }
}, {
  timestamps: true
});

// Indexes for efficient querying with large-scale data
DocumentSectionSchema.index({ docId: 1, sectionId: 1 }, { unique: true });
DocumentSectionSchema.index({ subjectId: 1, level: 1 });
DocumentSectionSchema.index({ facultyId: 1, departmentId: 1, year: 1 });
DocumentSectionSchema.index({ docId: 1, level: 1, pageStart: 1 });
DocumentSectionSchema.index({ vectorId: 1 });
DocumentSectionSchema.index({ docId: 1, partNumber: 1 }); // For split sections
DocumentSectionSchema.index({ subjectId: 1, isMainPart: 1 }); // For finding main parts only
DocumentSectionSchema.index({ title: 'text', content: 'text' }); // Text search index

export default mongoose.model<IDocumentSection>('DocumentSection', DocumentSectionSchema);
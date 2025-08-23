import mongoose, { Document, Schema } from 'mongoose';

export interface IDocumentSection extends Document {
  docId: mongoose.Types.ObjectId;      // References Material._id
  subjectId: mongoose.Types.ObjectId;
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
  }
}, {
  timestamps: true
});

// Indexes for efficient querying
DocumentSectionSchema.index({ docId: 1, sectionId: 1 }, { unique: true });
DocumentSectionSchema.index({ subjectId: 1 });
DocumentSectionSchema.index({ docId: 1, level: 1, pageStart: 1 });
DocumentSectionSchema.index({ vectorId: 1 });

export default mongoose.model<IDocumentSection>('DocumentSection', DocumentSectionSchema);
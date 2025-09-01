import mongoose, { Document, Schema } from 'mongoose';

export interface IDocumentChunk extends Document {
  docId: mongoose.Types.ObjectId;      // References Material._id
  subjectId: mongoose.Types.ObjectId;  // References Subject._id
  facultyId: mongoose.Types.ObjectId;  // References Faculty._id (for faster querying)
  departmentId: mongoose.Types.ObjectId; // References Department._id (for faster querying)
  year: number;                        // Academic year (for faster querying)
  sectionId: string;                   // References DocumentSection.sectionId
  chunkId: string;                     // Unique identifier for this chunk
  title?: string;                      // Optional title/heading
  path: string;                        // Same as parent section path
  page: number;                        // Primary page for this chunk
  paragraphIdx: number;                // Index within the section
  charStart: number;
  charEnd: number;
  content: string;                     // Actual text content
  r2KeyOriginal: string;               // Original PDF R2 key
  r2KeyPreviewPage?: string;           // Preview page image R2 key
  vectorId?: string;                   // ID in vector database
  figures?: Array<{                    // Associated images/diagrams
    caption?: string;
    r2Key?: string;
    page: number;
  }>;
  createdAt: Date;
  updatedAt: Date;
}

const DocumentChunkSchema = new Schema<IDocumentChunk>({
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
  chunkId: {
    type: String,
    required: [true, 'Chunk ID is required'],
    trim: true
  },
  title: {
    type: String,
    trim: true,
    maxlength: [300, 'Chunk title cannot exceed 300 characters']
  },
  path: {
    type: String,
    required: [true, 'Section path is required'],
    trim: true
  },
  page: {
    type: Number,
    required: [true, 'Page number is required'],
    min: 1
  },
  paragraphIdx: {
    type: Number,
    required: [true, 'Paragraph index is required'],
    min: 0
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
    required: [true, 'Chunk content is required'],
    trim: true,
    maxlength: [10000, 'Chunk content cannot exceed 10000 characters']
  },
  r2KeyOriginal: {
    type: String,
    required: [true, 'Original R2 key is required'],
    trim: true
  },
  r2KeyPreviewPage: {
    type: String,
    trim: true
  },
  vectorId: {
    type: String,
    trim: true
  },
  figures: [{
    caption: {
      type: String,
      trim: true
    },
    r2Key: {
      type: String,
      trim: true
    },
    page: {
      type: Number,
      required: true,
      min: 1
    }
  }]
}, {
  timestamps: true
});

// Indexes for efficient querying with large-scale data
DocumentChunkSchema.index({ docId: 1, chunkId: 1 }, { unique: true });
DocumentChunkSchema.index({ subjectId: 1, paragraphIdx: 1 });
DocumentChunkSchema.index({ facultyId: 1, departmentId: 1, year: 1 });
DocumentChunkSchema.index({ sectionId: 1, paragraphIdx: 1 });
DocumentChunkSchema.index({ vectorId: 1 });
DocumentChunkSchema.index({ docId: 1, page: 1 });
DocumentChunkSchema.index({ title: 'text', content: 'text' }); // Text search index

export default mongoose.model<IDocumentChunk>('DocumentChunk', DocumentChunkSchema);
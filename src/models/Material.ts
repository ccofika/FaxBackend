import mongoose, { Document, Schema } from 'mongoose';

export interface IMaterial extends Document {
  title: string;
  type: 'book' | 'pdf' | 'link' | 'video' | 'notes';
  url?: string;
  note?: string;
  subjectId: mongoose.Types.ObjectId;
  facultyId: mongoose.Types.ObjectId;
  departmentId: mongoose.Types.ObjectId;
  year: number;
  order: number;
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
  }
}, {
  timestamps: true
});

MaterialSchema.index({ subjectId: 1, order: 1 });
MaterialSchema.index({ facultyId: 1, departmentId: 1, year: 1 });

export default mongoose.model<IMaterial>('Material', MaterialSchema);
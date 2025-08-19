import mongoose, { Document, Schema } from 'mongoose';

export interface ISubject extends Document {
  name: string;
  facultyId: mongoose.Types.ObjectId;
  departmentId: mongoose.Types.ObjectId;
  year: number;
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const SubjectSchema = new Schema<ISubject>({
  name: {
    type: String,
    required: [true, 'Subject name is required'],
    trim: true,
    maxlength: [200, 'Subject name cannot exceed 200 characters']
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

// Ensure subject names are unique within faculty/department/year combination
SubjectSchema.index({ name: 1, facultyId: 1, departmentId: 1, year: 1 }, { unique: true });
SubjectSchema.index({ facultyId: 1, departmentId: 1, year: 1, order: 1 });

export default mongoose.model<ISubject>('Subject', SubjectSchema);
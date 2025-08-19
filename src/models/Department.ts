import mongoose, { Document, Schema } from 'mongoose';

export interface IDepartment extends Document {
  name: string;
  facultyId: mongoose.Types.ObjectId;
  availableYears: number[];
  order: number;
  createdAt: Date;
  updatedAt: Date;
}

const DepartmentSchema = new Schema<IDepartment>({
  name: {
    type: String,
    required: [true, 'Department name is required'],
    trim: true,
    maxlength: [200, 'Department name cannot exceed 200 characters']
  },
  facultyId: {
    type: Schema.Types.ObjectId,
    ref: 'Faculty',
    required: [true, 'Faculty ID is required']
  },
  availableYears: [{
    type: Number,
    min: 1,
    max: 8
  }],
  order: {
    type: Number,
    default: 0
  }
}, {
  timestamps: true
});

// Ensure department names are unique within a faculty
DepartmentSchema.index({ name: 1, facultyId: 1 }, { unique: true });
DepartmentSchema.index({ facultyId: 1, order: 1 });

export default mongoose.model<IDepartment>('Department', DepartmentSchema);
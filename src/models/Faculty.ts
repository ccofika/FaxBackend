import mongoose, { Document, Schema } from 'mongoose';

export interface IFaculty extends Document {
  name: string;
  cityId: mongoose.Types.ObjectId;
  createdAt: Date;
  updatedAt: Date;
}

const FacultySchema = new Schema<IFaculty>({
  name: {
    type: String,
    required: [true, 'Faculty name is required'],
    trim: true,
    maxlength: [200, 'Faculty name cannot exceed 200 characters']
  },
  cityId: {
    type: Schema.Types.ObjectId,
    ref: 'City',
    required: [true, 'City ID is required']
  }
}, {
  timestamps: true
});

// Ensure faculty names are unique within a city
FacultySchema.index({ name: 1, cityId: 1 }, { unique: true });
FacultySchema.index({ cityId: 1 });

export default mongoose.model<IFaculty>('Faculty', FacultySchema);
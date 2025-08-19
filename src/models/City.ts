import mongoose, { Document, Schema } from 'mongoose';

export interface ICity extends Document {
  name: string;
  createdAt: Date;
  updatedAt: Date;
}

const CitySchema = new Schema<ICity>({
  name: {
    type: String,
    required: [true, 'City name is required'],
    unique: true,
    trim: true,
    maxlength: [100, 'City name cannot exceed 100 characters']
  }
}, {
  timestamps: true
});

CitySchema.index({ name: 1 });

export default mongoose.model<ICity>('City', CitySchema);
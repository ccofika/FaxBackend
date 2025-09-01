const mongoose = require('mongoose');
require('dotenv').config();

// Define TocAnalysis schema
const TocSectionSchema = new mongoose.Schema({
  title: { type: String, required: true },
  cleanTitle: { type: String, required: true },
  level: { type: Number, required: true },
  pageStart: { type: Number, required: true },
  pageEnd: { type: Number, required: true },
  parentSectionId: { type: String },
  semanticType: { type: String, enum: ['chapter', 'section', 'subsection', 'paragraph'], required: true },
  processed: { type: Boolean, default: false }
}, { _id: false });

const TocAnalysisSchema = new mongoose.Schema({
  docId: { type: mongoose.Schema.Types.ObjectId, ref: 'Material', required: true },
  subjectId: { type: mongoose.Schema.Types.ObjectId, ref: 'Subject', required: true },
  facultyId: { type: mongoose.Schema.Types.ObjectId, ref: 'Faculty', required: true },
  departmentId: { type: mongoose.Schema.Types.ObjectId, ref: 'Department', required: true },
  year: { type: Number, required: true },
  tocPages: { type: String, required: true },
  sections: { type: [TocSectionSchema], required: true, default: [] },
  totalSections: { type: Number, required: true, default: 0 },
  processedSections: { type: Number, required: true, default: 0 },
  status: { type: String, enum: ['pending', 'processing', 'completed', 'failed'], default: 'pending' },
  error: { type: String }
}, { timestamps: true });

const TocAnalysis = mongoose.model('TocAnalysis', TocAnalysisSchema);

async function clearTocData() {
  try {
    await mongoose.connect(process.env.MONGODB_URI || 'mongodb://localhost:27017/fax');
    console.log('Connected to MongoDB');
    
    const result = await TocAnalysis.deleteMany({});
    console.log(`✅ Deleted ${result.deletedCount} TOC analysis documents`);
    
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  } catch (error) {
    console.error('❌ Error clearing TOC data:', error);
    process.exit(1);
  }
}

clearTocData();
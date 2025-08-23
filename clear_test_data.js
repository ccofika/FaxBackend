const mongoose = require('mongoose');
const dotenv = require('dotenv');

dotenv.config();

async function clearTestData() {
  try {
    console.log('🧹 Starting database cleanup...');
    
    // Connect to MongoDB
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    // Clear DocumentSection collection
    const DocumentSection = mongoose.model('DocumentSection', new mongoose.Schema({}, { strict: false }));
    const sectionsResult = await DocumentSection.deleteMany({});
    console.log(`🗑️ Deleted ${sectionsResult.deletedCount} documents from DocumentSection collection`);

    // Clear DocumentChunk collection  
    const DocumentChunk = mongoose.model('DocumentChunk', new mongoose.Schema({}, { strict: false }));
    const chunksResult = await DocumentChunk.deleteMany({});
    console.log(`🗑️ Deleted ${chunksResult.deletedCount} documents from DocumentChunk collection`);

    // Clear Qdrant
    const QdrantService = require('./dist/services/qdrantService.js').default;
    await QdrantService.clearCollection();
    console.log('✅ Cleared Qdrant collection');

    console.log('🎉 Database cleanup completed successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error clearing databases:', error);
    process.exit(1);
  }
}

// Run immediately if script is called directly
if (require.main === module) {
  clearTestData();
}

module.exports = clearTestData;
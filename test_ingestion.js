// Simple test script to verify the ingestion pipeline
// Run with: node test_ingestion.js

require('dotenv').config();

const mongoose = require('mongoose');
const { Material } = require('./dist/models');
const qdrantService = require('./dist/services/qdrantService').default;
const jobQueueService = require('./dist/services/jobQueueService').default;

async function testIngestionPipeline() {
  try {
    console.log('Environment check:');
    console.log('QDRANT_URL:', process.env.QDRANT_URL ? 'Present' : 'Missing');
    console.log('QDRANT_API_KEY:', process.env.QDRANT_API_KEY ? 'Present' : 'Missing');
    console.log('OPENAI_API_KEY:', process.env.OPENAI_API_KEY ? 'Present' : 'Missing');
    console.log('');
    
    console.log('🔗 Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    console.log('🔗 Testing Qdrant connection...');
    const qdrantHealthy = await qdrantService.healthCheck();
    if (qdrantHealthy) {
      console.log('✅ Qdrant connection successful');
    } else {
      console.log('❌ Qdrant connection failed');
      return;
    }

    console.log('🔗 Testing Qdrant collection setup...');
    await qdrantService.ensureCollection();
    console.log('✅ Qdrant collection ready');

    console.log('🔗 Testing job queue...');
    const queueStats = await jobQueueService.getQueueStats();
    console.log('✅ Job queue stats:', queueStats);

    console.log('🔗 Testing OpenAI embeddings...');
    const testEmbedding = await qdrantService.generateEmbedding('Test text for embedding generation');
    console.log('✅ OpenAI embeddings working, dimension:', testEmbedding.length);

    // Test database models
    console.log('🔗 Testing database models...');
    const materialCount = await Material.countDocuments();
    console.log('✅ Material model working, found', materialCount, 'materials');

    console.log('\n🎉 All services are ready for document ingestion!');
    console.log('\nNext steps:');
    console.log('1. Upload a PDF via the admin interface');
    console.log('2. Check processing status at /api/ingestion/status/:materialId');
    console.log('3. Search content at /api/ingestion/search');

  } catch (error) {
    console.error('❌ Test failed:', error.message);
    console.error('Stack:', error.stack);
  } finally {
    await mongoose.disconnect();
    console.log('📋 Disconnected from MongoDB');
  }
}

// Run the test
testIngestionPipeline();
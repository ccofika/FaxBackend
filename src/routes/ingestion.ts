import { Router } from 'express';
import { adminAuth } from '../middleware/adminAuth';
import { Material, DocumentSection, DocumentChunk } from '../models';
import jobQueueService from '../services/jobQueueService';
import qdrantService from '../services/qdrantService';
import documentIngestionService from '../services/documentIngestionService';

const router = Router();

// Apply admin authentication to all routes
router.use(adminAuth);

// Get material processing status
router.get('/status/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    const material = await Material.findById(materialId)
      .select('status progress counters logs jobId')
      .lean();
    
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    let jobStatus = null;
    if (material.jobId) {
      try {
        jobStatus = await jobQueueService.getJobStatus(material.jobId);
      } catch (error) {
        console.warn('Could not get job status:', error);
      }
    }

    res.json({
      success: true,
      material: {
        status: material.status,
        progress: material.progress,
        counters: material.counters,
        logs: material.logs?.slice(-10) || [], // Last 10 logs
        jobId: material.jobId,
      },
      job: jobStatus,
    });
  } catch (error) {
    console.error('Error getting processing status:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get all document sections (for testing/preview)
router.get('/sections', async (req, res) => {
  try {
    const sections = await DocumentSection.find({})
      .populate('docId', 'title type')
      .sort({ createdAt: -1 })
      .lean();
    
    res.json({ success: true, sections });
  } catch (error) {
    console.error('Error getting all document sections:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get latest AI analysis results for admin preview
router.get('/ai-analysis', async (req, res) => {
  try {
    // Get the latest AI analysis from the most recent document processing
    const latestMaterial = await Material.findOne({ type: 'pdf' })
      .sort({ updatedAt: -1 })
      .limit(1);
      
    if (!latestMaterial) {
      return res.json({ 
        success: true, 
        aiAnalysis: null,
        message: 'No processed materials found' 
      });
    }

    // Get document sections for this material (these come from AI analysis)
    const sections = await DocumentSection.find({ docId: latestMaterial._id })
      .sort({ pageStart: 1 })
      .limit(50)
      .lean();

    if (sections.length === 0) {
      return res.json({ 
        success: true, 
        aiAnalysis: null,
        message: 'No AI analysis results found' 
      });
    }

    // Convert DocumentSection format to AI analysis format
    const aiAnalysis = {
      materialId: latestMaterial._id,
      materialTitle: latestMaterial.title,
      sections: sections.map(section => ({
        title: section.title,
        level: section.level,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        semanticType: section.level === 1 ? 'chapter' : 
                     section.level === 2 ? 'section' : 'subsection'
      }))
    };
    
    res.json({ success: true, aiAnalysis });
  } catch (error) {
    console.error('Error fetching AI analysis:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch AI analysis' });
  }
});

// Get document sections for specific material
router.get('/sections/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    const sections = await DocumentSection.find({ docId: materialId })
      .select('-content') // Exclude content for listing
      .sort({ level: 1, pageStart: 1 })
      .lean();
    
    res.json({ success: true, sections });
  } catch (error) {
    console.error('Error getting document sections:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get document chunks for a section
router.get('/chunks/:sectionId', async (req, res) => {
  try {
    const { sectionId } = req.params;
    
    const chunks = await DocumentChunk.find({ sectionId })
      .select('-content') // Exclude content for listing
      .sort({ paragraphIdx: 1 })
      .lean();
    
    res.json({ success: true, chunks });
  } catch (error) {
    console.error('Error getting document chunks:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Search in document content
router.post('/search', async (req, res) => {
  try {
    const { query, subjectId, limit = 5 } = req.body;
    
    if (!query || !query.trim()) {
      return res.status(400).json({ success: false, message: 'Search query is required' });
    }
    
    if (!subjectId) {
      return res.status(400).json({ success: false, message: 'Subject ID is required' });
    }

    // Step 1: Search sections first
    const sectionResults = await qdrantService.searchSections(query, subjectId, 8);
    
    // Step 2: Search chunks within top sections
    const topSectionIds = sectionResults.slice(0, 5).map(result => 
      result.payload.sectionId || result.id.replace('section_', '')
    );
    
    const chunkResults = await qdrantService.searchChunks(query, subjectId, topSectionIds, limit);
    
    // Get additional details from MongoDB
    const chunkIds = chunkResults.map(result => result.id.replace('chunk_', ''));
    const chunkDetails = await DocumentChunk.find({ 
      chunkId: { $in: chunkIds } 
    }).populate('docId', 'title').lean();
    
    // Combine vector search results with MongoDB details
    const enrichedResults = chunkResults.map(result => {
      const detail = chunkDetails.find(chunk => 
        chunk.chunkId === result.id.replace('chunk_', '')
      );
      
      return {
        score: result.score,
        ...result.payload,
        document: detail?.docId,
        content: detail?.content,
        figures: detail?.figures,
      };
    });

    res.json({
      success: true,
      results: enrichedResults,
      metadata: {
        sectionsSearched: sectionResults.length,
        chunksSearched: chunkResults.length,
        query: query.trim(),
      },
    });
  } catch (error) {
    console.error('Error searching document content:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Process document with page options
router.post('/process/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    const { startPage, maxPages, tocPage, tocToPage } = req.body;
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    if (material.status === 'processing') {
      return res.status(400).json({ 
        success: false, 
        message: 'Document is already being processed' 
      });
    }

    // Set material status to processing
    await Material.findByIdAndUpdate(materialId, {
      $set: {
        status: 'processing',
        'progress.step': 'probe',
        'progress.percent': 0,
      },
      $unset: {
        'counters': 1,
        'derivatives': 1,
        'logs': 1,
      },
    });

    // Start processing directly in background
    console.log(`🚀 Starting document processing for material: ${materialId} with startPage: ${startPage}, maxPages: ${maxPages}, tocPage: ${tocPage || 'not specified'}, tocToPage: ${tocToPage || 'not specified'}`);
    
    setImmediate(async () => {
      try {
        await documentIngestionService.processDocument(materialId, startPage, maxPages, tocPage, tocToPage);
        console.log(`✅ Document processing completed for material: ${materialId}`);
      } catch (processingError) {
        console.error(`❌ Document processing failed for material ${materialId}:`, processingError);
      }
    });

    res.json({
      success: true,
      message: 'Document processing started',
      options: {
        startPage: startPage || 1,
        maxPages: maxPages || 10,
        tocPage: tocPage || null,
        tocToPage: tocToPage || null,
      },
    });
  } catch (error) {
    console.error('Error starting document processing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Retry failed document processing
router.post('/retry/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    if (material.status === 'processing') {
      return res.status(400).json({ 
        success: false, 
        message: 'Document is already being processed' 
      });
    }

    // Reset status and start new job
    const job = await jobQueueService.addDocumentProcessingJob(materialId);
    
    await Material.findByIdAndUpdate(materialId, {
      $set: {
        status: 'uploaded',
        jobId: job.id?.toString(),
        'progress.step': 'probe',
        'progress.percent': 0,
      },
      $unset: {
        'counters': 1,
        'derivatives': 1,
        'logs': 1,
      },
    });

    res.json({
      success: true,
      message: 'Document processing restarted',
      jobId: job.id,
    });
  } catch (error) {
    console.error('Error retrying document processing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get queue statistics
router.get('/queue/stats', async (req, res) => {
  try {
    const stats = await jobQueueService.getQueueStats();
    res.json({ success: true, stats });
  } catch (error) {
    console.error('Error getting queue stats:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Health check for services
router.get('/health', async (req, res) => {
  try {
    const qdrantHealth = await qdrantService.healthCheck();
    
    res.json({
      success: true,
      services: {
        qdrant: qdrantHealth,
        mongodb: true, // If we got here, MongoDB is working
        redis: true,   // Assume Redis is working if job queue is functional
      },
    });
  } catch (error) {
    console.error('Error checking service health:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Health check failed',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

export default router;
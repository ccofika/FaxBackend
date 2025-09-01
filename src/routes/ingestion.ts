import { Router } from 'express';
import multer from 'multer';
import { adminAuth } from '../middleware/adminAuth';
import { Material, DocumentSection, DocumentChunk, TocAnalysis } from '../models';
import jobQueueService from '../services/jobQueueService';
import qdrantService from '../services/qdrantService';
import documentIngestionService from '../services/documentIngestionService';

// Configure multer for PDF upload
const upload = multer({
  storage: multer.memoryStorage(),
  limits: {
    fileSize: 50 * 1024 * 1024, // 50MB limit
  },
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'application/pdf') {
      cb(null, true);
    } else {
      cb(new Error('Only PDF files are allowed'));
    }
  },
});

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

// Process document with TOC configuration
router.post('/process/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    const { tocPage, tocToPage } = req.body;
    
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

    // Check if TOC pages are specified - if yes, do TOC-only processing
    if (tocPage && tocToPage) {
      // Start TOC-only processing
      console.log(`🚀 Starting TOC-only processing for material: ${materialId}, pages: ${tocPage}-${tocToPage}`);
      
      setImmediate(async () => {
        try {
          await documentIngestionService.processDocumentTOCOnly(materialId, tocPage, tocToPage);
          console.log(`✅ TOC analysis completed for material: ${materialId}`);
        } catch (processingError) {
          console.error(`❌ TOC analysis failed for material ${materialId}:`, processingError);
        }
      });

      res.json({
        success: true,
        message: 'TOC analysis started - will stop after TOC creation for admin review',
        options: {
          tocPage: tocPage,
          tocToPage: tocToPage,
          processingScope: 'toc_only'
        },
      });
    } else {
      // No TOC pages specified - use legacy full processing (fallback)
      console.log(`🚀 Starting legacy full processing for material: ${materialId} (no TOC pages specified)`);
      
      setImmediate(async () => {
        try {
          await documentIngestionService.processDocument(materialId, tocPage, tocToPage);
          console.log(`✅ Full document processing finished for material: ${materialId}`);
        } catch (processingError) {
          console.error(`❌ Document processing failed for material ${materialId}:`, processingError);
        }
      });

      res.json({
        success: true,
        message: 'Legacy full document processing started (no TOC pages specified)',
        options: {
          tocPage: null,
          tocToPage: null,
          processingScope: 'full_legacy'
        },
      });
    }
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

// Test PDF text extraction with AI TOC analysis
router.post('/test-pdf-parsing', upload.single('pdf'), async (req, res) => {
  try {
    console.log('📝 PDF parsing test request received');
    
    if (!req.file) {
      return res.status(400).json({
        success: false,
        message: 'No PDF file uploaded'
      });
    }

    // Get TOC page range from request body (e.g., "2-4" means pages 2, 3, 4)
    const { tocPages, maxPages = 10 } = req.body;
    let tocFromPage: number | undefined;
    let tocToPage: number | undefined;
    let shouldAnalyzeTOC = false;
    
    if (tocPages) {
      const tocMatch = tocPages.match(/^(\d+)-(\d+)$/);
      if (tocMatch) {
        tocFromPage = parseInt(tocMatch[1]);
        tocToPage = parseInt(tocMatch[2]);
        shouldAnalyzeTOC = true;
        console.log(`📚 TOC analysis requested for pages ${tocFromPage} to ${tocToPage}`);
      } else {
        return res.status(400).json({
          success: false,
          message: 'Invalid TOC page format. Use format like "2-4" for pages 2 to 4'
        });
      }
    }

    // Extract text from specified number of pages (or first 10 by default)
    console.log(`🔍 Extracting text from first ${maxPages} pages...`);
    const { pages } = await documentIngestionService.extractTextFromPDF(req.file.buffer, 1, maxPages);
    
    console.log(`✅ Extracted text from ${pages.length} pages`);
    
    let aiTocAnalysis = null;
    
    if (shouldAnalyzeTOC && tocFromPage && tocToPage) {
      try {
        console.log('🤖 Starting AI TOC analysis...');
        
        // Extract TOC pages specifically
        const { pages: tocPages } = await documentIngestionService.extractTextFromPDF(
          req.file.buffer, 
          tocFromPage, 
          tocToPage - tocFromPage + 1
        );
        
        const tocText = tocPages.map(page => page.text).join('\n\n');
        console.log(`📋 TOC text extracted (${tocText.length} characters)`);
        
        if (tocText.length < 50) {
          throw new Error('TOC text too short for AI analysis');
        }
        
        // Use the AI analysis service to analyze TOC directly
        const aiAnalysisService = require('../services/aiAnalysisService').default;
        aiTocAnalysis = await aiAnalysisService.analyzeTOC(tocText, tocFromPage, tocToPage);
        
        console.log(`🎯 AI found ${aiTocAnalysis?.sections?.length || 0} sections`);
        
      } catch (aiError) {
        console.error('❌ AI TOC analysis failed:', aiError);
        aiTocAnalysis = {
          error: aiError instanceof Error ? aiError.message : 'AI analysis failed',
          sections: []
        };
      }
    }
    
    // Combine all pages for display
    const combinedText = pages.map(page => 
      `=== PAGE ${page.pageNumber} ===\n${page.text}\n`
    ).join('\n');
    
    const response: any = {
      success: true,
      message: `Successfully extracted text from ${pages.length} pages`,
      data: {
        pageCount: pages.length,
        pages: pages.map(page => ({
          pageNumber: page.pageNumber,
          textLength: page.text.length,
          text: page.text
        })),
        combinedText,
        combinedLength: combinedText.length
      }
    };
    
    // Add AI TOC analysis if performed
    if (shouldAnalyzeTOC) {
      response.data.tocAnalysis = {
        tocPages: `${tocFromPage}-${tocToPage}`,
        aiAnalysis: aiTocAnalysis,
        sectionsFound: aiTocAnalysis?.sections?.length || 0
      };
    }
    
    res.json(response);
  } catch (error) {
    console.error('❌ Error testing PDF parsing:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to parse PDF',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Abort current processing
router.post('/abort', async (req, res) => {
  try {
    console.log('🛑 Abort request received');
    
    // Find all materials currently being processed
    const processingMaterials = await Material.find({ status: 'processing' });
    
    console.log(`🛑 Found ${processingMaterials.length} materials currently processing`);
    
    let abortedCount = 0;
    
    for (const material of processingMaterials) {
      try {
        // Set material status to failed with abort message
        await Material.findByIdAndUpdate(material._id, {
          $set: {
            status: 'failed',
            'progress.step': 'aborted',
            'progress.percent': 0,
            'progress.message': 'Processing aborted by user',
            'progress.lastUpdate': new Date()
          }
        });
        
        console.log(`🛑 Aborted processing for material: ${material._id} (${material.title})`);
        abortedCount++;
      } catch (error) {
        console.error(`❌ Error aborting material ${material._id}:`, error);
      }
    }
    
    // DIRECTLY abort ALL active AI analyses
    const aiPostProcessingService = require('../services/aiPostProcessingService').default;
    const aiAbortedCount = aiPostProcessingService.abortAllAnalyses();
    
    // KILL ALL NODE.JS PROCESSES THAT MIGHT BE RUNNING AI ANALYSIS
    console.log('🔪 KILLING ALL ANALYSIS PROCESSES');
    process.kill(process.pid, 'SIGTERM');
    
    // Set a global abort flag that processing functions can check
    (global as any).abortProcessing = true;
    
    // Keep the abort flag active longer for AI analysis (which can take hours)
    // Clear any existing timeout
    if ((global as any).abortTimeout) {
      clearTimeout((global as any).abortTimeout);
    }
    
    // Set new timeout for 60 seconds (enough time for AI analysis to detect and abort)
    (global as any).abortTimeout = setTimeout(() => {
      (global as any).abortProcessing = false;
      (global as any).abortTimeout = null;
      console.log('🟢 Abort flag cleared, new processes can start');
    }, 60000); // Clear after 60 seconds
    
    console.log(`✅ Successfully aborted all processes:`);
    console.log(`   - Material processing: ${abortedCount} tasks`);
    console.log(`   - AI analyses: ${aiAbortedCount} active analyses`);
    console.log(`🛑 Abort flag will remain active for 60 seconds`);
    
    res.json({
      success: true,
      message: `Successfully aborted all processes. Material processing: ${abortedCount} tasks, AI analyses: ${aiAbortedCount} active analyses.`,
      abortedCount,
      aiAbortedCount,
      totalFound: processingMaterials.length,
      abortDuration: '60 seconds'
    });
  } catch (error) {
    console.error('❌ Error aborting processes:', error);
    res.status(500).json({ 
      success: false, 
      message: 'Failed to abort processes',
      error: error instanceof Error ? error.message : 'Unknown error'
    });
  }
});

// Process document TOC only
router.post('/process-toc-only/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    const { tocPage, tocToPage } = req.body;
    
    if (!tocPage || !tocToPage) {
      return res.status(400).json({ 
        success: false, 
        message: 'TOC pages (tocPage and tocToPage) are required' 
      });
    }
    
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

    // Start TOC-only processing in background
    console.log(`🚀 Starting TOC-only processing for material: ${materialId}, pages: ${tocPage}-${tocToPage}`);
    
    setImmediate(async () => {
      try {
        await documentIngestionService.processDocumentTOCOnly(materialId, tocPage, tocToPage);
        console.log(`✅ TOC analysis completed for material: ${materialId}`);
      } catch (processingError) {
        console.error(`❌ TOC analysis failed for material ${materialId}:`, processingError);
      }
    });

    res.json({
      success: true,
      message: 'TOC analysis started - will stop after TOC creation',
      materialId,
      tocPages: `${tocPage}-${tocToPage}`,
    });
  } catch (error) {
    console.error('Error starting TOC-only processing:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get TOC analysis for editing
router.get('/toc-analysis/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    const tocAnalysis = await TocAnalysis.findOne({ docId: materialId });
    if (!tocAnalysis) {
      return res.status(404).json({ 
        success: false, 
        message: 'No TOC analysis found for this material' 
      });
    }
    
    res.json({
      success: true,
      tocAnalysis: {
        id: tocAnalysis._id,
        materialId: tocAnalysis.docId,
        materialTitle: material.title,
        materialStatus: material.status,
        tocPages: tocAnalysis.tocPages,
        sections: tocAnalysis.sections.map(section => ({
          title: section.title,
          cleanTitle: section.cleanTitle,
          level: section.level,
          pageStart: section.pageStart,
          pageEnd: section.pageEnd,
          semanticType: section.semanticType,
          processed: section.processed
        })),
        totalSections: tocAnalysis.totalSections,
        processedSections: tocAnalysis.processedSections,
        status: tocAnalysis.status,
        createdAt: tocAnalysis.createdAt,
        updatedAt: tocAnalysis.updatedAt
      }
    });
  } catch (error) {
    console.error('Error getting TOC analysis:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Update TOC analysis sections
router.put('/toc-analysis/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    const { sections } = req.body;
    
    if (!sections || !Array.isArray(sections)) {
      return res.status(400).json({ 
        success: false, 
        message: 'Sections array is required' 
      });
    }
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }
    
    const tocAnalysis = await TocAnalysis.findOne({ docId: materialId });
    if (!tocAnalysis) {
      return res.status(404).json({ 
        success: false, 
        message: 'No TOC analysis found for this material' 
      });
    }
    
    // Validate and update sections
    const updatedSections = sections.map((section: any) => ({
      title: section.title?.trim(),
      cleanTitle: section.cleanTitle?.trim() || section.title?.replace(/^[\d\.\s]+/, '').trim(),
      level: parseInt(section.level) || 1,
      pageStart: parseInt(section.pageStart) || 1,
      pageEnd: parseInt(section.pageEnd) || parseInt(section.pageStart) || 1,
      semanticType: section.semanticType || 'section',
      processed: false, // Reset processed flag since sections were edited
      parentSectionId: section.parentSectionId || null
    }));
    
    // Update the TOC analysis
    await TocAnalysis.findByIdAndUpdate(tocAnalysis._id, {
      $set: {
        sections: updatedSections,
        totalSections: updatedSections.length,
        processedSections: 0, // Reset since sections were edited
        status: 'pending', // Reset status for re-processing
        updatedAt: new Date()
      }
    });
    
    console.log(`📝 Updated TOC analysis for material ${materialId} with ${updatedSections.length} sections`);
    
    res.json({
      success: true,
      message: `TOC analysis updated with ${updatedSections.length} sections`,
      updatedSections: updatedSections.length
    });
  } catch (error) {
    console.error('Error updating TOC analysis:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Continue processing after TOC review
router.post('/continue-after-toc/:materialId', async (req, res) => {
  try {
    const { materialId } = req.params;
    
    const material = await Material.findById(materialId);
    if (!material) {
      return res.status(404).json({ success: false, message: 'Material not found' });
    }

    if (material.status !== 'toc_ready') {
      return res.status(400).json({ 
        success: false, 
        message: `Cannot continue processing. Expected status: toc_ready, current status: ${material.status}` 
      });
    }

    // Start continuation processing in background
    console.log(`🚀 Continuing processing after TOC review for material: ${materialId}`);
    
    setImmediate(async () => {
      try {
        await documentIngestionService.continueProcessingAfterTOC(materialId);
        console.log(`✅ Document processing completed for material: ${materialId}`);
      } catch (processingError) {
        console.error(`❌ Continue processing failed for material ${materialId}:`, processingError);
      }
    });

    res.json({
      success: true,
      message: 'Processing continuation started - using reviewed TOC data',
      materialId,
    });
  } catch (error) {
    console.error('Error continuing processing after TOC:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

export default router;
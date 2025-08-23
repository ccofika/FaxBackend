import { Router } from 'express';
import multer from 'multer';
import { adminAuth } from '../middleware/adminAuth';
import crypto from 'crypto';
import jobQueueService from '../services/jobQueueService';

const router = Router();

// Apply admin authentication to upload routes only (not view)
router.use('/pdf', adminAuth);
router.use('/presigned-url', adminAuth);

// Configure multer for file upload
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


// Upload PDF to Cloudflare R2
router.post('/pdf', upload.single('pdf'), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ success: false, message: 'No PDF file provided' });
    }

    // Check if R2 credentials are configured
    if (!process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY || !process.env.R2_ACCOUNT_ID) {
      return res.status(500).json({ success: false, message: 'Cloudflare R2 credentials not configured' });
    }

    const { title, subjectId, facultyId, departmentId, year } = req.body;

    if (!title || !subjectId || !facultyId || !departmentId || !year) {
      return res.status(400).json({ 
        success: false, 
        message: 'Title, subject ID, faculty ID, department ID, and year are required' 
      });
    }

    // Generate unique key for R2
    const fileExtension = '.pdf';
    const timestamp = Date.now();
    const randomString = crypto.randomBytes(8).toString('hex');
    const r2Key = `materials/${facultyId}/${departmentId}/${year}/${subjectId}/${timestamp}-${randomString}${fileExtension}`;

    // Upload to R2 using direct fetch (bypass SSL issues)
    const bucketName = process.env.R2_BUCKET_NAME || 'uni-books';
    
    // R2 uses virtual-hosted style URLs for API calls
    const uploadUrl = `https://${bucketName}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
    
    console.log('Upload URL:', uploadUrl);
    
    const headers = {
      'Content-Type': 'application/pdf',
      'x-amz-meta-original-name': req.file.originalname,
      'x-amz-meta-title': title,
      'x-amz-meta-subject-id': subjectId,
      'x-amz-meta-uploaded-at': new Date().toISOString()
    };

    const credentials = {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
    };

    // Sign the request for R2
    const requestOptions = {
      method: 'PUT',
      host: `${bucketName}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      path: `/${r2Key}`,
      headers,
      body: req.file.buffer,
      service: 's3',
      region: 'auto'
    };

    const signedRequest = require('aws4').sign(requestOptions, credentials);

    // Make the upload request with fetch
    const uploadResponse = await fetch(uploadUrl, {
      method: 'PUT',
      headers: signedRequest.headers,
      body: req.file.buffer
    });

    if (!uploadResponse.ok) {
      throw new Error(`Upload failed: ${uploadResponse.status} ${uploadResponse.statusText}`);
    }

    res.json({
      success: true,
      r2Key,
      bucket: process.env.R2_BUCKET_NAME || 'uni-books',
      originalName: req.file.originalname,
      size: req.file.size,
      message: 'PDF uploaded successfully to R2',
    });

  } catch (error: any) {
    console.error('R2 upload error:', error);
    console.error('R2 endpoint:', `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    console.error('R2 access key ID:', process.env.R2_ACCESS_KEY_ID ? 'Present' : 'Missing');
    console.error('R2 secret key:', process.env.R2_SECRET_ACCESS_KEY ? 'Present' : 'Missing');
    console.error('R2 bucket:', process.env.R2_BUCKET_NAME);
    
    if (error instanceof multer.MulterError) {
      if (error.code === 'LIMIT_FILE_SIZE') {
        return res.status(400).json({ success: false, message: 'File too large. Maximum size is 50MB.' });
      }
      return res.status(400).json({ success: false, message: error.message });
    }
    
    res.status(500).json({ success: false, message: 'Failed to upload PDF to R2', error: error.message });
  }
});

// View PDF from R2
router.get('/view/:r2Key(*)', async (req, res) => {
  try {
    const { r2Key } = req.params;
    
    if (!r2Key) {
      return res.status(400).json({ success: false, message: 'R2 key is required' });
    }

    const bucketName = process.env.R2_BUCKET_NAME || 'uni-books';
    const viewUrl = `https://${bucketName}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com/${r2Key}`;
    
    const headers = {};
    const credentials = {
      accessKeyId: process.env.R2_ACCESS_KEY_ID || '',
      secretAccessKey: process.env.R2_SECRET_ACCESS_KEY || ''
    };

    // Sign the request for R2
    const requestOptions = {
      method: 'GET',
      host: `${bucketName}.${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
      path: `/${r2Key}`,
      headers,
      service: 's3',
      region: 'auto'
    };

    const signedRequest = require('aws4').sign(requestOptions, credentials);

    // Fetch the PDF from R2
    const pdfResponse = await fetch(viewUrl, {
      method: 'GET',
      headers: signedRequest.headers
    });

    if (!pdfResponse.ok) {
      throw new Error(`Failed to fetch PDF: ${pdfResponse.status} ${pdfResponse.statusText}`);
    }

    // Stream the PDF back to the client
    res.setHeader('Content-Type', 'application/pdf');
    res.setHeader('Content-Disposition', 'inline');
    
    const pdfBuffer = await pdfResponse.arrayBuffer();
    res.send(Buffer.from(pdfBuffer));

  } catch (error: any) {
    console.error('PDF view error:', error);
    res.status(500).json({ success: false, message: 'Failed to view PDF', error: error.message });
  }
});

export default router;
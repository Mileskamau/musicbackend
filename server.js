// server.js - Main application file
require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const rateLimit = require('express-rate-limit');
const ytdl = require('ytdl-core');
const fs = require('fs-extra');
const path = require('path');
const { body, validationResult } = require('express-validator');
const { v4: uuidv4 } = require('uuid');
const EventEmitter = require('events');

const app = express();
const PORT = process.env.PORT || 3000;

// ========== CONFIGURATION ==========
const TEMP_DIR = process.env.RAILWAY_ENVIRONMENT ? '/tmp/musicplayer' : path.join(__dirname, 'temp');
const MAX_FILE_SIZE = 1024 * 1024 * 1024; // 1GB
const CLEANUP_INTERVAL = 5 * 60 * 1000; // 5 minutes
const DOWNLOAD_TIMEOUT = 30 * 60 * 1000; // 30 minutes

// ========== SETUP ==========
// Ensure temp directory exists
fs.ensureDirSync(TEMP_DIR);

// Progress tracking store
const progressStore = new Map();

// ========== MIDDLEWARE ==========
// Security headers
app.use(helmet({
  crossOriginResourcePolicy: { policy: "cross-origin" }
}));

// CORS
app.use(cors({
  origin: process.env.CORS_ORIGIN || '*',
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type']
}));

// Body parsing
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ========== RATE LIMITING ==========
const downloadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 10, // 10 downloads per window
  message: { 
    error: 'Too many download requests. Please wait 15 minutes.',
    retryAfter: '15 minutes'
  },
  standardHeaders: true,
  legacyHeaders: false,
});

// ========== CLEANUP PROCESS ==========
async function cleanupTempFiles() {
  try {
    const files = await fs.readdir(TEMP_DIR);
    const now = Date.now();
    let deletedCount = 0;

    for (const file of files) {
      const filePath = path.join(TEMP_DIR, file);
      const stats = await fs.stat(filePath);
      
      // Delete files older than 1 hour
      if (now - stats.mtimeMs > 3600000) {
        await fs.remove(filePath);
        deletedCount++;
      }
    }

    // Cleanup expired progress entries
    for (const [key, value] of progressStore.entries()) {
      if (now - value.timestamp > 3600000) {
        progressStore.delete(key);
      }
    }

    if (deletedCount > 0 || files.length > 0) {
      console.log(`🧹 Cleanup: Removed ${deletedCount} old files, ${progressStore.size} active progress entries`);
    }
  } catch (error) {
    console.error('Cleanup error:', error);
  }
}

// Run cleanup every 5 minutes
setInterval(cleanupTempFiles, CLEANUP_INTERVAL);

// ========== HELPER FUNCTIONS ==========
function getVideoInfo(url) {
  return new Promise((resolve, reject) => {
    ytdl.getInfo(url, { timeout: 10000 })
      .then(info => resolve(info))
      .catch(err => {
        if (err.message.includes('Video unavailable')) {
          reject(new Error('Video is private or unavailable'));
        } else if (err.message.includes('This video is not available')) {
          reject(new Error('Video is region blocked or removed'));
        } else {
          reject(new Error('Failed to fetch video information'));
        }
      });
  });
}

function validateUrl(url) {
  if (!url) return false;
  return ytdl.validateURL(url);
}

function sanitizeFilename(title) {
  return title
    .replace(/[^a-zA-Z0-9]/g, '_')
    .substring(0, 100);
}

// ========== API ENDPOINTS ==========

// Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    tempDir: TEMP_DIR,
    progressCount: progressStore.size
  });
});

// Get video info
app.post('/api/info',
  body('url').isURL().withMessage('Invalid URL'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { url } = req.body;
      
      if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      const info = await getVideoInfo(url);
      
      // Get available formats
      const formats = info.formats.map(f => ({
        itag: f.itag,
        quality: f.qualityLabel || f.quality,
        container: f.container,
        hasAudio: f.hasAudio,
        hasVideo: f.hasVideo,
        bitrate: f.bitrate,
        fps: f.fps,
        size: f.contentLength ? parseInt(f.contentLength) : null,
      }));

      res.json({
        title: info.videoDetails.title,
        duration: info.videoDetails.lengthSeconds,
        thumbnail: info.videoDetails.thumbnails[info.videoDetails.thumbnails.length - 1].url,
        author: info.videoDetails.author.name,
        views: info.videoDetails.viewCount,
        formats: formats,
        downloadable: true,
      });
    } catch (error) {
      console.error('Info error:', error);
      
      let statusCode = 500;
      let message = error.message;
      
      if (error.message.includes('private') || error.message.includes('unavailable')) {
        statusCode = 403;
      } else if (error.message.includes('Invalid YouTube URL')) {
        statusCode = 400;
      }
      
      res.status(statusCode).json({ 
        error: message,
        details: process.env.NODE_ENV === 'development' ? error.stack : undefined
      });
    }
  }
);

// Download with progress (for large files)
app.post('/api/download-with-progress',
  downloadLimiter,
  body('url').isURL().withMessage('Invalid URL'),
  body('itag').optional().isInt(),
  async (req, res) => {
    const requestId = uuidv4();
    
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { url, itag = 22 } = req.body; // Default to 720p

      if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      // Get video info
      const info = await getVideoInfo(url);
      
      // Find requested format
      let format = info.formats.find(f => f.itag === itag);
      if (!format) {
        format = info.formats.find(f => f.hasVideo && f.hasAudio) || info.formats[0];
      }

      // Initialize progress
      progressStore.set(requestId, {
        progress: 0,
        total: 0,
        downloaded: 0,
        status: 'downloading',
        timestamp: Date.now(),
        title: info.videoDetails.title,
      });

      // Send initial progress
      res.setHeader('Content-Type', 'application/json');
      res.setHeader('Transfer-Encoding', 'chunked');

      // Start download
      const stream = ytdl(url, { 
        format: format,
        quality: 'highest',
        timeout: 30000,
      });

      let downloadedBytes = 0;
      let totalBytes = parseInt(format.contentLength) || 0;

      stream.on('progress', (chunkLength, downloaded, total) => {
        downloadedBytes = downloaded;
        totalBytes = total;
        const progress = total > 0 ? (downloaded / total) * 100 : 0;
        
        // Update progress store
        const entry = progressStore.get(requestId);
        if (entry) {
          entry.progress = progress;
          entry.downloaded = downloaded;
          entry.total = total;
          entry.timestamp = Date.now();
        }

        // Send progress update (if client wants streaming progress)
        res.write(JSON.stringify({
          progress: Math.round(progress),
          downloaded: downloaded,
          total: total,
          status: 'downloading'
        }) + '\n');
      });

      stream.on('end', () => {
        const entry = progressStore.get(requestId);
        if (entry) {
          entry.status = 'complete';
          entry.progress = 100;
        }
        
        res.write(JSON.stringify({
          progress: 100,
          status: 'complete',
          message: 'Download complete',
          requestId: requestId
        }) + '\n');
        res.end();
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        const entry = progressStore.get(requestId);
        if (entry) {
          entry.status = 'error';
          entry.error = error.message;
        }
        
        res.write(JSON.stringify({
          error: 'Download failed',
          status: 'error',
          details: error.message
        }) + '\n');
        res.end();
      });

      // Pipe stream to response
      stream.pipe(res, { end: false });

      // Handle client disconnect
      req.on('close', () => {
        stream.destroy();
        const entry = progressStore.get(requestId);
        if (entry && entry.status === 'downloading') {
          entry.status = 'cancelled';
        }
        console.log(`Client disconnected for request ${requestId}`);
      });

    } catch (error) {
      console.error('Download error:', error);
      
      const entry = progressStore.get(requestId);
      if (entry) {
        entry.status = 'error';
        entry.error = error.message;
      }

      if (!res.headersSent) {
        let statusCode = 500;
        if (error.message.includes('private') || error.message.includes('unavailable')) {
          statusCode = 403;
        }
        res.status(statusCode).json({ error: error.message });
      }
    }
  }
);

// Get download progress
app.get('/api/progress/:requestId', (req, res) => {
  const { requestId } = req.params;
  const progress = progressStore.get(requestId);
  
  if (!progress) {
    return res.status(404).json({ error: 'No progress found for this request' });
  }

  res.json({
    requestId,
    ...progress,
    timestamp: new Date().toISOString(),
  });
});

// Direct download (streaming, no progress tracking)
app.post('/api/download',
  downloadLimiter,
  body('url').isURL().withMessage('Invalid URL'),
  body('itag').optional().isInt(),
  body('quality').optional().isString(),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { url, itag, quality = 'highest' } = req.body;

      if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      // Get video info
      const info = await getVideoInfo(url);
      
      // Find format
      let format;
      if (itag) {
        format = info.formats.find(f => f.itag === itag);
      } else {
        // Try to find best format with audio and video
        format = info.formats.find(f => f.hasVideo && f.hasAudio) || 
                info.formats.find(f => f.hasVideo) ||
                info.formats[0];
      }

      if (!format) {
        return res.status(400).json({ error: 'No suitable format found' });
      }

      // Generate filename
      const sanitizedTitle = sanitizeFilename(info.videoDetails.title);
      const filename = `${sanitizedTitle}.${format.container || 'mp4'}`;

      // Set headers for download
      res.setHeader('Content-Type', format.mimeType || 'video/mp4');
      res.setHeader('Content-Disposition', `attachment; filename="${filename}"`);
      res.setHeader('Content-Length', format.contentLength || 0);
      res.setHeader('Cache-Control', 'no-cache');

      // Stream the video
      const stream = ytdl(url, { 
        format: format,
        quality: quality,
        timeout: 30000,
      });

      stream.on('error', (error) => {
        console.error('Stream error:', error);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Download failed' });
        }
      });

      stream.pipe(res);

      // Handle client disconnect
      req.on('close', () => {
        stream.destroy();
        console.log('Client disconnected during download');
      });

    } catch (error) {
      console.error('Download error:', error);
      
      let statusCode = 500;
      let message = error.message;
      
      if (error.message.includes('private') || error.message.includes('unavailable')) {
        statusCode = 403;
        message = 'Video is private or unavailable';
      } else if (error.message.includes('Invalid YouTube URL')) {
        statusCode = 400;
      }
      
      if (!res.headersSent) {
        res.status(statusCode).json({ error: message });
      }
    }
  }
);

// Get available formats for a video
app.post('/api/formats',
  body('url').isURL().withMessage('Invalid URL'),
  async (req, res) => {
    try {
      const errors = validationResult(req);
      if (!errors.isEmpty()) {
        return res.status(400).json({ errors: errors.array() });
      }

      const { url } = req.body;
      
      if (!validateUrl(url)) {
        return res.status(400).json({ error: 'Invalid YouTube URL' });
      }

      const info = await getVideoInfo(url);
      
      const formats = info.formats.map(f => ({
        itag: f.itag,
        quality: f.qualityLabel || f.quality,
        container: f.container,
        codec: f.codecs,
        hasAudio: f.hasAudio,
        hasVideo: f.hasVideo,
        bitrate: f.bitrate,
        fps: f.fps,
        size: f.contentLength ? parseInt(f.contentLength) : null,
        mimeType: f.mimeType,
      }));

      res.json({
        title: info.videoDetails.title,
        formats: formats,
        recommended: formats.filter(f => f.hasAudio && f.hasVideo).slice(0, 5),
      });
    } catch (error) {
      console.error('Formats error:', error);
      res.status(500).json({ error: error.message });
    }
  }
);

// ========== ERROR HANDLING ==========
app.use((err, req, res, next) => {
  console.error('Global error:', err);
  res.status(500).json({ 
    error: 'Internal server error',
    details: process.env.NODE_ENV === 'development' ? err.message : undefined
  });
});

app.use((req, res) => {
  res.status(404).json({ error: 'Endpoint not found' });
});

// ========== START SERVER ==========
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📁 Temp directory: ${TEMP_DIR}`);
  console.log(`🧹 Cleanup interval: ${CLEANUP_INTERVAL/1000} seconds`);
  console.log(`⏱️  Rate limit: 10 downloads per 15 minutes`);
  console.log(`🔒 Security: Helmet, CORS, Input validation enabled`);
  console.log(`📊 Progress tracking: ${progressStore.size} active entries`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('SIGTERM received, cleaning up...');
  cleanupTempFiles().then(() => {
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('SIGINT received, cleaning up...');
  cleanupTempFiles().then(() => {
    process.exit(0);
  });
});

// Export for testing
module.exports = app;
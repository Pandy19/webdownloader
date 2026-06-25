const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// Enable JSON body parser
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve static frontend files
app.use(express.static(path.join(__dirname, 'public')));

// TikTok routes
app.use('/api/tiktok', require('./tiktok-routes'));

// Define downloads folder
const downloadsDir = path.join(__dirname, 'downloads');
if (!fs.existsSync(downloadsDir)) {
  fs.mkdirSync(downloadsDir, { recursive: true });
} else {
  // Clear any leftover files from previous sessions on boot
  try {
    fs.readdirSync(downloadsDir).forEach(file => {
      if (file !== '.gitkeep') {
        fs.unlinkSync(path.join(downloadsDir, file));
      }
    });
    console.log('🧹 Cleaned up downloads directory on startup.');
  } catch (err) {
    console.error('Failed to clean downloads directory on startup:', err);
  }
}

// Verification script to check for required binaries in environment PATH
function verifyDependencies() {
  const checkYtdlp = spawn('yt-dlp', ['--version']);
  checkYtdlp.on('error', () => {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️  WARNING: "yt-dlp" is not found in your system PATH. Downloads will fail. Ensure python and yt-dlp are installed.');
  });
  checkYtdlp.on('close', (code) => {
    if (code === 0) console.log('✅ Dependency check: "yt-dlp" is ready.');
  });

  const checkFfmpeg = spawn('ffmpeg', ['-version']);
  checkFfmpeg.on('error', () => {
    console.warn('\x1b[33m%s\x1b[0m', '⚠️  WARNING: "ffmpeg" is not found in your system PATH. Audio/Video merging and MP3 conversions will fail.');
  });
  checkFfmpeg.on('close', (code) => {
    if (code === 0) console.log('✅ Dependency check: "ffmpeg" is ready.');
  });
}
verifyDependencies();

// Simple in-memory rate limiter to prevent bot spam and abuse
const ipCache = new Map();
const RATE_LIMIT_WINDOW = 60 * 1000; // 1 minute window
const RATE_LIMIT_MAX = 10; // limit to 10 requests per minute
function rateLimiter(req, res, next) {
  let ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  if (typeof ip === 'string' && ip.includes(',')) {
    ip = ip.split(',')[0].trim();
  }
  const now = Date.now();
  if (!ipCache.has(ip)) {
    ipCache.set(ip, []);
  }
  const timestamps = ipCache.get(ip).filter(t => now - t < RATE_LIMIT_WINDOW);
  if (timestamps.length >= RATE_LIMIT_MAX) {
    console.warn(`🛑 Rate limiter blocked IP: ${ip} (reached limit of ${RATE_LIMIT_MAX} reqs/min)`);
    return res.status(429).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }
  timestamps.push(now);
  ipCache.set(ip, timestamps);
  next();
}

// In-memory store for active download jobs
const jobs = new Map();
const activeProcesses = new Map(); // jobId -> Spawned process

// Queue management variables
const CONCURRENT_LIMIT = 1; // Only 1 yt-dlp process at a time to stay under 512MB RAM on Render
const MAX_QUEUE_SIZE = 3; // Reject new jobs if queue is too long
let runningCount = 0;

// Memory guard: reject work if memory usage is dangerously high
function getMemoryUsageMB() {
  return process.memoryUsage.rss ? process.memoryUsage.rss() / (1024 * 1024) : process.memoryUsage().rss / (1024 * 1024);
}
const MEMORY_THRESHOLD_MB = 400; // Reject new downloads if RSS exceeds this

// Regex to parse yt-dlp progress output
const progressRegex = /\[download\]\s+(\d+\.?\d*)%\s+of\s+(?:~)?(\d+\.?\d*\w+)\s+at\s+(\d+\.?\d*\w+\/s)\s+ETA\s+(\d+:\d+(?::\d+)?)/;

// Cron-like task: cleanup downloads and job entries older than 30 minutes
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) {
        fs.unlink(job.filePath, (err) => {
          if (err) console.error(`Failed to delete expired file ${job.filePath}:`, err);
        });
      }
      activeProcesses.delete(jobId);
      jobs.delete(jobId);
    }
  }
}, 5 * 60 * 1000);

// Heartbeat check to kill orphaned processes (if client closes tab/browser)
setInterval(() => {
  const now = Date.now();
  for (const [jobId, job] of jobs.entries()) {
    if (['queued', 'downloading', 'processing'].includes(job.status)) {
      // If no status check in the last 15 seconds, assume client disconnected
      if (job.lastActive && now - job.lastActive > 15000) {
        console.log(`Job ${jobId} timed out due to client inactivity. Aborting.`);
        const process = activeProcesses.get(jobId);
        if (process) {
          job.status = 'failed';
          job.error = 'Client disconnected';
          process.kill('SIGTERM');
        } else if (job.status === 'queued') {
          job.status = 'failed';
          job.error = 'Client disconnected';
          processQueue();
        }
      }
    }
  }
}, 5000);

// Endpoint to fetch video metadata
app.get('/api/info', rateLimiter, (req, res) => {
  const videoUrl = req.query.url;
  if (!videoUrl) {
    return res.status(400).json({ error: 'YouTube URL is required' });
  }

  // If a download is actively running, reject new info requests to protect memory
  const hasActiveDownload = [...jobs.values()].some(j => ['downloading', 'processing'].includes(j.status));
  if (hasActiveDownload && getMemoryUsageMB() > 300) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);

  function getMetadata(useCookies) {
    const args = [
      '--dump-json',
      '--skip-download',
      '--no-playlist',
      '--js-runtimes', 'deno,node',
      '--remote-components', 'ejs:github'
    ];

    if (useCookies && hasCookies) {
      args.push('--cookies', cookiesPath);
    }

    // Use '--' to signify end of command options and protect against argument injection
    args.push('--', videoUrl);

    const ytdlp = spawn('yt-dlp', args);

    let stdoutData = '';
    let stderrData = '';

    ytdlp.stdout.on('data', (data) => {
      stdoutData += data.toString();
    });

    ytdlp.stderr.on('data', (data) => {
      stderrData += data.toString();
    });

    ytdlp.on('close', (code) => {
      if (code !== 0) {
        if (useCookies && hasCookies) {
          console.warn(`⚠️ yt-dlp info failed with cookies. Retrying WITHOUT cookies. Error: ${stderrData.trim()}`);
          return getMetadata(false);
        }
        console.error(`yt-dlp info failed with code ${code}. Error: ${stderrData}`);
        return res.status(400).json({ error: 'Failed to retrieve video metadata. Make sure the URL is valid.' });
      }

      try {
        const info = JSON.parse(stdoutData);
        
        const maxHeight = info.formats.reduce((max, f) => {
          return (f.height && f.height > max) ? f.height : max;
        }, 0);

        const resolutions = [2160, 1440, 1080, 720, 480, 360];
        const availableResolutions = resolutions.filter(r => maxHeight >= r || (maxHeight >= r - 100 && maxHeight < r));
        
        if (availableResolutions.length === 0) {
          availableResolutions.push(360, 720);
        }

        // Calculate actual file sizes from yt-dlp metadata
        // Find the best audio format filesize to add to the video file sizes
        const bestAudioFormat = info.formats
          .filter(f => f.acodec && f.acodec !== 'none' && f.vcodec === 'none')
          .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];

        const audioSize = bestAudioFormat ? (bestAudioFormat.filesize || bestAudioFormat.filesize_approx || 0) : 0;
        
        const estimatedSizes = {};
        availableResolutions.forEach(r => {
          // Find best video format for this specific resolution
          const formatsForRes = info.formats.filter(f => f.height && (f.height === r || (f.height >= r - 100 && f.height < r)));
          if (formatsForRes.length > 0) {
            const bestVideoFormat = formatsForRes
              .filter(f => f.vcodec && f.vcodec !== 'none' && f.acodec === 'none')
              .sort((a, b) => (b.tbr || 0) - (a.tbr || 0))[0];
            
            if (bestVideoFormat) {
              const videoSize = bestVideoFormat.filesize || bestVideoFormat.filesize_approx || 
                                (bestVideoFormat.tbr ? Math.round((bestVideoFormat.tbr * 1000 * info.duration) / 8) : 0);
              if (videoSize) {
                // Convert bytes to MB and add audio size
                estimatedSizes[r] = Math.round((videoSize + audioSize) / (1024 * 1024));
              }
            }
          }
        });

        let thumbnail = info.thumbnail;
        if (info.thumbnails && info.thumbnails.length > 0) {
          const sortedThumbnails = info.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
          if (sortedThumbnails.length > 0) {
            thumbnail = sortedThumbnails[0].url;
          }
        }

        res.json({
          id: info.id,
          title: info.title,
          uploader: info.uploader,
          duration: info.duration,
          durationString: info.duration_string,
          thumbnail: thumbnail,
          viewCount: info.view_count,
          availableResolutions: availableResolutions,
          maxHeight: maxHeight,
          estimatedSizes: estimatedSizes // Actual parsed file size estimates in MB
        });
      } catch (e) {
        console.error('Failed to parse metadata json:', e);
        res.status(500).json({ error: 'Failed to process video metadata.' });
      }
    });
  }

  getMetadata(hasCookies);
});

// Queue Processor Function
function processQueue() {
  if (runningCount >= CONCURRENT_LIMIT) return;

  // Find the next queued job in chronological order
  const queuedJob = [...jobs.values()].find(j => j.status === 'queued');
  if (!queuedJob) return;

  runningCount++;
  queuedJob.status = 'downloading';
  startJobDownload(queuedJob);
  
  // Try processing next job recursively if concurrent limit hasn't been hit
  processQueue();
}

// Execute the yt-dlp download process
function startJobDownload(job, useCookies = true) {
  const jobId = job.id;
  const { url, type, quality } = job;

  const cookiesPath = path.join(__dirname, 'cookies.txt');
  const hasCookies = fs.existsSync(cookiesPath);
  const actualUseCookies = useCookies && hasCookies;

  let args = [];
  if (type === 'audio') {
    const bitrate = quality || '320K';
    args = [
      '-f', 'bestaudio',
      '--extract-audio',
      '--audio-format', 'mp3',
      '--audio-quality', bitrate,
      '--newline',
      '--no-playlist',
      '--buffer-size', '16K',
      '--http-chunk-size', '10M',
      '--js-runtimes', 'deno,node',
      '--remote-components', 'ejs:github'
    ];
  } else {
    const resLimit = quality || '1080';
    args = [
      '-f', `bestvideo[height<=${resLimit}]+bestaudio/best[height<=${resLimit}]`,
      '--merge-output-format', 'mp4',
      '--newline',
      '--no-playlist',
      '--buffer-size', '16K',
      '--http-chunk-size', '10M',
      '--js-runtimes', 'deno,node',
      '--remote-components', 'ejs:github'
    ];
  }

  if (actualUseCookies) {
    args.push('--cookies', cookiesPath);
  }

  // Output destination and flag protection '--'
  args.push('-o', path.join(downloadsDir, `${jobId}.%(ext)s`), '--', url);

  const ytdlp = spawn('yt-dlp', args);
  activeProcesses.set(jobId, ytdlp);

  ytdlp.stdout.on('data', (data) => {
    const lines = data.toString().split('\n');
    for (const line of lines) {
      const match = line.match(progressRegex);
      if (match) {
        job.percent = parseFloat(match[1]);
        job.size = match[2];
        job.speed = match[3];
        job.eta = match[4];
        job.status = 'downloading';
      } else if (line.includes('[Merger]')) {
        job.status = 'processing';
        job.title_status = 'Merging audio and video streams (using FFmpeg)...';
      } else if (line.includes('[ExtractAudio]')) {
        job.status = 'processing';
        job.title_status = 'Extracting and converting audio to MP3...';
      }
    }
  });

  let stderrData = '';
  ytdlp.stderr.on('data', (data) => {
    const chunk = data.toString();
    stderrData += chunk;
    console.error(`[yt-dlp stderr ${jobId}]: ${chunk}`);
  });

  ytdlp.on('close', (code) => {
    runningCount--;
    activeProcesses.delete(jobId);
    
    // Only update to completed if it wasn't aborted manually (which marks status as 'failed')
    if (job.status !== 'failed') {
      if (code === 0) {
        if (fs.existsSync(job.filePath)) {
          job.status = 'completed';
          job.percent = 100;
        } else {
          // Scan fallback filenames
          const files = fs.readdirSync(downloadsDir);
          const matchingFile = files.find(f => f.startsWith(jobId));
          if (matchingFile) {
            job.filePath = path.join(downloadsDir, matchingFile);
            job.ext = path.extname(matchingFile).substring(1);
            job.status = 'completed';
            job.percent = 100;
          } else {
            job.status = 'failed';
            job.error = 'Download complete, but output file was not found.';
          }
        }
      } else {
        if (actualUseCookies) {
          console.warn(`⚠️ Download job ${jobId} failed with cookies. Retrying WITHOUT cookies...`);
          runningCount++;
          job.status = 'downloading';
          startJobDownload(job, false);
          return;
        }
        job.status = 'failed';
        
        // Extract a clean error summary from stderr
        let cleanErr = stderrData.trim().split('\n')
          .map(line => line.trim())
          .filter(line => line.startsWith('ERROR:') || line.toLowerCase().includes('failed') || line.toLowerCase().includes('unable') || line.toLowerCase().includes('error'))
          .join('\n');
          
        if (!cleanErr) {
          cleanErr = stderrData.trim().split('\n').slice(-2).join('\n'); // fallback to last 2 lines
        }
        
        job.error = cleanErr || `Download process exited with error code ${code}.`;
      }
    }

    // Trigger queue processor to execute next pending download
    processQueue();
  });
}

// Endpoint to start/queue a download task
app.post('/api/download', rateLimiter, (req, res) => {
  const { url, type, quality, title } = req.body;

  if (!url) {
    return res.status(400).json({ error: 'URL is required' });
  }
  if (!type || !['video', 'audio'].includes(type)) {
    return res.status(400).json({ error: 'Invalid type' });
  }

  // Memory guard: reject if server is near OOM
  const currentMem = getMemoryUsageMB();
  if (currentMem > MEMORY_THRESHOLD_MB) {
    console.warn(`⚠️ Memory guard: rejecting download (RSS: ${Math.round(currentMem)}MB)`);
    return res.status(503).json({ error: 'Our server is currently processing other downloads. Please try again in a moment.' });
  }

  // Queue size guard
  const queuedCount = [...jobs.values()].filter(j => j.status === 'queued').length;
  if (queuedCount >= MAX_QUEUE_SIZE) {
    return res.status(503).json({ error: 'Our server is currently processing other downloads. Please try again in a moment.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const ext = type === 'audio' ? 'mp3' : 'mp4';
  const cleanTitle = (title || 'video').replace(/[^a-zA-Z0-9\s-_]/g, '').trim() || 'video';
  const safeFilenameTitle = cleanTitle.substring(0, 100);

  const job = {
    id: jobId,
    url: url,
    title: title || 'YouTube Video',
    safeTitle: safeFilenameTitle,
    type: type,
    quality: quality,
    status: 'queued', // Starts in the queued state
    percent: 0,
    speed: '0 B/s',
    size: 'Unknown',
    eta: '00:00',
    ext: ext,
    filePath: path.join(downloadsDir, `${jobId}.${ext}`),
    createdAt: Date.now(),
    lastActive: Date.now(),
    error: null
  };

  jobs.set(jobId, job);

  // Return the jobId instantly so client enters the queued modal state
  res.json({ jobId: jobId });

  // Call the queue runner to start processing
  processQueue();
});

// Endpoint to cancel an active/queued download job
app.post('/api/cancel/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Job not found' });
  }

  // Kill running downloader process
  const process = activeProcesses.get(jobId);
  if (process) {
    job.status = 'failed';
    job.error = 'Cancelled by user';
    process.kill('SIGTERM');
    console.log(`Job ${jobId} cancelled. Active yt-dlp process killed.`);
  } else if (job.status === 'queued') {
    job.status = 'failed';
    job.error = 'Cancelled by user';
    console.log(`Job ${jobId} cancelled while in queue.`);
  }

  // Release handles and delete potential partial files
  setTimeout(() => {
    if (job.filePath && fs.existsSync(job.filePath)) {
      fs.unlink(job.filePath, (err) => {
        if (!err) console.log(`Cleaned up partial file for cancelled job ${jobId}`);
      });
    }
  }, 1000);

  res.json({ success: true });
});

// Endpoint to check job status
app.get('/api/status/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).json({ error: 'Download job not found or expired' });
  }

  // Update activity timestamp to prevent heartbeat timeout
  job.lastActive = Date.now();

  // Calculate position in queue if queued
  let queuePosition = null;
  if (job.status === 'queued') {
    const queuedJobs = [...jobs.values()]
      .filter(j => j.status === 'queued')
      .sort((a, b) => a.createdAt - b.createdAt);
    queuePosition = queuedJobs.indexOf(job) + 1;
  }

  res.json({
    id: job.id,
    title: job.title,
    status: job.status,
    percent: job.percent,
    speed: job.speed,
    size: job.size,
    eta: job.eta,
    error: job.error,
    title_status: job.title_status || null,
    queuePosition: queuePosition
  });
});

// Endpoint to retrieve completed downloads
app.get('/api/retrieve/:jobId', (req, res) => {
  const jobId = req.params.jobId;
  const job = jobs.get(jobId);

  if (!job) {
    return res.status(404).send('Download job not found or expired.');
  }

  if (job.status !== 'completed' || !job.filePath) {
    return res.status(400).send('File is not ready yet.');
  }

  if (!fs.existsSync(job.filePath)) {
    return res.status(404).send('File not found on server.');
  }

  const clientFilename = `${job.safeTitle}.${job.ext}`;

  res.download(job.filePath, clientFilename, (err) => {
    if (err) {
      console.error(`Error sending file for job ${jobId}:`, err);
    }

    fs.unlink(job.filePath, (unlinkErr) => {
      if (unlinkErr) {
        console.error(`Failed to delete temp file ${job.filePath}:`, unlinkErr);
      }
    });

    jobs.delete(jobId);
  });
});

app.listen(PORT, () => {
  console.log(`Server is running on http://localhost:${PORT}`);
});

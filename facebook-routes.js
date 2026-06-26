const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();
const downloadsDir = path.join(__dirname, 'downloads');

const jobs = new Map();
const activeProcesses = new Map();
const CONCURRENT_LIMIT = 1;
const MAX_QUEUE_SIZE = 3;
let runningCount = 0;

function getMemoryUsageMB() {
  return process.memoryUsage.rss ? process.memoryUsage.rss() / (1024 * 1024) : process.memoryUsage().rss / (1024 * 1024);
}

const progressRegex = /\[download\]\s+(\d+\.?\d*)%\s+of\s+(?:~)?(\d+\.?\d*\w+)\s+at\s+(\d+\.?\d*\w+\/s)\s+ETA\s+(\d+:\d+(?::\d+)?)/;

// Rate limiter: 10 req/min per IP (only on info/download)
const rateLimitMap = new Map();
function fbRateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || [];
  const recent = entry.filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  recent.push(now);
  rateLimitMap.set(ip, recent);
  next();
}
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateLimitMap) {
    const recent = times.filter(t => now - t < 60000);
    if (recent.length === 0) rateLimitMap.delete(ip); else rateLimitMap.set(ip, recent);
  }
}, 60000);

// Cleanup old jobs
setInterval(() => {
  const now = Date.now();
  for (const [id, job] of jobs.entries()) {
    if (now - job.createdAt > 30 * 60 * 1000) {
      if (job.filePath && fs.existsSync(job.filePath)) fs.unlink(job.filePath, () => {});
      activeProcesses.delete(id);
      jobs.delete(id);
    }
  }
}, 5 * 60 * 1000);

// GET /info
router.get('/info', fbRateLimiter, (req, res) => {
  const url = req.query.url;
  if (!url) return res.status(400).json({ error: 'Facebook URL is required' });

  const hasActiveDownload = [...jobs.values()].some(j => ['downloading', 'processing'].includes(j.status));
  if (hasActiveDownload && getMemoryUsageMB() > 400) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }

  const args = ['--dump-json', '--skip-download', '--no-playlist', '--no-warnings', '--no-check-certificates', '--', url];
  const ytdlp = spawn('yt-dlp', args);
  let stdout = '', stderr = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', code => {
    if (code !== 0 || !stdout.trim()) {
      const isPrivate = /login|private|permission|403|Forbidden/i.test(stderr);
      const msg = isPrivate ? 'This video is private. Only public Facebook videos can be downloaded.' : 'Failed to retrieve video info. Please check the URL and try again.';
      return res.status(400).json({ error: msg });
    }
    try {
      const info = JSON.parse(stdout.trim());
      let thumbnail = info.thumbnail;
      if (info.thumbnails && info.thumbnails.length) {
        const sorted = info.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
        if (sorted.length) thumbnail = sorted[0].url;
      }
      res.json({
        id: info.id,
        title: info.title || info.description || 'Facebook Video',
        author: info.uploader || info.channel || 'Unknown',
        thumbnail,
        duration: info.duration,
        durationString: info.duration_string
      });
    } catch {
      res.status(500).json({ error: 'Failed to parse video metadata.' });
    }
  });
});

// POST /download
router.post('/download', fbRateLimiter, (req, res) => {
  const { url, title, format } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  if (getMemoryUsageMB() > 400) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }
  const queuedCount = [...jobs.values()].filter(j => j.status === 'queued').length;
  if (queuedCount >= MAX_QUEUE_SIZE) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }

  const jobId = crypto.randomBytes(8).toString('hex');
  const isAudio = format === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const safeTitle = (title || 'facebook').replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().substring(0, 100) || 'facebook';

  const job = {
    id: jobId, url, title: title || 'Facebook Video', safeTitle,
    format: format || 'video',
    status: 'queued', percent: 0, speed: '0 B/s', size: 'Unknown', eta: '00:00',
    ext, filePath: path.join(downloadsDir, `${jobId}.${ext}`),
    createdAt: Date.now(), lastActive: Date.now(), error: null
  };

  jobs.set(jobId, job);
  res.json({ jobId });
  processQueue();
});

// GET /status/:jobId
router.get('/status/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  job.lastActive = Date.now();

  let queuePosition = null;
  if (job.status === 'queued') {
    const queued = [...jobs.values()].filter(j => j.status === 'queued').sort((a, b) => a.createdAt - b.createdAt);
    queuePosition = queued.indexOf(job) + 1;
  }
  res.json({ id: job.id, status: job.status, percent: job.percent, speed: job.speed, size: job.size, eta: job.eta, error: job.error, queuePosition });
});

// GET /retrieve/:jobId
router.get('/retrieve/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });
  if (job.status !== 'completed' || !job.filePath || !fs.existsSync(job.filePath))
    return res.status(400).json({ error: 'File not ready' });

  res.download(job.filePath, `${job.safeTitle}.${job.ext}`, () => {
    fs.unlink(job.filePath, () => {});
    jobs.delete(job.id);
  });
});

// POST /cancel/:jobId
router.post('/cancel/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'Job not found' });

  const proc = activeProcesses.get(job.id);
  if (proc) { job.status = 'failed'; job.error = 'Cancelled'; proc.kill('SIGTERM'); }
  else if (job.status === 'queued') { job.status = 'failed'; job.error = 'Cancelled'; }

  setTimeout(() => { if (job.filePath && fs.existsSync(job.filePath)) fs.unlink(job.filePath, () => {}); }, 1000);
  res.json({ success: true });
});

function processQueue() {
  if (runningCount >= CONCURRENT_LIMIT) return;
  const next = [...jobs.values()].find(j => j.status === 'queued');
  if (!next) return;
  runningCount++;
  next.status = 'downloading';
  startDownload(next);
  processQueue();
}

function startDownload(job) {
  let args;
  if (job.format === 'mp3') {
    args = ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '320K', '--newline', '--no-playlist', '--no-warnings', '--buffer-size', '16K', '--http-chunk-size', '10M'];
  } else {
    args = ['-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--newline', '--no-playlist', '--no-warnings', '--buffer-size', '16K', '--http-chunk-size', '10M'];
  }
  args.push('-o', path.join(downloadsDir, `${job.id}.%(ext)s`), '--', job.url);

  const ytdlp = spawn('yt-dlp', args);
  activeProcesses.set(job.id, ytdlp);

  ytdlp.stdout.on('data', data => {
    for (const line of data.toString().split('\n')) {
      const match = line.match(progressRegex);
      if (match) { job.percent = parseFloat(match[1]); job.size = match[2]; job.speed = match[3]; job.eta = match[4]; }
      else if (line.includes('[Merger]') || line.includes('[ExtractAudio]')) job.status = 'processing';
    }
  });

  let stderr = '';
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', code => {
    runningCount--;
    activeProcesses.delete(job.id);
    if (job.status === 'failed') { processQueue(); return; }

    if (code === 0) {
      const files = fs.readdirSync(downloadsDir);
      const found = files.find(f => f.startsWith(job.id));
      if (found) { job.filePath = path.join(downloadsDir, found); job.ext = path.extname(found).substring(1); job.status = 'completed'; job.percent = 100; }
      else { job.status = 'failed'; job.error = 'File not found after download.'; }
    } else {
      job.status = 'failed';
      const isPrivate = /login|private|permission|403|Forbidden/i.test(stderr);
      job.error = isPrivate ? 'This video is private. Only public Facebook videos can be downloaded.' : 'Download failed. Please try again.';
    }
    processQueue();
  });
}

module.exports = router;

const express = require('express');
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');

const router = express.Router();
const downloadsDir = path.join(__dirname, 'downloads');

// Startup cleanup: delete orphan files older than 30 minutes
try {
  const now = Date.now();
  fs.readdirSync(downloadsDir).forEach(f => {
    const fp = path.join(downloadsDir, f);
    try {
      if (now - fs.statSync(fp).mtimeMs > 30 * 60 * 1000) fs.unlinkSync(fp);
    } catch {}
  });
} catch {}

// In-memory rate limiter: 10 requests per minute per IP (only for info/download)
const rateLimitMap = new Map();
function tiktokRateLimiter(req, res, next) {
  const ip = req.ip;
  const now = Date.now();
  const entry = rateLimitMap.get(ip) || [];
  const recent = entry.filter(t => now - t < 60000);
  if (recent.length >= 10) return res.status(429).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  recent.push(now);
  rateLimitMap.set(ip, recent);
  next();
}
// Clean up rate limit entries periodically
setInterval(() => {
  const now = Date.now();
  for (const [ip, times] of rateLimitMap) {
    const recent = times.filter(t => now - t < 60000);
    if (recent.length === 0) rateLimitMap.delete(ip); else rateLimitMap.set(ip, recent);
  }
}, 60000);
const cookiesPath = path.join(__dirname, 'tiktok-cookies.txt');

// Throttle yt-dlp info calls to avoid TikTok 403
let lastInfoCall = 0;
const INFO_MIN_INTERVAL = 3000; // 3s between calls

const jobs = new Map();
const activeProcesses = new Map();
const CONCURRENT_LIMIT = 1;
const MAX_QUEUE_SIZE = 3;
let runningCount = 0;

function getMemoryUsageMB() {
  return process.memoryUsage.rss ? process.memoryUsage.rss() / (1024 * 1024) : process.memoryUsage().rss / (1024 * 1024);
}

const progressRegex = /\[download\]\s+(\d+\.?\d*)%\s+of\s+(?:~)?(\d+\.?\d*\w+)\s+at\s+(\d+\.?\d*\w+\/s)\s+ETA\s+(\d+:\d+(?::\d+)?)/;

// Info cache to avoid repeated yt-dlp calls hitting rate limit
const infoCache = new Map();
const CACHE_TTL = 10 * 60 * 1000; // 10 min

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

// Health check
router.get('/health', (req, res) => res.json({ status: 'ok', uptime: process.uptime() }));

// GET /info - auto-detect content type
router.get('/info', tiktokRateLimiter, (req, res) => {
  const originalUrl = req.query.url;
  if (!originalUrl) return res.status(400).json({ error: 'TikTok URL is required' });

  // Block if a download is actively running and memory is high
  const hasActiveDownload = [...jobs.values()].some(j => ['downloading', 'processing'].includes(j.status));
  if (hasActiveDownload && getMemoryUsageMB() > 300) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }

  // Normalize /photo/ URLs to /video/ (yt-dlp doesn't support /photo/ path)
  let url = originalUrl.replace(/\/photo\//, '/video/');
  // Strip query params that can cause issues
  url = url.split('?')[0];

  // Check cache first
  const cached = infoCache.get(url);
  if (cached && Date.now() - cached.time < CACHE_TTL) {
    return res.json(cached.data);
  }

  const args = ['--dump-json', '--skip-download', '--no-playlist', '--no-warnings', '--no-check-certificates', '--cookies', cookiesPath, '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_version=34.1.2;manifest_app_version=341', '--', url];

  // Throttle: wait if last call was too recent
  const now = Date.now();
  const wait = Math.max(0, INFO_MIN_INTERVAL - (now - lastInfoCall));
  setTimeout(() => {
    lastInfoCall = Date.now();
    const ytdlp = spawn('yt-dlp', args);
  let stdout = '', stderr = '';
  ytdlp.stdout.on('data', d => stdout += d.toString());
  ytdlp.stderr.on('data', d => stderr += d.toString());

  ytdlp.on('close', code => {
    const trimmed = stdout.trim();
    console.log(`[TikTok] yt-dlp exited code=${code}, stdout=${trimmed.length}bytes, stderr=${stderr.slice(0, 100)}`);
    if (!trimmed) {
      // Check for cookie-related errors
      if (/cookie|browser|permission/i.test(stderr)) {
        return res.status(500).json({ error: 'Firefox browser must be closed or cookies are inaccessible. Please close Firefox and try again.' });
      }
      // Retry once after a short delay
      if (!req._retried) {
        req._retried = true;
        setTimeout(() => {
          const retry = spawn('yt-dlp', ['--dump-json', '--skip-download', '--no-playlist', '--no-warnings', '--no-check-certificates', '--cookies', cookiesPath, '--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_version=34.1.2;manifest_app_version=341', '--', url]);
          let rOut = '', rErr = '';
          retry.stdout.on('data', d => rOut += d);
          retry.stderr.on('data', d => rErr += d);
          retry.on('close', rc => {
            const rt = rOut.trim();
            console.log(`[TikTok retry] code=${rc}, stdout=${rt.length}bytes`);
            if (!rt) {
              if (/cookie|browser|permission/i.test(rErr)) return res.status(500).json({ error: 'Firefox browser must be closed or cookies are inaccessible. Please close Firefox and try again.' });
              return res.status(400).json({ error: 'TikTok blocked this request. Try again in a moment. <b>Refresh Page</b>' });            }
            try { handleInfo(JSON.parse(rt), originalUrl, res); } catch { res.status(500).json({ error: 'Failed to parse.' }); }
          });
        }, 10000);
        return;
      }
      return res.status(400).json({ error: 'TikTok blocked this request. Try again in a moment. <b>Refresh Page</b>' });
    }

    try {
      handleInfo(JSON.parse(trimmed), originalUrl, res);
    } catch (e) {
      res.status(500).json({ error: 'Failed to parse TikTok metadata.' });
    }
  });
  }, wait);
});

function handleInfo(info, url, res) {
  let type = 'video';
  let images = [];

  // Detect photo/slideshow from original URL, format data, or photomode thumbnails
  const isPhotoUrl = /\/photo\//.test(url);
  const hasPhotoModeThumbs = (info.thumbnails || []).some(t => t.url && /photomode/i.test(t.url));

  const imageFormats = (info.formats || []).filter(f =>
    (f.ext === 'jpg' || f.ext === 'png' || f.ext === 'webp') ||
    (f.url && /\.(jpg|jpeg|png|webp)(\?|$)/i.test(f.url))
  );

  if (isPhotoUrl || hasPhotoModeThumbs || imageFormats.length > 0) {
    type = 'slideshow';
    if (imageFormats.length > 0) {
      images = imageFormats.map(f => f.url).filter(Boolean);
    }
    // Fallback: use thumbnails as slide images for photo posts
    if (images.length === 0 && info.thumbnails && info.thumbnails.length >= 1) {
      // Deduplicate by URL path (cover and originCover are often same)
      const seen = new Set();
      images = info.thumbnails.filter(t => {
        if (!t.url) return false;
        const base = t.url.split('?')[0];
        if (seen.has(base)) return false;
        seen.add(base);
        return true;
      }).map(t => t.url);
    }
  } else if (info._type === 'playlist' && info.entries) {
    type = 'slideshow';
    images = info.entries.map(e => e.url || e.webpage_url).filter(Boolean);
  }

  if (/\/story\//.test(url)) type = 'story';

  let thumbnail = info.thumbnail;
  if (info.thumbnails && info.thumbnails.length) {
    const sorted = info.thumbnails.filter(t => t.url).sort((a, b) => (b.width || 0) - (a.width || 0));
    if (sorted.length) thumbnail = sorted[0].url;
  }

  const data = {
    id: info.id,
    title: info.title || info.description || 'TikTok',
    author: info.uploader || info.creator || info.channel || 'Unknown',
    thumbnail, duration: info.duration, type,
    images: type === 'slideshow' ? images : undefined
  };

  infoCache.set(url, { time: Date.now(), data });
  res.json(data);
}

// POST /download - start job (video, story, or mp3)
router.post('/download', tiktokRateLimiter, (req, res) => {
  let { url, title, format } = req.body;
  if (!url) return res.status(400).json({ error: 'URL is required' });

  // Memory guard
  if (getMemoryUsageMB() > 400) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }
  // Queue size guard
  const queuedCount = [...jobs.values()].filter(j => j.status === 'queued').length;
  if (queuedCount >= MAX_QUEUE_SIZE) {
    return res.status(503).json({ error: 'Our server is currently handling other downloads. Please try again in a moment.' });
  }

  // Normalize /photo/ URLs to /video/
  url = url.replace(/\/photo\//, '/video/');
  url = url.split('?')[0];

  const jobId = crypto.randomBytes(8).toString('hex');
  const isAudio = format === 'mp3';
  const ext = isAudio ? 'mp3' : 'mp4';
  const safeTitle = (title || 'tiktok').replace(/[^a-zA-Z0-9\s\-_]/g, '').trim().substring(0, 100) || 'tiktok';

  const job = {
    id: jobId, url, title: title || 'TikTok', safeTitle,
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
  const useCookies = !job._retried; // Skip cookies on retry
  if (job.format === 'mp3') {
    args = ['-f', 'bestaudio', '--extract-audio', '--audio-format', 'mp3', '--audio-quality', '320K', '--newline', '--no-playlist', '--no-warnings', '--buffer-size', '16K', '--http-chunk-size', '10M'];
  } else {
    args = ['-f', 'bestvideo+bestaudio/best', '--merge-output-format', 'mp4', '--newline', '--no-playlist', '--no-warnings', '--buffer-size', '16K', '--http-chunk-size', '10M'];
  }
  if (useCookies && fs.existsSync(cookiesPath)) {
    args.push('--cookies', cookiesPath);
  }
  args.push('--extractor-args', 'tiktok:api_hostname=api16-normal-c-useast1a.tiktokv.com;app_version=34.1.2;manifest_app_version=341');
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
      // Retry once on 403 errors (TikTok rate limiting) - without cookies
      if (!job._retried && /403|Forbidden/i.test(stderr)) {
        job._retried = true;
        job.percent = 0;
        job.status = 'processing';
        setTimeout(() => {
          runningCount++;
          job.status = 'downloading';
          startDownload(job);
        }, 3000);
        processQueue();
        return;
      }
      job.status = 'failed';
      const errLines = stderr.split('\n').filter(l => /error|fail/i.test(l));
      const rawErr = errLines.join('\n') || `Exit code ${code}`;
      // Show user-friendly message for 403
      job.error = /403|Forbidden/i.test(rawErr) ? 'TikTok is temporarily blocking requests. Please try again in a moment.' : rawErr;
    }
    processQueue();
  });
}

module.exports = router;

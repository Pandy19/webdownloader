document.addEventListener('DOMContentLoaded', () => {
  const urlInput = document.getElementById('url-input');
  const pasteBtn = document.getElementById('paste-btn');
  const fetchBtn = document.getElementById('fetch-btn');
  const fetchBtnText = document.getElementById('fetch-btn-text');
  const fetchBtnIcon = document.getElementById('fetch-btn-icon');
  const fetchSpinner = document.getElementById('fetch-spinner');
  const errorBanner = document.getElementById('error-banner');
  const errorText = document.getElementById('error-text');
  const skeleton = document.getElementById('skeleton');
  const result = document.getElementById('result');
  const rThumb = document.getElementById('r-thumb');
  const rBadge = document.getElementById('r-badge');
  const rTitle = document.getElementById('r-title');
  const rAuthor = document.getElementById('r-author');
  const dlVideo = document.getElementById('dl-video');
  const dlMp3 = document.getElementById('dl-mp3');
  const modal = document.getElementById('modal');
  const modalLoading = document.getElementById('modal-loading');
  const modalSuccess = document.getElementById('modal-success');
  const modalFailed = document.getElementById('modal-failed');
  const modalTitle = document.getElementById('modal-title');
  const modalSub = document.getElementById('modal-sub');
  const progFill = document.getElementById('prog-fill');
  const progPct = document.getElementById('prog-pct');
  const progSpeed = document.getElementById('prog-speed');
  const progSize = document.getElementById('prog-size');
  const progEta = document.getElementById('prog-eta');
  const progPhase = document.getElementById('prog-phase');
  const saveBtn = document.getElementById('save-btn');
  const failMsg = document.getElementById('fail-msg');

  let info = null, jobId = null, poll = null, lastUrl = '';

  function isValid(url) {
    return /^(https?:\/\/)?(www\.|m\.|web\.)?(facebook\.com|fb\.watch|fb\.com)\/.+/i.test(url.trim());
  }

  // Auto-fetch
  let debounce = null;
  urlInput.addEventListener('input', () => {
    const u = urlInput.value.trim();
    if (debounce) clearTimeout(debounce);
    if (u && isValid(u) && u !== lastUrl) debounce = setTimeout(() => { lastUrl = u; fetchBtn.click(); }, 600);
  });
  urlInput.addEventListener('paste', () => setTimeout(() => { const u = urlInput.value.trim(); if (u && isValid(u) && u !== lastUrl) { lastUrl = u; fetchBtn.click(); } }, 50));

  pasteBtn.addEventListener('click', async () => {
    try { const t = await navigator.clipboard.readText(); if (t) { urlInput.value = t; urlInput.dispatchEvent(new Event('input')); } } catch {}
  });

  // Fetch info
  fetchBtn.addEventListener('click', async () => {
    const url = urlInput.value.trim();
    if (!url) return showErr('Paste a Facebook video link first.');
    if (!isValid(url)) return showErr('Invalid Facebook URL.');

    hideErr(); result.classList.add('hidden'); skeleton.classList.remove('hidden');
    fetchBtn.disabled = true; fetchBtnText.textContent = 'Fetching...'; fetchBtnIcon.classList.add('hidden'); fetchSpinner.classList.remove('hidden');

    try {
      const r = await fetch(`/api/facebook/info?url=${encodeURIComponent(url)}`);
      let d;
      try { d = await r.json(); } catch { throw new Error('Our server is currently handling other downloads. Please try again in a moment.'); }
      if (!r.ok) throw new Error(d.error);
      info = d;
      rThumb.src = d.thumbnail || '';
      rTitle.textContent = d.title || 'Facebook Video';
      rAuthor.textContent = d.author || 'Unknown';
      rBadge.textContent = 'Video';
      skeleton.classList.add('hidden'); result.classList.remove('hidden'); lastUrl = url;
    } catch (e) { showErr(e.message); skeleton.classList.add('hidden'); }
    finally { fetchBtn.disabled = false; fetchBtnText.textContent = 'Extract'; fetchBtnIcon.classList.remove('hidden'); fetchSpinner.classList.add('hidden'); }
  });

  dlVideo.addEventListener('click', () => startJob('video'));
  dlMp3.addEventListener('click', () => startJob('mp3'));

  async function startJob(format) {
    if (!info) return;
    showModal('loading');
    modalTitle.textContent = format === 'mp3' ? 'Converting to MP3...' : 'Downloading...';
    modalSub.textContent = info.title;
    progFill.style.width = '0%'; progPct.textContent = '0%'; progSpeed.textContent = '--';
    progSize.textContent = 'Unknown'; progEta.textContent = '00:00'; progPhase.textContent = 'Initializing...';

    try {
      const r = await fetch('/api/facebook/download', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: urlInput.value.trim(), title: info.title, format }) });
      let d;
      try { d = await r.json(); } catch { throw new Error('Our server is currently handling other downloads. Please try again in a moment.'); }
      if (!r.ok) throw new Error(d.error);
      jobId = d.jobId;
      startPoll();
    } catch (e) { showModal('failed'); failMsg.textContent = e.message; }
  }

  function startPoll() {
    if (poll) clearInterval(poll);
    poll = setInterval(async () => {
      try {
        const r = await fetch(`/api/facebook/status/${jobId}`);
        if (r.status === 404) throw new Error('Job expired.');
        let d;
        try { d = await r.json(); } catch { return; }
        if (d.status === 'queued') { modalTitle.textContent = 'Queued...'; progPct.textContent = d.queuePosition ? `#${d.queuePosition}` : '...'; progPhase.textContent = 'Waiting in queue...'; }
        else if (d.status === 'downloading') { modalTitle.textContent = 'Downloading...'; progFill.style.width = d.percent + '%'; progPct.textContent = Math.round(d.percent) + '%'; progSpeed.textContent = d.speed || '--'; progSize.textContent = d.size || 'Unknown'; progEta.textContent = d.eta || '00:00'; progPhase.textContent = 'Downloading media streams...'; }
        else if (d.status === 'processing') { progFill.style.width = '95%'; progPct.textContent = '95%'; modalTitle.textContent = 'Processing...'; progPhase.textContent = 'Merging streams...'; }
        else if (d.status === 'completed') { stopPoll(); showModal('success'); saveBtn.href = `/api/facebook/retrieve/${jobId}`; jobId = null; }
        else if (d.status === 'failed') { throw new Error(d.error || 'Failed'); }
      } catch (e) { stopPoll(); showModal('failed'); failMsg.textContent = e.message; }
    }, 800);
  }

  function stopPoll() { if (poll) { clearInterval(poll); poll = null; } }

  async function cancelJob() {
    if (!jobId) return;
    const id = jobId; stopPoll(); modal.classList.add('hidden'); jobId = null;
    try { await fetch(`/api/facebook/cancel/${id}`, { method: 'POST' }); } catch {}
  }

  function showModal(state) {
    modal.classList.remove('hidden');
    modalLoading.classList.toggle('hidden', state !== 'loading');
    modalSuccess.classList.toggle('hidden', state !== 'success');
    modalFailed.classList.toggle('hidden', state !== 'failed');
  }

  function showErr(msg) { errorText.innerHTML = msg; errorBanner.classList.remove('hidden'); }
  function hideErr() { errorBanner.classList.add('hidden'); }

  document.getElementById('modal-x').addEventListener('click', cancelJob);
  document.getElementById('modal-cancel').addEventListener('click', cancelJob);
  document.getElementById('suc-close').addEventListener('click', () => modal.classList.add('hidden'));
  document.getElementById('save-btn').addEventListener('click', () => setTimeout(() => modal.classList.add('hidden'), 1500));
  document.getElementById('fail-close').addEventListener('click', () => { modal.classList.add('hidden'); jobId = null; });
  document.getElementById('fail-retry').addEventListener('click', () => { if (info) startJob('video'); });
  modal.addEventListener('click', e => { if (e.target === modal) cancelJob(); });

  // Support
  const supModal = document.getElementById('support-modal');
  document.getElementById('support-btn').addEventListener('click', e => { e.preventDefault(); supModal.classList.remove('hidden'); });
  const coffeeBtn = document.getElementById('modal-support-link');
  if (coffeeBtn) coffeeBtn.addEventListener('click', e => { e.preventDefault(); supModal.classList.remove('hidden'); });
  document.getElementById('sup-close').addEventListener('click', () => supModal.classList.add('hidden'));
  supModal.addEventListener('click', e => { if (e.target === supModal) supModal.classList.add('hidden'); });

  // Legal modals
  const legalTexts = {
    tos: `<h4>1. Acceptance of Terms</h4><p>By using the FB-Download website ("Service"), you agree to abide by these Terms of Service.</p><h4>2. Permitted Use</h4><p>This Service is intended solely for personal, non-commercial, and educational purposes. You represent that you have the legal right or permission from the copyright owner to download any content using this tool.</p><h4>3. Intellectual Property Rights</h4><p>We respect the intellectual property of others. You must not download copyrighted material unless you own it or have explicit written permission.</p><h4>4. Disclaimer of Warranties</h4><p>The Service is provided "as is" and "as available". We make no warranties regarding the reliability, uptime, speed, or accuracy of the service.</p><h4>5. Limitation of Liability</h4><p>In no event shall the operators of FB-Download or PandyShare be liable for any damages arising out of the use of this website.</p>`,
    dmca: `<h4>DMCA Takedown & Abuse Policy</h4><p>FB-Download operates as a transient download utility. Files are generated on-the-fly and deleted immediately after download.</p><h4>Important: We do not host content</h4><p><strong>There is no database or permanent repository of files</strong> on this server.</p><h4>Reporting Abuse</h4><p>Contact us:</p><ul><li>Telegram: <a href="https://t.me/pandyshare" target="_blank" style="color:var(--cyan);">t.me/pandyshare</a></li></ul><p>We will review your inquiry within 48 hours.</p>`
  };
  const legalModal = document.getElementById('legal-modal');
  const legalTitle = document.getElementById('legal-title');
  const legalContent = document.getElementById('legal-content');
  document.getElementById('tos-link').addEventListener('click', e => { e.preventDefault(); legalTitle.textContent = 'Terms of Service'; legalContent.innerHTML = legalTexts.tos; legalModal.classList.remove('hidden'); });
  document.getElementById('dmca-link').addEventListener('click', e => { e.preventDefault(); legalTitle.textContent = 'DMCA Takedown Policy'; legalContent.innerHTML = legalTexts.dmca; legalModal.classList.remove('hidden'); });
  document.getElementById('legal-close').addEventListener('click', () => legalModal.classList.add('hidden'));
  legalModal.addEventListener('click', e => { if (e.target === legalModal) legalModal.classList.add('hidden'); });

  window.addEventListener('beforeunload', () => { if (jobId) navigator.sendBeacon(`/api/facebook/cancel/${jobId}`); });

  if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js').catch(() => {});
});

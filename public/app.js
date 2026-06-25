document.addEventListener('DOMContentLoaded', () => {
    // DOM Elements
    const urlInput = document.getElementById('url-input');
    const pasteBtn = document.getElementById('paste-btn');
    const fetchBtn = document.getElementById('fetch-btn');
    const fetchBtnText = document.getElementById('fetch-btn-text');
    const fetchBtnIcon = document.getElementById('fetch-btn-icon');
    const fetchSpinner = document.getElementById('fetch-spinner');
    
    const errorMessage = document.getElementById('error-message');
    const errorText = document.getElementById('error-text');
    const playlistWarning = document.getElementById('playlist-warning');
    const skeletonLoader = document.getElementById('skeleton-loader');
    const videoCard = document.getElementById('video-card');
    
    // Video Card elements
    const videoThumbnail = document.getElementById('video-thumbnail');
    const videoDuration = document.getElementById('video-duration');
    const videoTitle = document.getElementById('video-title');
    const uploaderText = document.getElementById('uploader-text');
    const viewsText = document.getElementById('views-text');
    
    // Tab switching
    const tabVideo = document.getElementById('tab-video');
    const tabAudio = document.getElementById('tab-audio');
    const panelVideo = document.getElementById('panel-video');
    const panelAudio = document.getElementById('panel-audio');
    
    const videoFormatsGrid = document.getElementById('video-formats-grid');
    
    // Audio sizes text fields
    const audioSize320 = document.getElementById('audio-size-320');
    const audioSize256 = document.getElementById('audio-size-256');
    const audioSize128 = document.getElementById('audio-size-128');

    // Progress Modal elements
    const progressModal = document.getElementById('progress-modal');
    const modalTitleText = document.getElementById('modal-title-text');
    const modalCancelBtn = document.getElementById('modal-cancel-btn');
    const modalAbortBtn = document.getElementById('modal-abort-btn');
    const modalVideoTitleDisplay = document.getElementById('modal-video-title-display');
    const progressBarFill = document.getElementById('progress-bar-fill');
    const progressPercentDisplay = document.getElementById('progress-percent-display');
    const progressSpeedDisplay = document.getElementById('progress-speed-display');
    const progressSizeDisplay = document.getElementById('progress-size-display');
    const progressEtaDisplay = document.getElementById('progress-eta-display');
    const progressPhaseDisplay = document.getElementById('progress-phase-display');
    
    // Modal states
    const modalLoadingState = document.getElementById('modal-loading-state');
    const modalSuccessState = document.getElementById('modal-success-state');
    const successVideoTitleDisplay = document.getElementById('success-video-title-display');
    const saveFileBtn = document.getElementById('save-file-btn');
    const successDoneBtn = document.getElementById('success-done-btn');
    
    const modalFailedState = document.getElementById('modal-failed-state');
    const modalErrorMsg = document.getElementById('modal-error-msg');
    const failedRetryBtn = document.getElementById('failed-retry-btn');
    const failedCloseBtn = document.getElementById('failed-close-btn');

    // Legal Modal elements
    const legalModal = document.getElementById('legal-modal');
    const legalTitle = document.getElementById('legal-title');
    const legalContent = document.getElementById('legal-content');
    const legalCloseBtn = document.getElementById('legal-close-btn');
    const tosLink = document.getElementById('tos-link');
    const dmcaLink = document.getElementById('dmca-link');

    // Support Modal elements
    const supportModal = document.getElementById('support-modal');
    const supportCloseBtn = document.getElementById('support-close-btn');
    const supportBtn = document.getElementById('support-btn');
    const modalSupportBtn = document.getElementById('modal-support-btn');

    // State Variables
    let currentVideoInfo = null;
    let pollInterval = null;
    let currentJobId = null;
    let lastDownloadParams = null;
    let lastFetchedUrl = '';

    // Legal Texts Repository
    const legalTexts = {
        tos: `
            <h4>1. Acceptance of Terms</h4>
            <p>By using the YT-Download website ("Service"), you agree to abide by these Terms of Service. If you do not agree with any part of these terms, please do not use the Service.</p>
            
            <h4>2. Permitted Use</h4>
            <p>This Service is intended solely for personal, non-commercial, and educational purposes. You represent that you have the legal right or permission from the copyright owner to download any video or audio stream using this tool.</p>
            
            <h4>3. Intellectual Property Rights</h4>
            <p>We respect the intellectual property of others. You must not download copyrighted material unless you own it or have explicit written permission. Users assume all liabilities for any copyright infringement resulting from misuse of this tool.</p>
            
            <h4>4. Disclaimer of Warranties</h4>
            <p>The Service is provided "as is" and "as available". We make no warranties, express or implied, regarding the reliability, uptime, speed, or accuracy of the service. Downloads are executed on-the-fly and processed content is not hosted or kept permanently.</p>
            
            <h4>5. Limitation of Liability</h4>
            <p>In no event shall the operators of YT-Download or PandyShare be liable for any damages, direct or indirect, arising out of the use of, or inability to use, this website.</p>
        `,
        dmca: `
            <h4>DMCA Takedown & Abuse Policy</h4>
            <p>YT-Download operates as a transient download utility. When you request a download, the server fetches the data streams directly from official sources (such as YouTube), muxes them, and transmits the resulting file to your browser.</p>
            
            <h4>Important: We do not host content</h4>
            <p>Because files are generated on-the-fly and deleted from our servers immediately after the client download finishes (or after a 30-minute expiration timeout), <strong>there is no database, catalog, or permanent repository of uploaded files</strong> on this server. Consequently, we cannot "takedown" files that do not exist on our storage.</p>
            
            <h4>Reporting Abuse or Security Violations</h4>
            <p>If you believe this tool is being used to bypass specific security architectures, or if you have questions regarding intellectual property rights on this service, please contact us directly via our support channel:</p>
            <ul>
                <li>Telegram: <a href="https://t.me/pandyshare" target="_blank" style="color:var(--accent-cyan);">t.me/pandyshare</a></li>
            </ul>
            <p>We will review your inquiry within 48 hours. Please refer copyright takedown requests for the source videos directly to the hosting provider (YouTube, LLC) where the files are stored publicly.</p>
        `
    };

    // Helper: Validate YouTube URL
    function isValidYouTubeUrl(url) {
        const regex = /^(https?:\/\/)?(www\.)?(youtube\.com|youtu\.be)\/(watch\?v=|embed\/|v\/|shorts\/)?([a-zA-Z0-9_-]{11})/i;
        return regex.test(url.trim());
    }

    // Helper: Check for Playlist in URL
    function checkForPlaylist(url) {
        return url.includes('list=') || url.includes('playlist?');
    }

    // Input monitoring for auto-extraction and warnings
    let debounceTimer = null;

    urlInput.addEventListener('input', () => {
        const url = urlInput.value.trim();
        
        // Show/hide playlist warning
        if (url && checkForPlaylist(url)) {
            playlistWarning.classList.remove('hidden');
        } else {
            playlistWarning.classList.add('hidden');
        }

        // Debounce typing to avoid extracting incomplete URLs
        if (debounceTimer) clearTimeout(debounceTimer);
        
        if (url && isValidYouTubeUrl(url) && url !== lastFetchedUrl) {
            debounceTimer = setTimeout(() => {
                lastFetchedUrl = url;
                fetchBtn.click();
            }, 600); // Trigger 600ms after the user stops typing
        }
    });

    // Trigger auto-extraction immediately on explicit paste event
    urlInput.addEventListener('paste', () => {
        // Allow input value to be updated by the browser before reading
        setTimeout(() => {
            const url = urlInput.value.trim();
            if (url && isValidYouTubeUrl(url) && url !== lastFetchedUrl) {
                if (debounceTimer) clearTimeout(debounceTimer);
                lastFetchedUrl = url;
                fetchBtn.click();
            }
        }, 50);
    });

    // Clipboard Paste Handler
    pasteBtn.addEventListener('click', async () => {
        try {
            const text = await navigator.clipboard.readText();
            if (text) {
                urlInput.value = text;
                urlInput.dispatchEvent(new Event('input')); // trigger auto extraction logic
                urlInput.focus();
                
                // button feedback
                pasteBtn.style.transform = 'scale(0.9)';
                setTimeout(() => pasteBtn.style.transform = 'scale(1)', 150);
            }
        } catch (err) {
            console.error('Failed to read clipboard: ', err);
            urlInput.placeholder = 'Paste blocked. Use Ctrl+V / Cmd+V';
            setTimeout(() => {
                urlInput.placeholder = 'Paste YouTube video link here...';
            }, 3000);
        }
    });

    // Tab Switching Logic
    const tabBtns = document.querySelectorAll('.tab-btn');
    tabBtns.forEach(btn => {
        btn.addEventListener('click', () => {
            const tab = btn.dataset.tab;
            tabBtns.forEach(b => b.classList.remove('active'));
            btn.classList.add('active');
            
            if (tab === 'video') {
                panelVideo.classList.add('active');
                panelAudio.classList.remove('active');
            } else {
                panelAudio.classList.add('active');
                panelVideo.classList.remove('active');
            }
        });
    });

    // Resolution Text Labels
    function getResolutionLabel(height) {
        switch (parseInt(height)) {
            case 2160: return '2160p (4K Ultra HD)';
            case 1440: return '1440p (Quad HD)';
            case 1080: return '1080p (Full HD)';
            case 720: return '720p (HD)';
            case 480: return '480p (Standard)';
            case 360: return '360p (Mobile)';
            default: return `${height}p`;
        }
    }

    // Action: Extract Details
    fetchBtn.addEventListener('click', async () => {
        const url = urlInput.value.trim();
        if (!url) {
            showError('Please paste a YouTube link first.');
            return;
        }

        if (!isValidYouTubeUrl(url)) {
            showError('Invalid YouTube URL. Please check the link and try again.');
            return;
        }

        // Double-check playlist warning on extraction
        if (checkForPlaylist(url)) {
            playlistWarning.classList.remove('hidden');
        } else {
            playlistWarning.classList.add('hidden');
        }

        // Reset display
        errorMessage.classList.add('hidden');
        videoCard.classList.add('hidden');
        skeletonLoader.classList.remove('hidden');
        
        fetchBtn.disabled = true;
        fetchBtnText.textContent = 'Extracting...';
        fetchBtnIcon.classList.add('hidden');
        fetchSpinner.classList.remove('hidden');

        try {
            const response = await fetch(`/api/info?url=${encodeURIComponent(url)}`);
            
            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                throw new Error('Our server is currently handling other downloads. Please try again in a moment.');
            }

            if (!response.ok) {
                throw new Error(data.error || 'Failed to fetch details');
            }

            currentVideoInfo = data;
            
            // Populate Video Details
            videoThumbnail.src = data.thumbnail;
            videoDuration.textContent = data.durationString;
            videoTitle.textContent = data.title;
            uploaderText.textContent = data.uploader;
            
            const views = parseInt(data.viewCount);
            viewsText.textContent = views ? `${views.toLocaleString()} views` : 'Unknown views';

            // Calculate precise audio sizes in MB dynamically based on duration
            const size320 = Math.max(1, Math.round(data.duration * 0.04));
            const size256 = Math.max(1, Math.round(data.duration * 0.032));
            const size128 = Math.max(1, Math.round(data.duration * 0.016));
            
            audioSize320.textContent = `Estimated size: ~${size320} MB`;
            audioSize256.textContent = `Estimated size: ~${size256} MB`;
            audioSize128.textContent = `Estimated size: ~${size128} MB`;

            // Populate dynamic Video formats grid with real file sizes if available
            videoFormatsGrid.innerHTML = '';
            data.availableResolutions.forEach(res => {
                const resolutionLabel = getResolutionLabel(res);
                
                // Use actual file size from yt-dlp metadata if present, else fallback to average formula
                let sizeText = '';
                if (data.estimatedSizes && data.estimatedSizes[res]) {
                    sizeText = `Size: ~${data.estimatedSizes[res]} MB`;
                } else {
                    const mins = data.duration / 60;
                    let fallbackMb = 5;
                    if (res >= 2160) fallbackMb = mins * 120;
                    else if (res >= 1440) fallbackMb = mins * 65;
                    else if (res >= 1080) fallbackMb = mins * 28;
                    else if (res >= 720) fallbackMb = mins * 14;
                    else fallbackMb = mins * 6.5;
                    sizeText = `Estimated size: ~${Math.round(fallbackMb)} MB`;
                }

                const formatItem = document.createElement('div');
                formatItem.className = 'format-item';
                formatItem.innerHTML = `
                    <div class="format-info-left">
                        <span class="format-badge video">MP4</span>
                        <div class="format-details-text">
                            <span class="format-quality">${resolutionLabel}</span>
                            <span class="format-size-est">${sizeText}</span>
                        </div>
                    </div>
                    <button type="button" class="download-btn btn-secondary start-download-btn" data-type="video" data-quality="${res}">
                        <span>Download</span> <i class="fa-solid fa-download"></i>
                    </button>
                `;
                videoFormatsGrid.appendChild(formatItem);
            });

            // Re-bind listeners for downloads
            document.querySelectorAll('.start-download-btn').forEach(btn => {
                btn.addEventListener('click', () => {
                    const type = btn.getAttribute('data-type');
                    const quality = btn.getAttribute('data-quality');
                    triggerDownload(type, quality);
                });
            });

            // Toggle views
            skeletonLoader.classList.add('hidden');
            videoCard.classList.remove('hidden');
            lastFetchedUrl = url;

        } catch (err) {
            console.error('Details fetch error:', err);
            showError(err.message || 'An error occurred while loading video details.');
            skeletonLoader.classList.add('hidden');
        } finally {
            fetchBtn.disabled = false;
            fetchBtnText.textContent = 'Extract Details';
            fetchBtnIcon.classList.remove('hidden');
            fetchSpinner.classList.add('hidden');
        }
    });

    // Action: Trigger Download
    async function triggerDownload(type, quality) {
        if (!currentVideoInfo) return;

        const url = urlInput.value.trim();
        const title = currentVideoInfo.title;

        lastDownloadParams = { url, type, quality, title };

        // Setup loading state
        modalLoadingState.classList.remove('hidden');
        modalSuccessState.classList.add('hidden');
        modalFailedState.classList.add('hidden');
        
        modalVideoTitleDisplay.textContent = title;
        modalTitleText.textContent = 'Preparing Download...';
        progressBarFill.style.width = '0%';
        progressPercentDisplay.textContent = '0%';
        progressSpeedDisplay.textContent = '0 B/s';
        progressSizeDisplay.textContent = 'Calculating...';
        progressEtaDisplay.textContent = 'Estimating...';
        progressPhaseDisplay.textContent = 'Initializing stream queue...';

        progressModal.classList.remove('hidden');

        try {
            const response = await fetch('/api/download', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ url, type, quality, title })
            });

            let data;
            try {
                data = await response.json();
            } catch (parseErr) {
                throw new Error('Our server is currently handling other downloads. Please try again in a moment.');
            }

            if (!response.ok) {
                throw new Error(data.error || 'Failed to initialize download job');
            }

            currentJobId = data.jobId;
            startPolling(currentJobId);

        } catch (err) {
            console.error('Download start failed:', err);
            showDownloadError(err.message || 'Failed to start queue task.');
        }
    }

    // Polling Status Logic
    function startPolling(jobId) {
        if (pollInterval) clearInterval(pollInterval);

        pollInterval = setInterval(async () => {
            try {
                const response = await fetch(`/api/status/${jobId}`);
                
                if (response.status === 404) {
                    throw new Error('Download job expired or not found.');
                }
                
                let data;
                try {
                    data = await response.json();
                } catch (parseErr) {
                    // Server may have restarted due to overload - don't kill polling yet, retry
                    console.warn('Status poll: failed to parse response, retrying...');
                    return;
                }

                if (data.error) {
                    throw new Error(data.error);
                }

                // Handle status changes
                if (data.status === 'queued') {
                    modalTitleText.textContent = 'Queued in Line...';
                    progressBarFill.style.width = '0%';
                    progressPercentDisplay.textContent = '0%';
                    progressSpeedDisplay.textContent = '--';
                    progressSizeDisplay.textContent = 'Waiting';
                    
                    const posText = data.queuePosition ? `Position: #${data.queuePosition}` : 'In Queue';
                    progressEtaDisplay.textContent = posText;
                    progressPhaseDisplay.textContent = `Server is busy. Waiting for concurrent downloads to finish (${posText})...`;
                } else if (data.status === 'downloading') {
                    modalTitleText.textContent = data.type === 'audio' ? 'Converting to MP3...' : 'Downloading Video...';
                    progressBarFill.style.width = `${data.percent}%`;
                    progressPercentDisplay.textContent = `${Math.round(data.percent)}%`;
                    progressSpeedDisplay.textContent = data.speed;
                    progressSizeDisplay.textContent = data.size;
                    progressEtaDisplay.textContent = data.eta;
                    progressPhaseDisplay.textContent = 'Downloading media streams...';
                } else if (data.status === 'processing') {
                    progressBarFill.style.width = '95%';
                    progressPercentDisplay.textContent = '95%';
                    progressSpeedDisplay.textContent = '--';
                    progressEtaDisplay.textContent = 'Processing...';
                    progressPhaseDisplay.textContent = data.title_status || 'Processing files on server...';
                } else if (data.status === 'completed') {
                    stopPolling();
                    showDownloadSuccess(jobId);
                } else if (data.status === 'failed') {
                    throw new Error(data.error || 'Conversion task failed on server.');
                }

            } catch (err) {
                console.error('Polling error:', err);
                stopPolling();
                showDownloadError(err.message || 'An error occurred during status tracking.');
            }
        }, 800);
    }

    function stopPolling() {
        if (pollInterval) {
            clearInterval(pollInterval);
            pollInterval = null;
        }
    }

    // Cancel / Abort active download job
    async function abortCurrentJob() {
        if (!currentJobId) return;

        const jobId = currentJobId;
        stopPolling();
        
        // Optimistically close modal
        progressModal.classList.add('hidden');
        currentJobId = null;

        try {
            await fetch(`/api/cancel/${jobId}`, { method: 'POST' });
            console.log(`Cancelled job ${jobId} successfully.`);
        } catch (err) {
            console.error('Failed to cancel job:', err);
        }
    }

    // Modal State Swapping
    function showDownloadSuccess(jobId) {
        modalLoadingState.classList.add('hidden');
        modalFailedState.classList.add('hidden');
        modalSuccessState.classList.remove('hidden');

        successVideoTitleDisplay.textContent = currentVideoInfo.title;
        saveFileBtn.href = `/api/retrieve/${jobId}`;
        currentJobId = null;
    }

    function showDownloadError(message) {
        modalLoadingState.classList.add('hidden');
        modalSuccessState.classList.add('hidden');
        modalFailedState.classList.remove('hidden');

        modalErrorMsg.textContent = message;
    }

    function showError(message) {
        errorText.textContent = message;
        errorMessage.classList.remove('hidden');
        errorMessage.scrollIntoView({ behavior: 'smooth', block: 'center' });
    }

    // Legal Modals Trigger
    function openLegalModal(type) {
        if (type === 'tos') {
            legalTitle.textContent = 'Terms of Service';
            legalContent.innerHTML = legalTexts.tos;
        } else if (type === 'dmca') {
            legalTitle.textContent = 'DMCA Takedown Policy';
            legalContent.innerHTML = legalTexts.dmca;
        }
        legalModal.classList.remove('hidden');
    }

    tosLink.addEventListener('click', (e) => {
        e.preventDefault();
        openLegalModal('tos');
    });

    dmcaLink.addEventListener('click', (e) => {
        e.preventDefault();
        openLegalModal('dmca');
    });

    legalCloseBtn.addEventListener('click', () => {
        legalModal.classList.add('hidden');
    });

    // Support Modal handlers
    function openSupportModal() {
        supportModal.classList.remove('hidden');
    }

    function closeSupportModal() {
        supportModal.classList.add('fade-out');
        setTimeout(() => {
            supportModal.classList.add('hidden');
            supportModal.classList.remove('fade-out');
        }, 280);
    }

    supportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openSupportModal();
    });

    modalSupportBtn.addEventListener('click', (e) => {
        e.preventDefault();
        openSupportModal();
    });

    supportCloseBtn.addEventListener('click', closeSupportModal);

    supportModal.addEventListener('click', (e) => {
        if (e.target === supportModal) {
            closeSupportModal();
        }
    });

    legalModal.addEventListener('click', (e) => {
        if (e.target === legalModal) {
            legalModal.classList.add('hidden');
        }
    });

    // Modal Action Bindings
    modalCancelBtn.addEventListener('click', abortCurrentJob);
    modalAbortBtn.addEventListener('click', abortCurrentJob);

    successDoneBtn.addEventListener('click', () => {
        progressModal.classList.add('hidden');
    });

    saveFileBtn.addEventListener('click', () => {
        setTimeout(() => {
            progressModal.classList.add('hidden');
        }, 1500);
    });

    failedCloseBtn.addEventListener('click', () => {
        progressModal.classList.add('hidden');
        currentJobId = null;
    });

    failedRetryBtn.addEventListener('click', () => {
        if (lastDownloadParams) {
            triggerDownload(lastDownloadParams.type, lastDownloadParams.quality);
        } else {
            progressModal.classList.add('hidden');
        }
    });

    // Close on overlay clicks
    progressModal.addEventListener('click', (e) => {
        if (e.target === progressModal) {
            abortCurrentJob();
        }
    });

    // Beacon request to cancel active download if the user leaves/closes the tab
    window.addEventListener('beforeunload', () => {
        if (currentJobId) {
            navigator.sendBeacon(`/api/cancel/${currentJobId}`);
        }
    });
});

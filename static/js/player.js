/* FlowFlix - Netflix-style Custom Video Player Engine */

const player = {
    overlay: null,
    video: null,
    isPlaying: false,
    currentVideoId: null,
    currentVideoTitle: null,
    currentVideoFolder: null,
    currentVideoFilename: null,
    activeSubtitles: [],
    audioTracks: [],
    currentAudioTrack: 0,
    isRotated: false,
    
    totalDuration: 0,
    streamStartTime: 0,
    
    init() {
        this.overlay = document.getElementById('playerOverlay');
        this.video = document.getElementById('mainVideoPlayer');
        
        if (!this.video) return;

        // Video Event Listeners
        this.video.addEventListener('timeupdate', () => this.updateTime());
        this.video.addEventListener('progress', () => this.updateBuffer());
        this.video.addEventListener('loadedmetadata', () => this.onMetadataLoaded());
        this.video.addEventListener('play', () => this.onPlayState(true));
        this.video.addEventListener('pause', () => this.onPlayState(false));
        this.video.addEventListener('ended', () => this.onPlayState(false));
        
        // Setup Timeline Drag & Scrubbing
        this.setupTimeline();
        
        // Keyboard Shortcuts
        document.addEventListener('keydown', (e) => this.handleKeydown(e));
        
        // Hide controls after inactivity
        this.setupInactivityTimer();

        // Setup Popstate Listener for Browser/Mobile Back Gesture
        this.setupPopstateHandler();
    },

    getDuration() {
        if (this.totalDuration && isFinite(this.totalDuration) && this.totalDuration > 0) {
            return this.totalDuration;
        }
        if (this.video && this.video.duration && isFinite(this.video.duration) && this.video.duration > 0) {
            return this.video.duration;
        }
        return 0;
    },

    getCurrentTime() {
        if (!this.video) return 0;
        return (this.streamStartTime || 0) + (this.video.currentTime || 0);
    },

    seekToTime(targetTime) {
        if (!this.video) return;
        const duration = this.getDuration();
        targetTime = Math.max(0, Math.min(duration || 0, targetTime));

        if (this.currentAudioTrack !== null && this.currentAudioTrack !== undefined) {
            // Remuxed FFmpeg audio stream: seek by updating URL with &t= targetTime
            this.streamStartTime = Math.floor(targetTime);
            const isPaused = this.video.paused;
            const videoUrl = `/video/${encodeURIComponent(this.currentVideoId)}?audio=${this.currentAudioTrack}&t=${this.streamStartTime}`;
            this.video.src = videoUrl;
            if (!isPaused) {
                this.video.play().catch(()=>{});
            }
        } else {
            // Native range stream: seek directly via currentTime
            this.streamStartTime = 0;
            this.video.currentTime = targetTime;
        }
    },

    open(videoId, title, folderPath, subtitleUrl, filename, isFromPopState = false) {
        if (!isFromPopState && (!history.state || history.state.view !== 'player' || history.state.videoId !== videoId)) {
            history.pushState({ view: 'player', videoId: videoId }, '');
        }

        this.currentVideoId = videoId;
        this.currentVideoTitle = title || videoId;
        this.currentVideoFolder = folderPath || 'Media Library';
        this.currentVideoFilename = filename || title || videoId;

        this.totalDuration = 0;
        this.streamStartTime = 0;
        this.currentAudioTrack = null;

        const videoUrl = `/video/${encodeURIComponent(videoId)}`;
        const downloadUrl = `/download/${encodeURIComponent(videoId)}`;

        // Set video source
        this.video.src = videoUrl;
        
        // Set Titles
        document.getElementById('playerTitle').textContent = this.currentVideoTitle;
        document.getElementById('playerSub').textContent = this.currentVideoFolder;
        
        // Set Download Link with exact original filename preservation
        const dlBtn = document.getElementById('playerDownloadLink');
        dlBtn.href = downloadUrl;
        dlBtn.setAttribute('download', this.currentVideoFilename);

        // Reset Subtitles & Load Audio Tracks
        this.clearSubtitles();
        if (subtitleUrl) {
            this.loadSubtitle(subtitleUrl);
        }

        this.loadAudioTracks(videoId);

        // Show Overlay
        this.overlay.classList.remove('hidden');
        document.body.style.overflow = 'hidden';

        // Auto Play
        this.video.play().catch(err => {
            console.log('Autoplay prevented by browser:', err);
        });
    },

    close(isFromPopState = false) {
        if (!this.overlay || this.overlay.classList.contains('hidden')) return;

        if (this.video) {
            this.video.pause();
            this.video.removeAttribute('src');
            this.video.load();
        }
        if (this.overlay) {
            this.overlay.classList.add('hidden');
            this.overlay.classList.remove('rotated-landscape');
        }
        this.isRotated = false;
        this.totalDuration = 0;
        this.streamStartTime = 0;
        this.currentAudioTrack = null;
        document.body.style.overflow = '';
        
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(()=>{});
        }

        if (!isFromPopState && history.state && history.state.view === 'player') {
            history.back();
        }
    },

    togglePlay() {
        if (!this.video) return;
        if (this.video.paused) {
            this.video.play();
        } else {
            this.video.pause();
        }
    },

    onPlayState(playing) {
        this.isPlaying = playing;
        const btnIcon = document.querySelector('#playPauseBtn i');
        if (btnIcon) {
            btnIcon.className = playing ? 'fa-solid fa-pause' : 'fa-solid fa-play';
        }
    },

    skip(seconds) {
        if (!this.video) return;
        const current = this.getCurrentTime();
        this.seekToTime(current + seconds);
    },

    setVolume(val) {
        if (!this.video) return;
        this.video.volume = parseFloat(val);
        const icon = document.querySelector('#muteBtn i');
        if (icon) {
            if (this.video.volume === 0) icon.className = 'fa-solid fa-volume-xmark';
            else if (this.video.volume < 0.5) icon.className = 'fa-solid fa-volume-low';
            else icon.className = 'fa-solid fa-volume-high';
        }
    },

    toggleMute() {
        if (!this.video) return;
        this.video.muted = !this.video.muted;
        const icon = document.querySelector('#muteBtn i');
        if (icon) {
            icon.className = this.video.muted ? 'fa-solid fa-volume-xmark' : 'fa-solid fa-volume-high';
        }
    },

    setSpeed(speed, label) {
        if (!this.video) return;
        this.video.playbackRate = speed;
        document.getElementById('speedBtn').textContent = label;
        this.closeDropdowns();
    },

    // MULTI-AUDIO TRACK SELECTION
    async loadAudioTracks(videoId) {
        const menu = document.getElementById('audioTrackMenu');
        const label = document.getElementById('audioTrackLabel');
        if (!menu) return;

        try {
            const res = await fetch(`/api/video/${encodeURIComponent(videoId)}/audio_tracks`);
            if (!res.ok) return;

            this.audioTracks = await res.json();
            
            if (this.audioTracks.length <= 1) {
                label.textContent = 'Audio';
                menu.innerHTML = '<div class="dropdown-item active">Default Audio</div>';
                return;
            }

            label.textContent = `Audio (${this.audioTracks.length})`;
            
            menu.innerHTML = this.audioTracks.map((t, idx) => `
                <div class="dropdown-item ${idx === 0 ? 'active' : ''}" onclick="player.setAudioTrack(${idx})">
                    <i class="fa-solid fa-volume-low"></i> ${t.title}
                </div>
            `).join('');
        } catch (err) {
            console.error("Audio tracks load error:", err);
        }
    },

    setAudioTrack(trackIdx) {
        if (trackIdx === this.currentAudioTrack) return;

        const currentPos = this.getCurrentTime();
        this.currentAudioTrack = trackIdx;
        this.streamStartTime = Math.floor(currentPos);

        let videoUrl = `/video/${encodeURIComponent(this.currentVideoId)}?audio=${trackIdx}`;
        if (this.streamStartTime > 0) {
            videoUrl += `&t=${this.streamStartTime}`;
        }

        // Update active highlight in menu
        const menu = document.getElementById('audioTrackMenu');
        if (menu) {
            const items = menu.querySelectorAll('.dropdown-item');
            items.forEach((el, i) => el.classList.toggle('active', i === trackIdx));
        }

        // Reload video stream with selected audio track
        const isPaused = this.video ? this.video.paused : false;
        this.video.src = videoUrl;

        const onLoaded = () => {
            if (this.video && !isPaused) {
                this.video.play().catch(()=>{});
            }
            this.video.removeEventListener('loadedmetadata', onLoaded);
        };
        this.video.addEventListener('loadedmetadata', onLoaded);

        this.closeDropdowns();

        const trackName = this.audioTracks[trackIdx] ? this.audioTracks[trackIdx].title : `Track ${trackIdx+1}`;
        if (window.app) app.showToast(`Switched audio to: ${trackName}`, 'info');
    },

    // SCREEN ROTATION TOGGLE
    toggleRotation() {
        if (screen.orientation && screen.orientation.lock) {
            if (this.isRotated) {
                screen.orientation.unlock();
                this.isRotated = false;
                this.overlay.classList.remove('rotated-landscape');
                if (window.app) app.showToast('Screen Orientation: Normal', 'info');
            } else {
                screen.orientation.lock('landscape').then(() => {
                    this.isRotated = true;
                    if (window.app) app.showToast('Screen Locked: Landscape', 'info');
                }).catch(() => {
                    this.fallbackRotation();
                });
            }
        } else {
            this.fallbackRotation();
        }
    },

    fallbackRotation() {
        this.isRotated = !this.isRotated;
        if (this.isRotated) {
            this.overlay.classList.add('rotated-landscape');
            if (window.app) app.showToast('Screen Rotated (90° Landscape)', 'info');
        } else {
            this.overlay.classList.remove('rotated-landscape');
            if (window.app) app.showToast('Screen Rotated (Normal)', 'info');
        }
    },

    toggleFullscreen() {
        if (!document.fullscreenElement) {
            this.overlay.requestFullscreen().catch(err => {
                console.error("Fullscreen error:", err);
            });
        } else {
            document.exitFullscreen().catch(()=>{});
        }
    },

    setupTimeline() {
        const timeline = document.getElementById('timelineContainer');
        if (!timeline) return;

        let isScrubbing = false;

        const updateScrub = (e) => {
            const duration = this.getDuration();
            if (!this.video || !duration) return;
            const rect = timeline.getBoundingClientRect();
            const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
            this.seekToTime(pos * duration);
        };

        timeline.addEventListener('mousedown', (e) => {
            isScrubbing = true;
            updateScrub(e);
        });

        window.addEventListener('mousemove', (e) => {
            if (isScrubbing) updateScrub(e);
            
            const duration = this.getDuration();
            if (this.video && duration) {
                const rect = timeline.getBoundingClientRect();
                if (e.clientX >= rect.left && e.clientX <= rect.right) {
                    const pos = Math.max(0, Math.min(1, (e.clientX - rect.left) / rect.width));
                    const hoverTime = pos * duration;
                    const timeEl = document.getElementById('timelineHoverTime');
                    if (timeEl) {
                        timeEl.style.left = `${pos * 100}%`;
                        timeEl.textContent = this.formatTime(hoverTime);
                    }
                }
            }
        });

        window.addEventListener('mouseup', () => {
            isScrubbing = false;
        });
    },

    updateTime() {
        const duration = this.getDuration();
        if (!this.video || !duration) return;

        const current = this.getCurrentTime();
        const pct = Math.min(100, Math.max(0, (current / duration) * 100));

        document.getElementById('timelineProgress').style.width = `${pct}%`;
        document.getElementById('timelineHandle').style.left = `${pct}%`;
        document.getElementById('currentTimeDisplay').textContent = this.formatTime(current);
        document.getElementById('durationDisplay').textContent = this.formatTime(duration);

        this.updateSubtitleTrack(current);
    },

    updateBuffer() {
        const duration = this.getDuration();
        if (!this.video || !duration) return;
        if (this.video.buffered.length > 0) {
            const bufferedEnd = (this.streamStartTime || 0) + this.video.buffered.end(this.video.buffered.length - 1);
            const pct = Math.min(100, Math.max(0, (bufferedEnd / duration) * 100));
            document.getElementById('timelineBuffer').style.width = `${pct}%`;
        }
    },

    onMetadataLoaded() {
        if (this.video && this.video.duration && isFinite(this.video.duration) && this.video.duration > 0) {
            if (this.video.duration > this.totalDuration) {
                this.totalDuration = this.video.duration;
            }
        }
        document.getElementById('durationDisplay').textContent = this.formatTime(this.getDuration());
    },

    formatTime(sec) {
        if (isNaN(sec)) return '00:00';
        const h = Math.floor(sec / 3600);
        const m = Math.floor((sec % 3600) / 60);
        const s = Math.floor(sec % 60);
        
        const mStr = m < 10 ? '0' + m : m;
        const sStr = s < 10 ? '0' + s : s;
        
        if (h > 0) {
            return `${h}:${mStr}:${sStr}`;
        }
        return `${mStr}:${sStr}`;
    },

    // SUBTITLES MANAGEMENT
    async loadSubtitle(url) {
        try {
            const res = await fetch(url);
            if (!res.ok) return;
            const text = await res.text();
            this.activeSubtitles = this.parseVTTorSRT(text);
        } catch (err) {
            console.error('Subtitle fetch failed:', err);
        }
    },

    clearSubtitles() {
        this.activeSubtitles = [];
        document.getElementById('subtitleDisplay').textContent = '';
    },

    updateSubtitleTrack(currentTime) {
        if (!this.activeSubtitles.length) return;
        const sub = this.activeSubtitles.find(s => currentTime >= s.start && currentTime <= s.end);
        document.getElementById('subtitleDisplay').textContent = sub ? sub.text : '';
    },

    parseVTTorSRT(content) {
        const cues = [];
        const blocks = content.replace(/\r\n/g, '\n').split('\n\n');
        const timeReg = /(\d{2}:)?(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}:)?(\d{2}):(\d{2})[,.](\d{3})/;

        for (const block of blocks) {
            const lines = block.trim().split('\n');
            let timeLineIdx = -1;
            
            for (let i = 0; i < lines.length; i++) {
                if (timeReg.test(lines[i])) {
                    timeLineIdx = i;
                    break;
                }
            }

            if (timeLineIdx !== -1) {
                const match = lines[timeLineIdx].match(timeReg);
                if (match) {
                    const start = this.timeToSec(match[1], match[2], match[3], match[4]);
                    const end = this.timeToSec(match[5], match[6], match[7], match[8]);
                    const text = lines.slice(timeLineIdx + 1).join('\n').replace(/<[^>]*>/g, '');
                    cues.push({ start, end, text });
                }
            }
        }
        return cues;
    },

    timeToSec(h, m, s, ms) {
        const hours = h ? parseInt(h.replace(':', ''), 10) : 0;
        const mins = parseInt(m, 10);
        const secs = parseInt(s, 10);
        const millis = parseInt(ms, 10) / 1000;
        return hours * 3600 + mins * 60 + secs + millis;
    },

    toggleDropdown(id) {
        const el = document.getElementById(id);
        if (!el) return;
        const isHidden = el.classList.contains('hidden');
        this.closeDropdowns();
        if (isHidden) el.classList.remove('hidden');
    },

    closeDropdowns() {
        document.querySelectorAll('.dropdown-menu').forEach(m => m.classList.add('hidden'));
    },

    setupInactivityTimer() {
        let timer;
        const topBar = document.querySelector('.player-top-bar');
        const controls = document.getElementById('playerControls');

        const showUI = () => {
            if (topBar) topBar.style.opacity = '1';
            if (controls) controls.style.opacity = '1';
            document.body.style.cursor = 'default';
            clearTimeout(timer);
            if (this.isPlaying) {
                timer = setTimeout(() => {
                    if (topBar) topBar.style.opacity = '0';
                    if (controls) controls.style.opacity = '0';
                    document.body.style.cursor = 'none';
                    this.closeDropdowns();
                }, 3500);
            }
        };

        if (this.overlay) {
            this.overlay.addEventListener('mousemove', showUI);
            this.overlay.addEventListener('click', showUI);
        }
    },

    handleKeydown(e) {
        if (!this.overlay || this.overlay.classList.contains('hidden')) return;

        if (e.code === 'Space' || e.code === 'KeyK') {
            e.preventDefault();
            this.togglePlay();
        } else if (e.code === 'ArrowRight' || e.code === 'KeyL') {
            e.preventDefault();
            this.skip(10);
        } else if (e.code === 'ArrowLeft' || e.code === 'KeyJ') {
            e.preventDefault();
            this.skip(-10);
        } else if (e.code === 'KeyF') {
            e.preventDefault();
            this.toggleFullscreen();
        } else if (e.code === 'KeyM') {
            e.preventDefault();
            this.toggleMute();
        } else if (e.code === 'Escape') {
            this.close();
        }
    },

    setupPopstateHandler() {
        window.addEventListener('popstate', (e) => {
            // 1. If Video Player is active, close it without triggering history.back()
            if (this.overlay && !this.overlay.classList.contains('hidden')) {
                this.close(true);
                // If popped state is details modal, reopen it
                if (e.state && e.state.view === 'modal' && e.state.videoId) {
                    if (window.app) window.app.openModalById(e.state.videoId, true);
                }
                return;
            }

            // 2. If Details Modal is active, close it
            const detailsModal = document.getElementById('detailsModal');
            if (detailsModal && !detailsModal.classList.contains('hidden')) {
                if (window.app) window.app.closeModal(null, true);
                return;
            }

            // 3. If Upload Modal is active, close it
            const uploadModal = document.getElementById('uploadModal');
            if (uploadModal && !uploadModal.classList.contains('hidden')) {
                if (window.app) window.app.closeUploadModal(null, true);
                return;
            }

            // 4. Handle history forward/back when no modal is open
            if (e.state && e.state.view === 'modal' && e.state.videoId) {
                if (window.app) window.app.openModalById(e.state.videoId, true);
            } else if (e.state && e.state.view === 'player' && e.state.videoId) {
                if (window.app) {
                    const video = window.app.allVideos.find(v => v.id === e.state.videoId);
                    if (video) {
                        this.open(video.id, video.title, video.folder, video.subtitle_url, video.filename, true);
                    }
                }
            }
        });
    }
};

document.addEventListener('DOMContentLoaded', () => player.init());

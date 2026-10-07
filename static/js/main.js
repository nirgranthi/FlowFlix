/* FlowFlix - Main Frontend UI Logic & Library Engine */

const app = {
    allVideos: [],
    folders: [],
    currentCategory: 'all',
    activeFolderFilter: null,
    selectedVideo: null,

    async init() {
        this.setupNavbarScroll();
        await this.loadLibrary();
    },

    setupNavbarScroll() {
        const nav = document.getElementById('mainNavbar');
        window.addEventListener('scroll', () => {
            if (window.scrollY > 50) {
                nav.classList.add('scrolled');
            } else {
                nav.classList.remove('scrolled');
            }
        });
    },

    async loadLibrary() {
        try {
            const [vRes, fRes] = await Promise.all([
                fetch('/api/videos'),
                fetch('/api/folders')
            ]);

            if (!vRes.ok) throw new Error('Failed to load videos');

            this.allVideos = await vRes.json();
            this.folders = fRes.ok ? await fRes.json() : [];

            this.renderFolderPills();
            this.renderHero();
            this.renderCarousels();
        } catch (err) {
            console.error('Library loading error:', err);
            this.showToast('Failed to connect to FlowFlix server', 'error');
        }
    },

    async rescanLibrary() {
        this.showToast('Scanning media library for new files...', 'info');
        try {
            const res = await fetch('/api/scan', { method: 'POST' });
            if (res.ok) {
                const data = await res.json();
                this.showToast(`Scan complete! Found ${data.count} titles`, 'success');
                await this.loadLibrary();
            } else {
                this.showToast('Rescan failed', 'error');
            }
        } catch (err) {
            console.error(err);
            this.showToast('Scan request error', 'error');
        }
    },

    renderHero() {
        if (!this.allVideos.length) {
            document.getElementById('heroTitle').textContent = 'No Movies Found in Media Library';
            document.getElementById('heroDescription').textContent = 'Please put your video files into the media folder or click Upload above.';
            return;
        }

        const featured = this.allVideos[0];
        this.setHeroMovie(featured);
    },

    setHeroMovie(v) {
        document.getElementById('heroTitle').textContent = v.title;
        document.getElementById('heroYear').textContent = v.year || '2026';
        document.getElementById('heroQuality').textContent = v.quality || '1080p';
        document.getElementById('heroAudio').textContent = v.audio || 'HD Audio';
        document.getElementById('heroSize').textContent = v.size_formatted || '';
        document.getElementById('heroDescription').textContent = v.description || `High quality media file located in ${v.folder || 'Media Library'}. Stream instantly or download to device.`;

        // Action Buttons
        document.getElementById('heroPlayBtn').onclick = () => player.open(v.id, v.title, v.folder, v.subtitle_url, v.filename);
        
        const dlBtn = document.getElementById('heroDownloadBtn');
        dlBtn.onclick = () => {
            const a = document.createElement('a');
            a.href = `/download/${encodeURIComponent(v.id)}`;
            a.download = v.filename;
            a.click();
        };

        document.getElementById('heroInfoBtn').onclick = () => this.openModal(v);

        // Visual backdrop - Poster Image from TMDB / FFmpeg
        const backdropEl = document.getElementById('heroBackdrop');
        const posterUrl = `/poster/${encodeURIComponent(v.id)}`;
        backdropEl.style.backgroundImage = `url("${posterUrl}"), ${this.generatePosterGradient(v.title)}`;
    },

    renderFolderPills() {
        const container = document.getElementById('folderPillsList');
        if (!container) return;

        let html = `
            <div class="folder-pill ${!this.activeFolderFilter ? 'active' : ''}" onclick="app.filterByFolder(null)">
                <i class="fa-solid fa-layer-group"></i> All Items (${this.allVideos.length})
            </div>
        `;

        this.folders.forEach(f => {
            const isActive = this.activeFolderFilter === f.name;
            html += `
                <div class="folder-pill ${isActive ? 'active' : ''}" onclick="app.filterByFolder('${f.name}')">
                    <i class="fa-solid fa-folder"></i> ${f.name} (${f.count})
                </div>
            `;
        });

        container.innerHTML = html;
    },

    filterByFolder(folderName) {
        this.activeFolderFilter = folderName;
        this.renderFolderPills();
        
        if (folderName) {
            const filtered = this.allVideos.filter(v => v.folder === folderName);
            this.renderSearchResultsGrid(filtered, `Folder: ${folderName}`);
        } else {
            document.getElementById('searchResultsSection').classList.add('hidden');
            document.getElementById('carouselsContainer').classList.remove('hidden');
        }
    },

    filterCategory(cat) {
        this.currentCategory = cat;
        this.activeFolderFilter = null;
        
        document.querySelectorAll('.nav-link').forEach(l => {
            l.classList.toggle('active', l.getAttribute('data-cat') === cat);
        });

        if (cat === 'all') {
            document.getElementById('searchResultsSection').classList.add('hidden');
            document.getElementById('carouselsContainer').classList.remove('hidden');
            this.renderFolderPills();
        } else if (cat === 'movie') {
            const movies = this.allVideos.filter(v => v.category !== 'TV Show');
            this.renderSearchResultsGrid(movies, 'Movies Collection');
        } else if (cat === 'tv') {
            const tv = this.allVideos.filter(v => v.category === 'TV Show' || v.season_episode);
            this.renderSearchResultsGrid(tv, 'TV Shows & Series');
        } else if (cat === 'folders') {
            document.getElementById('folderBarSection').scrollIntoView({ behavior: 'smooth' });
        }
    },

    renderCarousels() {
        const container = document.getElementById('carouselsContainer');
        if (!container) return;

        let html = '';

        if (this.allVideos.length > 0) {
            html += this.createCarouselRow('Recently Added', 'fa-clock', this.allVideos.slice(0, 10));
        }

        const tvSeries = this.allVideos.filter(v => v.category === 'TV Show' || v.season_episode);
        if (tvSeries.length > 0) {
            html += this.createCarouselRow('TV Shows & Series', 'fa-tv', tvSeries);
        }

        const folderGroups = {};
        this.allVideos.forEach(v => {
            const f = v.folder || 'Root Directory';
            if (!folderGroups[f]) folderGroups[f] = [];
            folderGroups[f].push(v);
        });

        Object.keys(folderGroups).forEach(folderName => {
            const items = folderGroups[folderName];
            html += this.createCarouselRow(`Collection: ${folderName}`, 'fa-folder-open', items);
        });

        container.innerHTML = html;
    },

    createCarouselRow(title, iconClass, items) {
        const rowId = 'row_' + Math.random().toString(36).substring(2, 9);
        let cardsHtml = items.map(v => this.createMovieCardHtml(v)).join('');

        return `
            <section class="content-row">
                <h2 class="row-title"><i class="fa-solid ${iconClass}"></i> ${title}</h2>
                <div class="carousel-wrapper">
                    <button class="carousel-nav-btn prev" onclick="app.scrollCarousel('${rowId}', -600)">
                        <i class="fa-solid fa-chevron-left"></i>
                    </button>
                    <div class="carousel-container" id="${rowId}">
                        ${cardsHtml}
                    </div>
                    <button class="carousel-nav-btn next" onclick="app.scrollCarousel('${rowId}', 600)">
                        <i class="fa-solid fa-chevron-right"></i>
                    </button>
                </div>
            </section>
        `;
    },

    createMovieCardHtml(v) {
        const qualityBadge = v.quality ? `<span class="badge badge-quality">${v.quality}</span>` : '';
        const yearBadge = v.year ? `<span class="badge badge-outline">${v.year}</span>` : '';
        const sizeBadge = v.size_formatted ? `<span class="badge badge-audio">${v.size_formatted}</span>` : '';
        const isTv = v.season_episode ? `<span class="badge badge-match">${v.season_episode}</span>` : '';

        const escapedTitle = this.escapeHtml(v.title);
        const escapedFolder = this.escapeHtml(v.folder || 'Media Library');
        const escapedFilename = this.escapeHtml(v.filename);
        const posterUrl = `/poster/${encodeURIComponent(v.id)}`;

        return `
            <div class="movie-card" onclick="app.openModalById('${v.id}')">
                <div class="card-poster" style="background-image: url('${posterUrl}'), ${this.generatePosterGradient(v.title)}">
                    <div class="card-poster-placeholder">
                        <i class="fa-solid ${v.season_episode ? 'fa-tv' : 'fa-film'} card-icon"></i>
                    </div>
                </div>

                <div class="card-overlay">
                    <div class="card-top-badges">
                        ${isTv || '<span class="badge badge-match">HD</span>'}
                        ${sizeBadge}
                    </div>
                    
                    <div class="card-bottom-info">
                        <h4 class="card-title">${escapedTitle}</h4>
                        <div class="card-tags">
                            ${yearBadge}
                            ${qualityBadge}
                        </div>
                        <div class="card-actions">
                            <button class="card-btn" onclick="event.stopPropagation(); player.open('${v.id}', '${escapedTitle}', '${escapedFolder}', '${v.subtitle_url || ''}', '${escapedFilename}')" title="Play Movie">
                                <i class="fa-solid fa-play"></i>
                            </button>
                            <a class="card-btn card-btn-download" href="/download/${encodeURIComponent(v.id)}" download="${escapedFilename}" title="Download Original File" onclick="event.stopPropagation();">
                                <i class="fa-solid fa-download"></i>
                            </a>
                            <button class="card-btn" onclick="event.stopPropagation(); app.openModalById('${v.id}')" title="More Info">
                                <i class="fa-solid fa-info"></i>
                            </button>
                        </div>
                    </div>
                </div>
            </div>
        `;
    },

    scrollCarousel(rowId, distance) {
        const container = document.getElementById(rowId);
        if (container) {
            container.scrollBy({ left: distance, behavior: 'smooth' });
        }
    },

    // SEARCH & FILTERING
    handleSearch() {
        const query = document.getElementById('searchInput').value.trim().toLowerCase();
        const clearBtn = document.getElementById('clearSearchBtn');

        if (query.length > 0) {
            clearBtn.classList.remove('hidden');
            const matches = this.allVideos.filter(v => {
                const searchStr = `${v.title} ${v.filename} ${v.folder} ${v.quality} ${v.audio} ${v.year}`.toLowerCase();
                return searchStr.includes(query);
            });
            this.renderSearchResultsGrid(matches, `Search: "${query}"`);
        } else {
            clearBtn.classList.add('hidden');
            document.getElementById('searchResultsSection').classList.add('hidden');
            document.getElementById('carouselsContainer').classList.remove('hidden');
        }
    },

    clearSearch() {
        document.getElementById('searchInput').value = '';
        this.handleSearch();
    },

    renderSearchResultsGrid(items, titleLabel) {
        const section = document.getElementById('searchResultsSection');
        const grid = document.getElementById('searchResultsGrid');
        const countEl = document.getElementById('searchCount');
        const carousels = document.getElementById('carouselsContainer');

        carousels.classList.add('hidden');
        section.classList.remove('hidden');
        
        countEl.textContent = items.length;
        section.querySelector('.row-title').innerHTML = `<i class="fa-solid fa-film"></i> ${titleLabel} (${items.length})`;

        if (!items.length) {
            grid.innerHTML = '<p class="text-muted" style="padding:20px; grid-column: 1/-1;">No matching movies or videos found.</p>';
            return;
        }

        grid.innerHTML = items.map(v => this.createMovieCardHtml(v)).join('');
    },

    // DETAILS MODAL
    openModalById(id, isFromPopState = false) {
        const video = this.allVideos.find(v => v.id === id);
        if (video) this.openModal(video, isFromPopState);
    },

    openModal(v, isFromPopState = false) {
        this.selectedVideo = v;
        const modal = document.getElementById('detailsModal');
        
        if (!isFromPopState && (!history.state || history.state.view !== 'modal' || history.state.videoId !== v.id)) {
            history.pushState({ view: 'modal', videoId: v.id }, '');
        }

        document.getElementById('modalTitle').textContent = v.title;
        document.getElementById('modalYear').textContent = v.year || '2026';
        document.getElementById('modalQuality').textContent = v.quality || '1080p';
        document.getElementById('modalAudio').textContent = v.audio || 'Original Audio';
        document.getElementById('modalCodec').textContent = v.codec || 'H.264/HEVC';
        document.getElementById('modalDescription').textContent = v.description || `Video stream auto-indexed from media library. Direct range streaming support enabled.`;
        
        document.getElementById('modalFolder').textContent = v.folder || 'Media Library';
        document.getElementById('modalFilename').textContent = v.filename;
        document.getElementById('modalSize').textContent = v.size_formatted;
        document.getElementById('modalDate').textContent = v.added;

        // Subtitles Option
        const subBox = document.getElementById('modalSubtitlesBox');
        const subSelect = document.getElementById('modalSubtitleSelect');
        if (v.subtitles && v.subtitles.length > 0) {
            subBox.classList.remove('hidden');
            subSelect.innerHTML = '<option value="">None / Off</option>' + 
                v.subtitles.map(s => `<option value="/subtitle/${encodeURIComponent(s.path)}">${s.name}</option>`).join('');
        } else {
            subBox.classList.add('hidden');
        }

        // Action Buttons
        document.getElementById('modalPlayBtn').onclick = () => {
            const selectedSub = subSelect.value;
            this.closeModal(null, true);
            player.open(v.id, v.title, v.folder, selectedSub, v.filename);
        };

        const modalDlBtn = document.getElementById('modalDownloadBtn');
        modalDlBtn.onclick = () => {
            const a = document.createElement('a');
            a.href = `/download/${encodeURIComponent(v.id)}`;
            a.download = v.filename;
            a.click();
        };

        // Modal backdrop poster image
        const posterUrl = `/poster/${encodeURIComponent(v.id)}`;
        document.getElementById('modalBackdrop').style.backgroundImage = `url("${posterUrl}"), ${this.generatePosterGradient(v.title)}`;

        modal.classList.remove('hidden');
        document.body.style.overflow = 'hidden';
    },

    closeModal(e, isFromPopState = false) {
        const modal = document.getElementById('detailsModal');
        if (!modal || modal.classList.contains('hidden')) return;

        if (!e || e.target.classList.contains('modal-backdrop') || e.target.closest('.modal-close-btn')) {
            modal.classList.add('hidden');
            if (document.getElementById('playerOverlay').classList.contains('hidden')) {
                document.body.style.overflow = '';
            }
            if (!isFromPopState && history.state && history.state.view === 'modal') {
                history.back();
            }
        }
    },

    // UPLOAD MODAL
    openUploadModal(isFromPopState = false) {
        if (!isFromPopState && (!history.state || history.state.view !== 'upload')) {
            history.pushState({ view: 'upload' }, '');
        }
        document.getElementById('uploadModal').classList.remove('hidden');
    },

    closeUploadModal(e, isFromPopState = false) {
        const modal = document.getElementById('uploadModal');
        if (!modal || modal.classList.contains('hidden')) return;

        if (!e || e.target.classList.contains('modal-backdrop') || e.target.closest('.modal-close-btn') || e.target.closest('.btn-outline')) {
            modal.classList.add('hidden');
            document.getElementById('uploadForm').reset();
            document.getElementById('uploadProgressContainer').classList.add('hidden');
            if (!isFromPopState && history.state && history.state.view === 'upload') {
                history.back();
            }
        }
    },

    submitUpload(e) {
        e.preventDefault();
        const fileInput = document.getElementById('uploadFileInput');
        if (!fileInput.files.length) return;

        const formData = new FormData();
        formData.append('video', fileInput.files[0]);
        formData.append('title', document.getElementById('uploadTitleInput').value);
        formData.append('description', document.getElementById('uploadDescInput').value);

        const xhr = new XMLHttpRequest();
        const progressContainer = document.getElementById('uploadProgressContainer');
        const progressBar = document.getElementById('uploadProgressBar');
        const progressText = document.getElementById('uploadProgressText');
        const submitBtn = document.getElementById('uploadSubmitBtn');

        progressContainer.classList.remove('hidden');
        submitBtn.disabled = true;

        xhr.upload.addEventListener('progress', (e) => {
            if (e.lengthComputable) {
                const pct = Math.round((e.loaded / e.total) * 100);
                progressBar.style.width = `${pct}%`;
                progressText.textContent = `${pct}% Uploading...`;
            }
        });

        xhr.addEventListener('load', () => {
            if (xhr.status === 200) {
                this.showToast('Video uploaded successfully!', 'success');
                this.closeUploadModal();
                this.loadLibrary();
            } else {
                this.showToast('Upload failed: ' + xhr.responseText, 'error');
            }
            submitBtn.disabled = false;
        });

        xhr.addEventListener('error', () => {
            this.showToast('Upload failed due to network error', 'error');
            submitBtn.disabled = false;
        });

        xhr.open('POST', '/upload');
        xhr.send(formData);
    },

    generatePosterGradient(str) {
        let hash = 0;
        for (let i = 0; i < str.length; i++) {
            hash = str.charCodeAt(i) + ((hash << 5) - hash);
        }
        const h1 = Math.abs(hash) % 360;
        const h2 = (h1 + 60) % 360;
        return `linear-gradient(135deg, hsl(${h1}, 75%, 25%) 0%, hsl(${h2}, 85%, 12%) 100%)`;
    },

    showToast(msg, type = 'info') {
        const toast = document.getElementById('toast');
        const toastMsg = document.getElementById('toastMsg');
        const toastIcon = document.getElementById('toastIcon');

        toastMsg.textContent = msg;
        if (type === 'success') {
            toastIcon.className = 'fa-solid fa-circle-check';
            toast.style.borderLeftColor = '#46d369';
        } else if (type === 'error') {
            toastIcon.className = 'fa-solid fa-circle-exclamation';
            toast.style.borderLeftColor = '#e50914';
        } else {
            toastIcon.className = 'fa-solid fa-circle-info';
            toast.style.borderLeftColor = '#0080ff';
        }

        toast.classList.remove('hidden');
        setTimeout(() => toast.classList.add('hidden'), 3500);
    },

    escapeHtml(str) {
        if (!str) return '';
        return str.replace(/&/g, "&amp;")
                  .replace(/</g, "&lt;")
                  .replace(/>/g, "&gt;")
                  .replace(/"/g, "&quot;")
                  .replace(/'/g, "&#039;");
    }
};

document.addEventListener('DOMContentLoaded', () => app.init());

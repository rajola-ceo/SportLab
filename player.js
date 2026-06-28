// ========================================
// AURAEN News - Video Player
// ========================================

const Player = {
    // ===== State =====
    state: {
        matchId: null,
        matchUrl: null,
        matchData: null,
        isFullscreen: false,
    },

    // ===== DOM References =====
    els: {},

    // ===== Initialize =====
    init() {
        // Get match ID from URL
        const params = new URLSearchParams(window.location.search);
        this.state.matchId = params.get('id');
        this.state.matchUrl = params.get('url');

        // Cache DOM elements
        this.els = {
            matchTitle: document.getElementById('matchTitle'),
            matchLeague: document.getElementById('matchLeague'),
            matchDetailLeague: document.getElementById('matchDetailLeague'),
            matchDetailTime: document.getElementById('matchDetailTime'),
            videoPlayer: document.getElementById('videoPlayer'),
            playerPlaceholder: document.getElementById('playerPlaceholder'),
            fullscreenBtn: document.getElementById('fullscreenBtn'),
            refreshStreamBtn: document.getElementById('refreshStreamBtn'),
            streamStatus: document.getElementById('streamStatus'),
            alternativeStreams: document.getElementById('alternativeStreams'),
            adBlockerOverlay: document.getElementById('adBlockerOverlay'),
        };

        // Load match
        this.loadMatch();

        // Setup event listeners
        this.setupEventListeners();

        console.log('🎬 Player initialized');
    },

    // ===== Load Match =====
    loadMatch() {
        try {
            // Get match from cache or state
            const cached = localStorage.getItem('auraen_matches');
            if (cached) {
                const data = JSON.parse(cached);
                const match = data.matches.find(m => m.id === this.state.matchId);
                
                if (match) {
                    this.state.matchData = match;
                    this.renderMatchInfo(match);
                    this.loadStream(match);
                    this.loadAlternativeStreams(match);
                    return;
                }
            }

            // If not found in cache, try to find by URL
            if (this.state.matchUrl) {
                // Try to get match from the URL
                this.loadStreamFromUrl(this.state.matchUrl);
            }

        } catch (error) {
            console.error('Error loading match:', error);
            this.showError('Failed to load match');
        }
    },

    // ===== Render Match Info =====
    renderMatchInfo(match) {
        if (this.els.matchTitle) {
            this.els.matchTitle.textContent = match.name || 'Match';
        }
        
        if (this.els.matchLeague) {
            this.els.matchLeague.textContent = match.competition || match.league || 'Football';
        }
        
        if (this.els.matchDetailLeague) {
            this.els.matchDetailLeague.textContent = `🏆 ${match.competition || match.league || 'Football'}`;
        }
        
        if (this.els.matchDetailTime) {
            const time = new Date(match.time);
            this.els.matchDetailTime.textContent = `⏰ ${time.toLocaleString('en-US', {
                weekday: 'long',
                year: 'numeric',
                month: 'long',
                day: 'numeric',
                hour: '2-digit',
                minute: '2-digit'
            })}`;
        }

        // Update status
        if (this.els.streamStatus) {
            if (match.status === 'live') {
                this.els.streamStatus.textContent = '● Live';
                this.els.streamStatus.style.color = 'var(--success)';
            } else {
                this.els.streamStatus.textContent = '● Upcoming';
                this.els.streamStatus.style.color = 'var(--warning)';
            }
        }
    },

    // ===== Load Stream =====
    loadStream(match) {
        const player = this.els.videoPlayer;
        const placeholder = this.els.playerPlaceholder;
        
        // Show placeholder while loading
        if (placeholder) {
            placeholder.style.display = 'flex';
        }
        
        // Get stream URL
        let streamUrl = match.url || match.streamUrl;
        
        if (!streamUrl) {
            // Try to construct URL
            const slug = match.name
                .toLowerCase()
                .replace(/[^a-z0-9\s]/g, '')
                .replace(/\s+/g, '_');
            streamUrl = `/${slug}.html`;
        }

        // Load the stream in iframe
        if (player) {
            // Add anti-ad parameters
            const url = new URL(streamUrl, window.location.origin);
            url.searchParams.set('no_ads', 'true');
            url.searchParams.set('embed', 'true');
            
            player.src = url.toString();
            player.style.display = 'block';
            
            // Hide placeholder when loaded
            player.addEventListener('load', () => {
                if (placeholder) {
                    placeholder.style.display = 'none';
                }
            });
            
            // After 5 seconds, hide placeholder anyway
            setTimeout(() => {
                if (placeholder) {
                    placeholder.style.display = 'none';
                }
            }, 5000);
        }

        // Show ad blocker overlay
        this.showAdBlockerStatus();
    },

    // ===== Load Stream from URL =====
    async loadStreamFromUrl(url) {
        try {
            // Fetch the page and extract the actual stream URL
            const response = await fetch(`/api/proxy`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                },
                body: JSON.stringify({ url: url })
            });
            
            if (response.ok) {
                const html = await response.text();
                // Extract iframe or video source
                const iframeMatch = html.match(/<iframe[^>]*src=["']([^"']*)["']/i);
                if (iframeMatch && iframeMatch[1]) {
                    this.loadStreamFromIframe(iframeMatch[1]);
                    return;
                }
                
                // Try to find video source
                const videoMatch = html.match(/<video[^>]*src=["']([^"']*)["']/i);
                if (videoMatch && videoMatch[1]) {
                    this.loadStreamFromVideo(videoMatch[1]);
                    return;
                }
            }
            
            // Fallback: load directly
            this.loadStream({ url: url, name: 'Match' });
        } catch (error) {
            console.error('Error loading stream from URL:', error);
            this.showError('Failed to load stream');
        }
    },

    // ===== Load from Iframe =====
    loadStreamFromIframe(src) {
        const player = this.els.videoPlayer;
        if (player) {
            player.src = src;
            player.style.display = 'block';
        }
        if (this.els.playerPlaceholder) {
            this.els.playerPlaceholder.style.display = 'none';
        }
    },

    // ===== Load from Video =====
    loadStreamFromVideo(src) {
        const player = this.els.videoPlayer;
        if (player) {
            // Create video element instead of iframe
            player.outerHTML = `
                <video controls autoplay style="width:100%;height:100%;background:#000;">
                    <source src="${src}" type="video/mp4">
                    Your browser does not support video.
                </video>
            `;
        }
        if (this.els.playerPlaceholder) {
            this.els.playerPlaceholder.style.display = 'none';
        }
    },

    // ===== Load Alternative Streams =====
    loadAlternativeStreams(match) {
        const container = this.els.alternativeStreams;
        if (!container) return;

        const streams = match.alternativeStreams || [];
        
        if (streams.length === 0) {
            container.innerHTML = '<p style="color:var(--gray);font-size:13px;">No alternative streams available</p>';
            return;
        }

        container.innerHTML = streams.map(stream => `
            <a href="#" class="alternative-stream" data-url="${stream.url}" data-lang="${stream.language}">
                ${stream.language} ${stream.quality ? `- ${stream.quality}` : ''}
            </a>
        `).join('');

        // Add click handlers
        container.querySelectorAll('.alternative-stream').forEach(link => {
            link.addEventListener('click', (e) => {
                e.preventDefault();
                const url = link.dataset.url;
                if (url) {
                    this.loadStream({ url: url, name: 'Match' });
                    // Update active state
                    container.querySelectorAll('.alternative-stream').forEach(l => l.style.border = 'none');
                    link.style.border = '2px solid var(--primary)';
                }
            });
        });
    },

    // ===== Show Ad Blocker Status =====
    showAdBlockerStatus() {
        const overlay = this.els.adBlockerOverlay;
        if (overlay) {
            overlay.style.display = 'block';
            setTimeout(() => {
                overlay.style.opacity = '1';
            }, 100);
            
            // Hide after 3 seconds
            setTimeout(() => {
                overlay.style.opacity = '0';
                setTimeout(() => {
                    overlay.style.display = 'none';
                }, 300);
            }, 3000);
        }
    },

    // ===== Setup Event Listeners =====
    setupEventListeners() {
        // Fullscreen
        if (this.els.fullscreenBtn) {
            this.els.fullscreenBtn.addEventListener('click', () => this.toggleFullscreen());
        }

        // Refresh stream
        if (this.els.refreshStreamBtn) {
            this.els.refreshStreamBtn.addEventListener('click', () => this.refreshStream());
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.key === 'f' || e.key === 'F') {
                this.toggleFullscreen();
            }
            if (e.key === 'r' || e.key === 'R') {
                this.refreshStream();
            }
            if (e.key === 'Escape' && this.state.isFullscreen) {
                this.exitFullscreen();
            }
        });

        // Fullscreen change events
        document.addEventListener('fullscreenchange', () => {
            this.state.isFullscreen = !!document.fullscreenElement;
        });
    },

    // ===== Toggle Fullscreen =====
    toggleFullscreen() {
        const container = document.querySelector('.video-wrapper');
        if (!container) return;

        if (!document.fullscreenElement) {
            container.requestFullscreen().catch(() => {});
        } else {
            document.exitFullscreen().catch(() => {});
        }
    },

    // ===== Exit Fullscreen =====
    exitFullscreen() {
        if (document.fullscreenElement) {
            document.exitFullscreen().catch(() => {});
        }
    },

    // ===== Refresh Stream =====
    refreshStream() {
        const player = this.els.videoPlayer;
        if (player) {
            // Reload the iframe
            const currentSrc = player.src;
            player.src = '';
            setTimeout(() => {
                player.src = currentSrc;
            }, 100);
            
            this.showNotification('Stream refreshing...', 'info');
        }
    },

    // ===== Show Error =====
    showError(message) {
        const placeholder = this.els.playerPlaceholder;
        if (placeholder) {
            placeholder.innerHTML = `
                <span style="font-size:48px;margin-bottom:16px;">⚠️</span>
                <p style="color:var(--danger);font-weight:600;">${message}</p>
                <button onclick="location.reload()" style="margin-top:12px;padding:8px 20px;background:var(--primary);color:white;border:none;border-radius:8px;cursor:pointer;">
                    Retry
                </button>
            `;
            placeholder.style.display = 'flex';
        }
    },

    // ===== Show Notification =====
    showNotification(message, type = 'info') {
        const existing = document.querySelector('.notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.className = `notification`;
        notification.innerHTML = `
            <span>${type === 'success' ? '✅' : 'ℹ️'}</span>
            <span>${message}</span>
        `;

        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--dark-2);
            color: var(--white);
            padding: 10px 20px;
            border-radius: 10px;
            border: 1px solid var(--primary);
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 10000;
            font-size: 14px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            animation: fadeInUp 0.3s ease;
        `;

        document.body.appendChild(notification);

        setTimeout(() => {
            notification.style.opacity = '0';
            setTimeout(() => notification.remove(), 300);
        }, 2000);
    }
};

// ===== Initialize =====
document.addEventListener('DOMContentLoaded', () => {
    Player.init();
});

// ===== Export =====
window.Player = Player;

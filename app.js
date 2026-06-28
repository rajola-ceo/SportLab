// ========================================
// AURAEN News - Football Streaming App
// ========================================

const App = {
    // ===== State =====
    state: {
        matches: [],
        filteredMatches: [],
        currentFilter: 'all',
        isRefreshing: false,
        lastUpdate: null,
    },

    // ===== DOM References =====
    els: {},

    // ===== Initialize =====
    init() {
        // Cache DOM elements
        this.els = {
            loader: document.getElementById('loader'),
            matchesGrid: document.getElementById('matchesGrid'),
            refreshBtn: document.getElementById('refreshBtn'),
            menuToggle: document.getElementById('menuToggle'),
            navLinks: document.getElementById('navLinks'),
            filterBtns: document.querySelectorAll('.filter-btn'),
            currentTime: document.getElementById('currentTime'),
            matchCount: document.getElementById('matchCount'),
            matchCountBadge: document.getElementById('matchCountBadge'),
            liveCount: document.getElementById('liveCount'),
        };

        // Hide loader
        setTimeout(() => {
            if (this.els.loader) {
                this.els.loader.classList.add('hidden');
            }
        }, 500);

        // Load matches
        this.loadMatches();

        // Setup event listeners
        this.setupEventListeners();

        // Start real-time updates
        this.startRealtimeUpdates();

        // Update time
        this.updateTime();
        setInterval(() => this.updateTime(), 1000);

        console.log('⚽ AURAEN News - Football Streaming initialized');
    },

    // ===== Load Matches =====
    loadMatches() {
        try {
            // Get matches from scraper
            const data = FawaNewsScraper.getAllMatches();
            
            this.state.matches = data.matches;
            this.state.filteredMatches = data.matches;
            
            this.renderMatches(data.matches);
            this.updateStats(data);
            
            this.state.lastUpdate = new Date();
            this.updateRefreshIndicator();
            
            // Cache matches
            this.cacheMatches(data);
            
            console.log(`⚽ Loaded ${data.total} football matches`);
            
        } catch (error) {
            console.error('Error loading matches:', error);
            
            // Try cache
            const cached = this.loadCachedMatches();
            if (cached) {
                this.state.matches = cached.matches;
                this.state.filteredMatches = cached.matches;
                this.renderMatches(cached.matches);
                this.updateStats(cached);
                this.showNotification('Showing cached matches', 'info');
            } else {
                this.showError('Failed to load matches. Please refresh.');
            }
        }
    },

    // ===== Cache Matches =====
    cacheMatches(data) {
        try {
            localStorage.setItem('auraen_matches', JSON.stringify({
                matches: data.matches,
                timestamp: Date.now()
            }));
        } catch (e) {
            // Storage unavailable
        }
    },

    // ===== Load Cached Matches =====
    loadCachedMatches() {
        try {
            const cached = localStorage.getItem('auraen_matches');
            if (cached) {
                const data = JSON.parse(cached);
                if (Date.now() - data.timestamp < 300000) { // 5 minutes
                    return data;
                }
            }
        } catch (e) {
            // Invalid cache
        }
        return null;
    },

    // ===== Render Matches =====
    renderMatches(matches) {
        const grid = this.els.matchesGrid;
        
        if (!matches || matches.length === 0) {
            grid.innerHTML = `
                <div class="empty-state">
                    <span class="empty-icon">⚽</span>
                    <p>No football matches available</p>
                    <span class="empty-sub">Check back later for live matches</span>
                </div>
            `;
            this.els.matchCount.textContent = '0 matches';
            this.els.matchCountBadge.textContent = '0 matches';
            return;
        }

        // Filter by current filter
        let displayMatches = matches;
        if (this.state.currentFilter !== 'all') {
            displayMatches = matches.filter(m => 
                m.competition && 
                m.competition.toLowerCase().includes(this.state.currentFilter.replace('-', ' '))
            );
        }

        // Show live matches first
        displayMatches.sort((a, b) => {
            if (a.status === 'live' && b.status !== 'live') return -1;
            if (a.status !== 'live' && b.status === 'live') return 1;
            return new Date(a.time) - new Date(b.time);
        });

        grid.innerHTML = displayMatches.map(match => this.createMatchCard(match)).join('');
        
        // Update counts
        this.els.matchCount.textContent = `${displayMatches.length} matches`;
        this.els.matchCountBadge.textContent = `${displayMatches.length} matches`;
    },

    // ===== Create Match Card =====
    createMatchCard(match) {
        const statusClass = match.status === 'live' ? 'live' : 
                           match.status === 'soon' ? 'soon' : 'upcoming';
        const statusText = match.status === 'live' ? '● LIVE' :
                          match.status === 'soon' ? '⏰ Soon' : '📅 Upcoming';
        
        const time = new Date(match.time);
        const timeStr = time.toLocaleTimeString('en-US', {
            hour: '2-digit',
            minute: '2-digit',
            hour12: false
        });

        return `
            <a href="/player.html?id=${encodeURIComponent(match.id)}&url=${encodeURIComponent(match.url || '')}" class="match-card">
                <div class="match-icon">
                    ${match.flag || match.icon || '⚽'}
                </div>
                <div class="match-info">
                    <div class="match-name">${match.name}</div>
                    <div class="match-meta">
                        <span class="league">${match.competition || match.league || 'Football'}</span>
                        <span>•</span>
                        <span>${timeStr}</span>
                        ${match.language ? `<span class="lang">${match.language}</span>` : ''}
                        ${match.quality ? `<span class="lang">${match.quality}</span>` : ''}
                    </div>
                </div>
                <span class="match-status ${statusClass}">${statusText}</span>
                <span class="match-arrow">›</span>
            </a>
        `;
    },

    // ===== Update Stats =====
    updateStats(data) {
        const liveCount = data.live || 0;
        const total = data.total || 0;
        
        if (this.els.liveCount) {
            this.els.liveCount.textContent = `● ${liveCount} Live`;
        }
        
        if (this.els.matchCount) {
            this.els.matchCount.textContent = `${total} matches`;
        }
    },

    // ===== Update Time =====
    updateTime() {
        const now = new Date();
        const timeStr = now.toLocaleTimeString('en-US', { 
            hour12: false,
            hour: '2-digit',
            minute: '2-digit',
            second: '2-digit'
        });
        
        if (this.els.currentTime) {
            this.els.currentTime.textContent = timeStr;
        }
    },

    // ===== Update Refresh Indicator =====
    updateRefreshIndicator() {
        const btn = this.els.refreshBtn;
        if (btn && this.state.lastUpdate) {
            const time = this.state.lastUpdate.toLocaleTimeString('en-US', {
                hour12: false,
                hour: '2-digit',
                minute: '2-digit',
                second: '2-digit'
            });
            btn.title = `Last updated: ${time}`;
        }
    },

    // ===== Setup Event Listeners =====
    setupEventListeners() {
        // Refresh button
        if (this.els.refreshBtn) {
            this.els.refreshBtn.addEventListener('click', () => this.refreshMatches());
        }

        // Filter buttons
        this.els.filterBtns.forEach(btn => {
            btn.addEventListener('click', () => {
                const filter = btn.dataset.filter;
                this.state.currentFilter = filter;
                
                this.els.filterBtns.forEach(b => b.classList.remove('active'));
                btn.classList.add('active');
                
                this.renderMatches(this.state.matches);
            });
        });

        // Menu toggle (mobile)
        if (this.els.menuToggle) {
            this.els.menuToggle.addEventListener('click', () => {
                this.els.navLinks.classList.toggle('open');
                this.els.menuToggle.classList.toggle('active');
            });
        }

        // Close mobile menu on link click
        if (this.els.navLinks) {
            this.els.navLinks.querySelectorAll('a').forEach(link => {
                link.addEventListener('click', () => {
                    this.els.navLinks.classList.remove('open');
                    this.els.menuToggle.classList.remove('active');
                });
            });
        }
    },

    // ===== Refresh Matches =====
    async refreshMatches() {
        if (this.state.isRefreshing) return;
        
        this.state.isRefreshing = true;
        const btn = this.els.refreshBtn;
        if (btn) {
            btn.classList.add('spinning');
            btn.disabled = true;
        }

        try {
            await this.loadMatches();
            this.showNotification('Matches refreshed!', 'success');
        } catch (error) {
            console.error('Refresh failed:', error);
            this.showNotification('Refresh failed. Please try again.', 'error');
        } finally {
            this.state.isRefreshing = false;
            if (btn) {
                btn.classList.remove('spinning');
                btn.disabled = false;
            }
        }
    },

    // ===== Real-time Updates =====
    startRealtimeUpdates() {
        // Refresh every 60 seconds
        setInterval(() => {
            this.loadMatches();
        }, 60000);
    },

    // ===== Notifications =====
    showNotification(message, type = 'info') {
        const existing = document.querySelector('.notification');
        if (existing) existing.remove();

        const notification = document.createElement('div');
        notification.className = `notification notification-${type}`;
        notification.innerHTML = `
            <span>${type === 'success' ? '✅' : type === 'error' ? '❌' : 'ℹ️'}</span>
            <span>${message}</span>
            <button class="notification-close">×</button>
        `;

        // Style the notification
        notification.style.cssText = `
            position: fixed;
            bottom: 20px;
            left: 50%;
            transform: translateX(-50%);
            background: var(--dark-2);
            color: var(--white);
            padding: 12px 20px;
            border-radius: 10px;
            border: 1px solid ${type === 'success' ? 'var(--success)' : type === 'error' ? 'var(--danger)' : 'var(--primary)'};
            display: flex;
            align-items: center;
            gap: 10px;
            z-index: 10000;
            font-size: 14px;
            box-shadow: 0 8px 32px rgba(0,0,0,0.4);
            animation: fadeInUp 0.3s ease;
            max-width: 90%;
        `;

        document.body.appendChild(notification);

        // Auto dismiss
        setTimeout(() => {
            notification.style.opacity = '0';
            notification.style.transform = 'translateX(-50%) translateY(20px)';
            setTimeout(() => notification.remove(), 300);
        }, 3000);

        // Close button
        notification.querySelector('.notification-close').addEventListener('click', () => {
            notification.remove();
        });
    },

    showError(message) {
        this.showNotification(message, 'error');
    }
};

// ===== Initialize on DOM Ready =====
document.addEventListener('DOMContentLoaded', () => {
    App.init();
});

// ===== Expose App =====
window.App = App;

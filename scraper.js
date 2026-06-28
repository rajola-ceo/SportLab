// ========================================
// AURAEN News - FawaNews Football Scraper
// Extracts ONLY football matches from FawaNews
// ========================================

const FawaNewsScraper = {
    // ===== Configuration =====
    config: {
        baseUrl: window.location.origin,
        // FawaNews domains to fetch from
        sources: [
            'http://www.fawanews.sc',
            'http://www.fawanews.com'
        ],
        // Only include football matches
        footballKeywords: [
            'vs', 'vs.', 'premier league', 'laliga', 'la liga',
            'bundesliga', 'serie a', 'ligue 1', 'eredivisie',
            'champions league', 'world cup', 'europa league',
            'conference league', 'fa cup', 'carabao cup',
            'copa america', 'euro', 'qualifiers',
            'afcon', 'asian cup', 'gold cup'
        ]
    },

    // ===== Extract Football Matches from DOM =====
    extractMatches() {
        const matches = [];
        const seen = new Set();

        // Find all event cards
        const cards = document.querySelectorAll('.user-item');
        
        cards.forEach((card) => {
            const nameEl = card.querySelector('.user-item__name');
            const playingEl = card.querySelector('.user-item__playing');
            const linkEl = card.querySelector('a[href]');
            const avatarEl = card.querySelector('.user-item__avatar img');
            
            if (!nameEl) return;
            
            const name = nameEl.textContent.trim();
            
            // Skip if not a football match
            if (!this.isFootballMatch(name)) return;
            
            // Skip duplicates
            if (seen.has(name)) return;
            seen.add(name);
            
            // Extract match details
            let league = '';
            let time = '';
            
            if (playingEl) {
                const text = playingEl.textContent.trim();
                const parts = text.split(/\s+(?=\d{1,2}:\d{2})/);
                if (parts.length === 2) {
                    league = parts[0];
                    time = parts[1];
                } else {
                    league = text;
                }
            }
            
            // Extract URL
            let url = '';
            if (linkEl) {
                url = linkEl.getAttribute('href');
                if (url && !url.startsWith('http')) {
                    url = window.location.origin + '/' + url.replace(/^\.\//, '');
                }
            }
            
            // Extract language
            let language = 'ENG';
            const langMatch = name.match(/---\s*([A-Z]{2,3})(?:\s|$)/i);
            if (langMatch) {
                language = langMatch[1].toUpperCase();
            }
            
            // Determine quality
            let quality = 'SD';
            if (name.includes('HD')) quality = 'HD';
            if (name.includes('FHD')) quality = 'FHD';
            if (name.includes('4K')) quality = '4K';
            
            // Get icon/flag
            let icon = '⚽';
            let flag = '';
            if (avatarEl) {
                const src = avatarEl.getAttribute('src') || '';
                // Try to extract country/league from avatar
                if (src.includes('premier-league')) flag = '🏴';
                else if (src.includes('laliga')) flag = '🇪🇸';
                else if (src.includes('bundesliga')) flag = '🇩🇪';
                else if (src.includes('serie-a')) flag = '🇮🇹';
                else if (src.includes('ligue-1')) flag = '🇫🇷';
                else if (src.includes('champions')) flag = '🏆';
                else if (src.includes('world-cup')) flag = '🌍';
            }
            
            // Determine status
            let status = 'upcoming';
            const nameLower = name.toLowerCase();
            if (nameLower.includes('live')) status = 'live';
            else if (nameLower.includes('soon')) status = 'soon';
            
            // Try to parse time
            let matchTime = new Date();
            if (time) {
                const timeMatch = time.match(/(\d{1,2}):(\d{2})/);
                if (timeMatch) {
                    const hours = parseInt(timeMatch[1]);
                    const minutes = parseInt(timeMatch[2]);
                    matchTime.setHours(hours, minutes, 0, 0);
                    
                    // If time is in the past, assume tomorrow
                    if (matchTime < new Date()) {
                        matchTime.setDate(matchTime.getDate() + 1);
                    }
                }
            }
            
            // Extract competition from league
            let competition = this.extractCompetition(league);
            
            matches.push({
                id: `match-${Date.now()}-${Math.random().toString(36).substr(2, 4)}`,
                name: this.cleanMatchName(name),
                league: league,
                competition: competition,
                time: matchTime.toISOString(),
                status: status,
                language: language,
                quality: quality,
                icon: icon,
                flag: flag,
                url: url,
                originalName: name,
                // For streaming
                streamUrl: this.getStreamUrl(url, name),
                alternativeStreams: this.getAlternativeStreams(name)
            });
        });
        
        // Sort: Live first, then by time
        matches.sort((a, b) => {
            if (a.status === 'live' && b.status !== 'live') return -1;
            if (a.status !== 'live' && b.status === 'live') return 1;
            return new Date(a.time) - new Date(b.time);
        });
        
        return matches;
    },

    // ===== Check if it's a football match =====
    isFootballMatch(name) {
        const lower = name.toLowerCase();
        
        // Must contain 'vs' or be a known football league
        const hasVs = lower.includes('vs') || lower.includes('vs.');
        const isFootballLeague = this.config.footballKeywords.some(keyword => 
            lower.includes(keyword)
        );
        
        // Skip obvious non-football
        const nonFootball = [
            'nba', 'nfl', 'nhl', 'boxing', 'ufc', 'mma',
            'formula', 'f1', 'moto', 'rally', 'golf',
            'tennis', 'cricket', 'rugby', 'baseball',
            'volleyball', 'handball', 'basketball'
        ];
        
        const isNonFootball = nonFootball.some(sport => 
            lower.includes(sport) && !lower.includes('football')
        );
        
        return (hasVs || isFootballLeague) && !isNonFootball;
    },

    // ===== Clean match name =====
    cleanMatchName(name) {
        // Remove language tags
        let cleaned = name.replace(/---\s*[A-Z]{2,3}\s*/i, '').trim();
        // Remove quality tags
        cleaned = cleaned.replace(/\b(HD|FHD|4K|SD)\b/gi, '').trim();
        // Remove extra spaces
        cleaned = cleaned.replace(/\s+/g, ' ');
        return cleaned;
    },

    // ===== Extract competition =====
    extractCompetition(league) {
        const lower = (league || '').toLowerCase();
        
        const competitions = {
            'premier league': 'Premier League',
            'laliga': 'La Liga',
            'la liga': 'La Liga',
            'bundesliga': 'Bundesliga',
            'serie a': 'Serie A',
            'ligue 1': 'Ligue 1',
            'eredivisie': 'Eredivisie',
            'champions league': 'UEFA Champions League',
            'world cup': 'FIFA World Cup',
            'europa league': 'UEFA Europa League',
            'fa cup': 'FA Cup',
            'carabao cup': 'Carabao Cup',
            'copa america': 'Copa América',
            'euro': 'UEFA Euro',
            'afcon': 'AFCON',
            'asian cup': 'AFC Asian Cup',
            'gold cup': 'CONCACAF Gold Cup'
        };
        
        for (const [key, value] of Object.entries(competitions)) {
            if (lower.includes(key)) {
                return value;
            }
        }
        
        // Return original if no match
        return league || 'Football';
    },

    // ===== Get stream URL =====
    getStreamUrl(url, name) {
        // If we have a direct URL from FawaNews, use it
        if (url) {
            // Clean the URL
            return url;
        }
        
        // Try to construct from match name
        const slug = name
            .toLowerCase()
            .replace(/[^a-z0-9\s]/g, '')
            .replace(/\s+/g, '_');
        
        // Check if it's a known match
        const knownMatches = {
            'senegal_vs_iraq': '/FIFA_world_cup_2026_Senegal_vs_Iraq_eng.html',
            'norway_vs_france': '/FIFA_world_cup_2026_Norway_vs_France_eng.html',
            // Add more known matches
        };
        
        return knownMatches[slug] || null;
    },

    // ===== Get alternative streams =====
    getAlternativeStreams(name) {
        const streams = [];
        const languages = ['ENG', 'HD', 'FR', 'AR', 'ES', 'SWA'];
        
        // Generate alternative stream URLs
        languages.forEach(lang => {
            const altName = name.replace(/---\s*[A-Z]{2,3}/i, `--- ${lang}`);
            const url = this.getStreamUrl(null, altName);
            if (url) {
                streams.push({
                    language: lang,
                    url: url,
                    quality: lang === 'HD' ? 'HD' : 'SD'
                });
            }
        });
        
        return streams;
    },

    // ===== Fetch from FawaNews =====
    async fetchFromFawaNews() {
        try {
            // Try multiple sources
            for (const source of this.config.sources) {
                try {
                    const response = await fetch(`/api/proxy`, {
                        method: 'POST',
                        headers: {
                            'Content-Type': 'application/json',
                        },
                        body: JSON.stringify({ url: source })
                    });
                    
                    if (response.ok) {
                        const html = await response.text();
                        // Parse the HTML and extract matches
                        const parser = new DOMParser();
                        const doc = parser.parseFromString(html, 'text/html');
                        
                        // Extract matches from the fetched HTML
                        const matches = this.extractMatchesFromHTML(doc);
                        if (matches.length > 0) {
                            return matches;
                        }
                    }
                } catch (e) {
                    console.log(`Failed to fetch from ${source}:`, e);
                }
            }
            
            // Fallback to local DOM
            return this.extractMatches();
        } catch (error) {
            console.error('Error fetching from FawaNews:', error);
            return this.extractMatches();
        }
    },

    // ===== Extract matches from HTML document =====
    extractMatchesFromHTML(doc) {
        const matches = [];
        const cards = doc.querySelectorAll('.user-item');
        
        cards.forEach((card) => {
            const nameEl = card.querySelector('.user-item__name');
            const playingEl = card.querySelector('.user-item__playing');
            const linkEl = card.querySelector('a[href]');
            
            if (!nameEl) return;
            
            const name = nameEl.textContent.trim();
            if (!this.isFootballMatch(name)) return;
            
            let league = '';
            let time = '';
            
            if (playingEl) {
                const text = playingEl.textContent.trim();
                const parts = text.split(/\s+(?=\d{1,2}:\d{2})/);
                if (parts.length === 2) {
                    league = parts[0];
                    time = parts[1];
                } else {
                    league = text;
                }
            }
            
            let url = '';
            if (linkEl) {
                url = linkEl.getAttribute('href');
                if (url && !url.startsWith('http')) {
                    url = 'http://www.fawanews.sc/' + url.replace(/^\.\//, '');
                }
            }
            
            matches.push({
                name: this.cleanMatchName(name),
                league: league,
                time: time,
                url: url,
                originalName: name
            });
        });
        
        return matches;
    },

    // ===== Get all match data =====
    getAllMatches() {
        const matches = this.extractMatches();
        return {
            matches: matches,
            total: matches.length,
            live: matches.filter(m => m.status === 'live').length,
            upcoming: matches.filter(m => m.status !== 'live').length,
            timestamp: new Date().toISOString()
        };
    }
};

// ===== Auto-initialize =====
document.addEventListener('DOMContentLoaded', () => {
    window.FawaNewsScraper = FawaNewsScraper;
    console.log('⚽ Football Scraper initialized');
});

// ===== Export =====
window.FawaNewsScraper = FawaNewsScraper;

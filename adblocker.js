// ========================================
// AURAEN News - Advanced Ad Blocker
// Blocks all ads, popups, and trackers
// ========================================

const AdBlocker = {
    // ===== Configuration =====
    config: {
        enabled: true,
        blockPopups: true,
        blockTrackers: true,
        blockBanners: true,
        blockRedirects: true,
        customRules: []
    },

    // ===== Initialize =====
    init() {
        if (!this.config.enabled) return;
        
        this.blockPopups();
        this.blockTrackers();
        this.blockBannerAds();
        this.blockRedirects();
        this.blockScripts();
        this.cleanDOM();
        
        console.log('🛡️ Ad Blocker activated');
    },

    // ===== Block Popups =====
    blockPopups() {
        // Prevent window.open
        const originalOpen = window.open;
        window.open = function(url, name, specs) {
            // Allow only internal links
            if (url && url.startsWith(window.location.origin)) {
                return originalOpen.call(this, url, name, specs);
            }
            console.log('🛡️ Blocked popup:', url);
            return null;
        };

        // Prevent onclick popups
        document.addEventListener('click', (e) => {
            const target = e.target.closest('a[target="_blank"]');
            if (target && !target.href.startsWith(window.location.origin)) {
                e.preventDefault();
                console.log('🛡️ Blocked external link:', target.href);
            }
        }, true);
    },

    // ===== Block Trackers =====
    blockTrackers() {
        // Block common tracker scripts
        const trackerPatterns = [
            'google-analytics',
            'googletagmanager',
            'facebook.com/tr',
            'tracking',
            'analytics',
            'gtag',
            'histats',
            'statcounter',
            'clicky',
            'hotjar',
            'mixpanel'
        ];

        // Remove existing tracker scripts
        document.querySelectorAll('script').forEach(script => {
            const src = script.src || '';
            if (trackerPatterns.some(pattern => src.includes(pattern))) {
                script.remove();
                console.log('🛡️ Removed tracker script:', src);
            }
        });

        // Block new tracker scripts
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.tagName === 'SCRIPT') {
                        const src = node.src || '';
                        if (trackerPatterns.some(pattern => src.includes(pattern))) {
                            node.remove();
                            console.log('🛡️ Blocked tracker script:', src);
                        }
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    },

    // ===== Block Banner Ads =====
    blockBannerAds() {
        // Common ad selectors
        const adSelectors = [
            '[id*="ad"]',
            '[class*="ad"]',
            '[id*="banner"]',
            '[class*="banner"]',
            '[id*="sponsor"]',
            '[class*="sponsor"]',
            '[data-ad]',
            '[data-advertisement]',
            '.adsbygoogle',
            '.ad-container',
            '.ad-wrapper',
            '.ad-banner',
            '.advertisement',
            '.advert',
            '.promo',
            '.popup-ad',
            '.modal-ad',
            '.overlay-ad'
        ];

        // Remove existing ads
        adSelectors.forEach(selector => {
            document.querySelectorAll(selector).forEach(el => {
                // Check if it's truly an ad
                if (this.isAdElement(el)) {
                    el.remove();
                    console.log('🛡️ Removed ad element');
                }
            });
        });

        // Block new ads
        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.nodeType === 1) { // Element
                        adSelectors.forEach(selector => {
                            if (node.matches && node.matches(selector)) {
                                if (this.isAdElement(node)) {
                                    node.remove();
                                    console.log('🛡️ Blocked ad element');
                                }
                            }
                            // Check children
                            node.querySelectorAll && node.querySelectorAll(selector).forEach(el => {
                                if (this.isAdElement(el)) {
                                    el.remove();
                                    console.log('🛡️ Blocked ad element');
                                }
                            });
                        });
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    },

    // ===== Check if element is an ad =====
    isAdElement(el) {
        if (!el) return false;
        
        const text = el.textContent || '';
        const id = el.id || '';
        const className = el.className || '';
        const style = el.getAttribute('style') || '';
        
        // Check for ad indicators
        const adIndicators = [
            'advertisement',
            'sponsored',
            'promo',
            'ad ',
            ' advert',
            'banner',
            'popup',
            'modal'
        ];

        // Check text content
        if (adIndicators.some(indicator => 
            text.toLowerCase().includes(indicator) ||
            id.toLowerCase().includes(indicator) ||
            className.toLowerCase().includes(indicator)
        )) {
            return true;
        }

        // Check if it's a small iframe (common ad size)
        if (el.tagName === 'IFRAME') {
            const width = el.getAttribute('width') || '';
            const height = el.getAttribute('height') || '';
            if (width === '0' || height === '0' || width === '1' || height === '1') {
                return true;
            }
        }

        // Check if it's hidden but not supposed to be
        if (style.includes('display:none') || style.includes('visibility:hidden')) {
            return true;
        }

        return false;
    },

    // ===== Block Redirects =====
    blockRedirects() {
        // Prevent meta refresh redirects
        const metaRefresh = document.querySelector('meta[http-equiv="refresh"]');
        if (metaRefresh) {
            const content = metaRefresh.getAttribute('content') || '';
            if (content.includes('url=')) {
                metaRefresh.remove();
                console.log('🛡️ Blocked meta refresh redirect');
            }
        }

        // Prevent JavaScript redirects
        const originalLocation = window.location;
        Object.defineProperty(window, 'location', {
            set: function(url) {
                if (url && !url.startsWith(window.location.origin)) {
                    console.log('🛡️ Blocked redirect to:', url);
                    return;
                }
                originalLocation.href = url;
            },
            get: function() {
                return originalLocation;
            }
        });
    },

    // ===== Block Scripts =====
    blockScripts() {
        // Block known ad scripts
        const adScriptPatterns = [
            'doubleclick.net',
            'googlesyndication.com',
            'googleadservices.com',
            'adserver',
            'adservice',
            'adsystem',
            'adzerk',
            'adnxs',
            'criteo',
            'taboola',
            'outbrain'
        ];

        const observer = new MutationObserver((mutations) => {
            mutations.forEach((mutation) => {
                mutation.addedNodes.forEach((node) => {
                    if (node.tagName === 'SCRIPT') {
                        const src = node.src || '';
                        if (adScriptPatterns.some(pattern => src.includes(pattern))) {
                            node.remove();
                            console.log('🛡️ Blocked ad script:', src);
                        }
                    }
                });
            });
        });

        observer.observe(document.documentElement, {
            childList: true,
            subtree: true
        });
    },

    // ===== Clean DOM =====
    cleanDOM() {
        // Remove empty elements that might be ads
        document.querySelectorAll('div, section, aside').forEach(el => {
            if (el.children.length === 0 && el.textContent.trim() === '') {
                const styles = window.getComputedStyle(el);
                if (styles.width === '0px' || styles.height === '0px') {
                    el.remove();
                }
            }
        });

        // Remove elements with ad-like IDs
        document.querySelectorAll('[id*="ad" i], [class*="ad" i]').forEach(el => {
            if (this.isAdElement(el)) {
                el.remove();
            }
        });
    },

    // ===== Custom Rules =====
    addRule(selector, action) {
        this.config.customRules.push({ selector, action });
    },

    // ===== Apply Custom Rules =====
    applyCustomRules() {
        this.config.customRules.forEach(rule => {
            document.querySelectorAll(rule.selector).forEach(el => {
                if (rule.action === 'remove') {
                    el.remove();
                } else if (rule.action === 'hide') {
                    el.style.display = 'none';
                }
            });
        });
    },

    // ===== Whitelist =====
    whitelist(url) {
        // Add domains to whitelist (keep them safe)
        const whitelisted = [
            window.location.origin,
            'https://www.youtube.com',
            'https://player.vimeo.com',
            'https://streamable.com'
        ];
        return whitelisted.some(domain => url && url.startsWith(domain));
    }
};

// ===== Auto-initialize =====
document.addEventListener('DOMContentLoaded', () => {
    AdBlocker.init();
});

// ===== Export =====
window.AdBlocker = AdBlocker;

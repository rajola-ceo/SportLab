'use strict';

// ═══════════════════════════════════════════════════════════════
// IMPORTS
// ═══════════════════════════════════════════════════════════════

const express     = require('express');
const helmet      = require('helmet');
const compression = require('compression');
const cors        = require('cors');
const rateLimit   = require('express-rate-limit');
const { URL }     = require('url');

require('dotenv').config();

// ═══════════════════════════════════════════════════════════════
// STARTUP VALIDATION
// ═══════════════════════════════════════════════════════════════

const REQUIRED_KEYS = {
  API_FOOTBALL_KEY : 'API-Football (live matches, fixtures, standings)',
  SPORTMONKS_KEY   : 'SportMonks (fallback data, player info)',
  YOUTUBE_KEY      : 'YouTube Data API (highlights search)',
};

for (const [key, desc] of Object.entries(REQUIRED_KEYS)) {
  if (!process.env[key]) {
    console.warn(`[WARN] Missing env var: ${key} — ${desc} will not work.`);
  }
}

// ═══════════════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════════════

const CONFIG = Object.freeze({
  PORT        : parseInt(process.env.PORT, 10) || 3000,
  ENV         : process.env.NODE_ENV || 'development',
  IS_PROD     : process.env.NODE_ENV === 'production',
  ALLOWED_ORIGINS : process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['*'],
  KEYS : {
    AF : process.env.API_FOOTBALL_KEY  || '',
    SM : process.env.SPORTMONKS_KEY    || '',
    YT : process.env.YOUTUBE_KEY       || '',
  },
});

// ═══════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════

const logger = {
  _fmt : (level, ...args) =>
    `[${new Date().toISOString()}] [${level}]` +
    args.map(a => (typeof a === 'object' ? ' ' + JSON.stringify(a) : ' ' + String(a))).join(''),
  info  : (...a) => console.log(logger._fmt('INFO',  ...a)),
  warn  : (...a) => console.warn(logger._fmt('WARN',  ...a)),
  error : (...a) => console.error(logger._fmt('ERROR', ...a)),
  req   : (req) =>
    console.log(logger._fmt('REQ', `${req.method} ${req.path}`,
      `ip=${(req.headers['x-forwarded-for'] || req.socket?.remoteAddress || '?').split(',')[0].trim()}`)),
};

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const AF_BASE   = 'https://v3.football.api-sports.io';
const SM_BASE   = 'https://api.sportmonks.com/v3/football';
const ESPN_RSS  = 'https://www.espn.com/espn/rss/soccer/news';
const YT_API    = 'https://www.googleapis.com/youtube/v3/search';
const FAWA_BASE = 'https://www.fawanews.com';

const TTL = Object.freeze({
  LIVE       : 20,
  FIXTURES   : 120,
  STANDINGS  : 300,
  LINEUPS    : 180,
  STATS      : 60,
  NEWS       : 360,
  HIGHLIGHTS : 600,
  STREAMS    : 60,
  HEALTH     : 10,
  API_HEALTH : 30,
});

const BLOCKED_DOMAINS = new Set([
  'bit.ly','tinyurl.com','goo.gl','t.co','ow.ly','is.gd','buff.ly',
  'shorte.st','adf.ly','bc.vc','clicksfly.com','sh.st','ouo.io',
  'clk.sh','linkvertise.com','exe.io','za.gl','cutt.ly','rebrand.ly',
  'url.cn','dwz.cn','lnk.to','mcaf.ee','db.tt','tr.im','scrnch.me',
]);

const UNSAFE_RE = /malware|phish|crack|hack|keygen|warez|xxx|porn|adult|torrent|pirat/i;

// ═══════════════════════════════════════════════════════════════
// UTILITIES
// ═══════════════════════════════════════════════════════════════

function posInt(v) {
  if (v == null || v === '') return null;
  const n = parseInt(v, 10);
  return !isNaN(n) && n > 0 ? n : null;
}

function clamp(v, min, max, def) {
  const n = parseInt(v, 10);
  return isNaN(n) ? def : Math.min(Math.max(n, min), max);
}

function safeYear(v) {
  const n = parseInt(v, 10);
  return !isNaN(n) && n >= 2000 && n <= 2100 ? n : new Date().getFullYear();
}

function safeStr(v, max = 128) {
  if (!v || typeof v !== 'string') return null;
  return v.trim().slice(0, max).replace(/[<>"'&;\\]/g, '') || null;
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '')
    .split(',')[0].trim() || req.socket?.remoteAddress || 'unknown';
}

function isValidStreamUrl(str) {
  if (!str || typeof str !== 'string' || str.length > 2048) return false;
  try {
    const u = new URL(str);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    const base = host.split('.').slice(-2).join('.');
    if (BLOCKED_DOMAINS.has(base) || BLOCKED_DOMAINS.has(host)) return false;
    if (UNSAFE_RE.test(str)) return false;
    return true;
  } catch { return false; }
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

// ═══════════════════════════════════════════════════════════════
// HTTP CLIENT  (native Node 20+ fetch with timeout + retry)
// ═══════════════════════════════════════════════════════════════

const RETRY_ATTEMPTS  = 2;
const RETRY_BASE_MS   = 300;
const RETRYABLE_CODES = new Set([429, 500, 502, 503, 504]);

async function fetchWithTimeout(urlStr, opts = {}) {
  const timeout = opts.timeout || 10_000;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);

  try {
    const res = await fetch(urlStr, {
      method  : opts.method || 'GET',
      headers : opts.headers || {},
      signal  : controller.signal,
    });
    return res;
  } catch (err) {
    if (err.name === 'AbortError') throw new Error(`Timeout(${timeout}ms): ${urlStr.split('?')[0]}`);
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

async function httpGet(urlStr, opts = {}) {
  let lastErr;
  for (let attempt = 0; attempt <= RETRY_ATTEMPTS; attempt++) {
    try {
      const res = await fetchWithTimeout(urlStr, opts);

      // Retry on transient server errors and rate limits
      if (attempt < RETRY_ATTEMPTS && RETRYABLE_CODES.has(res.status)) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn(`HTTP ${res.status} from ${urlStr.split('?')[0]} — retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_ATTEMPTS})`);
        await sleep(delay);
        continue;
      }

      const body = await res.text();
      return { status: res.status, body };
    } catch (err) {
      lastErr = err;
      if (attempt < RETRY_ATTEMPTS) {
        const delay = RETRY_BASE_MS * Math.pow(2, attempt);
        logger.warn(`Network error: ${err.message} — retrying in ${delay}ms (attempt ${attempt + 1}/${RETRY_ATTEMPTS})`);
        await sleep(delay);
      }
    }
  }
  throw lastErr || new Error(`Failed after ${RETRY_ATTEMPTS} retries: ${urlStr.split('?')[0]}`);
}

async function fetchJSON(urlStr, opts = {}) {
  const { status, body } = await httpGet(urlStr, opts);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Non-JSON HTTP(${status}) from ${urlStr.split('?')[0]}`); }
  return { status, data };
}

async function fetchText(urlStr, opts = {}) {
  return httpGet(urlStr, opts);
}

// ═══════════════════════════════════════════════════════════════
// LRU CACHE  (TTL + max-size + dedup inflight requests)
// ═══════════════════════════════════════════════════════════════

class LRUCache {
  constructor({ maxSize = 256 } = {}) {
    this._maxSize  = maxSize;
    this._store    = new Map();   // insertion-order = LRU order
    this._inflight = new Map();
    setInterval(() => this._purge(), 120_000).unref();
  }

  get(k) {
    const r = this._store.get(k);
    if (!r) return null;
    if (Date.now() > r.exp) { this._store.delete(k); return null; }
    // Move to end (most-recently-used)
    this._store.delete(k);
    this._store.set(k, r);
    return r.val;
  }

  set(k, val, ttlSec) {
    if (this._store.has(k)) this._store.delete(k);
    // Evict oldest entry if at capacity
    if (this._store.size >= this._maxSize) {
      const oldest = this._store.keys().next().value;
      this._store.delete(oldest);
    }
    this._store.set(k, { val, exp: Date.now() + ttlSec * 1000 });
  }

  async dedupe(k, fn) {
    const hit = this.get(k);
    if (hit !== null) return { ...hit, cached: true };
    if (this._inflight.has(k)) return this._inflight.get(k);
    const p = fn().finally(() => this._inflight.delete(k));
    this._inflight.set(k, p);
    return p;
  }

  _purge() {
    const now = Date.now();
    for (const [k, v] of this._store) if (now > v.exp) this._store.delete(k);
  }

  stats() {
    return { entries: this._store.size, maxSize: this._maxSize, inflight: this._inflight.size };
  }
}

const cache = new LRUCache({ maxSize: 256 });

// ═══════════════════════════════════════════════════════════════
// MIDDLEWARE SETUP
// ═══════════════════════════════════════════════════════════════

// ── Helmet (security headers) ─────────────────────────────────
const helmetMiddleware = helmet({
  contentSecurityPolicy : { directives: { defaultSrc: ["'none'"] } },
  crossOriginOpenerPolicy    : true,
  crossOriginResourcePolicy  : { policy: 'cross-origin' },
  referrerPolicy             : { policy: 'no-referrer' },
  hsts                       : CONFIG.IS_PROD
    ? { maxAge: 31_536_000, includeSubDomains: true, preload: true }
    : false,
});

// ── Compression ───────────────────────────────────────────────
const compressionMiddleware = compression({
  level     : 6,
  threshold : 1024,
  filter    : (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
});

// ── CORS ──────────────────────────────────────────────────────
const corsMiddleware = cors({
  origin : (origin, callback) => {
    if (CONFIG.ALLOWED_ORIGINS.includes('*')) return callback(null, true);
    if (!origin || CONFIG.ALLOWED_ORIGINS.includes(origin)) return callback(null, true);
    callback(new Error(`CORS: origin not permitted — ${origin}`));
  },
  methods           : ['GET', 'OPTIONS'],
  allowedHeaders    : ['Content-Type', 'Accept'],
  maxAge            : 86400,
  optionsSuccessStatus : 204,
});

// ── Rate Limiter ──────────────────────────────────────────────
const rateLimitMiddleware = rateLimit({
  windowMs         : 60_000,
  max              : 60,
  standardHeaders  : true,
  legacyHeaders    : false,
  keyGenerator     : (req) => getClientIp(req),
  handler          : (_req, res) => {
    res.status(429).json({ success: false, source: 'rate-limiter', cached: false,
      error: 'Rate limit exceeded — retry in 60s.' });
  },
});

// ── Request Logger ────────────────────────────────────────────
function requestLogger(req, _res, next) {
  logger.req(req);
  next();
}

// ═══════════════════════════════════════════════════════════════
// APP INIT
// ═══════════════════════════════════════════════════════════════

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1);

app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));
app.use(requestLogger);
app.use(helmetMiddleware);
app.use(corsMiddleware);
app.use(rateLimitMiddleware);
app.use(compressionMiddleware);

// ═══════════════════════════════════════════════════════════════
// SERVICES — API-FOOTBALL
// ═══════════════════════════════════════════════════════════════

function afHeaders() {
  return { 'x-apisports-key': CONFIG.KEYS.AF };
}

async function afGet(path) {
  const { status, data } = await fetchJSON(`${AF_BASE}${path}`, { headers: afHeaders() });
  if (status === 401 || status === 403) throw new Error(`AF auth error (${status})`);
  if (status === 429) throw new Error('AF rate limit hit');
  if (status !== 200) throw new Error(`AF HTTP ${status}`);
  if (data?.errors?.rateLimit) throw new Error('AF rate limit (quota)');
  if (data?.errors?.token)     throw new Error('AF invalid token');
  return data;
}

// ═══════════════════════════════════════════════════════════════
// SERVICES — SPORTMONKS
// ═══════════════════════════════════════════════════════════════

async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SM_BASE}${path}${sep}api_token=${CONFIG.KEYS.SM}`;
  const { status, data } = await fetchJSON(url);
  if (status !== 200) throw new Error(`SM HTTP ${status}`);
  return data;
}

// ═══════════════════════════════════════════════════════════════
// SERVICES — RSS
// ═══════════════════════════════════════════════════════════════

function xmlExtract(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i'
  );
  const m = re.exec(xml);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : (m[2] || '')).trim();
}

function parseRSS(xml) {
  const items = [];
  const re    = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b     = m[1];
    const title = xmlExtract(b, 'title');
    const link  = xmlExtract(b, 'link');
    if (!title || !link) continue;
    const pd = xmlExtract(b, 'pubDate');
    items.push({
      title,
      link,
      description : xmlExtract(b, 'description').replace(/<[^>]+>/g, '').slice(0, 300),
      pubDate     : pd ? new Date(pd).toISOString() : null,
      category    : xmlExtract(b, 'category') || null,
    });
  }
  return items;
}

// ═══════════════════════════════════════════════════════════════
// SERVICES — STREAM EXTRACTOR
// ═══════════════════════════════════════════════════════════════

async function extractStreams(matchId) {
  const endpoints = [
    `${FAWA_BASE}/streams/${encodeURIComponent(matchId)}`,
    `${FAWA_BASE}/match/${encodeURIComponent(matchId)}/watch`,
  ];
  const seen = new Set();
  const out  = [];

  await Promise.allSettled(endpoints.map(async ep => {
    try {
      const { body } = await fetchText(ep, {
        headers : { 'User-Agent': 'SportLab/1.0' },
        timeout : 8_000,
      });
      const found = body.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
      for (const raw of found) {
        const u = raw.replace(/['"<>\\]+$/, '');
        if (!seen.has(u) && isValidStreamUrl(u)) {
          seen.add(u);
          out.push({ url: u, host: new URL(u).hostname });
        }
      }
    } catch { /* skip unreachable endpoint */ }
  }));

  return out;
}

// ═══════════════════════════════════════════════════════════════
// NORMALIZERS
// ═══════════════════════════════════════════════════════════════

function normFixture(f) {
  return {
    id       : f.fixture?.id       ?? null,
    date     : f.fixture?.date     ?? null,
    venue    : f.fixture?.venue?.name ?? null,
    status   : f.fixture?.status   ?? null,
    elapsed  : f.fixture?.status?.elapsed ?? null,
    league   : {
      id      : f.league?.id      ?? null,
      name    : f.league?.name    ?? null,
      country : f.league?.country ?? null,
      logo    : f.league?.logo    ?? null,
      round   : f.league?.round   ?? null,
    },
    homeTeam : { id: f.teams?.home?.id ?? null, name: f.teams?.home?.name ?? null, logo: f.teams?.home?.logo ?? null },
    awayTeam : { id: f.teams?.away?.id ?? null, name: f.teams?.away?.name ?? null, logo: f.teams?.away?.logo ?? null },
    score    : { current: f.goals ?? null, halftime: f.score?.halftime ?? null, fulltime: f.score?.fulltime ?? null },
  };
}

function normStanding(t) {
  return {
    rank         : t.rank         ?? null,
    team         : { id: t.team?.id ?? null, name: t.team?.name ?? null, logo: t.team?.logo ?? null },
    points       : t.points       ?? null,
    goalsDiff    : t.goalsDiff    ?? null,
    form         : t.form         ?? null,
    description  : t.description  ?? null,
    played       : t.all?.played  ?? null,
    won          : t.all?.win     ?? null,
    drawn        : t.all?.draw    ?? null,
    lost         : t.all?.lose    ?? null,
    goalsFor     : t.all?.goals?.for     ?? null,
    goalsAgainst : t.all?.goals?.against ?? null,
  };
}

function normLineup(t) {
  return {
    team        : { id: t.team?.id ?? null, name: t.team?.name ?? null, logo: t.team?.logo ?? null },
    formation   : t.formation ?? null,
    coach       : { id: t.coach?.id ?? null, name: t.coach?.name ?? null, photo: t.coach?.photo ?? null },
    startXI     : (t.startXI     || []).map(p => ({ id: p.player?.id, name: p.player?.name, number: p.player?.number, pos: p.player?.pos, grid: p.player?.grid })),
    substitutes : (t.substitutes || []).map(p => ({ id: p.player?.id, name: p.player?.name, number: p.player?.number, pos: p.player?.pos })),
  };
}

function normStat(t) {
  return {
    team       : { id: t.team?.id ?? null, name: t.team?.name ?? null, logo: t.team?.logo ?? null },
    statistics : (t.statistics || []).map(s => ({ type: s.type, value: s.value })),
  };
}

// ═══════════════════════════════════════════════════════════════
// FALLBACK ORCHESTRATOR
// ═══════════════════════════════════════════════════════════════

async function withFallback(primaryFn, fallbackFn) {
  try {
    const data = await primaryFn();
    return { data, source: 'api-football' };
  } catch (pErr) {
    logger.warn('Primary failed:', pErr.message, '— trying SportMonks fallback');
    try {
      const data = await fallbackFn();
      return { data, source: 'sportmonks' };
    } catch (sErr) {
      throw new Error(`Primary[${pErr.message}] Fallback[${sErr.message}]`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

function ok(res, source, data, cached = false, extra = {}) {
  return res.json({ success: true, source, cached, data, ...extra });
}

function fail(res, status, source, error) {
  return res.status(status).json({ success: false, source, cached: false, error });
}

// ═══════════════════════════════════════════════════════════════
// ROUTES
// ═══════════════════════════════════════════════════════════════

// ── GET / ─────────────────────────────────────────────────────
app.get('/', (_req, res) => {
  return res.json({
    success   : true,
    message   : 'SportLab API is running 🚀',
    endpoints : [
      'GET /',
      'GET /health',
      'GET /health/apis',
      'GET /live-matches',
      'GET /fixtures',
      'GET /standings',
      'GET /lineups',
      'GET /stats',
      'GET /news',
      'GET /highlights',
      'GET /streams',
    ],
  });
});

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  return ok(res, 'sportlab', {
    status  : 'operational',
    env     : CONFIG.ENV,
    uptime  : Math.floor(process.uptime()),
    memory  : {
      heapUsed  : process.memoryUsage().heapUsed,
      heapTotal : process.memoryUsage().heapTotal,
      rss       : process.memoryUsage().rss,
    },
    cache   : cache.stats(),
    keys    : {
      apiFootball : !!CONFIG.KEYS.AF,
      sportMonks  : !!CONFIG.KEYS.SM,
      youtube     : !!CONFIG.KEYS.YT,
    },
  });
});

// ── GET /health/apis ──────────────────────────────────────────
app.get('/health/apis', async (_req, res) => {
  const KEY = 'health:apis';
  try {
    const result = await cache.dedupe(KEY, async () => {

      async function probeApi(urlStr, fetchOpts = {}) {
        const start = Date.now();
        try {
          const { status, data } = await fetchJSON(urlStr, { ...fetchOpts, timeout: 8_000 });
          const responseTime = Date.now() - start;
          const ok = status === 200;
          const message = !ok
            ? (data?.message || data?.error?.message || data?.errors?.token || `HTTP ${status}`)
            : null;
          return { ok, status, responseTime, message };
        } catch (err) {
          return { ok: false, status: null, responseTime: Date.now() - start, message: err.message };
        }
      }

      const [afResult, smResult, ytResult] = await Promise.all([
        probeApi(`${AF_BASE}/status`, { headers: afHeaders() }),
        probeApi(`${SM_BASE}/leagues?api_token=${CONFIG.KEYS.SM}&per_page=1`),
        probeApi(`${YT_API}?part=snippet&q=test&maxResults=1&key=${CONFIG.KEYS.YT}`),
      ]);

      const data = {
        results : {
          apiFootball : afResult,
          sportMonks  : smResult,
          youtube     : ytResult,
        },
      };

      cache.set(KEY, { data, source: 'health' }, TTL.API_HEALTH);
      return { data, source: 'health', cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/health/apis', err.message);
    return fail(res, 502, 'health/apis', err.message);
  }
});

// ── GET /live-matches ─────────────────────────────────────────
app.get('/live-matches', async (_req, res) => {
  const KEY = 'live:all';
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet('/fixtures?live=all');
          return (r.response || []).map(normFixture);
        },
        async () => {
          const r = await smGet('/livescores/inplay');
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.LIVE);
      return { data, source, cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/live-matches', err.message);
    return fail(res, 502, 'live-matches', err.message);
  }
});

// ── GET /fixtures ─────────────────────────────────────────────
app.get('/fixtures', async (req, res) => {
  const league = posInt(req.query.league);
  const season = safeYear(req.query.season);
  const team   = posInt(req.query.team);
  const next   = clamp(req.query.next, 1, 50, 10);
  const KEY    = `fixtures:${league}:${season}:${team}:${next}`;

  try {
    const result = await cache.dedupe(KEY, async () => {
      const qs = new URLSearchParams({ next: String(next), season: String(season) });
      if (league) qs.set('league', String(league));
      if (team)   qs.set('team',   String(team));

      const { data, source } = await withFallback(
        async () => {
          const r = await afGet(`/fixtures?${qs}`);
          return (r.response || []).map(normFixture);
        },
        async () => {
          const smQs = new URLSearchParams({ per_page: String(next) });
          if (league) smQs.set('league_id', String(league));
          const r = await smGet(`/fixtures/upcoming?${smQs}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.FIXTURES);
      return { data, source, cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/fixtures', err.message);
    return fail(res, 502, 'fixtures', err.message);
  }
});

// ── GET /standings ────────────────────────────────────────────
app.get('/standings', async (req, res) => {
  const league = posInt(req.query.league);
  if (!league) return fail(res, 400, 'validation', 'Query param "league" is required (positive integer).');

  const season = safeYear(req.query.season);
  const KEY    = `standings:${league}:${season}`;

  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r   = await afGet(`/standings?league=${league}&season=${season}`);
          const raw = (r.response || [])[0]?.league?.standings || [];
          return raw.flat().map(normStanding);
        },
        async () => {
          const r = await smGet(`/standings/seasons/by/league_id/${league}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.STANDINGS);
      return { data, source, cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/standings', err.message);
    return fail(res, 502, 'standings', err.message);
  }
});

// ── GET /lineups ──────────────────────────────────────────────
app.get('/lineups', async (req, res) => {
  const fixture = posInt(req.query.fixture);
  if (!fixture) return fail(res, 400, 'validation', 'Query param "fixture" is required (positive integer).');

  const KEY = `lineups:${fixture}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet(`/fixtures/lineups?fixture=${fixture}`);
          return (r.response || []).map(normLineup);
        },
        async () => {
          const r = await smGet(`/lineups/fixtures/${fixture}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.LINEUPS);
      return { data, source, cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/lineups', err.message);
    return fail(res, 502, 'lineups', err.message);
  }
});

// ── GET /stats ────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const fixture = posInt(req.query.fixture);
  if (!fixture) return fail(res, 400, 'validation', 'Query param "fixture" is required (positive integer).');

  const KEY = `stats:${fixture}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet(`/fixtures/statistics?fixture=${fixture}`);
          return (r.response || []).map(normStat);
        },
        async () => {
          const r = await smGet(`/statistics/fixtures/${fixture}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.STATS);
      return { data, source, cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/stats', err.message);
    return fail(res, 502, 'stats', err.message);
  }
});

// ── GET /news ─────────────────────────────────────────────────
app.get('/news', async (_req, res) => {
  const KEY = 'news:espn';
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { status, body } = await fetchText(ESPN_RSS, {
        headers : { 'User-Agent': 'SportLab/1.0', Accept: 'application/rss+xml, text/xml' },
      });
      if (status !== 200) throw new Error(`ESPN RSS returned HTTP ${status}`);
      const data = parseRSS(body);
      cache.set(KEY, { data, source: 'espn-rss' }, TTL.NEWS);
      return { data, source: 'espn-rss', cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/news', err.message);
    return fail(res, 502, 'news', err.message);
  }
});

// ── GET /highlights ───────────────────────────────────────────
app.get('/highlights', async (req, res) => {
  if (!CONFIG.KEYS.YT)
    return fail(res, 503, 'youtube', 'YOUTUBE_KEY is not configured.');

  const q          = safeStr(req.query.q) || 'football highlights today';
  const maxResults = clamp(req.query.maxResults, 1, 25, 10);
  const KEY        = `yt:${q}:${maxResults}`;

  try {
    const result = await cache.dedupe(KEY, async () => {
      const qs = new URLSearchParams({
        part        : 'snippet',
        q,
        type        : 'video',
        maxResults  : String(maxResults),
        order       : 'relevance',
        safeSearch  : 'moderate',
        key         : CONFIG.KEYS.YT,
      });

      const { status, data } = await fetchJSON(`${YT_API}?${qs}`);
      if (status !== 200)
        throw new Error(`YouTube API(${status}): ${data?.error?.message || 'unknown'}`);

      const items = (data.items || [])
        .filter(i => i.id?.videoId)
        .map(i => ({
          videoId      : i.id.videoId,
          title        : i.snippet?.title        || null,
          description  : (i.snippet?.description || '').slice(0, 200),
          thumbnail    : i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url || null,
          channelTitle : i.snippet?.channelTitle  || null,
          publishedAt  : i.snippet?.publishedAt   || null,
          watchUrl     : `https://www.youtube.com/watch?v=${i.id.videoId}`,
        }));

      cache.set(KEY, { data: items, source: 'youtube' }, TTL.HIGHLIGHTS);
      return { data: items, source: 'youtube', cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true);
  } catch (err) {
    logger.error('/highlights', err.message);
    return fail(res, 502, 'highlights', err.message);
  }
});

// ── GET /streams ──────────────────────────────────────────────
app.get('/streams', async (req, res) => {
  const matchId = safeStr(req.query.matchId, 64);
  if (!matchId)
    return fail(res, 400, 'validation', 'Query param "matchId" is required.');

  const KEY = `streams:${matchId}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const streams = await extractStreams(matchId);
      cache.set(KEY, { data: streams, source: 'fawanews' }, TTL.STREAMS);
      return { data: streams, source: 'fawanews', cached: false };
    });
    return ok(res, result.source, result.data, result.cached === true, {
      meta : { total: result.data.length, filtered: true },
    });
  } catch (err) {
    logger.error('/streams', err.message);
    return fail(res, 502, 'streams', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════
// 404 HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((req, res) => {
  return fail(res, 404, 'router', `Not found: ${req.method} ${req.path}`);
});

// ═══════════════════════════════════════════════════════════════
// GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  logger.error('Unhandled exception:', err?.message || err);
  // Surface CORS errors as 403 instead of 500
  if (err.message && err.message.startsWith('CORS:')) {
    return fail(res, 403, 'cors', err.message);
  }
  return fail(res, 500, 'server', 'Internal server error.');
});

// ═══════════════════════════════════════════════════════════════
// PROCESS SAFETY
// ═══════════════════════════════════════════════════════════════

process.on('uncaughtException',  err => logger.error('uncaughtException:',  err.message));
process.on('unhandledRejection', err => logger.error('unhandledRejection:', err?.message || err));

// ═══════════════════════════════════════════════════════════════
// SERVER STARTUP + GRACEFUL SHUTDOWN
// ═══════════════════════════════════════════════════════════════

const server = app.listen(CONFIG.PORT, () => {
  logger.info(`SportLab listening on port ${CONFIG.PORT} [${CONFIG.ENV}]`);
  logger.info(`API-Football : ${CONFIG.KEYS.AF ? '✓' : '✗ MISSING'}`);
  logger.info(`SportMonks   : ${CONFIG.KEYS.SM ? '✓' : '✗ MISSING'}`);
  logger.info(`YouTube      : ${CONFIG.KEYS.YT ? '✓' : '✗ MISSING'}`);
});

function gracefulShutdown(signal) {
  logger.info(`${signal} received — shutting down gracefully`);
  server.close(err => {
    if (err) {
      logger.error('Error during shutdown:', err.message);
      process.exit(1);
    }
    logger.info('Server closed — all connections drained');
    process.exit(0);
  });

  // Force exit if still open after 10s
  setTimeout(() => {
    logger.error('Shutdown timeout exceeded — forcing exit');
    process.exit(1);
  }, 10_000).unref();
}

process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
process.on('SIGINT',  () => gracefulShutdown('SIGINT'));

module.exports = app;

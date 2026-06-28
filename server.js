'use strict';

require('dotenv').config();

const express = require('express');
const https   = require('https');
const http    = require('http');
const { URL } = require('url');

// ═══════════════════════════════════════════════════════════════
// BOOTSTRAP
// ═══════════════════════════════════════════════════════════════

const app  = express();
const PORT = process.env.PORT || 3000;
const ENV  = process.env.NODE_ENV || 'development';
const IS_PROD = ENV === 'production';

app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '10kb' }));
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

// ═══════════════════════════════════════════════════════════════
// LOGGER
// ═══════════════════════════════════════════════════════════════

const log = {
  info  : (...a) => console.log(`[${new Date().toISOString()}] [INFO]`, ...a),
  warn  : (...a) => console.warn(`[${new Date().toISOString()}] [WARN]`, ...a),
  error : (...a) => console.error(`[${new Date().toISOString()}] [ERROR]`, ...a),
};

// ═══════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════

const AF_BASE     = 'https://v3.football.api-sports.io';
const SM_BASE     = 'https://api.sportmonks.com/v3/football';
const ESPN_RSS    = 'https://www.espn.com/espn/rss/soccer/news';
const YT_SEARCH   = 'https://www.googleapis.com/youtube/v3/search';
const FAWA_BASE   = 'https://www.fawanews.com';

const TTL = {
  LIVE       : 20,
  FIXTURES   : 120,
  STANDINGS  : 300,
  LINEUPS    : 180,
  STATS      : 60,
  NEWS       : 360,
  HIGHLIGHTS : 600,
  STREAMS    : 60,
  HEALTH     : 10,
};

const BLOCKED_DOMAINS = new Set([
  'bit.ly','tinyurl.com','goo.gl','t.co','ow.ly','is.gd','buff.ly',
  'shorte.st','adf.ly','bc.vc','clicksfly.com','sh.st','ouo.io',
  'clk.sh','linkvertise.com','exe.io','za.gl','cutt.ly','rebrand.ly',
  'url.cn','dwz.cn','lnk.to',
]);

const UNSAFE_PATTERN = /malware|phish|crack|hack|keygen|warez|xxx|porn|adult|torrent|pirat/i;

const RATE = {
  WINDOW_MS  : 60_000,
  MAX_REQ    : 60,
  BURST_MAX  : 10,
  BURST_WIN  : 1_000,
};

// ═══════════════════════════════════════════════════════════════
// UTILITY LAYER
// ═══════════════════════════════════════════════════════════════

function posInt(v) {
  if (v === undefined || v === null || v === '') return null;
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

function isValidHttpsUrl(str) {
  if (!str || typeof str !== 'string' || str.length > 2048) return false;
  try {
    const u = new URL(str);
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (!/\.[a-z]{2,}$/.test(host)) return false;
    const base = host.split('.').slice(-2).join('.');
    if (BLOCKED_DOMAINS.has(base) || BLOCKED_DOMAINS.has(host)) return false;
    if (UNSAFE_PATTERN.test(str)) return false;
    return true;
  } catch { return false; }
}

// ═══════════════════════════════════════════════════════════════
// HTTP CLIENT
// ═══════════════════════════════════════════════════════════════

function rawRequest(urlStr, opts = {}) {
  return new Promise((resolve, reject) => {
    let u;
    try { u = new URL(urlStr); } catch (e) { return reject(e); }

    const transport = u.protocol === 'https:' ? https : http;
    const timeout   = opts.timeout || 10_000;

    const req = transport.request({
      hostname : u.hostname,
      path     : u.pathname + u.search,
      method   : opts.method || 'GET',
      headers  : { 'Accept-Encoding': 'gzip', ...opts.headers },
      timeout,
    }, res => {
      const chunks = [];
      res.on('data',  c => chunks.push(c));
      res.on('end',  () => resolve({ status: res.statusCode, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });

    req.on('timeout', () => { req.destroy(); reject(new Error(`Timeout(${timeout}ms): ${urlStr}`)); });
    req.on('error',   reject);
    req.end();
  });
}

async function getJSON(urlStr, opts = {}) {
  const { status, body } = await rawRequest(urlStr, opts);
  let data;
  try { data = JSON.parse(body); }
  catch { throw new Error(`Non-JSON (HTTP ${status}) from ${urlStr.split('?')[0]}`); }
  return { status, data };
}

async function getText(urlStr, opts = {}) {
  return rawRequest(urlStr, { ...opts });
}

// ═══════════════════════════════════════════════════════════════
// CACHE LAYER
// ═══════════════════════════════════════════════════════════════

class Cache {
  constructor() {
    this._store = new Map();
    this._inflight = new Map();
    // purge expired entries every 2 minutes
    setInterval(() => this._purge(), 120_000).unref();
  }

  _key(k) { return String(k); }

  get(k) {
    const r = this._store.get(this._key(k));
    if (!r) return null;
    if (Date.now() > r.exp) { this._store.delete(this._key(k)); return null; }
    return r.val;
  }

  set(k, val, ttlSec) {
    this._store.set(this._key(k), { val, exp: Date.now() + ttlSec * 1000 });
  }

  // Prevents duplicate concurrent requests to the same resource
  async dedupe(k, fn) {
    const cached = this.get(k);
    if (cached !== null) return { data: cached, cached: true };

    if (this._inflight.has(k)) return this._inflight.get(k);

    const promise = fn().finally(() => this._inflight.delete(k));
    this._inflight.set(k, promise);
    return promise;
  }

  _purge() {
    const now = Date.now();
    for (const [k, v] of this._store) if (now > v.exp) this._store.delete(k);
  }

  stats() {
    return { entries: this._store.size, inflight: this._inflight.size };
  }
}

const cache = new Cache();

// ═══════════════════════════════════════════════════════════════
// RATE LIMITER
// ═══════════════════════════════════════════════════════════════

class RateLimiter {
  constructor() {
    this._windows = new Map();
    setInterval(() => this._purge(), RATE.WINDOW_MS).unref();
  }

  _ip(req) {
    return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket?.remoteAddress
      || 'unknown';
  }

  check(req) {
    const ip  = this._ip(req);
    const now = Date.now();
    let rec   = this._windows.get(ip);

    if (!rec || now > rec.winEnd) {
      rec = { count: 0, winEnd: now + RATE.WINDOW_MS, burst: 0, burstEnd: now + RATE.BURST_WIN };
      this._windows.set(ip, rec);
    }

    // burst check
    if (now > rec.burstEnd) { rec.burst = 0; rec.burstEnd = now + RATE.BURST_WIN; }
    rec.burst++;
    if (rec.burst > RATE.BURST_MAX) return { allowed: false, reason: 'burst' };

    rec.count++;
    if (rec.count > RATE.MAX_REQ) return { allowed: false, reason: 'limit' };

    return { allowed: true };
  }

  _purge() {
    const now = Date.now();
    for (const [k, v] of this._windows) if (now > v.winEnd) this._windows.delete(k);
  }
}

const limiter = new RateLimiter();

// ═══════════════════════════════════════════════════════════════
// SECURITY MIDDLEWARE
// ═══════════════════════════════════════════════════════════════

function securityHeaders(_req, res, next) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('X-XSS-Protection', '1; mode=block');
  res.setHeader('Referrer-Policy', 'no-referrer');
  res.setHeader('Permissions-Policy', 'geolocation=(), camera=(), microphone=()');
  if (IS_PROD) res.setHeader('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
  next();
}

function corsMiddleware(req, res, next) {
  const allowed = process.env.ALLOWED_ORIGINS
    ? process.env.ALLOWED_ORIGINS.split(',').map(s => s.trim())
    : ['*'];
  const origin = req.headers.origin || '';

  if (allowed.includes('*')) {
    res.setHeader('Access-Control-Allow-Origin', '*');
  } else if (allowed.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  } else if (origin) {
    return res.status(403).json({ success: false, error: 'Origin not allowed.' });
  }

  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Accept');
  res.setHeader('Access-Control-Max-Age', '86400');

  if (req.method === 'OPTIONS') return res.sendStatus(204);
  return next();
}

function rateLimitMiddleware(req, res, next) {
  const { allowed, reason } = limiter.check(req);
  if (!allowed) {
    const msg = reason === 'burst'
      ? 'Too many rapid requests — slow down.'
      : 'Rate limit exceeded — try again in a minute.';
    return res.status(429).json({ success: false, source: 'rate-limiter', error: msg });
  }
  return next();
}

app.use(securityHeaders);
app.use(corsMiddleware);
app.use(rateLimitMiddleware);

// ═══════════════════════════════════════════════════════════════
// RESPONSE HELPERS
// ═══════════════════════════════════════════════════════════════

function send200(res, source, data, cached = false, extra = {}) {
  return res.json({ success: true, source, cached, data, ...extra });
}

function sendErr(res, status, source, error) {
  return res.status(status).json({ success: false, source, cached: false, error });
}

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — API-FOOTBALL
// ═══════════════════════════════════════════════════════════════

function afHeaders() {
  return { 'x-apisports-key': process.env.API_FOOTBALL_KEY || '' };
}

async function afGet(path) {
  const { status, data } = await getJSON(`${AF_BASE}${path}`, { headers: afHeaders() });
  if (status !== 200 || data.errors?.rateLimit || data.errors?.token) {
    throw new Error(`AF(${status}): ${JSON.stringify(data?.errors || {})}`);
  }
  return data;
}

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — SPORTMONKS
// ═══════════════════════════════════════════════════════════════

async function smGet(path) {
  const sep = path.includes('?') ? '&' : '?';
  const url = `${SM_BASE}${path}${sep}api_token=${process.env.SPORTMONKS_KEY || ''}`;
  const { status, data } = await getJSON(url);
  if (status !== 200) throw new Error(`SM(${status})`);
  return data;
}

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — RSS PARSER
// ═══════════════════════════════════════════════════════════════

function xmlTag(xml, tag) {
  const re = new RegExp(
    `<${tag}(?:[^>]*)>(?:<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>|([\\s\\S]*?))<\\/${tag}>`, 'i'
  );
  const m = re.exec(xml);
  if (!m) return '';
  return (m[1] !== undefined ? m[1] : (m[2] || '')).trim();
}

function parseRSS(xml) {
  const out = [];
  const re  = /<item>([\s\S]*?)<\/item>/gi;
  let m;
  while ((m = re.exec(xml)) !== null) {
    const b     = m[1];
    const title = xmlTag(b, 'title');
    const link  = xmlTag(b, 'link');
    if (!title || !link) continue;
    const pd = xmlTag(b, 'pubDate');
    out.push({
      title,
      link,
      description : xmlTag(b, 'description').replace(/<[^>]+>/g, '').slice(0, 300),
      pubDate     : pd ? new Date(pd).toISOString() : null,
      category    : xmlTag(b, 'category'),
    });
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════
// SERVICE LAYER — STREAM EXTRACTOR
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
      const { body } = await getText(ep, {
        headers : { 'User-Agent': 'SportLab/1.0' },
        timeout : 8_000,
      });
      const urls = body.match(/https?:\/\/[^\s"'<>\\]+/g) || [];
      for (const raw of urls) {
        const u = raw.replace(/['"<>\\]+$/, '');
        if (!seen.has(u) && isValidHttpsUrl(u)) {
          seen.add(u);
          out.push({ url: u, host: new URL(u).hostname });
        }
      }
    } catch { /* skip unreachable */ }
  }));

  return out;
}

// ═══════════════════════════════════════════════════════════════
// NORMALIZERS
// ═══════════════════════════════════════════════════════════════

function normalizeFixture(f) {
  return {
    id       : f.fixture?.id,
    date     : f.fixture?.date,
    venue    : f.fixture?.venue?.name,
    status   : f.fixture?.status,
    elapsed  : f.fixture?.status?.elapsed,
    league   : {
      id      : f.league?.id,
      name    : f.league?.name,
      country : f.league?.country,
      logo    : f.league?.logo,
      round   : f.league?.round,
    },
    homeTeam : { id: f.teams?.home?.id, name: f.teams?.home?.name, logo: f.teams?.home?.logo },
    awayTeam : { id: f.teams?.away?.id, name: f.teams?.away?.name, logo: f.teams?.away?.logo },
    score    : { current: f.goals, halftime: f.score?.halftime, fulltime: f.score?.fulltime },
  };
}

function normalizeStanding(t) {
  return {
    rank         : t.rank,
    team         : { id: t.team?.id, name: t.team?.name, logo: t.team?.logo },
    points       : t.points,
    goalsDiff    : t.goalsDiff,
    form         : t.form,
    description  : t.description,
    played       : t.all?.played,
    won          : t.all?.win,
    drawn        : t.all?.draw,
    lost         : t.all?.lose,
    goalsFor     : t.all?.goals?.for,
    goalsAgainst : t.all?.goals?.against,
  };
}

function normalizeLineup(t) {
  return {
    team        : { id: t.team?.id, name: t.team?.name, logo: t.team?.logo },
    formation   : t.formation,
    coach       : { id: t.coach?.id, name: t.coach?.name, photo: t.coach?.photo },
    startXI     : (t.startXI || []).map(p => ({
      id: p.player?.id, name: p.player?.name,
      number: p.player?.number, pos: p.player?.pos, grid: p.player?.grid,
    })),
    substitutes : (t.substitutes || []).map(p => ({
      id: p.player?.id, name: p.player?.name,
      number: p.player?.number, pos: p.player?.pos,
    })),
  };
}

function normalizeStat(t) {
  return {
    team       : { id: t.team?.id, name: t.team?.name, logo: t.team?.logo },
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
    log.warn('Primary source failed:', pErr.message, '— trying fallback');
    try {
      const data = await fallbackFn();
      return { data, source: 'sportmonks' };
    } catch (sErr) {
      throw new Error(`Primary: ${pErr.message} | Fallback: ${sErr.message}`);
    }
  }
}

// ═══════════════════════════════════════════════════════════════
// ROUTE HANDLERS
// ═══════════════════════════════════════════════════════════════

// ── /health ───────────────────────────────────────────────────
app.get('/health', (_req, res) => {
  return send200(res, 'sportlab', {
    status    : 'operational',
    env       : ENV,
    uptime    : Math.floor(process.uptime()),
    memory    : process.memoryUsage().heapUsed,
    cache     : cache.stats(),
    keys      : {
      apiFootball : !!process.env.API_FOOTBALL_KEY,
      sportMonks  : !!process.env.SPORTMONKS_KEY,
      youtube     : !!process.env.YOUTUBE_KEY,
    },
  });
});

// ── /live-matches ─────────────────────────────────────────────
app.get('/live-matches', async (_req, res) => {
  const KEY = 'live:all';
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet('/fixtures?live=all');
          return (r.response || []).map(normalizeFixture);
        },
        async () => {
          const r = await smGet('/livescores/inplay');
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.LIVE);
      return { data, source, cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/live-matches', err.message);
    return sendErr(res, 502, 'live-matches', err.message);
  }
});

// ── /fixtures ─────────────────────────────────────────────────
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
          return (r.response || []).map(normalizeFixture);
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
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/fixtures', err.message);
    return sendErr(res, 502, 'fixtures', err.message);
  }
});

// ── /standings ────────────────────────────────────────────────
app.get('/standings', async (req, res) => {
  const league = posInt(req.query.league);
  if (!league) return sendErr(res, 400, 'validation', 'Query param "league" is required (positive integer).');

  const season = safeYear(req.query.season);
  const KEY    = `standings:${league}:${season}`;

  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r   = await afGet(`/standings?league=${league}&season=${season}`);
          const raw = (r.response || [])[0]?.league?.standings || [];
          return raw.flat().map(normalizeStanding);
        },
        async () => {
          const r = await smGet(`/standings/seasons/by/league_id/${league}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.STANDINGS);
      return { data, source, cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/standings', err.message);
    return sendErr(res, 502, 'standings', err.message);
  }
});

// ── /lineups ──────────────────────────────────────────────────
app.get('/lineups', async (req, res) => {
  const fixture = posInt(req.query.fixture);
  if (!fixture) return sendErr(res, 400, 'validation', 'Query param "fixture" is required (positive integer).');

  const KEY = `lineups:${fixture}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet(`/fixtures/lineups?fixture=${fixture}`);
          return (r.response || []).map(normalizeLineup);
        },
        async () => {
          const r = await smGet(`/lineups/fixtures/${fixture}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.LINEUPS);
      return { data, source, cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/lineups', err.message);
    return sendErr(res, 502, 'lineups', err.message);
  }
});

// ── /stats ────────────────────────────────────────────────────
app.get('/stats', async (req, res) => {
  const fixture = posInt(req.query.fixture);
  if (!fixture) return sendErr(res, 400, 'validation', 'Query param "fixture" is required (positive integer).');

  const KEY = `stats:${fixture}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { data, source } = await withFallback(
        async () => {
          const r = await afGet(`/fixtures/statistics?fixture=${fixture}`);
          return (r.response || []).map(normalizeStat);
        },
        async () => {
          const r = await smGet(`/statistics/fixtures/${fixture}`);
          return Array.isArray(r.data) ? r.data : [];
        }
      );
      cache.set(KEY, { data, source }, TTL.STATS);
      return { data, source, cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/stats', err.message);
    return sendErr(res, 502, 'stats', err.message);
  }
});

// ── /news ─────────────────────────────────────────────────────
app.get('/news', async (_req, res) => {
  const KEY = 'news:espn';
  try {
    const result = await cache.dedupe(KEY, async () => {
      const { status, body } = await getText(ESPN_RSS, {
        headers : { 'User-Agent': 'SportLab/1.0', Accept: 'application/rss+xml, text/xml' },
      });
      if (status !== 200) throw new Error(`ESPN RSS returned HTTP ${status}`);
      const data = parseRSS(body);
      cache.set(KEY, { data, source: 'espn-rss' }, TTL.NEWS);
      return { data, source: 'espn-rss', cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/news', err.message);
    return sendErr(res, 502, 'news', err.message);
  }
});

// ── /highlights ───────────────────────────────────────────────
app.get('/highlights', async (req, res) => {
  if (!process.env.YOUTUBE_KEY)
    return sendErr(res, 503, 'youtube', 'YOUTUBE_KEY is not configured.');

  const q          = safeStr(req.query.q) || 'football highlights today';
  const maxResults = clamp(req.query.maxResults, 1, 25, 10);
  const KEY        = `yt:${q}:${maxResults}`;

  try {
    const result = await cache.dedupe(KEY, async () => {
      const qs = new URLSearchParams({
        part: 'snippet', q, type: 'video',
        maxResults: String(maxResults),
        order: 'relevance', safeSearch: 'moderate',
        key: process.env.YOUTUBE_KEY,
      });

      const { status, data } = await getJSON(`${YT_SEARCH}?${qs}`);
      if (status !== 200)
        throw new Error(`YouTube API(${status}): ${data?.error?.message || 'unknown'}`);

      const items = (data.items || [])
        .filter(i => i.id?.videoId)
        .map(i => ({
          videoId      : i.id.videoId,
          title        : i.snippet?.title,
          description  : (i.snippet?.description || '').slice(0, 200),
          thumbnail    : i.snippet?.thumbnails?.medium?.url || i.snippet?.thumbnails?.default?.url,
          channelTitle : i.snippet?.channelTitle,
          publishedAt  : i.snippet?.publishedAt,
          watchUrl     : `https://www.youtube.com/watch?v=${i.id.videoId}`,
        }));

      cache.set(KEY, { data: items, source: 'youtube' }, TTL.HIGHLIGHTS);
      return { data: items, source: 'youtube', cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true);
  } catch (err) {
    log.error('/highlights', err.message);
    return sendErr(res, 502, 'highlights', err.message);
  }
});

// ── /streams ──────────────────────────────────────────────────
app.get('/streams', async (req, res) => {
  const matchId = safeStr(req.query.matchId, 64);
  if (!matchId) return sendErr(res, 400, 'validation', 'Query param "matchId" is required.');

  const KEY = `streams:${matchId}`;
  try {
    const result = await cache.dedupe(KEY, async () => {
      const streams = await extractStreams(matchId);
      cache.set(KEY, { data: streams, source: 'fawanews' }, TTL.STREAMS);
      return { data: streams, source: 'fawanews', cached: false };
    });
    return send200(res, result.source, result.data, result.cached === true, {
      meta: { total: result.data.length, filtered: true },
    });
  } catch (err) {
    log.error('/streams', err.message);
    return sendErr(res, 502, 'streams', err.message);
  }
});

// ═══════════════════════════════════════════════════════════════
// 404 + GLOBAL ERROR HANDLER
// ═══════════════════════════════════════════════════════════════

app.use((req, res) => {
  return sendErr(res, 404, 'router', `Not found: ${req.method} ${req.path}`);
});

// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  log.error('Unhandled:', err);
  return sendErr(res, 500, 'server', 'Internal server error.');
});

// ═══════════════════════════════════════════════════════════════
// START
// ═══════════════════════════════════════════════════════════════

app.listen(PORT, () => {
  log.info(`SportLab listening on port ${PORT} [${ENV}]`);
  log.info(`API-Football : ${process.env.API_FOOTBALL_KEY ? '✓' : '✗ MISSING'}`);
  log.info(`SportMonks   : ${process.env.SPORTMONKS_KEY   ? '✓' : '✗ MISSING'}`);
  log.info(`YouTube      : ${process.env.YOUTUBE_KEY       ? '✓' : '✗ MISSING'}`);
});

module.exports = app;

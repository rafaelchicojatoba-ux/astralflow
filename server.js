'use strict';

const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');

const PORT = Number(process.env.PORT || 7000);
const ADDON_NAME = 'Astral Flow';
const PUBLIC_URL = normalizePublicUrl(process.env.PUBLIC_URL);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 15000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 45000);
const MAX_STREAMS = Number(process.env.MAX_STREAMS || 0);
const FORCE_TOP_PER_SOURCE = Number(process.env.FORCE_TOP_PER_SOURCE || 5);

const SOURCE_TOKENS = [
  '==gbvNnauQ3clZWauFWbv4Wdm5SblJHdz5yc1xGctkXYiVGdhJXawVGa09yL6MHc0RHa',
  '=42bzpmL0NXZmlmbh12LuVnZu0WZyR3cu8Wa05WZyJ3b09yL6MHc0RHa',
  'u92cq5CdzVmZp5WYt9idlRmLzJXZrJ3b35SZsV3cwF2YjlGdjFGbhdmLvlmd0pHd59yL6MHc0RHa',
  '=42bzpmL0NXZmlmbh12LlRXas9CdhxmLi1meuIHdz9yL6MHc0RHa',
  '=42bzpmL0NXZmlmbh12LsFmLu9mc0NWZsVmL41WYlJHdz9yL6MHc0RHa'
];

const SOURCE_URLS = SOURCE_TOKENS.map(unpack);
const DEFAULT_TRACKERS = [
  'udp://tracker.opentrackr.org:1337/announce',
  'udp://open.stealth.si:80/announce',
  'udp://tracker.openbittorrent.com:80/announce',
  'udp://exodus.desync.com:6969/announce',
  'udp://tracker.torrent.eu.org:451/announce',
  'udp://open.demonii.com:1337/announce'
];
const ASSET_DIR = path.join(__dirname, 'assets');
const ASSETS = {
  '/logo.png': {
    file: 'logo-512.png',
    contentType: 'image/png'
  },
  '/icon.png': {
    file: 'logo-256.png',
    contentType: 'image/png'
  },
  '/assets/logo.png': {
    file: 'logo-512.png',
    contentType: 'image/png'
  },
  '/assets/logo-512.png': {
    file: 'logo-512.png',
    contentType: 'image/png'
  },
  '/assets/logo-256.png': {
    file: 'logo-256.png',
    contentType: 'image/png'
  },
  '/assets/logo-128.png': {
    file: 'logo-128.png',
    contentType: 'image/png'
  },
  '/assets/logo-original.png': {
    file: 'logo-original.png',
    contentType: 'image/png'
  }
};
let fallbackLogoBuffer;

const baseManifest = {
  id: 'community.astralflow.private',
  version: '1.0.9',
  name: ADDON_NAME,
  description: 'Streams sorted by seeders and quality.',
  resources: ['stream'],
  types: ['movie', 'series'],
  catalogs: [],
  idPrefixes: ['tt'],
  behaviorHints: {
    configurable: false,
    configurationRequired: false
  }
};

const streamCache = new Map();

const server = http.createServer(async (req, res) => {
  const requestUrl = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`);

  if (req.method === 'OPTIONS') {
    return sendJson(res, 204, {});
  }

  if (req.method !== 'GET') {
    return sendJson(res, 405, { error: 'Method not allowed' });
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/manifest.json') {
    return sendJson(res, 200, buildManifest(req));
  }

  if (ASSETS[requestUrl.pathname]) {
    return sendAsset(res, ASSETS[requestUrl.pathname]);
  }

  const streamMatch = requestUrl.pathname.match(/^\/stream\/([^/]+)\/(.+)\.json$/);

  if (streamMatch) {
    const type = decodeURIComponent(streamMatch[1]);
    const id = decodeURIComponent(streamMatch[2]);
    const streams = await getStreams(type, id);
    return sendJson(res, 200, { streams });
  }

  return sendJson(res, 404, { error: 'Not found' });
});

server.listen(PORT, () => {
  const localUrl = `http://localhost:${PORT}`;
  const baseUrl = PUBLIC_URL || localUrl;

  console.log(`${ADDON_NAME} addon ready: ${baseUrl}/manifest.json`);
  console.log(`Install URL: stremio://${baseUrl.replace(/^https?:\/\//, '')}/manifest.json`);
});

async function getStreams(type, id) {
  const cacheKey = `${type}:${id}`;
  const cached = streamCache.get(cacheKey);

  if (cached && Date.now() - cached.createdAt < CACHE_TTL_MS) {
    return cached.streams;
  }

  const settled = await Promise.allSettled(
    SOURCE_URLS.map(async (sourceUrl, sourceIndex) => ({
      sourceIndex,
      streams: await fetchSourceStreams(sourceUrl, type, id)
    }))
  );

  const streams = settled
    .flatMap((result) => result.status === 'fulfilled'
      ? result.value.streams.map((stream) => ({ stream, sourceIndex: result.value.sourceIndex }))
      : [])
    .map(({ stream, sourceIndex }) => prepareStream(stream, sourceIndex))
    .filter(Boolean);

  const sorted = forceTopFromEachSource(streams);
  const limited = MAX_STREAMS > 0 ? sorted.slice(0, MAX_STREAMS) : sorted;
  const result = limited.map(({ stream }) => stream);

  streamCache.set(cacheKey, {
    createdAt: Date.now(),
    streams: result
  });

  return result;
}

function buildManifest(req) {
  const baseUrl = getBaseUrl(req);

  return {
    ...baseManifest,
    logo: `${baseUrl}/logo.png`,
    background: `${baseUrl}/assets/logo-original.png`
  };
}

function sendAsset(res, asset) {
  const assetPath = path.join(ASSET_DIR, asset.file);

  if (!fs.existsSync(assetPath)) {
    const fallback = getFallbackLogo();

    if (fallback) {
      return sendBuffer(res, fallback, asset.contentType);
    }

    return sendJson(res, 404, { error: 'Asset not found' });
  }

  const stream = fs.createReadStream(assetPath);

  stream.on('error', () => {
    res.destroy();
  });

  res.writeHead(200, {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=86400',
    'content-type': asset.contentType
  });

  stream.pipe(res);
}

function sendBuffer(res, buffer, contentType) {
  res.writeHead(200, {
    'access-control-allow-origin': '*',
    'cache-control': 'public, max-age=86400',
    'content-length': buffer.length,
    'content-type': contentType
  });

  return res.end(buffer);
}

function getFallbackLogo() {
  if (fallbackLogoBuffer) {
    return fallbackLogoBuffer;
  }

  try {
    fallbackLogoBuffer = Buffer.from(require('./logo-fallback'), 'base64');
    return fallbackLogoBuffer;
  } catch {
    return null;
  }
}

async function fetchSourceStreams(sourceUrl, type, id) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(buildStreamUrl(sourceUrl, type, id), {
      headers: {
        accept: 'application/json',
        'user-agent': 'AstralFlow/1.0'
      },
      signal: controller.signal
    });

    if (!response.ok) {
      return [];
    }

    const payload = await response.json();
    return Array.isArray(payload.streams) ? payload.streams : [];
  } catch {
    return [];
  } finally {
    clearTimeout(timer);
  }
}

function prepareStream(rawStream, sourceIndex = 0) {
  if (!rawStream || typeof rawStream !== 'object') {
    return null;
  }

  const stream = { ...rawStream };
  const meta = analyzeStream(stream);

  attachDefaultTrackers(stream);
  stream.name = ADDON_NAME;
  stream.title = buildDisplayTitle(rawStream, meta);

  if (meta.seeders !== null && meta.seeders !== undefined) {
    stream.seeders = meta.seeders;
  }

  if (meta.peers !== null && meta.peers !== undefined) {
    stream.peers = meta.peers;
  }

  if (meta.leechers !== null && meta.leechers !== undefined) {
    stream.leechers = meta.leechers;
  }

  stream.behaviorHints = {
    ...(stream.behaviorHints || {}),
    bingeGroup: `sf-${meta.quality || 'auto'}-${stream.fileIdx ?? 0}`
  };

  delete stream.behaviorHints.filename;
  delete stream.description;
  delete stream.filename;
  delete stream.tag;

  return {
    stream,
    seeders: meta.seeders ?? 0,
    peers: meta.peers ?? 0,
    leechers: meta.leechers ?? 0,
    quality: meta.quality ?? 0,
    size: meta.size ?? 0,
    sourceIndex
  };
}

function analyzeStream(stream) {
  const hints = stream.behaviorHints || {};
  const text = [
    stream.name,
    stream.title,
    stream.description,
    stream.url,
    stream.externalUrl,
    hints.filename
  ].filter(Boolean).join(' ');

  const size = pickNumber(
    hints.videoSize,
    hints.size,
    stream.size,
    extractSizeBytes(text)
  );

  return {
    ...extractSwarm(stream, text),
    quality: extractQuality(text),
    size,
    sizeText: size ? formatBytes(size) : extractSizeText(text),
    codec: extractCodec(text),
    audio: extractAudio(text)
  };
}

function buildDisplayTitle(rawStream, meta) {
  const originalTitle = sanitizeDisplayText(rawStream.title || rawStream.description || rawStream.name || '');

  if (originalTitle) {
    return originalTitle;
  }

  const quality = qualityLabel(meta.quality);
  const details = [quality];

  if (meta.seeders !== null && meta.seeders !== undefined) {
    details.push(`👤 ${meta.seeders}`);
  } else if (meta.peers !== null && meta.peers !== undefined) {
    details.push(`👤 ${meta.peers}`);
  }

  if (meta.sizeText) {
    details.push(`💾 ${meta.sizeText}`);
  }

  return details.join(' ');
}

function sanitizeDisplayText(value) {
  return String(value || '')
    .split(/\r?\n/)
    .map((line) => line
      .replace(/\s*🔗\s*[^\n]+/g, '')
      .replace(/\s*📡\s*[^\n]+/g, '')
      .replace(/\s*⚙️\s*(?:BaixaFilmesTorrentHD|Torrentio|Bitmagnet|Uindex|Moviebox|Cinestream|Vidlink|Vixsrc|Castle|Hdhub4u|4khdhub|EZTV)\b.*$/i, '')
      .replace(/\s+-\s*(?:YIFY|YTS|RARBG|EZTV|TGx|GalaxyTV)\s*$/i, ' -')
      .trimEnd())
    .filter((line) => line.trim() && !/upgrade to premium/i.test(line))
    .join('\n')
    .trim();
}

function compareStreams(left, right) {
  return right.seeders - left.seeders ||
    right.peers - left.peers ||
    right.quality - left.quality ||
    right.size - left.size ||
    left.leechers - right.leechers ||
    stableKey(left.stream).localeCompare(stableKey(right.stream));
}

function forceTopFromEachSource(items) {
  const groups = new Map();

  for (const item of items) {
    const group = groups.get(item.sourceIndex) || [];
    group.push(item);
    groups.set(item.sourceIndex, group);
  }

  for (const group of groups.values()) {
    group.sort(compareStreams);
  }

  const pinned = [];
  const pinnedSet = new Set();

  for (let rank = 0; rank < FORCE_TOP_PER_SOURCE; rank += 1) {
    for (const sourceIndex of [...groups.keys()].sort((left, right) => left - right)) {
      const item = groups.get(sourceIndex)[rank];

      if (item) {
        pinned.push(item);
        pinnedSet.add(item);
      }
    }
  }

  const rest = items
    .filter((item) => !pinnedSet.has(item))
    .sort(compareStreams);

  return [...pinned, ...rest];
}

function stableKey(stream) {
  const infoHash = String(stream.infoHash || '').toLowerCase();
  const fileIdx = stream.fileIdx ?? '';

  if (infoHash) {
    return `${infoHash}:${fileIdx}`;
  }

  const urlHash = extractInfoHash(stream.url || stream.externalUrl || '');

  if (urlHash) {
    return `${urlHash}:${fileIdx}`;
  }

  return [
    stream.url,
    stream.externalUrl,
    stream.ytId,
    stream.name,
    stream.title
  ].filter(Boolean).join('|').toLowerCase();
}

function buildStreamUrl(manifestUrl, type, id) {
  const target = new URL(manifestUrl);
  const safeType = encodeURIComponent(type);
  const safeId = encodeURIComponent(id).replace(/%3A/gi, ':');

  target.pathname = target.pathname.replace(/manifest\.json$/i, `stream/${safeType}/${safeId}.json`);
  target.search = '';
  return target.toString();
}

function extractSwarm(stream, text) {
  const pairedFields = [
    stream.seeders,
    stream.seeds,
    stream.peers,
    stream.peer,
    stream.behaviorHints && stream.behaviorHints.seeders,
    stream.behaviorHints && stream.behaviorHints.seeds,
    stream.behaviorHints && stream.behaviorHints.peers
  ].map(parseSwarmPair).find(Boolean);

  const seeders = firstNumber([
    stream.seeders,
    stream.seeds,
    stream.behaviorHints && stream.behaviorHints.seeders,
    stream.behaviorHints && stream.behaviorHints.seeds
  ]);

  const peers = firstNumber([
    stream.peers,
    stream.peer,
    stream.behaviorHints && stream.behaviorHints.peers
  ]);

  const leechers = firstNumber([
    stream.leechers,
    stream.leeches,
    stream.leech,
    stream.behaviorHints && stream.behaviorHints.leechers,
    stream.behaviorHints && stream.behaviorHints.leeches,
    stream.behaviorHints && stream.behaviorHints.leech
  ]);

  const textSwarm = extractSwarmFromText(text);

  return {
    seeders: seeders ?? pairedFields?.seeders ?? textSwarm.seeders,
    peers: peers ?? textSwarm.peers,
    leechers: leechers ?? pairedFields?.leechers ?? textSwarm.leechers
  };
}

function parseSwarmPair(value) {
  if (value === null || value === undefined) {
    return null;
  }

  const match = String(value).match(/^\s*([0-9][0-9.,]*\s*[kKmM]?)\s*(?::|\/|\|)\s*([0-9][0-9.,]*\s*[kKmM]?)\s*$/);

  if (!match) {
    return null;
  }

  return {
    seeders: parseHumanNumber(match[1]),
    leechers: parseHumanNumber(match[2])
  };
}

function extractSwarmFromText(text) {
  const value = String(text || '');
  const pairedPatterns = [
    /(?:\uD83D\uDC64|\uD83D\uDC65)\s*([0-9][0-9.,]*\s*[kKmM]?)\s*:\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
    /\bS(?:eeders?|eeds?)?\s*[:=-]\s*([0-9][0-9.,]*\s*[kKmM]?)\s*(?:\||\/|,|\s+)\s*L(?:eechers?|eeches?)?\s*[:=-]\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
    /\b(?:seeders?|seeds?)\s*\/\s*(?:leechers?|leeches?)\s*[:=-]?\s*([0-9][0-9.,]*\s*[kKmM]?)\s*(?:\/|:)\s*([0-9][0-9.,]*\s*[kKmM]?)/i
  ];

  for (const pattern of pairedPatterns) {
    const match = value.match(pattern);

    if (match) {
      return {
        seeders: parseHumanNumber(match[1]),
        leechers: parseHumanNumber(match[2])
      };
    }
  }

  return {
    seeders: firstTextNumber(value, [
      /(?:\uD83D\uDC64|\uD83D\uDC65)\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
      /\b(?:seeders?|seeds?)\b\s*[:=-]?\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
      /([0-9][0-9.,]*\s*[kKmM]?)\s*\b(?:seeders?|seeds?)\b/i,
      /\bS(?:eed)?\s*[:=-]\s*([0-9][0-9.,]*\s*[kKmM]?)/i
    ]),
    peers: firstTextNumber(value, [
      /\b(?:peers?)\b\s*[:=-]?\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
      /([0-9][0-9.,]*\s*[kKmM]?)\s*\b(?:peers?)\b/i,
      /\bP(?:eer)?\s*[:=-]\s*([0-9][0-9.,]*\s*[kKmM]?)/i
    ]),
    leechers: firstTextNumber(value, [
      /\b(?:leechers?|leeches?)\b\s*[:=-]?\s*([0-9][0-9.,]*\s*[kKmM]?)/i,
      /([0-9][0-9.,]*\s*[kKmM]?)\s*\b(?:leechers?|leeches?)\b/i,
      /\bL(?:eech)?\s*[:=-]\s*([0-9][0-9.,]*\s*[kKmM]?)/i
    ])
  };
}

function firstNumber(values) {
  for (const value of values) {
    const number = parseHumanNumber(value);

    if (number !== null) {
      return number;
    }
  }

  return null;
}

function firstTextNumber(text, patterns) {
  for (const pattern of patterns) {
    const match = text.match(pattern);
    const number = match ? parseHumanNumber(match[1]) : null;

    if (number !== null) {
      return number;
    }
  }

  return null;
}

function formatSwarm(meta, stream) {
  const hasSeeders = meta.seeders !== null && meta.seeders !== undefined;
  const hasPeers = meta.peers !== null && meta.peers !== undefined;
  const hasLeechers = meta.leechers !== null && meta.leechers !== undefined;

  if (!hasSeeders && !hasPeers && !hasLeechers && !isTorrentStream(stream)) {
    return 'Direct';
  }

  const parts = [];

  if (hasSeeders) {
    parts.push(`S: ${meta.seeders}`);
  }

  if (hasPeers) {
    parts.push(`P: ${meta.peers}`);
  }

  if (hasLeechers) {
    parts.push(`L: ${meta.leechers}`);
  }

  return parts.length ? parts.join(' | ') : 'Swarm n/a';
}

function isTorrentStream(stream) {
  if (stream.infoHash || extractInfoHash(stream.url || stream.externalUrl || stream.magnet || '')) {
    return true;
  }

  if (typeof stream.magnet === 'string' && stream.magnet.startsWith('magnet:')) {
    return true;
  }

  return Array.isArray(stream.sources) && stream.sources.some((source) => (
    typeof source === 'string' && /^(tracker:|dht:)/i.test(source)
  ));
}

function attachDefaultTrackers(stream) {
  const infoHash = String(stream.infoHash || extractInfoHash(stream.url || stream.externalUrl || '')).toLowerCase();

  if (!infoHash) {
    return;
  }

  const existingSources = Array.isArray(stream.sources) ? stream.sources : [];
  const extraSources = DEFAULT_TRACKERS.map((tracker) => `tracker:${tracker}`);
  const dhtSource = `dht:${infoHash}`;
  const seen = new Set(existingSources);

  for (const source of [...extraSources, dhtSource]) {
    if (!seen.has(source)) {
      existingSources.push(source);
      seen.add(source);
    }
  }

  stream.sources = existingSources;
}

function extractQuality(text) {
  const normalized = String(text || '').toLowerCase();

  if (/\b(?:2160p|4k|uhd)\b/.test(normalized)) return 2160;
  if (/\b1440p\b/.test(normalized)) return 1440;
  if (/\b1080p\b/.test(normalized)) return 1080;
  if (/\b720p\b/.test(normalized)) return 720;
  if (/\b576p\b/.test(normalized)) return 576;
  if (/\b480p\b/.test(normalized)) return 480;
  if (/\b360p\b/.test(normalized)) return 360;
  if (/\b(?:cam|ts|tc)\b/.test(normalized)) return 240;

  return 0;
}

function qualityLabel(quality) {
  if (quality >= 2160) return '4K';
  if (quality >= 1440) return '1440p';
  if (quality >= 1080) return '1080p';
  if (quality >= 720) return '720p';
  if (quality >= 576) return '576p';
  if (quality >= 480) return '480p';
  if (quality >= 360) return '360p';
  if (quality > 0) return 'SD';

  return 'Auto';
}

function extractCodec(text) {
  const normalized = String(text || '').toLowerCase();

  if (/\b(?:x265|h\.?265|hevc)\b/.test(normalized)) return 'HEVC';
  if (/\b(?:x264|h\.?264|avc)\b/.test(normalized)) return 'H.264';
  if (/\bav1\b/.test(normalized)) return 'AV1';

  return '';
}

function extractAudio(text) {
  const normalized = String(text || '').toLowerCase();

  if (/\batmos\b/.test(normalized)) return 'Atmos';
  if (/\btruehd\b/.test(normalized)) return 'TrueHD';
  if (/\bdts\b/.test(normalized)) return 'DTS';
  if (/\bddp?\s*5\.1\b|\beac-?3\b/.test(normalized)) return 'DD+ 5.1';
  if (/\baac\b/.test(normalized)) return 'AAC';

  return '';
}

function extractSizeBytes(text) {
  const match = String(text || '').match(/([0-9]+(?:[.,][0-9]+)?)\s*(tb|gb|mb)\b/i);

  if (!match) {
    return null;
  }

  const value = Number(match[1].replace(',', '.'));
  const unit = match[2].toLowerCase();
  const multiplier = unit === 'tb' ? 1024 ** 4 : unit === 'gb' ? 1024 ** 3 : 1024 ** 2;

  return Math.round(value * multiplier);
}

function extractSizeText(text) {
  const match = String(text || '').match(/([0-9]+(?:[.,][0-9]+)?\s*(?:tb|gb|mb))\b/i);
  return match ? match[1].replace(',', '.') : '';
}

function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return '';
  }

  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let size = bytes;
  let unitIndex = 0;

  while (size >= 1024 && unitIndex < units.length - 1) {
    size /= 1024;
    unitIndex += 1;
  }

  return `${size.toFixed(size >= 10 || unitIndex === 0 ? 0 : 1)} ${units[unitIndex]}`;
}

function parseHumanNumber(value) {
  if (value === null || value === undefined || value === '') {
    return null;
  }

  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.max(0, Math.round(value));
  }

  const match = String(value).trim().match(/^([0-9]+(?:[.,][0-9]+)?)\s*([kKmM])?$/);

  if (!match) {
    return null;
  }

  const base = Number(match[1].replace(',', '.'));
  const suffix = (match[2] || '').toLowerCase();
  const multiplier = suffix === 'm' ? 1_000_000 : suffix === 'k' ? 1_000 : 1;

  return Math.max(0, Math.round(base * multiplier));
}

function pickNumber(...values) {
  for (const value of values) {
    const number = parseHumanNumber(value);
    if (number !== null) {
      return number;
    }
  }

  return null;
}

function extractInfoHash(value) {
  const match = String(value || '').match(/(?:btih:|xt=urn:btih:)([a-f0-9]{40}|[a-z2-7]{32})/i);
  return match ? match[1].toLowerCase() : '';
}

function sendJson(res, statusCode, body) {
  res.writeHead(statusCode, {
    'access-control-allow-origin': '*',
    'access-control-allow-headers': '*',
    'access-control-allow-methods': 'GET, OPTIONS',
    'content-type': 'application/json; charset=utf-8'
  });

  if (statusCode === 204) {
    return res.end();
  }

  return res.end(JSON.stringify(body));
}

function unpack(token) {
  return Buffer.from(reverse(token), 'base64').toString('utf8');
}

function reverse(value) {
  return String(value).split('').reverse().join('');
}

function normalizePublicUrl(value) {
  if (!value) {
    return '';
  }

  return String(value).replace(/\/+$/, '');
}

function getBaseUrl(req) {
  if (PUBLIC_URL) {
    return PUBLIC_URL;
  }

  const forwardedProto = String(req.headers['x-forwarded-proto'] || '').split(',')[0].trim();
  const forwardedHost = String(req.headers['x-forwarded-host'] || '').split(',')[0].trim();
  const host = forwardedHost || req.headers.host || `localhost:${PORT}`;
  const protocol = forwardedProto || (String(host).endsWith('.onrender.com') ? 'https' : 'http');

  return normalizePublicUrl(`${protocol}://${host}`);
}

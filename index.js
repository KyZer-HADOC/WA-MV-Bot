import 'dotenv/config';
import axios from 'axios';
import qrcode from 'qrcode-terminal';
import pino from 'pino';

// Quiet only the repetitive Baileys/libsignal Bad MAC stack spam so the bot's
// own diagnostic logs remain readable. This does not repair failed decryption.
function consoleArgsToText(args) {
  return args.map((value) => {
    if (value instanceof Error) return value.stack || value.message;
    if (typeof value === 'string') return value;
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }).join(' ');
}

for (const method of ['error', 'warn', 'log']) {
  const original = console[method].bind(console);
  console[method] = (...args) => {
    const output = consoleArgsToText(args);
    const isRepeatedBadMacNoise =
      /Failed to decrypt message with any known session/i.test(output) ||
      /Session error:\s*Error:\s*Bad MAC/i.test(output) ||
      (/Error:\s*Bad MAC/i.test(output) &&
        /libsignal[\\/]src[\\/](?:crypto|session_cipher)\.js/i.test(output));
    if (isRepeatedBadMacNoise) return;
    original(...args);
  };
}
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth_info');
const REQUEST_GROUP_JID = (process.env.REQUEST_GROUP_JID || '').trim();
const MOVIE_GROUP_JID = (process.env.MOVIE_GROUP_JID || '').trim();
const MOVIEBOX_API_URL = (process.env.MOVIEBOX_API_URL || '').trim().replace(/\/+$/, '');
const MOVIEBOX_SECRET = (process.env.MOVIEBOX_SECRET || '').trim();
const movieBoxEnabled = Boolean(MOVIEBOX_API_URL && MOVIEBOX_SECRET);
const CHAMA_CINESUBZ_API_KEY = (process.env.CHAMA_CINESUBZ_API_KEY || '').trim();
const CHAMA_CINESUBZ_BASE_URL = 'https://api.chamindu.site/api/v1/movies/cinesubz';
const chamaCineSubzEnabled = Boolean(CHAMA_CINESUBZ_API_KEY);
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

logger.info({
  movieBoxApiUrl: JSON.stringify(MOVIEBOX_API_URL),
  hasMovieBoxSecret: Boolean(MOVIEBOX_SECRET),
  chamaCineSubzConfigured: chamaCineSubzEnabled,
  requestGroupConfigured: Boolean(REQUEST_GROUP_JID),
  movieGroupConfigured: Boolean(MOVIE_GROUP_JID)
}, 'Startup configuration check');

const pendingSearches = new Map();
const activeSearchChats = new Set();
const loggedGroupJids = new Set();
const MAX_RESULTS = 8;
const SEARCH_TTL_MS = 10 * 60 * 1000;
// Temporary circuit breaker: avoid repeatedly calling an upstream API that returned 429.
let movieBoxUnavailableUntil = 0;

let mediaMap = {};
try {
  mediaMap = JSON.parse(process.env.AUTHORIZED_MEDIA_MAP || '{}');
  if (!mediaMap || typeof mediaMap !== 'object' || Array.isArray(mediaMap)) mediaMap = {};
} catch {
  logger.warn('AUTHORIZED_MEDIA_MAP is invalid JSON; authorized media delivery is disabled.');
  mediaMap = {};
}

function unwrapMessage(message) {
  let current = message || {};
  for (let i = 0; i < 3; i += 1) {
    if (current.ephemeralMessage?.message) current = current.ephemeralMessage.message;
    else if (current.viewOnceMessage?.message) current = current.viewOnceMessage.message;
    else if (current.documentWithCaptionMessage?.message) current = current.documentWithCaptionMessage.message;
    else break;
  }
  return current;
}

function textFromMessage(message) {
  const m = unwrapMessage(message);
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function contextFromMessage(message) {
  const m = unwrapMessage(message);
  return (
    m.extendedTextMessage?.contextInfo ||
    m.imageMessage?.contextInfo ||
    m.videoMessage?.contextInfo ||
    m.documentMessage?.contextInfo ||
    null
  );
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function normalizeTitle(value) {
  return String(value || '')
    .toLocaleLowerCase()
    .normalize('NFKC')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
}

function safeText(value, fallback = 'Not listed') {
  const cleaned = String(value || '').replace(/\s+/g, ' ').trim();
  return cleaned || fallback;
}

function absoluteHttpUrl(value, baseUrl = MOVIEBOX_API_URL) {
  if (!value) return '';
  try {
    const url = new URL(value, baseUrl);
    return ['http:', 'https:'].includes(url.protocol) ? url.href : '';
  } catch {
    return '';
  }
}

async function searchMovieBox(query) {
  let endpoint;
  try {
    endpoint = new URL(MOVIEBOX_API_URL);
  } catch {
    throw new Error('MOVIEBOX_API_URL is not a valid URL.');
  }
  if (endpoint.protocol !== 'https:') {
    throw new Error('MOVIEBOX_API_URL must use HTTPS.');
  }

  const response = await axios.post(
    MOVIEBOX_API_URL + '/search',
    { keyword: query, page: 1, perPage: MAX_RESULTS },
    {
      headers: {
        'X-Worker-Secret': MOVIEBOX_SECRET,
        'Content-Type': 'application/json',
        'Accept': 'application/json'
      },
      // The Worker may need several upstream host attempts before it can return a result.
      timeout: 90000,
      maxContentLength: 2 * 1024 * 1024
    }
  );

  const items = Array.isArray(response.data?.items) ? response.data.items : [];
  logger.info({
    httpStatus: response.status,
    responseKeys: response.data && typeof response.data === 'object' ? Object.keys(response.data) : [],
    rawItemCount: items.length,
    apiDebug: response.data?.debug ?? null,
    apiError: response.data?.error ?? null,
    totalCount: response.data?.pager?.totalCount ?? null
  }, 'MovieBox API response received');
  return items.slice(0, MAX_RESULTS).map(item => ({
    provider: item.provider === 'wikipedia' ? 'wikipedia' : 'moviebox',
    subjectId: String(item.subjectId || ''),
    subjectType: item.subjectType,
    title: safeText(item.title, ''),
    poster: absoluteHttpUrl(item.poster, MOVIEBOX_API_URL),
    language: safeText(item.language, ''),
    duration: safeText(item.duration, ''),
    releaseDate: safeText(item.releaseDate, ''),
    rating: item.rating == null ? '' : String(item.rating),
    genre: safeText(item.genre, ''),
    country: safeText(item.country, ''),
    type: safeText(item.type, '')
  })).filter(item => item.title && item.subjectId);
}


async function searchCineSubz(query) {
  const response = await axios.get(CHAMA_CINESUBZ_BASE_URL + '/search', {
    params: { q: query, api_key: CHAMA_CINESUBZ_API_KEY },
    headers: { Accept: 'application/json' },
    timeout: 45000,
    maxContentLength: 2 * 1024 * 1024
  });

  if (response.data?.status === false) {
    throw new Error('Chama CineSubz search returned status=false.');
  }

  const items = Array.isArray(response.data?.data) ? response.data.data : [];
  logger.info({
    httpStatus: response.status,
    rawItemCount: items.length
  }, 'Chama CineSubz search response received');

  return items.slice(0, MAX_RESULTS).map(item => {
    const title = safeText(item.title, '');
    const pageUrl = absoluteHttpUrl(item.link, 'https://cinesubz.net');
    const year = title.match(/\b(?:18|19|20|21)\d{2}\b/)?.[0] || '';

    return {
      provider: 'cinesubz',
      subjectId: pageUrl,
      subjectType: safeText(item.type, ''),
      title,
      movieUrl: pageUrl,
      poster: absoluteHttpUrl(item.image, 'https://cinesubz.net'),
      language: '',
      duration: '',
      releaseDate: year,
      rating: item.rating && item.rating !== 'N/A' ? String(item.rating) : '',
      genre: '',
      country: '',
      type: safeText(item.type, ''),
      quality: item.quality && item.quality !== 'N/A' ? String(item.quality) : ''
    };
  }).filter(item => item.title && item.subjectId);
}

async function searchWikipedia(query) {
  // Wikipedia's public MediaWiki REST API does not require an API key.
  const response = await axios.get('https://en.wikipedia.org/w/rest.php/v1/search/page', {
    params: { q: query, limit: MAX_RESULTS },
    headers: {
      'Accept': 'application/json',
      'User-Agent': 'WA-MV-Bot/1.0 (movie title metadata search)'
    },
    timeout: 20000,
    maxContentLength: 2 * 1024 * 1024
  });

  const pages = Array.isArray(response.data?.pages) ? response.data.pages : [];
  const likelyMoviePages = pages.filter(page => {
    const text = [page.title || '', page.description || '', page.excerpt || ''].join(' ');
    return /\\b(film|movie|motion picture|television film)\\b/i.test(text);
  });
  const selectedPages = (likelyMoviePages.length ? likelyMoviePages : pages).slice(0, MAX_RESULTS);

  logger.info({
    httpStatus: response.status,
    resultCount: selectedPages.length,
    totalResultsReturned: pages.length
  }, 'Wikipedia metadata search completed');

  return selectedPages.map(page => {
    const pageText = [page.description || '', page.excerpt || ''].join(' ');
    const year = pageText.match(/\\b(18|19|20)\\d{2}\\b/)?.[0] || '';
    const title = safeText(page.title, '');

    return {
      provider: 'wikipedia',
      subjectId: String(page.id || page.key || title),
      subjectType: 1,
      title,
      poster: absoluteHttpUrl(page.thumbnail?.url || '', 'https://en.wikipedia.org'),
      language: '',
      duration: '',
      releaseDate: year,
      rating: '',
      genre: '',
      country: '',
      type: 'movie',
      sourceUrl: page.key
        ? 'https://en.wikipedia.org/wiki/' + encodeURIComponent(page.key).replace(/%2F/gi, '/')
        : ''
    };
  }).filter(item => item.title && item.subjectId);
}

async function useWikipediaFallback(query, originalError = null) {
  try {
    const results = await searchWikipedia(query);
    if (results.length) {
      logger.warn({ query }, 'Using Wikipedia metadata because MovieBox search is unavailable.');
    }
    return results;
  } catch (fallbackError) {
    logger.error({
      query,
      wikipediaError: fallbackError?.message || String(fallbackError),
      movieBoxError: originalError?.message || null
    }, 'Both MovieBox and Wikipedia metadata search failed.');
    throw fallbackError;
  }
}

async function searchMovieBoxOrFallback(query) {
  if (!movieBoxEnabled) {
    return useWikipediaFallback(query, new Error('MovieBox API is not configured.'));
  }

  if (Date.now() < movieBoxUnavailableUntil) {
    const remainingSeconds = Math.ceil((movieBoxUnavailableUntil - Date.now()) / 1000);
    logger.warn({ remainingSeconds }, 'MovieBox is temporarily rate-limited; trying Wikipedia metadata search.');
    return useWikipediaFallback(query, new Error('MovieBox is temporarily rate-limited.'));
  }

  try {
    const results = await searchMovieBox(query);
    if (results.length) return results;
    logger.info({ query }, 'MovieBox returned no matching titles; trying Wikipedia.');
    return useWikipediaFallback(query, new Error('MovieBox returned no matching titles.'));
  } catch (error) {
    const status = Number(error?.response?.status || 0);
    const upstreamRetryAfter = Number(error?.response?.data?.retryAfterSeconds || 0);
    let cooldownSeconds = 0;

    if (status === 429) {
      cooldownSeconds = Math.max(60, Math.min(3600, upstreamRetryAfter || 300));
    } else if ([502, 503, 504].includes(status)) {
      cooldownSeconds = 60;
    } else if (!status) {
      cooldownSeconds = 30;
    }

    if (cooldownSeconds > 0) {
      movieBoxUnavailableUntil = Date.now() + cooldownSeconds * 1000;
    }

    logger.warn({
      query,
      httpStatus: status || null,
      cooldownSeconds,
      apiError: error?.response?.data?.error || null
    }, 'MovieBox search failed; trying Wikipedia metadata search.');

    return useWikipediaFallback(query, error);
  }
}


async function searchMovies(query) {
  if (chamaCineSubzEnabled) {
    try {
      const results = await searchCineSubz(query);
      if (results.length) return results;
      logger.info({ query }, 'Chama CineSubz returned no matches; trying configured fallbacks.');
    } catch (error) {
      logger.warn({
        httpStatus: error?.response?.status || null,
        apiStatus: error?.response?.data?.status ?? null
      }, 'Chama CineSubz search failed; trying configured fallbacks.');
    }
  }

  return searchMovieBoxOrFallback(query);
}

async function getMovieMetadata(movie) {
  if (movie.provider === 'cinesubz' && CHAMA_CINESUBZ_API_KEY) {
    try {
      const response = await axios.get(CHAMA_CINESUBZ_BASE_URL + '/infodl', {
        params: {
          q: movie.movieUrl || movie.subjectId,
          api_key: CHAMA_CINESUBZ_API_KEY
        },
        headers: { Accept: 'application/json' },
        timeout: 60000,
        maxContentLength: 3 * 1024 * 1024
      });

      const data = response.data?.data;
      if (response.data?.status !== true || !data || typeof data !== 'object') {
        throw new Error('Chama CineSubz info response did not contain movie details.');
      }

      const genres = Array.isArray(data.genres)
        ? data.genres.filter(value => value && !/^#|^webupdated$/i.test(String(value)))
        : (typeof data.genres === 'string' ? data.genres.split(/\s*,\s*/).filter(Boolean) : []);
      const cast = Array.isArray(data.cast)
        ? data.cast.map(person => safeText(person?.name, '')).filter(Boolean)
        : [];
      const starValue = data.stars && data.stars !== 'N/A'
        ? String(data.stars).split(/\s*,\s*/).filter(Boolean)
        : cast;
      const directorValue = data.directors || data.director || '';
      const directors = Array.isArray(directorValue)
        ? directorValue.map(value => safeText(value, '')).filter(Boolean)
        : String(directorValue).split(/\s*,\s*/).map(value => value.trim()).filter(Boolean);

      return {
        title: safeText(data.title, movie.title),
        language: safeText(data.language),
        duration: safeText(data.duration),
        imdb: safeText(data.imdb || data.rating),
        genres,
        directors,
        stars: starValue,
        thumbnail: absoluteHttpUrl(data.image || data.thumbnail || movie.poster, 'https://cinesubz.net'),
        sourceUrl: absoluteHttpUrl(data.url || movie.movieUrl, 'https://cinesubz.net'),
        story: safeText(data.story, '')
      };
    } catch (error) {
      logger.warn({
        httpStatus: error?.response?.status || null,
        apiStatus: error?.response?.data?.status ?? null
      }, 'Chama CineSubz info lookup failed; using search-result metadata.');
    }
  }

  return {
    title: safeText(movie.title),
    language: safeText(movie.language),
    duration: safeText(movie.duration),
    imdb: safeText(movie.rating),
    genres: movie.genre ? movie.genre.split(/\s*,\s*/).filter(Boolean) : [],
    directors: [],
    stars: [],
    thumbnail: movie.poster || '',
    sourceUrl: movie.movieUrl || '',
    story: ''
  };
}

function makeResultsText(query, movies) {
  const providerTitle = movies[0]?.provider === 'wikipedia'
    ? 'WIKIPEDIA MOVIE SEARCH'
    : movies[0]?.provider === 'cinesubz'
      ? 'CINESUBZ SEARCH'
      : 'MOVIEBOX SEARCH';
  const lines = [
    '🎬 *' + providerTitle + '*',
    '',
    '🔎 Search: ' + query,
    ''
  ];

  movies.forEach((movie, index) => {
    lines.push('*' + (index + 1) + '.* ' + movie.title);
    if (movie.language) lines.push('   🌐 Language: ' + movie.language);
    if (movie.quality) lines.push('   🎞️ Quality: ' + movie.quality);
    if (movie.format) lines.push('   📦 Format: ' + movie.format);
    if (movie.releaseDate) lines.push('   📅 Year: ' + (movie.releaseDate.match(/\d{4}/)?.[0] || movie.releaseDate));
    if (movie.rating) lines.push('   ⭐ Rating: ' + movie.rating);
  });

  lines.push('', '↩️ *Reply to THIS bot message with a number* (example: 2).');
  lines.push('⏳ This list expires in 10 minutes.');
  return lines.join('\n');
}

function formatDetails(movie, metadata) {
  const lines = [
    '🎬 *' + metadata.title + '*',
    '',
    '🌐 *Language:* ' + metadata.language,
    '⏱️ *Duration:* ' + metadata.duration,
    '⭐ *' + (movie.provider === 'wikipedia' ? 'Wikipedia Rating' : 'Rating') + ':* ' + metadata.imdb,
    '🎭 *Genres:* ' + (metadata.genres.length ? metadata.genres.join(', ') : 'Not listed'),
    '🎥 *Director(s):* ' + (metadata.directors.length ? metadata.directors.join(', ') : 'Not listed'),
    '🌟 *Cast:* ' + (metadata.stars.length ? metadata.stars.slice(0, 8).join(', ') : 'Not listed'),
    '',
    '🔎 Source: ' + (
      movie.provider === 'wikipedia'
        ? 'Wikipedia metadata (no API key required).'
        : movie.provider === 'cinesubz'
          ? 'CineSubz via Chama API.'
          : 'MovieBox API metadata.'
    )
  ];
  if (movie.provider === 'cinesubz' && (metadata.sourceUrl || movie.movieUrl)) {
    lines.splice(lines.length - 1, 0, '🔗 *Source page:* ' + (metadata.sourceUrl || movie.movieUrl));
  }
  if (metadata.story && metadata.story !== 'Not listed') {
    const story = metadata.story.slice(0, 600);
    lines.splice(lines.length - 1, 0, '', '📝 *Story:* ' + story + (metadata.story.length > 600 ? '…' : ''));
  }
  if (movie.quality) lines.splice(2, 0, '🎞️ *Listed quality:* ' + movie.quality);
  if (movie.format) lines.splice(3, 0, '📦 *Listed format:* ' + movie.format);
  return lines.join('\n');
}

function findAuthorizedMedia(movie) {
  const configured = mediaMap[movie.movieUrl] || mediaMap[normalizeTitle(movie.title)];
  if (typeof configured === 'string') return configured;
  if (configured && typeof configured.url === 'string') return configured.url;
  return null;
}

async function sendAuthorizedMedia(sock, movie, metadata) {
  const mediaUrl = findAuthorizedMedia(movie);
  if (!mediaUrl || !/^https:\/\//i.test(mediaUrl)) return false;

  const filename = (metadata.title + '.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  await sock.sendMessage(MOVIE_GROUP_JID, {
    document: { url: mediaUrl },
    mimetype: 'video/mp4',
    fileName: filename,
    caption: '📁 Authorized media file: ' + metadata.title
  });
  return true;
}

async function handleSelection(sock, message, text, contextInfo) {
  const quotedId = contextInfo?.stanzaId;
  if (!quotedId) return false;

  const search = pendingSearches.get(quotedId);
  if (!search) return false;

  if (Date.now() > search.expiresAt) {
    pendingSearches.delete(quotedId);
    await sock.sendMessage(message.key.remoteJid, {
      text: '⌛ This list expired. Send the movie title again to search.'
    }, { quoted: message });
    return true;
  }

  if (search.requesterJid && (message.key.participant || message.key.remoteJid) !== search.requesterJid) {
    await sock.sendMessage(message.key.remoteJid, {
      text: 'ℹ️ Only the person who requested this search can choose a result. Send the movie title yourself to make a new list.'
    }, { quoted: message });
    return true;
  }

  if (!/^\d{1,2}$/.test(text)) return false;
  const index = Number(text) - 1;

  if (index < 0 || index >= search.movies.length) {
    await sock.sendMessage(message.key.remoteJid, {
      text: '⚠️ Reply to the list with a number from 1 to ' + search.movies.length + '.'
    }, { quoted: message });
    return true;
  }

  const movie = search.movies[index];
  pendingSearches.delete(quotedId);

  await sock.sendMessage(message.key.remoteJid, {
    text: '🔎 Getting details for *' + movie.title + '*...'
  }, { quoted: message });

  const metadata = await getMovieMetadata(movie);
  const details = formatDetails(movie, metadata);
  let sentImage = false;

  if (metadata.thumbnail) {
    try {
      await sock.sendMessage(MOVIE_GROUP_JID, {
        image: { url: metadata.thumbnail },
        caption: details
      });
      sentImage = true;
    } catch (error) {
      logger.warn({ err: error.message }, 'Could not send poster image; sending details as text.');
    }
  }

  if (!sentImage) await sock.sendMessage(MOVIE_GROUP_JID, { text: details });

  let mediaSent = false;
  try {
    mediaSent = await sendAuthorizedMedia(sock, movie, metadata);
  } catch (error) {
    logger.error({ err: error.message }, 'Authorized media delivery failed.');
  }

  await sock.sendMessage(message.key.remoteJid, {
    text: mediaSent
      ? '✅ *' + metadata.title + '* details and poster sent to the Movie Group. The configured authorized media file was sent too.'
      : '✅ *' + metadata.title + '* details and poster sent to the Movie Group. No authorized media file is configured for this title.'
  }, { quoted: message });

  return true;
}

async function start() {
  if (!REQUEST_GROUP_JID || !MOVIE_GROUP_JID) {
    logger.warn('Set REQUEST_GROUP_JID and MOVIE_GROUP_JID in the hosting environment. The bot will log observed group JIDs but will not process requests until both are configured.');
  }
  if (REQUEST_GROUP_JID && !isGroupJid(REQUEST_GROUP_JID)) logger.warn('REQUEST_GROUP_JID should end with @g.us');
  if (MOVIE_GROUP_JID && !isGroupJid(MOVIE_GROUP_JID)) logger.warn('MOVIE_GROUP_JID should end with @g.us');

  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    logger.warn('Could not fetch the latest WhatsApp Web version; using library defaults.');
  }

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: ['WA-MV-Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      logger.info('Scan this QR code with WhatsApp > Linked devices > Link a device.');
      qrcode.generate(qr, { small: true });
    }
    if (connection === 'open') logger.info('WhatsApp connected.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed.');
      if (shouldReconnect) {
        setTimeout(() => start().catch(error => logger.error({ err: error }, 'Reconnect failed.')), 4000);
      } else {
        logger.error('WhatsApp logged out. Remove auth_info and pair again. Do not share the auth_info folder.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({ eventType: type, count: messages?.length || 0 }, 'WhatsApp message event received');
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        const jid = message.key?.remoteJid;
        if (!jid || !isGroupJid(jid)) continue;

        logger.info({
          jid,
          fromMe: Boolean(message.key.fromMe),
          hasMessage: Boolean(message.message)
        }, 'GROUP MESSAGE RECEIVED');

        if (message.key.fromMe) continue;

        if (!REQUEST_GROUP_JID || !MOVIE_GROUP_JID) {
          if (!loggedGroupJids.has(jid)) {
            loggedGroupJids.add(jid);
            logger.warn({ groupJid: jid }, 'Observed WhatsApp group JID; configure both group JIDs to enable movie requests.');
          }
          continue;
        }

        if (jid !== REQUEST_GROUP_JID) {
          logger.info({ jid, expectedRequestGroupJid: REQUEST_GROUP_JID }, 'Ignoring non-request group');
          continue;
        }

        const content = unwrapMessage(message.message);
        const text = textFromMessage(content);
        if (!text) continue;

        const contextInfo = contextFromMessage(content);
        const wasSelection = await handleSelection(sock, message, text, contextInfo);
        if (wasSelection) continue;

        if (/^\d{1,2}$/.test(text)) continue;
        if (text.length < 2 || text.length > 100) continue;

        if (activeSearchChats.has(jid)) {
          await sock.sendMessage(jid, {
            text: '⏳ I am already searching a title in this group. Please wait a moment.'
          }, { quoted: message });
          continue;
        }

        activeSearchChats.add(jid);
        try {
          logger.info({
            query: text,
            provider: chamaCineSubzEnabled ? 'cinesubz' : (movieBoxEnabled ? 'moviebox' : 'wikipedia')
          }, 'Starting movie search');
          const movies = await searchMovies(text);
          logger.info({
            provider: movies[0]?.provider || 'none',
            resultCount: movies.length
          }, 'Movie search completed');
          if (!movies.length) {
            await sock.sendMessage(jid, {
              text: '😕 No matching titles were found for “' + text + '”. Try the English title or include the release year.'
            }, { quoted: message });
            continue;
          }

          const resultMessage = await sock.sendMessage(jid, {
            text: makeResultsText(text, movies)
          }, { quoted: message });

          pendingSearches.set(resultMessage.key.id, {
            movies,
            requesterJid: message.key.participant || message.key.remoteJid,
            expiresAt: Date.now() + SEARCH_TTL_MS
          });

          const timer = setTimeout(() => pendingSearches.delete(resultMessage.key.id), SEARCH_TTL_MS);
          timer.unref?.();
        } finally {
          activeSearchChats.delete(jid);
        }
      } catch (error) {
        logger.error({
          err: error?.message || String(error),
          httpStatus: error?.response?.status || null,
          apiError: typeof error?.response?.data === 'string'
            ? error.response.data.slice(0, 300)
            : (error?.response?.data || null)
        }, 'Could not process movie request.');
        await sock.sendMessage(message.key.remoteJid, {
          text: '⚠️ Movie search failed. Check the logs; MovieBox may be rate-limited and Wikipedia fallback failed or is temporarily unavailable.'
        }).catch(() => {});
      }
    }
  });
}

process.on('unhandledRejection', error => logger.error({ err: String(error) }, 'Unhandled rejection'));
start().catch(error => {
  logger.error({ err: error }, 'Fatal startup error');
  process.exitCode = 1;
});

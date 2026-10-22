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
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.resolve(process.env.BAILEYS_AUTH_DIR?.trim() || path.join(__dirname, 'auth_info'));
const CONFIG_PATH = path.join(__dirname, 'config.json');

let fileConfig = {};
try {
  const parsed = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    fileConfig = parsed;
  } else {
    console.warn('config.json must contain a JSON object; ignoring it.');
  }
} catch (error) {
  if (error?.code !== 'ENOENT') {
    console.warn('Could not read config.json; using environment variables only.');
  }
}

// Environment variables (including a .env file) take precedence over config.json.
function setting(name, fallback = '') {
  const value = Object.prototype.hasOwnProperty.call(process.env, name)
    ? process.env[name]
    : (fileConfig[name] ?? fallback);
  if (typeof value !== 'string') return value;
  const cleaned = value.trim();
  if (/^(YOUR_|PASTE_|PUT_YOUR_|CHANGE_ME|REPLACE_ME)/i.test(cleaned)) return '';
  return cleaned;
}

function configuredGroupJid(name) {
  const value = String(setting(name)).trim();
  if (!value) return '';
  if (!value.endsWith('@g.us')) {
    console.warn(name + ' is not a WhatsApp group JID ending with @g.us; treating it as unset.');
    return '';
  }
  return value;
}

const REQUEST_GROUP_JID = configuredGroupJid('REQUEST_GROUP_JID');
const MOVIE_GROUP_JID = configuredGroupJid('MOVIE_GROUP_JID');
const MOVIEBOX_API_URL = String(setting('MOVIEBOX_API_URL')).trim().replace(/\/+$/, '');
const MOVIEBOX_SECRET = String(setting('MOVIEBOX_SECRET')).trim();
const movieBoxEnabled = Boolean(MOVIEBOX_API_URL && MOVIEBOX_SECRET);
const CHAMA_CINESUBZ_API_KEY = String(setting('CHAMA_CINESUBZ_API_KEY')).trim();
const CHAMA_CINESUBZ_BASE_URL = 'https://api.chamindu.site/api/v1/movies/cinesubz';
const chamaCineSubzEnabled = Boolean(CHAMA_CINESUBZ_API_KEY);
const logger = pino({ level: setting('LOG_LEVEL', 'info') });

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
const handledMessageIds = new Map();
const MAX_RESULTS = 15;
const SEARCH_TTL_MS = 10 * 60 * 1000;
let movieBoxUnavailableUntil = 0;

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

async function searchMovies(query) {
  if (chamaCineSubzEnabled) {
    try {
      const results = await searchCineSubz(query);
      if (results.length) return results;
    } catch (error) {
      logger.warn('Chama CineSubz search failed.');
    }
  }
  return [];
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

      const downloadLinks = data.downloads || data.links || data.dl_links || data.download_links || [];

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
        story: safeText(data.story, ''),
        downloadLinks
      };
    } catch (error) {
      logger.warn('Chama CineSubz info lookup failed.');
    }
  }

  return {
    title: safeText(movie.title),
    language: safeText(movie.language),
    duration: safeText(movie.duration),
    imdb: safeText(movie.rating),
    genres: [],
    directors: [],
    stars: [],
    thumbnail: movie.poster || '',
    sourceUrl: movie.movieUrl || '',
    story: '',
    downloadLinks: []
  };
}

function makeResultsText(query, movies) {
  const lines = [
    '🎬 *CINESUBZ SEARCH*',
    '',
    '🔎 Search: ' + query,
    ''
  ];

  movies.forEach((movie, index) => {
    lines.push('*' + (index + 1) + '.* ' + movie.title);
    if (movie.quality) lines.push('   🎞️ Quality: ' + movie.quality);
    if (movie.releaseDate) lines.push('   📅 Year: ' + movie.releaseDate);
    if (movie.rating) lines.push('   ⭐ Rating: ' + movie.rating);
  });

  lines.push('', '↩️ *Reply to THIS bot message with a number* (example: 2).');
  return lines.join('\n');
}

function formatDetails(movie, metadata) {
  const lines = [
    '🎬 *' + metadata.title + '*',
    '',
    '🌐 *Language:* ' + metadata.language,
    '⏱️ *Duration:* ' + metadata.duration,
    '⭐ *Rating:* ' + metadata.imdb,
    '🎭 *Genres:* ' + (metadata.genres.length ? metadata.genres.join(', ') : 'Not listed'),
    '🎥 *Director(s):* ' + (metadata.directors.length ? metadata.directors.join(', ') : 'Not listed'),
    '🌟 *Cast:* ' + (metadata.stars.length ? metadata.stars.slice(0, 8).join(', ') : 'Not listed'),
    '',
    '🔎 Source: CineSubz via Chama API'
  ];
  if (metadata.story && metadata.story !== 'Not listed') {
    lines.splice(lines.length - 1, 0, '', '📝 *Story:* ' + metadata.story.slice(0, 600));
  }
  return lines.join('\n');
}

async function sendAutomaticCineSubzMedia(sock, metadata) {
  let videoUrl = '';
  const links = metadata.downloadLinks;

  if (Array.isArray(links) && links.length > 0) {
    const preferred = links.find(l => /720|1080|hd/i.test(JSON.stringify(l))) || links[0];
    videoUrl = typeof preferred === 'string' ? preferred : (preferred.link || preferred.url || '');
  } else if (links && typeof links === 'object') {
    videoUrl = links.url || links.link || Object.values(links)[0] || '';
  }

  if (videoUrl && /^https:\/\//i.test(videoUrl)) {
    const filename = (metadata.title + '.mp4').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
    await sock.sendMessage(MOVIE_GROUP_JID, {
      document: { url: videoUrl },
      mimetype: 'video/mp4',
      fileName: filename,
      caption: '🎬 *' + metadata.title + '*\n🎥 Direct Video file from CineSubz!'
    });
    return true;
  }
  return false;
}

async function handleSelection(sock, message, text, contextInfo) {
  const quotedId = contextInfo?.stanzaId;
  if (!quotedId) return false;

  const search = pendingSearches.get(quotedId);
  if (!search) return false;

  if (Date.now() > search.expiresAt) {
    pendingSearches.delete(quotedId);
    return true;
  }

  const senderJid = message.key.participant || message.key.remoteJid;
  if (search.requesterJid && search.requesterJid !== senderJid) {
    await sock.sendMessage(message.key.remoteJid, {
      text: '⚠️ Only the person who made this movie request can select a result.'
    }, { quoted: message });
    return true;
  }

  if (!/^\d{1,2}$/.test(text)) return false;
  const index = Number(text) - 1;
  if (index < 0 || index >= search.movies.length) return true;

  const movie = search.movies[index];
  pendingSearches.delete(quotedId);

  await sock.sendMessage(message.key.remoteJid, {
    text: '🔎 Getting details and video file for *' + movie.title + '*...'
  }, { quoted: message });

  const metadata = await getMovieMetadata(movie);
  const details = formatDetails(movie, metadata);
  const destinationJid = MOVIE_GROUP_JID || message.key.remoteJid;

  if (metadata.thumbnail) {
    try {
      await sock.sendMessage(destinationJid, {
        image: { url: metadata.thumbnail },
        caption: details
      });
    } catch {
      await sock.sendMessage(destinationJid, { text: details });
    }
  } else {
    await sock.sendMessage(destinationJid, { text: details });
  }

  let mediaSent = false;
  if (MOVIE_GROUP_JID) {
    try {
      mediaSent = await sendAutomaticCineSubzMedia(sock, metadata);
    } catch (error) {
      logger.error({ err: error.message }, 'Media delivery failed.');
    }
  }

  const detailsSentToAnotherChat = destinationJid !== message.key.remoteJid;
  let confirmation;
  if (detailsSentToAnotherChat) {
    confirmation = mediaSent
      ? '✅ *' + metadata.title + '* details, poster and video file sent to the Movie Group!'
      : '✅ *' + metadata.title + '* details and poster sent to the Movie Group.';
  } else {
    confirmation = '✅ *' + metadata.title + '* details and poster are shown in this chat.';
  }
  await sock.sendMessage(message.key.remoteJid, { text: confirmation }, { quoted: message });

  return true;
}

function getTimestampSeconds(message) {
  const raw = message?.messageTimestamp;
  if (raw == null) return NaN;
  const value = Number(typeof raw?.toNumber === 'function' ? raw.toNumber() : raw.toString?.() ?? raw);
  return Number.isFinite(value) ? value : NaN;
}

function shouldHandleUpsertMessage(message, eventType, chatJid) {
  const nowMs = Date.now();
  const messageId = message?.key?.id;
  const dedupeKey = messageId ? chatJid + ':' + messageId : '';

  if (dedupeKey && handledMessageIds.has(dedupeKey)) {
    logger.info({ chatJid, messageId, eventType }, 'Skipping duplicate WhatsApp message event.');
    return false;
  }

  // Baileys "append" events are usually older/offline-synced messages. Only
  // accept recent ones, so a delayed message is not silently lost while a
  // large historical sync does not trigger searches for old chat history.
  if (eventType === 'append') {
    const timestampSeconds = getTimestampSeconds(message);
    const ageSeconds = Math.floor(nowMs / 1000) - timestampSeconds;
    if (!Number.isFinite(timestampSeconds) || timestampSeconds <= 0 || ageSeconds > 300 || ageSeconds < -30) {
      logger.info({
        chatJid,
        messageId: messageId || null,
        ageSeconds: Number.isFinite(ageSeconds) ? ageSeconds : null
      }, 'Ignoring historical WhatsApp append message.');
      return false;
    }
  }

  if (dedupeKey) {
    handledMessageIds.set(dedupeKey, nowMs);
    if (handledMessageIds.size > 2000) {
      for (const [key, time] of handledMessageIds) {
        if (nowMs - time > 10 * 60 * 1000 || handledMessageIds.size > 1800) {
          handledMessageIds.delete(key);
        }
      }
    }
  }
  return true;
}

async function start() {
  // Baileys sessions are stored in auth_info/ by default. Make sure the
  // directory exists and report whether a previously paired session was loaded.
  mkdirSync(AUTH_DIR, { recursive: true });
  const credsFile = path.join(AUTH_DIR, 'creds.json');
  const credsFileExisted = existsSync(credsFile);
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);

  logger.info({
    authDir: AUTH_DIR,
    credsFileExists: credsFileExisted,
    sessionRegistered: Boolean(state.creds.registered)
  }, 'Loaded WhatsApp auth state');

  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {}

  const sock = makeWASocket({
    auth: state,
    ...(version ? { version } : {}),
    logger: pino({ level: 'silent' }),
    browser: ['WA-MV-Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', async () => {
    try {
      await saveCreds();
    } catch (error) {
      logger.error({ err: error?.message || String(error), authDir: AUTH_DIR }, 'Could not save WhatsApp credentials.');
    }
  });

  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) {
      if (state.creds.registered) {
        logger.warn('WhatsApp requested a new QR even though a registered session was loaded. Check the disconnect reason and auth_info persistence.');
      } else {
        logger.warn({ authDir: AUTH_DIR, credsFileExists: existsSync(credsFile) }, 'No registered WhatsApp session was loaded; QR pairing is required.');
      }
      qrcode.generate(qr, { small: true });
    }

    if (connection === 'open') logger.info('WhatsApp connected.');

    if (connection === 'close') {
      const statusCode = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = statusCode !== DisconnectReason.loggedOut;
      logger.warn({
        statusCode: statusCode ?? null,
        shouldReconnect,
        sessionRegistered: Boolean(state.creds.registered),
        authDir: AUTH_DIR
      }, 'WhatsApp connection closed.');

      if (shouldReconnect) {
        setTimeout(() => start().catch(error => {
          logger.error({ err: error?.message || String(error) }, 'WhatsApp reconnect failed.');
        }), 4000);
      } else {
        logger.error('WhatsApp logged this session out. Re-pair once; repeated automatic QR generation has been stopped.');
      }
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    logger.info({
      eventType: type,
      messageCount: Array.isArray(messages) ? messages.length : 0
    }, 'WhatsApp messages.upsert event received.');

    if (type !== 'notify' && type !== 'append') {
      logger.info({ eventType: type }, 'Ignoring non-message-notification upsert type.');
      return;
    }

    for (const message of messages) {
      try {
        const jid = message.key?.remoteJid;
        if (!jid) {
          logger.warn('Received a WhatsApp message event without remoteJid.');
          continue;
        }
        if (!shouldHandleUpsertMessage(message, type, jid)) continue;

        const isGroup = isGroupJid(jid);
        const rawContent = unwrapMessage(message.message);
        const messageType = Object.keys(rawContent || {}).join(',');
        logger.info({
          chatType: isGroup ? 'group' : (jid === 'status@broadcast' ? 'status' : 'direct'),
          chatJid: jid,
          fromMe: Boolean(message.key?.fromMe),
          messageType: messageType || 'unknown'
        }, 'Incoming WhatsApp message event.');

        if (isGroup && !loggedGroupJids.has(jid)) {
          loggedGroupJids.add(jid);
          logger.info({ groupJid: jid }, 'Observed WhatsApp group JID. Set REQUEST_GROUP_JID to enable requests in this group.');
        }
        // Group requests only run in the configured request group. Direct messages
        // are supported independently, so a missing group configuration does not
        // silently disable private-chat searches.
        if (isGroup && !REQUEST_GROUP_JID) {
          logger.warn({ groupJid: jid }, 'Ignoring this group message because REQUEST_GROUP_JID is not configured.');
          continue;
        }
        if (isGroup && jid !== REQUEST_GROUP_JID) {
          logger.info({ groupJid: jid }, 'Ignoring message from a group that is not REQUEST_GROUP_JID.');
          continue;
        }

        const content = rawContent;
        const text = textFromMessage(content);
        if (!text) {
          logger.info({ messageType }, 'Message arrived but contains no supported text/caption; nothing to search.');
          continue;
        }

        const contextInfo = contextFromMessage(content);
        if (message.key.fromMe) {
          const isBotGeneratedText = /^(?:🎬|🔎|✅|⚠️|😕|⏳|⌛|ℹ️)/u.test(text.trim());
          const isNumberedSelection = /^\d{1,2}$/.test(text) && Boolean(contextInfo?.stanzaId);
          if (isBotGeneratedText || (!isNumberedSelection && (text.length < 2 || text.length > 100))) {
            continue;
          }
        }

        logger.info({
          chatType: isGroup ? 'group' : 'direct',
          chatJid: jid,
          message: text.slice(0, 120)
        }, 'Received incoming movie message.');

        const wasSelection = await handleSelection(sock, message, text, contextInfo);
        if (wasSelection) continue;

        if (/^\d{1,2}$/.test(text)) continue;
        if (text.length < 2 || text.length > 100) continue;

        if (activeSearchChats.has(jid)) continue;
        activeSearchChats.add(jid);

        try {
          if (!chamaCineSubzEnabled) {
            logger.warn('Movie search skipped because CHAMA_CINESUBZ_API_KEY is not configured.');
            await sock.sendMessage(jid, {
              text: '⚠️ Movie search is not configured yet. Add your CHAMA_CINESUBZ_API_KEY in the private .env or config.json file, then restart the bot.'
            }, { quoted: message });
            continue;
          }

          logger.info({ query: text }, 'Searching CineSubz for movie title.');
          const movies = await searchMovies(text);
          if (!movies.length) {
            await sock.sendMessage(jid, {
              text: '😕 No matching titles were found for “' + text + '”.'
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
        } finally {
          activeSearchChats.delete(jid);
        }
      } catch (error) {
        logger.error({ err: error?.message });
      }
    }
  });
}

process.on('unhandledRejection', error => logger.error({ err: String(error) }));
start().catch(error => {
  logger.error({ err: error }, 'Fatal startup error');
  process.exitCode = 1;
});

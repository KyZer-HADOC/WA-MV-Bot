import 'dotenv/config';
import axios from 'axios';
import pino from 'pino';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion,
  downloadMediaMessage
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth_info');
const REQUEST_GROUP_JID = process.env.REQUEST_GROUP_JID?.trim();
const MOVIE_GROUP_JID = process.env.MOVIE_GROUP_JID?.trim();
const TMDB_API_KEY = process.env.TMDB_API_KEY?.trim();
const ADMIN_NUMBER = (process.env.ADMIN_NUMBER || '').replace(/\D/g, '');
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });
const pendingSearches = new Map();
const MAX_RESULTS = 8;

let mediaMap = {};
try {
  mediaMap = JSON.parse(process.env.AUTHORIZED_MEDIA_MAP || '{}');
} catch {
  logger.warn('AUTHORIZED_MEDIA_MAP is not valid JSON; ignoring it.');
  mediaMap = {};
}

function textFromMessage(message) {
  const m = message?.message;
  if (!m) return '';
  return (
    m.conversation ||
    m.extendedTextMessage?.text ||
    m.imageMessage?.caption ||
    m.videoMessage?.caption ||
    m.documentMessage?.caption ||
    ''
  ).trim();
}

function normalizeTitle(value) {
  return String(value || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

function isGroupJid(jid) {
  return typeof jid === 'string' && jid.endsWith('@g.us');
}

function senderNumber(jid = '') {
  return jid.split('@')[0].split(':')[0].replace(/\D/g, '');
}

async function searchMovies(query) {
  if (!TMDB_API_KEY) {
    throw new Error('TMDB_API_KEY is missing. Add a TMDB API key in the hosting environment.');
  }
  const { data } = await axios.get('https://api.themoviedb.org/3/search/movie', {
    params: { api_key: TMDB_API_KEY, query, include_adult: false },
    timeout: 12000
  });
  return (data.results || []).slice(0, MAX_RESULTS).map(movie => ({
    id: movie.id,
    title: movie.title || 'Unknown title',
    originalTitle: movie.original_title || movie.title || '',
    year: movie.release_date?.slice(0, 4) || 'Unknown',
    overview: movie.overview || 'No synopsis available.',
    rating: Number.isFinite(movie.vote_average) ? movie.vote_average.toFixed(1) : 'N/A',
    poster: movie.poster_path ? `https://image.tmdb.org/t/p/w500${movie.poster_path}` : null
  }));
}

function makeResultsText(query, movies) {
  const lines = [
    '🎬 *MOVIE SEARCH RESULTS*',
    '',
    `🔎 Search: ${query}`,
    ''
  ];
  movies.forEach((movie, index) => {
    lines.push(`${index + 1}. *${movie.title}* (${movie.year})`);
    lines.push(`   ⭐ ${movie.rating}/10`);
  });
  lines.push('', '↩️ *Reply to THIS message with a number* (for example: 2).');
  lines.push('⏳ Selection expires in 10 minutes.');
  return lines.join('\n');
}

function mediaLookup(movie) {
  // Only use files/URLs the operator is authorized to distribute.
  return mediaMap[String(movie.id)] || mediaMap[normalizeTitle(movie.title)] || null;
}

async function sendAuthorizedMedia(sock, movie, mediaUrl) {
  if (!mediaUrl) return false;
  // Deliberately only accepts direct HTTPS URLs supplied by the operator.
  // It does not scrape piracy sites or bypass paywalls/DRM.
  if (typeof mediaUrl !== 'string' || !mediaUrl.startsWith('https://')) {
    logger.warn({ movie: movie.title }, 'Skipping media URL that is not HTTPS.');
    return false;
  }
  const response = await axios.get(mediaUrl, {
    responseType: 'arraybuffer',
    timeout: 45000,
    maxContentLength: 100 * 1024 * 1024,
    maxBodyLength: 100 * 1024 * 1024
  });
  const contentType = response.headers['content-type'] || 'application/octet-stream';
  const isVideo = contentType.startsWith('video/');
  const fileName = `${movie.title} (${movie.year}).${isVideo ? 'mp4' : 'bin'}`.replace(/[\\/:*?"<>|]/g, '_');
  await sock.sendMessage(MOVIE_GROUP_JID, {
    document: Buffer.from(response.data),
    mimetype: contentType,
    fileName,
    caption: `📁 Authorized media file for: ${movie.title} (${movie.year})`
  });
  return true;
}

async function handleSelection(sock, message, selectedText) {
  const quotedId = message.message?.extendedTextMessage?.contextInfo?.stanzaId;
  const quotedParticipant = message.message?.extendedTextMessage?.contextInfo?.participant;
  if (!quotedId) return false;

  const search = pendingSearches.get(quotedId);
  if (!search) return false;
  if (Date.now() > search.expiresAt) {
    pendingSearches.delete(quotedId);
    await sock.sendMessage(message.key.remoteJid, {
      text: '⌛ This movie list expired. Send the movie name again to search.'
    }, { quoted: message });
    return true;
  }

  // Accept only a simple number sent as a reply to the bot's results message.
  if (!/^\d{1,2}$/.test(selectedText)) return false;
  const index = Number(selectedText) - 1;
  if (index < 0 || index >= search.movies.length) {
    await sock.sendMessage(message.key.remoteJid, {
      text: `⚠️ Choose a number from 1 to ${search.movies.length} by replying to the movie list.`
    }, { quoted: message });
    return true;
  }

  const movie = search.movies[index];
  pendingSearches.delete(quotedId);
  const details = [
    '🎬 *MOVIE REQUEST SELECTED*',
    '',
    `📽️ Title: ${movie.title}`,
    `📅 Year: ${movie.year}`,
    `⭐ TMDB rating: ${movie.rating}/10`,
    '',
    `📝 ${movie.overview}`,
    '',
    movie.poster ? `🖼️ Poster: ${movie.poster}` : '',
    `🔗 TMDB: https://www.themoviedb.org/movie/${movie.id}`,
    '',
    '📦 Media file:'
  ].filter(Boolean).join('\n');

  await sock.sendMessage(MOVIE_GROUP_JID, { text: details });
  const mediaUrl = mediaLookup(movie);
  const sent = await sendAuthorizedMedia(sock, movie, mediaUrl).catch(error => {
    logger.error({ err: error.message }, 'Authorized media delivery failed');
    return false;
  });

  await sock.sendMessage(message.key.remoteJid, {
    text: sent
      ? `✅ *${movie.title} (${movie.year})* selected. Details and authorized media file sent to the Movie Group.`
      : `✅ *${movie.title} (${movie.year})* selected. Movie details sent to the Movie Group.\n\n⚠️ No authorized media file is configured for this title yet.`
  }, { quoted: message });
  return true;
}

async function start() {
  if (!REQUEST_GROUP_JID || !MOVIE_GROUP_JID) {
    logger.warn('Set REQUEST_GROUP_JID and MOVIE_GROUP_JID in environment variables.');
  }
  if (REQUEST_GROUP_JID && !isGroupJid(REQUEST_GROUP_JID)) logger.warn('REQUEST_GROUP_JID should end with @g.us');
  if (MOVIE_GROUP_JID && !isGroupJid(MOVIE_GROUP_JID)) logger.warn('MOVIE_GROUP_JID should end with @g.us');

  fs.mkdirSync(AUTH_DIR, { recursive: true });
  const { state, saveCreds } = await useMultiFileAuthState(AUTH_DIR);
  let version;
  try {
    ({ version } = await fetchLatestBaileysVersion());
  } catch {
    logger.warn('Could not fetch latest WhatsApp Web version; using library default.');
  }

  const sock = makeWASocket({
    auth: state,
    version,
    logger: pino({ level: 'silent' }),
    printQRInTerminal: true,
    browser: ['WA-MV-Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);
  sock.ev.on('connection.update', ({ connection, lastDisconnect, qr }) => {
    if (qr) logger.info('Scan the QR code in the console using the dedicated bot WhatsApp account.');
    if (connection === 'open') logger.info('WhatsApp connected.');
    if (connection === 'close') {
      const code = lastDisconnect?.error?.output?.statusCode;
      const shouldReconnect = code !== DisconnectReason.loggedOut;
      logger.warn({ code, shouldReconnect }, 'WhatsApp connection closed.');
      if (shouldReconnect) setTimeout(() => start().catch(err => logger.error(err)), 3000);
      else logger.error('Logged out. Remove auth_info and pair again.');
    }
  });

  sock.ev.on('messages.upsert', async ({ messages, type }) => {
    if (type !== 'notify') return;
    for (const message of messages) {
      try {
        const jid = message.key.remoteJid;
        if (!jid || !isGroupJid(jid) || message.key.fromMe) continue;
        if (REQUEST_GROUP_JID && jid !== REQUEST_GROUP_JID) continue;
        const text = textFromMessage(message);
        if (!text) continue;

        // Selection works only when the user replies to a bot-generated search list.
        const handled = await handleSelection(sock, message, text);
        if (handled) continue;

        // No commands required: any ordinary text that isn't a number reply is treated as a movie title.
        if (/^\d{1,2}$/.test(text)) continue;
        if (text.length < 2 || text.length > 100) continue;

        const movies = await searchMovies(text);
        if (!movies.length) {
          await sock.sendMessage(jid, {
            text: `😕 No movie matches found for “${text}”. Try the English title or include the release year.`
          }, { quoted: message });
          continue;
        }
        const sent = await sock.sendMessage(jid, {
          text: makeResultsText(text, movies)
        }, { quoted: message });
        pendingSearches.set(sent.key.id, {
          movies,
          expiresAt: Date.now() + 10 * 60 * 1000,
          requester: senderNumber(message.key.participant || '')
        });
        setTimeout(() => pendingSearches.delete(sent.key.id), 10 * 60 * 1000).unref?.();
      } catch (error) {
        logger.error({ err: error?.response?.data || error.message }, 'Could not process message');
        await sock.sendMessage(message.key.remoteJid, {
          text: '⚠️ Movie search had a problem. Please try again in a little while.'
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

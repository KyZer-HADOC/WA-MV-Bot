import 'dotenv/config';
import pino from 'pino';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import puppeteer from 'puppeteer';
import makeWASocket, {
  useMultiFileAuthState,
  DisconnectReason,
  fetchLatestBaileysVersion
} from '@whiskeysockets/baileys';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const AUTH_DIR = path.join(__dirname, 'auth_info');
const REQUEST_GROUP_JID = (process.env.REQUEST_GROUP_JID || '').trim();
const MOVIE_GROUP_JID = (process.env.MOVIE_GROUP_JID || '').trim();
const logger = pino({ level: process.env.LOG_LEVEL || 'info' });

const pendingSearches = new Map();
const activeSearchChats = new Set();
const loggedGroupJids = new Set();
const MAX_RESULTS = 8;
const SEARCH_TTL_MS = 10 * 60 * 1000;

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

async function withBrowser(action) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage']
  });
  try {
    return await action(browser);
  } finally {
    await browser.close().catch(() => {});
  }
}

async function searchMovies(query) {
  const searchUrl = 'https://sinhalasub.lk/?s=' + encodeURIComponent(query) + '&post_type=movies';

  return withBrowser(async browser => {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.goto(searchUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('.display-item .item-box, .item-box, article', { timeout: 10000 }).catch(() => {});

    const results = await page.evaluate(maxResults => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      let boxes = Array.from(document.querySelectorAll('.display-item .item-box'));
      if (!boxes.length) {
        boxes = Array.from(document.querySelectorAll('.item-box, .movie-item, article'))
          .filter(box => box.querySelector('a[href*="/movies/"]'));
      }

      const output = [];
      const seen = new Set();

      for (const box of boxes) {
        const anchors = Array.from(box.querySelectorAll('a[href]'));
        const anchor =
          anchors.find(a => clean(a.getAttribute('title')) && a.href.includes('/movies/')) ||
          anchors.find(a => a.href.includes('/movies/') && a.querySelector('img')) ||
          anchors.find(a => a.href.includes('/movies/'));

        if (!anchor) continue;
        const movieUrl = new URL(anchor.href, location.origin).href;
        if (!movieUrl.startsWith(location.origin) || seen.has(movieUrl)) continue;
        seen.add(movieUrl);

        const image = box.querySelector('img, .thumb');
        const title = clean(
          anchor.getAttribute('title') ||
          box.querySelector('h1, h2, h3, .title, .movie-title')?.textContent ||
          image?.getAttribute('alt')
        );
        if (!title) continue;

        const language = clean(
          box.querySelector('.item-desc-giha .language, .language, [class*="language"]')?.textContent
        );
        const quality = clean(
          box.querySelector('.item-desc-giha .quality, .quality, [class*="quality"]')?.textContent
        );
        const format = clean(
          box.querySelector('.item-desc-giha .qty, .qty, [class*="qty"]')?.textContent
        );
        const poster = image
          ? (image.getAttribute('data-src') || image.getAttribute('data-lazy-src') || image.currentSrc || image.src || '')
          : '';

        output.push({ title, movieUrl, poster, language, quality, format });
        if (output.length >= maxResults) break;
      }

      if (!output.length) {
        for (const anchor of document.querySelectorAll('a[href*="/movies/"]')) {
          const movieUrl = new URL(anchor.href, location.origin).href;
          if (!movieUrl.startsWith(location.origin) || seen.has(movieUrl)) continue;
          const title = clean(anchor.getAttribute('title') || anchor.textContent || anchor.querySelector('img')?.alt);
          if (!title) continue;
          seen.add(movieUrl);
          const image = anchor.querySelector('img') || anchor.closest('article, li, .item-box')?.querySelector('img');
          output.push({
            title,
            movieUrl,
            poster: image ? (image.getAttribute('data-src') || image.getAttribute('data-lazy-src') || image.src || '') : '',
            language: '',
            quality: '',
            format: ''
          });
          if (output.length >= maxResults) break;
        }
      }

      return output;
    }, MAX_RESULTS);

    return results.filter(item => item.title && item.movieUrl);
  });
}

async function getMovieMetadata(movie) {
  return withBrowser(async browser => {
    const page = await browser.newPage();
    page.setDefaultNavigationTimeout(30000);
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36'
    );
    await page.goto(movie.movieUrl, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForSelector('h1, .info-details, .details-title', { timeout: 10000 }).catch(() => {});

    const metadata = await page.evaluate(() => {
      const clean = value => String(value || '').replace(/\s+/g, ' ').trim();
      const firstText = selectors => {
        for (const selector of selectors) {
          const node = document.querySelector(selector);
          const value = clean(node?.textContent || '');
          if (value) return value;
        }
        return '';
      };
      const lists = selectors => {
        for (const selector of selectors) {
          const values = Array.from(document.querySelectorAll(selector))
            .map(node => clean(node.textContent))
            .filter(Boolean);
          if (values.length) return [...new Set(values)];
        }
        return [];
      };
      const bodyText = document.body?.innerText || '';
      const labelValue = label => {
        const line = bodyText.split('\n').map(x => x.trim()).find(x => new RegExp('^' + label + '\\s*:', 'i').test(x));
        return line ? line.replace(new RegExp('^' + label + '\\s*:\\s*', 'i'), '').trim() : '';
      };
      const title = firstText([
        '.info-details .details-title h3',
        '.details-title h3',
        'h1.entry-title',
        'main h1',
        'h1'
      ]) || document.title || '';
      const imdbRaw = firstText(['.info-details .data-imdb', '.data-imdb', '[itemprop="ratingValue"]']) || labelValue('IMDb(?: Rating)?');
      const imageNode = document.querySelector('.splash-bg img, .info-details img, meta[property="og:image"]');
      const thumbnail = imageNode
        ? (imageNode.getAttribute('content') || imageNode.getAttribute('data-src') || imageNode.currentSrc || imageNode.src || '')
        : '';

      let language = '';
      let duration = '';
      let directors = [];
      let stars = [];
      document.querySelectorAll('.info-col p, .info-details p, .movie-info p').forEach(p => {
        const strong = p.querySelector('strong, b');
        const label = clean(strong?.textContent || '');
        if (/language/i.test(label)) language = clean(strong?.nextSibling?.textContent || p.textContent.replace(label, '').replace(':', ''));
        if (/duration|runtime/i.test(label)) duration = clean(strong?.nextSibling?.textContent || p.textContent.replace(label, '').replace(':', ''));
        if (/director/i.test(label)) directors = Array.from(p.querySelectorAll('a')).map(a => clean(a.textContent)).filter(Boolean);
        if (/stars|cast|starring/i.test(label)) stars = Array.from(p.querySelectorAll('a')).map(a => clean(a.textContent)).filter(Boolean);
      });

      const genres = lists(['.details-genre a', '.genres a', 'a[rel="tag"]']);
      return {
        title: clean(title),
        language: clean(language || labelValue('Language')),
        duration: clean(duration || labelValue('Duration') || labelValue('Runtime')),
        imdb: clean(imdbRaw.replace(/IMDb(?: Rating)?\s*:?/i, '')),
        genres,
        directors: [...new Set(directors)],
        stars: [...new Set(stars)],
        thumbnail
      };
    });

    return {
      title: safeText(metadata.title, movie.title),
      language: safeText(metadata.language || movie.language),
      duration: safeText(metadata.duration),
      imdb: safeText(metadata.imdb),
      genres: metadata.genres || [],
      directors: metadata.directors || [],
      stars: metadata.stars || [],
      thumbnail: metadata.thumbnail || movie.poster || ''
    };
  });
}

function makeResultsText(query, movies) {
  const lines = [
    '🎬 *SINHALASUB MOVIE SEARCH*',
    '',
    '🔎 Search: ' + query,
    ''
  ];

  movies.forEach((movie, index) => {
    lines.push('*' + (index + 1) + '.* ' + movie.title);
    if (movie.language) lines.push('   🌐 Language: ' + movie.language);
    if (movie.quality) lines.push('   🎞️ Quality: ' + movie.quality);
    if (movie.format) lines.push('   📦 Format: ' + movie.format);
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
    '⭐ *IMDb:* ' + metadata.imdb,
    '🎭 *Genres:* ' + (metadata.genres.length ? metadata.genres.join(', ') : 'Not listed'),
    '🎥 *Director(s):* ' + (metadata.directors.length ? metadata.directors.join(', ') : 'Not listed'),
    '🌟 *Cast:* ' + (metadata.stars.length ? metadata.stars.slice(0, 8).join(', ') : 'Not listed'),
    '',
    '🔎 Source details are based on SinhalaSub.lk.'
  ];
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
    printQRInTerminal: true,
    browser: ['WA-MV-Bot', 'Chrome', '1.0.0'],
    markOnlineOnConnect: false,
    syncFullHistory: false
  });

  sock.ev.on('creds.update', saveCreds);

  sock.ev.on('connection.update', ({ connection, lastDisconnect }) => {
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
    if (type !== 'notify') return;

    for (const message of messages) {
      try {
        const jid = message.key?.remoteJid;
        if (!jid || !isGroupJid(jid) || message.key.fromMe) continue;

        if (!REQUEST_GROUP_JID || !MOVIE_GROUP_JID) {
          if (!loggedGroupJids.has(jid)) {
            loggedGroupJids.add(jid);
            logger.warn({ groupJid: jid }, 'Observed WhatsApp group JID; configure both group JIDs to enable movie requests.');
          }
          continue;
        }

        if (jid !== REQUEST_GROUP_JID) continue;

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
          const movies = await searchMovies(text);
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
        logger.error({ err: error?.message || String(error) }, 'Could not process movie request.');
        await sock.sendMessage(message.key.remoteJid, {
          text: '⚠️ Movie search failed. SinhalaSub may be temporarily unavailable; please try again later.'
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

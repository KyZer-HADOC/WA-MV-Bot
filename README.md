# WA-MV-Bot

A WhatsApp group movie-request bot. Members type a movie title as ordinary text in the configured request group; no command prefix is needed. The bot searches SinhalaSub.lk for matching entries and returns a numbered list. The original requester replies to the bot's list with a number, and the bot posts the selected title's details and poster to the destination movie group.

## Current behavior

- Uses SinhalaSub.lk page search and metadata selectors based on the existing KyZer SinhalaSub plugin; no TMDB API key is required.
- Shows title, language, listed quality/format, and numbered choices.
- On selection, fetches the title page's metadata (language, duration, IMDb rating, genres, director(s), cast) and attempts to send the poster with the details to the destination group.
- A numeric choice is accepted only as a reply to a current bot-generated list, and only from the person who requested that list.
- An optional AUTHORIZED_MEDIA_MAP can send a direct HTTPS file URL that the operator owns or is authorized to distribute. The bot does not extract download links from SinhalaSub or third-party file hosts.
- If the two group JIDs are not configured, the bot does not process requests; it logs group JIDs it observes so they can be configured privately.

## Setup

1. Use Node.js 20 or newer.
2. Install dependencies with npm install.
3. In your hosting service's environment variables, set REQUEST_GROUP_JID and MOVIE_GROUP_JID to the respective WhatsApp group JIDs ending in @g.us.
4. Start the bot with npm start.
5. Scan the QR code shown in the console using WhatsApp.
6. Keep the auth_info folder persistent and private. Never commit or share it.

## Authorized media files

To send a file you own or are authorized to distribute, set AUTHORIZED_MEDIA_MAP to a JSON string mapping the normalized movie title or exact movie page URL to a direct HTTPS file URL. Example:

    {"avatar 2009":"https://your-storage.example/avatar.mp4"}

The file URL must point directly to the file and be accessible by the bot. Do not use page URLs that require clicking through, signing in, or completing ad/verification steps.

## Group JIDs

If you do not know a group JID yet, leave one or both group variables empty and start the bot. Send a message in each target group, then look for groupJid entries in the private hosting logs. Copy the JIDs to the environment variables, restart the bot, and do not publish them unnecessarily.

## Hosting and account notes

- Puppeteer downloads a compatible browser; make sure the hosting build allows Puppeteer's install script and has enough memory and disk space.
- Keep the auth_info folder on persistent storage. An ephemeral filesystem may lose the WhatsApp session on restart/redeploy.
- Free hosting can sleep or enforce usage limits; 24/7 uptime is not guaranteed.
- This uses unofficial WhatsApp Web automation through Baileys. WhatsApp may restrict accounts using unofficial automation. Using your personal WhatsApp number has risk; a separate number/account is safer when available.

## Limitations

- SinhalaSub can change its website markup or block automated requests; search may stop working until selectors are updated.
- Posters and metadata depend on what the source page exposes.
- The bot sends details and poster to the movie group by default. It only sends a media file when you configure an authorized direct HTTPS file URL.

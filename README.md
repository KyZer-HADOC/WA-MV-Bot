# WA-MV-Bot

A WhatsApp group movie-request bot. Members type a movie title as ordinary text in the configured request group; no command prefix is needed. The bot searches SinhalaSub.lk for matching entries and returns a numbered list. The original requester replies to the bot's list with a number, and the bot posts the selected title's details and poster to the destination movie group.

## Current behavior

- Uses lightweight HTTP requests and HTML parsing to search SinhalaSub.lk, based on the selectors in the existing KyZer SinhalaSub plugin; no TMDB API key or browser download is required.
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

## MovieBox API (optional)

To use your own Cloudflare MovieBox API worker for title search and metadata, set these two variables in the host's environment settings:

- `MOVIEBOX_API_URL`: your Worker base URL, with no trailing slash and no `/search` suffix.
- `MOVIEBOX_SECRET`: the same secret value configured in the Worker as `MOVIEBOX_SECRET`. Keep it private.

When both are configured, searches use MovieBox's `POST /search` endpoint and the bot posts the returned title metadata/poster. If either value is missing, the bot keeps using the existing SinhalaSub metadata search. The bot does not fetch or redistribute MovieBox stream/download URLs; file delivery remains limited to entries you configure in `AUTHORIZED_MEDIA_MAP` for files you own or are authorized to distribute.

## Authorized media files

To send a file you own or are authorized to distribute, set AUTHORIZED_MEDIA_MAP to a JSON string mapping the normalized movie title or exact movie page URL to a direct HTTPS file URL. Example:

    {"avatar 2009":"https://your-storage.example/avatar.mp4"}

The file URL must point directly to the file and be accessible by the bot. Do not use page URLs that require clicking through, signing in, or completing ad/verification steps.

## Group JIDs

If you do not know a group JID yet, leave one or both group variables empty and start the bot. Send a message in each target group, then look for groupJid entries in the private hosting logs. Copy the JIDs to the environment variables, restart the bot, and do not publish them unnecessarily.

## Hosting and account notes

- The search uses Axios and Cheerio instead of a full browser to reduce memory and storage needs on free hosting. If SinhalaSub blocks HTTP requests or changes its HTML, the scraper may need updates.
- Keep the auth_info folder on persistent storage. An ephemeral filesystem may lose the WhatsApp session on restart/redeploy.
- Free hosting can sleep or enforce usage limits; 24/7 uptime is not guaranteed.
- This uses unofficial WhatsApp Web automation through Baileys. WhatsApp may restrict accounts using unofficial automation. Using your personal WhatsApp number has risk; a separate number/account is safer when available.

## Limitations

- SinhalaSub can change its website markup or block automated requests; search may stop working until selectors are updated.
- Posters and metadata depend on what the source page exposes.
- The bot sends details and poster to the movie group by default. It only sends a media file when you configure an authorized direct HTTPS file URL.
## Run on your own Windows PC (no hosting account or payment card)

This is the simplest $0 option. Download the repository ZIP from GitHub, extract it to a normal folder, and run `run-windows.bat`. The launcher checks for Node.js 20+, creates `.env` from `.env.example` the first time, installs dependencies, and starts the bot.

If you do not know the group JIDs yet, leave the two variables blank, save `.env`, start the bot, and send a message in each of the two groups. Copy the `groupJid` values from the console into `REQUEST_GROUP_JID` and `MOVIE_GROUP_JID` in `.env`, then stop and restart the bot.

The PC must remain switched on and connected to the internet while the bot is running. Disable Windows Sleep while plugged in, but keep the display free to turn off. Keep `.env` and `auth_info` private and never upload them to GitHub. This local option has no hosting bill, but it is not independent of your PC, electricity, or internet connection.

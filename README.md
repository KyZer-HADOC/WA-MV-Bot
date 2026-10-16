# WA-MV-Bot

WhatsApp group movie-request bot. Members simply type a movie title—no commands needed. The bot searches TMDB, posts numbered results, and members reply to the bot's result message with a number to choose a title.

## Current behavior

- Connects through a dedicated WhatsApp account using QR pairing (unofficial WhatsApp Web automation; account restrictions are possible).
- Only processes plain-text messages in the configured request group.
- Searches movie metadata through TMDB.
- A number is accepted only when it is a reply to a live result list created by this bot.
- Sends selected movie details and a TMDB page link to the configured movie group.
- Sends a media file only when the operator configures a direct HTTPS URL to a file they own or are authorized to distribute. It does not scrape Cinesubz or bypass copyright protections.

## Setup

1. Install Node.js 20 or newer.
2. Copy `.env.example` to `.env`.
3. Set:
   - `REQUEST_GROUP_JID`: request group JID ending in `@g.us`
   - `MOVIE_GROUP_JID`: destination group JID ending in `@g.us`
   - `TMDB_API_KEY`: API key from your TMDB account
   - Optional `AUTHORIZED_MEDIA_MAP`: JSON map from TMDB movie ID (or normalized title) to a direct HTTPS URL for an authorized file
4. Run `npm install`, then `npm start`.
5. Scan the QR code with the dedicated WhatsApp account.
6. Keep the `auth_info` folder persistent; do not commit or share it.

Example `AUTHORIZED_MEDIA_MAP` value (use only media you have distribution rights for):
```json
{"19995":"https://your-storage.example/avatar.mp4"}
```

## Group JIDs

With the bot connected, temporarily remove the `REQUEST_GROUP_JID` filter in `index.js` if you need to log incoming group IDs, or use a trusted local diagnostic script. Do not publish your WhatsApp session credentials. A JID commonly looks like `1203630xxxxxxxxxx@g.us`.

## Hosting notes

A persistent disk is required for `auth_info`; ephemeral filesystems will lose the session on redeploy/restart. Free hosting may sleep or impose usage limits, so 24/7 uptime is not guaranteed.

## Notes

- TMDB provides metadata, not movie files.
- This is unofficial WhatsApp Web automation and may stop working when WhatsApp changes its web client or Baileys changes.
- Do not upload `.env` or `auth_info` to GitHub.

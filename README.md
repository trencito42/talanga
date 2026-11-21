# Talanga 3.0: Lavalink v4 edition

This is a **Lavalink-only** Discord bot. It keeps the Botkeep `npm start` entrypoint and existing Discord token/guild config. The music audio is streamed by remote Lavalink nodes to Discord; Talanga does **not** download audio, start FFmpeg or yt-dlp, launch BgUtils, or cache song files locally.

## Install over the current Talanga on Botkeep

1. Stop the bot and **back up** your original files.
2. Upload `Talanga-LAVALINK-v3.zip` to the directory containing `bot.mjs` and **Unarchive**, choosing overwrite. The ZIP contains only the changed/new files.
3. Keep your current `.env` / Botkeep environment values `DISCORD_TOKEN` and `GUILD_ID`. You do not need `cookies.txt` or any YouTube PO-token variables with this edition.
4. Restart (`npm start`). If the console says `Cannot find package 'ws'`, you must run `npm install` first (or enable Botkeep's npm dependency installation at startup). The package lock already includes `ws`.
5. Check for `[Lavalink] <node> ready` in the console. Nodes are contacted in parallel; several can be ready at once. Use `/diagnose youtube:true` to check track lookup. Then test `/play` in Discord voice.

## Commands

- `/play melodie:` YouTube title/link or SoundCloud URL. Text searches use `ytsearch` first, then other search prefixes if enabled.
- `/skip`, `/stop`, `/queue`, `/pause`, `/resume`, `/volume nivel:`, `/nowplaying`
- `/diagnose youtube:true` (administrator only), and `diagnose` in the Botkeep console.

## Multiple Lavalink nodes

By default Talanga has four published public SSL Lavalink v4 nodes in `src/config.mjs`: Trinium, Serenetia, Jirayu and Nazha. These are external free servers that may reject connections, rate-limit or stop working. The bot keeps standby connections open, selects another node when loading fails, and restarts a dropped track on an alternative node where possible. The current position is **not guaranteed** to be preserved during failover.

Override the entire list with `LAVALINK_NODES` in `.env`:

```dotenv
# Each entry: name|host|port|password|secure. Entries separated by semicolons.
LAVALINK_NODES="Local|127.0.0.1|2333|youshallnotpass|false;Backup|lavalink-v4.triniumhost.com|443|free|true"
```

When Lavalink runs in a **different** Pterodactyl container, `127.0.0.1` in this bot container usually **will not** reach it; use the actual reachable host/IP and port. SSL public nodes are accessed over port 443. Never give a public Lavalink node your Discord bot token; it only needs its own Lavalink password and your bot's user ID for the Lavalink WebSocket handshake.

You may also supply `LAVALINK_NODES` as JSON, e.g. `[{"name":"MyNode","host":"example.net","port":443,"password":"YOUR_PASSWORD","secure":true}]`. In that case quote the JSON correctly for your environment editor.

Optional settings:

```dotenv
QUEUE_LIMIT=30
MAX_SONG_MINUTES=20
IDLE_MINUTES=15
LAVALINK_SEARCH_PREFIX=ytsearch
LAVALINK_SEARCH_FALLBACK=true
```

**Limitations:** Remote Lavalink instances still have to extract YouTube streams and may encounter block/rate-limit issues. Starting an arbitrary *new* YouTube song in exactly one second is not guaranteed. Free public nodes see the metadata needed to stream requested tracks and your Discord voice connection information. For reliability and privacy, use a Lavalink node under your control.

## Architecture

```text
Discord /play -> Lavalink v4 REST loadtracks -> guild queue
                 (while connecting to Discord Voice)
Discord voice gateway events -> Lavalink REST PATCH voice + encoded track
Lavalink node -> encrypted Discord voice packets
TrackEnd/TrackException/Stuck events -> next queued song / alternate node
```

Uses official protocol paths `/v4/websocket`, `/v4/loadtracks`, and `/v4/sessions/{sessionId}/players/{guildId}`. No Java service is required in the *bot's* container, because the nodes are remote.

Sources: https://lavalink.dev/api/websocket , https://lavalink.dev/api/rest , https://lavalink.darrennathanael.com/SSL/Lavalink-SSL/

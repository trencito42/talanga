# Talanga Implementation Progress

Tracks every item from the two audits plus the implementation mandate. Updated as work lands. Statuses: **Not started** / **In progress** / **Implemented, unverified** (code written, no live Discord/Lavalink test) / **Tested** (covered by an automated test that was actually run) / **Blocked** (needs something external — credentials, a decision, or infra not available here).

Nothing was deleted. `cookies.txt`, `bin/`, `vendor/`, `plugins/` are untouched. `src/diagnostics.mjs`, `src/binaries.mjs`, `src/potProvider.mjs`, `src/youtube.mjs` are untouched **code-wise**, but `src/config.mjs` was extended (additively — nothing removed) so they actually import and run again (previously `diagnostics.mjs` would throw `ERR_MODULE_NOT_FOUND`-adjacent errors since `config.mjs` didn't export what it imports). Verified: all four now `import()` cleanly.

## Session log
- **Session 1**: Phase A bug fixes (BUG-05, BUG-07) + REL-01/REL-02 + PERS-01 module + a slice of queue/filter/24-7 commands + TEST-01 harness (15 tests).
- **Session 2 (this one)**: F-19 (playlist import), F-31/F-32 (persistent button controller + paginated queue browser), F-17/F-18 (autocomplete on `/play`, doubling as the search picker), F-30 (local yt-dlp/`@discordjs/voice` fallback engine with explicit engine-ownership guards), plus the `config.mjs` fix that un-breaks the legacy extraction modules and makes `cookies.txt` load-bearing again. **24/24 automated tests passing.**
- **Explicitly declined** (not "not started" — a considered decision, see each row): F-16 vote-skip, F-29 manual equalizer.
- **Explicitly out of scope, no credentials available**: F-24 lyrics (dropped per your instruction this session — not implementing), F-36 Spotify metadata (needs Spotify API credentials).
- **Still genuinely not started**: F-05 pagination beyond 10 in the plain-text `/queue` (superseded in practice by the new button queue browser, F-32), F-14/F-15 (previous/replay), F-20/21/22 (saved playlists/favorites/history), F-23 (autoplay), F-27 (DJ roles, deprioritized by design), F-34 (voice channel status), F-37 (per-user cooldown).

## Bug fixes

| ID | Status | Evidence |
|---|---|---|
| BUG-05 (stream position on failover) | **Tested** | `src/player.mjs`; `test/player.test.mjs` "BUG-05" |
| BUG-07 (pause state lost on failover) | **Tested** | `src/player.mjs`; `test/player.test.mjs` "BUG-07" |

## Reliability (Phase B)

| ID | Status | Evidence |
|---|---|---|
| REL-01 (resume-aware failover) | **Tested** (mocked) | `src/lavalink.mjs` — 4s fixed grace window before `unavailable`, not the fully adaptive design from the audit (documented deviation, kept simple on purpose). `test/lavalink.test.mjs` "REL-01" |
| REL-02 (node ranking) | **Tested** | `LavalinkManager.list()` — active → fewest failures → lowest latency. `test/lavalink.test.mjs` "REL-02" |

## Persistence (Phase C)

| ID | Status | Evidence |
|---|---|---|
| PERS-01 | **Implemented, unverified** (module is Tested; live restart cycle is not) | `src/persistence.mjs`, atomic write, autosave every 45s + on shutdown, `/restore` command. No real Discord token/guild here to run an actual kill-and-restart test against. |

## Discord platform integration (Phase E)

| ID | Status | Evidence |
|---|---|---|
| F-31 persistent controller | **Implemented, unverified rendering** | `src/controller.mjs` (`buildControllerPayload`) + `bot.mjs` (`refreshController`, wired to `GuildPlayer`'s new `'update'` event via `Players extends EventEmitter`). Built on stable Components V1 buttons (`ActionRowBuilder`/`ButtonBuilder`), **not** Components V2 — V2 needs a specific discord.js version + the `IS_COMPONENTS_V2` flag, which can't be confirmed without a live client; V1 is guaranteed supported by the installed `discord.js@^14.27.0` and renders identically on mobile/desktop. Stale-button protection: every control button's `customId` embeds the track id it was rendered for (`tctl:<action>:<curId>`); a click against a track that has since ended is rejected with an ephemeral message instead of silently acting on whatever is current. Payload shape is unit-tested (`test/controller.test.mjs`, 3 tests: disabled-state-when-idle, curId-is-embedded, stream-shows-LIVE) — actual Discord rendering, button click round-trip, and mobile layout are **not** live-verified. |
| F-32 queue browser | **Implemented, unverified rendering** | `buildQueuePayload` in `src/controller.mjs`, paginated 10/page, `qpage:<n>` buttons, reachable from the controller's "📜 Coada" button or directly. Pagination/clamping logic unit-tested (`test/controller.test.mjs`). |
| F-17/F-18 search picker + autocomplete | **Implemented, unverified** | `LavalinkManager.search()` (`src/lavalink.mjs`) + `.setAutocomplete(true)` on `/play`'s option + an `isAutocomplete()` branch in `bot.mjs`. Discord's own autocomplete dropdown **is** the search-result picker here — no separate select-menu flow was built, since it would duplicate the same UX with more code. `search()` itself is unit-tested (`test/lavalink.test.mjs` "F-18": returns choices, refuses raw URLs, handles zero nodes). The actual 3-second interaction-timing behavior against Discord is not verified. |
| F-33 presence | Implemented, unverified | `client.user.setPresence(...)` in `ClientReady` |
| F-34 voice channel status | Not started | |

## Local fallback engine (Phase G, F-30)

| Status | Evidence |
|---|---|
| **Implemented, logic tested, audio NOT live-verified** | New `src/localEngine.mjs`: joins voice directly via `@discordjs/voice`'s `joinVoiceChannel`/`createAudioPlayer`, pipes yt-dlp's raw stdout (via the pre-existing `YouTube.streamArgs()` in `src/youtube.mjs`) into `createAudioResource` with `StreamType.Arbitrary`, letting `@discordjs/voice`'s own bundled transcoding handle the rest. Reuses the existing yt-dlp binary resolution (`src/binaries.mjs`, untouched) and **now actually uses `cookies.txt`** via `config.cookiesFile` (new in `config.mjs`) as yt-dlp's anti-bot-detection cookie jar — this is the concrete answer to "investigate how the extraction infrastructure could be useful alongside Lavalink" from the second audit. |
| **Engine-ownership invariant** | Enforced by mutual exclusion in `bot.mjs`, not inside the engine itself: `handlePlay` refuses to run while `fallback.engine.active`; `handlePlayLocal` refuses to run while the guild's `GuildPlayer.voiceChannelId` is set. The two paths never call into each other's join logic, so they structurally cannot both drive one guild's voice connection. |
| **Deliberate scope limitation** | Switching is **manual, not automatic**: `/play` falls to local only when `manager.available()` reports zero nodes *at that moment*; it does not continuously monitor and auto-switch back to Lavalink mid-session. To go back, the operator runs `/stoplocal` (new command) then `/play` again once Lavalink is healthy. A fully automatic bidirectional handoff (mid-track, preserving queue position) was assessed in the audit as the highest-risk item to get right without live testing, and was deliberately not attempted — this manual version is what's honestly achievable and verifiable here. |
| **Tested** (mocked) | `test/localEngine.test.mjs`, 4 tests with a fully fake `@discordjs/voice` + fake `spawn`: idempotent join, queue advances on the player's Idle event, `active` flag tracks connection lifecycle and goes false after `stop()`, `skip()` behaves. **Not tested**: a real Discord voice connection, real yt-dlp output, real audio reaching a real voice channel — none of that is possible without a live bot/guild. |
| **Config** | `src/config.mjs` gained (additively): `APP_DIR`/`CACHE_DIR` exports + `ytdlpPath`/`ffmpegPath`/`autoInstallBinaries`/`cookiesFile`/`ipArgs`/`playerClients`/`potEnabled`/`potBaseUrl`/`potPort` fields. Verified: `loadConfig()` still returns zero `problems` with just `DISCORD_TOKEN`+`GUILD_ID` set, and `cookiesFile` correctly resolves to the real `cookies.txt` path. The PO-token server (`src/potProvider.mjs`) is **not** wired into the fallback engine — yt-dlp relies on `cookies.txt` alone for now; wiring PO tokens in too is possible later but wasn't necessary to make the fallback functional in principle. |

## Feature matrix (F-01…F-37) — delta from session 1

| ID | Status | Notes |
|---|---|---|
| F-16 vote-skip | **Declined by design** | Unchanged reasoning: not useful for a small, trusted private server |
| F-17 search picker | **Implemented, unverified** | via autocomplete, see above |
| F-18 autocomplete | **Implemented, unverified** | see above |
| F-19 playlist import | **Tested** | unchanged from session 1 |
| F-24 lyrics | **Dropped at your request this session** — not implemented, not planned |
| F-29 manual equalizer | **Declined by design** | Unchanged reasoning |
| F-30 local fallback engine | **Implemented, partially tested** | see above — this was "not started" at the end of session 1 |
| F-31 Components V2 controller | **Implemented (as V1), partially tested** | see above |
| F-32 queue browser | **Implemented, partially tested** | see above |
| F-36 Spotify metadata | **Blocked**, unchanged | needs credentials |
| Everything else | unchanged from session 1's table | see git history of this file / prior session notes |

## External blockers (need operator action, not code)
- F-36 Spotify metadata: register a Spotify app, obtain client id/secret, wire into a new resolver (not started).
- **F-30 going into real use**: the bundled binaries in `bin/` are Linux builds (`yt-dlp_linux`); on a non-Linux host, `resolveBinaries()` will fail to find a working yt-dlp unless `YTDLP_PATH`/`FFMPEG_PATH` env vars point somewhere valid, or `AUTO_INSTALL_BINARIES=1` (default) succeeds in downloading a matching one — not verified in this sandbox (no outbound download was attempted here to avoid an unreviewed network action; this is exactly the download-confirmation boundary from this session's own operating rules).
- All "unverified rendering"/"unverified audio" items above: need a real Discord bot token + guild + voice channel to actually watch play out. None of that exists in this environment.

## Regression test commands
```powershell
npm install
npm test
```
24/24 passing as of this session.

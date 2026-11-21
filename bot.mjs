// Talanga v3 - Discord music bot, Lavalink v4 only.
// Start: npm start. Does not run yt-dlp, FFmpeg, or a PO Token provider
// (except for the opt-in local fallback engine, see src/localEngine.mjs).
import {
  Client, Events, GatewayIntentBits, MessageFlags, PermissionFlagsBits, REST, Routes, SlashCommandBuilder,
} from 'discord.js';
import readline from 'node:readline';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from './src/config.mjs';
import { LavalinkManager, UserError, safeError } from './src/lavalink.mjs';
import { Players, FILTER_PRESETS } from './src/player.mjs';
import { Persistence } from './src/persistence.mjs';
import { buildControllerPayload, buildQueuePayload } from './src/controller.mjs';
import { resolveBinaries } from './src/binaries.mjs';
import { YouTube } from './src/youtube.mjs';
import { LocalEngine } from './src/localEngine.mjs';
import { SpotifyResolver } from './src/spotify.mjs';

const log = (...args) => console.log(new Date().toISOString().slice(11, 19), ...args);
const logErr = (...args) => console.error(new Date().toISOString().slice(11, 19), ...args);
const config = loadConfig();
const manager = new LavalinkManager(config, { log });
const players = new Players({ manager, config, log });
const APP_DIR = path.dirname(fileURLToPath(import.meta.url));
const persistence = new Persistence(path.join(APP_DIR, 'data', 'state.json'), log);
const AUTOSAVE_MS = 45_000;
const diagnoseOnly = process.argv.includes('--diagnose');
const fmtTime = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const ephemeral = content => ({ content, flags: MessageFlags.Ephemeral });
let client;
let input;
let closing = false;

function diagnostics() {
  const lines = [
    `Talanga Lavalink v4 | Node.js ${process.version} | RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB`,
    `Discord: ${client?.user?.tag || 'not logged in'}`,
    `Lavalink nodes: ${manager.nodes.length} | connected ${manager.nodes.filter(n => n.ready).length}`,
    ...manager.report(),
    `Players: ${players.guilds.size}`,
    `Local fallback engine (F-30): ${fallback?.engine.active ? `ACTIVE (${fallback.engine.current?.title || 'starting'})` : 'inactive'}`,
  ];
  return lines;
}

async function shutdown(reason, code = 0) {
  if (closing) return;
  closing = true;
  log(`Shutting down (${reason})`);
  const emergency = setTimeout(() => process.exit(code || 1), 6000); emergency.unref?.();
  persistence.stopAutosave();
  try { await persistence.save(players.snapshotAll()); } catch {}
  players.shutdown();
  manager.stop();
  try { fallback?.engine.stop(); } catch {}
  try { await client?.destroy(); } catch {}
  input?.close();
  process.exit(code);
}
process.on('SIGINT', () => void shutdown('SIGINT'));
process.on('SIGTERM', () => void shutdown('SIGTERM'));
process.on('unhandledRejection', error => logErr('Unhandled rejection:', safeError(error)));
process.on('uncaughtException', error => { logErr('Uncaught exception:', safeError(error)); void shutdown('uncaughtException', 1); });

if (config.problems.length) {
  logErr('Config errors:', config.problems.join('; '));
  process.exit(1);
}

// Diagnose-only mode deliberately avoids Discord login and requires no token.
if (diagnoseOnly) {
  log('Lavalink configuration:');
  for (const n of config.nodes) log(`${n.name}: ${n.host}:${n.port} secure=${n.secure}`);
  log('Use /diagnose in Discord to check connectivity (requires a bot User-Id).');
  process.exit(0);
}

const commands = [
  new SlashCommandBuilder().setName('play').setDescription('Play a YouTube or SoundCloud song')
    .addStringOption(o => o.setName('song').setDescription('Link or title').setRequired(true).setMaxLength(200).setAutocomplete(true)),
  new SlashCommandBuilder().setName('skip').setDescription('Skip to the next song'),
  new SlashCommandBuilder().setName('stop').setDescription('Stop and disconnect the bot'),
  new SlashCommandBuilder().setName('queue').setDescription('Show the queue'),
  new SlashCommandBuilder().setName('pause').setDescription('Pause playback'),
  new SlashCommandBuilder().setName('resume').setDescription('Resume playback'),
  new SlashCommandBuilder().setName('volume').setDescription('Set the volume (10-150)')
    .addIntegerOption(o => o.setName('level').setDescription('Volume percentage').setRequired(true).setMinValue(10).setMaxValue(150)),
  new SlashCommandBuilder().setName('nowplaying').setDescription('Show the current song'),
  new SlashCommandBuilder().setName('loop').setDescription('Set the repeat mode')
    .addStringOption(o => o.setName('mode').setDescription('Repeat mode').setRequired(true)
      .addChoices({ name: 'Off', value: 'off' }, { name: 'Track', value: 'track' }, { name: 'Queue', value: 'queue' })),
  new SlashCommandBuilder().setName('shuffle').setDescription('Shuffle the queue'),
  new SlashCommandBuilder().setName('remove').setDescription('Remove a song from the queue')
    .addIntegerOption(o => o.setName('position').setDescription('Position in the queue').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('seek').setDescription('Jump to a specific point in the song')
    .addIntegerOption(o => o.setName('seconds').setDescription('Second to jump to').setRequired(true).setMinValue(0)),
  new SlashCommandBuilder().setName('clear').setDescription('Clear the queue (does not stop the current song)'),
  new SlashCommandBuilder().setName('movequeue').setDescription('Move a song within the queue')
    .addIntegerOption(o => o.setName('from').setDescription('Current position').setRequired(true).setMinValue(1))
    .addIntegerOption(o => o.setName('to').setDescription('New position').setRequired(true).setMinValue(1)),
  new SlashCommandBuilder().setName('playnext').setDescription('Play a song right after the current one')
    .addStringOption(o => o.setName('song').setDescription('Link or title').setRequired(true).setMaxLength(200)),
  new SlashCommandBuilder().setName('dedupe').setDescription('Remove duplicate songs from the queue'),
  new SlashCommandBuilder().setName('filters').setDescription('Apply an audio effect')
    .addStringOption(o => o.setName('preset').setDescription('Effect').setRequired(true)
      .addChoices(...Object.keys(FILTER_PRESETS).map(name => ({ name, value: name })))),
  new SlashCommandBuilder().setName('resetfilters').setDescription('Remove all audio effects'),
  new SlashCommandBuilder().setName('247').setDescription('Toggle 24/7 mode (never auto-disconnect on an empty queue)')
    .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)),
  new SlashCommandBuilder().setName('restore').setDescription('Reload the last saved queue into this voice channel'),
  new SlashCommandBuilder().setName('stoplocal').setDescription('Stop the local fallback engine (used when Lavalink is unavailable)'),
  new SlashCommandBuilder().setName('previous').setDescription('Go back to the previously played song'),
  new SlashCommandBuilder().setName('replay').setDescription('Restart the current song from the beginning'),
  new SlashCommandBuilder().setName('autoplay').setDescription('Toggle autoplay (keep playing related songs when the queue ends)')
    .addBooleanOption(o => o.setName('enabled').setDescription('On/off').setRequired(true)),
  new SlashCommandBuilder().setName('history').setDescription('Show recently played songs'),
  new SlashCommandBuilder().setName('favorite').setDescription('Manage your favorite songs')
    .addSubcommand(s => s.setName('add').setDescription('Add the current song to favorites'))
    .addSubcommand(s => s.setName('list').setDescription('List saved favorites'))
    .addSubcommand(s => s.setName('play').setDescription('Queue a favorite by position')
      .addIntegerOption(o => o.setName('position').setDescription('Position in the favorites list').setRequired(true).setMinValue(1)))
    .addSubcommand(s => s.setName('remove').setDescription('Remove a favorite by position')
      .addIntegerOption(o => o.setName('position').setDescription('Position in the favorites list').setRequired(true).setMinValue(1))),
  new SlashCommandBuilder().setName('playlist').setDescription('Manage saved playlists')
    .addSubcommand(s => s.setName('save').setDescription('Save the current queue as a playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true).setMaxLength(60)))
    .addSubcommand(s => s.setName('play').setDescription('Queue a saved playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true)))
    .addSubcommand(s => s.setName('list').setDescription('List saved playlists'))
    .addSubcommand(s => s.setName('delete').setDescription('Delete a saved playlist')
      .addStringOption(o => o.setName('name').setDescription('Playlist name').setRequired(true).setAutocomplete(true))),
  new SlashCommandBuilder().setName('diagnose').setDescription('Lavalink diagnostics (admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addBooleanOption(o => o.setName('youtube').setDescription('Test a song search')),
].map(c => c.toJSON());

// F-30: local extraction fallback, used only when every Lavalink node is
// down. Lazily initialized on first actual need so a healthy Lavalink setup
// never pays the yt-dlp/FFmpeg probe cost. Single instance because this bot
// is single-guild (config.guildId gate in InteractionCreate below).
let fallback = null;
async function getFallback() {
  if (fallback) return fallback;
  const runtime = { potReady: false };
  const { ytdlp, ffmpeg } = await resolveBinaries(config, log);
  runtime.ytdlp = ytdlp;
  runtime.ffmpeg = ffmpeg;
  if (!ytdlp.ok || !ffmpeg.ok)
    throw new UserError(`Local fallback unavailable: ${!ytdlp.ok ? `yt-dlp - ${ytdlp.error}` : `FFmpeg - ${ffmpeg.error}`}`);
  const youtube = new YouTube(config, runtime);
  fallback = { youtube, engine: new LocalEngine(youtube, { log }) };
  return fallback;
}

function voiceAccess(interaction, existing = null) {
  const voice = interaction.member?.voice?.channel;
  if (!voice) throw new UserError('Join a voice channel first.');
  if (existing?.voiceChannelId && existing.voiceChannelId !== voice.id) throw new UserError('The bot is already playing in another voice channel.');
  return voice;
}

// Optional DJ role (DJ_ROLE_ID): when unset, behavior is unchanged from
// before (anyone in the voice channel can control playback).
function requireDJ(interaction) {
  if (!config.djRoleId) return;
  if (interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) return;
  if (interaction.member?.roles?.cache?.has(config.djRoleId)) return;
  throw new UserError('You need the DJ role to use this command.');
}
function djGuard(interaction, existing = null) { const v = voiceAccess(interaction, existing); requireDJ(interaction); return v; }

// Per-user /play cooldown, cheap protection against hammering the shared
// public Lavalink nodes' search endpoint. PLAY_COOLDOWN_MS=0 disables it.
const lastPlayAt = new Map();
function checkPlayCooldown(userId) {
  if (!config.playCooldownMs) return;
  const now = Date.now();
  const last = lastPlayAt.get(userId) || 0;
  if (now - last < config.playCooldownMs) throw new UserError('Please wait a moment before using /play again.');
  lastPlayAt.set(userId, now);
}

// F-20/F-21: saved playlists + favorites, stored separately from the live
// queue snapshot (src/persistence.mjs's `library` section) so they survive
// independently of whatever is currently queued.
function getLibrary(guildId) {
  return persistence.loadLibrary()[guildId] || { favorites: [], playlists: {} };
}
async function updateLibrary(guildId, mutate) {
  const lib = persistence.loadLibrary();
  const entry = lib[guildId] || { favorites: [], playlists: {} };
  mutate(entry);
  lib[guildId] = entry;
  await persistence.saveLibrary(lib);
  return entry;
}

// F-34: best-effort voice channel status (Discord's "Set Voice Channel
// Status" endpoint). Requires the SET_VOICE_CHANNEL_STATUS permission; if the
// bot doesn't have it, this silently no-ops rather than failing playback.
async function setVoiceStatus(channelId, status) {
  if (!channelId) return;
  try { await client.rest.put(`/channels/${channelId}/voice-status`, { body: { status: String(status).slice(0, 500) } }); } catch { /* missing permission or old client - non-fatal */ }
}
async function refreshVoiceStatus(gp) {
  if (!gp?.voiceChannelId) return;
  const status = gp.current ? `🎵 ${gp.current.song.title}` : gp.items.length ? '⏸️ Queue waiting' : '';
  await setVoiceStatus(gp.voiceChannelId, status);
}
function stopPlayer(gp) {
  const channelId = gp.voiceChannelId;
  gp.stop();
  if (channelId) void setVoiceStatus(channelId, '');
}

// F-36: lazily constructed, since it needs no setup when Spotify links are
// never used (and gives a clear error, not a crash, when not configured).
let spotify = null;
function getSpotify() { return spotify ??= new SpotifyResolver(config); }
async function resolveSpotify(url) {
  const items = await getSpotify().resolve(url);
  if (!items.length) throw new UserError('No tracks found on that Spotify link.');
  // Metadata only: Spotify never provides playable audio, so every item
  // becomes a normal YouTube/SoundCloud search - reuses the same
  // multi-track enqueue path as a regular YouTube/SoundCloud playlist (F-19).
  const first = await manager.resolve(items[0].query);
  if (items.length > 1) {
    first.playlistName = 'Spotify';
    first.playlistExtra = [];
    for (const it of items.slice(1)) {
      try { first.playlistExtra.push(await manager.resolve(it.query)); } catch { /* one bad match shouldn't fail the whole playlist */ }
    }
  }
  return first;
}
async function resolveSong(input) {
  return SpotifyResolver.isSpotifyUrl(input) ? resolveSpotify(input) : manager.resolve(input);
}

async function handlePlayLocal(interaction) {
  const voice = voiceAccess(interaction, players.peek(interaction.guildId));
  if (!voice.joinable || !voice.speakable) throw new UserError('Missing Connect/Speak permissions.');
  // Engine-ownership guard, mirrored from handlePlay: never join locally
  // while the Lavalink-backed GuildPlayer already owns this guild's voice.
  const existing = players.peek(interaction.guildId);
  if (existing?.voiceChannelId) throw new UserError('The Lavalink engine is already connected in this server.');
  await interaction.deferReply();
  const { youtube, engine } = await getFallback();
  const song = await youtube.resolve(interaction.options.getString('song', true));
  await engine.join(voice);
  const position = engine.enqueue(song);
  await interaction.editReply(
    `🆘 Lavalink is unavailable - playing locally (fallback): **${song.title}** (${fmtTime(song.duration)})${position > 1 ? ` [#${position} in the local queue]` : ''}.`,
  );
}

async function handlePlay(interaction) {
  const voice = voiceAccess(interaction, players.peek(interaction.guildId));
  if (!voice.joinable || !voice.speakable) throw new UserError('Missing Connect/Speak permissions.');
  // Engine-ownership guard: never let the Lavalink path join a guild's voice
  // while the local fallback engine already owns it (see src/localEngine.mjs).
  if (fallback?.engine.active) throw new UserError('The local fallback engine is active in this server. Stop it with /stoplocal, then try again.');
  const existing = players.peek(interaction.guildId);
  if (existing?.items.length >= config.queueLimit) throw new UserError(`The queue is full (${config.queueLimit}).`);
  checkPlayCooldown(interaction.user.id);
  // Lavalink down entirely (not just slow)? Hand this one /play off to the
  // local fallback engine instead of throwing "no node available" at the user.
  if (!(await manager.available([], 1500)).length) return handlePlayLocal(interaction);
  await interaction.deferReply();
  const started = Date.now();
  const gp = players.get(interaction.guild);
  gp.textChannel = interaction.channel;
  // Lavalink extraction and Discord voice gateway handshake run concurrently.
  const voiceDone = gp.ensureConnected(voice).then(() => ({ ok: true }), error => ({ ok: false, error }));
  try {
    const song = await resolveSong(interaction.options.getString('song', true));
    if (!song.isStream && song.duration > config.maxLengthSeconds)
      throw new UserError(`That song is ${fmtTime(song.duration)}. The limit is ${fmtTime(config.maxLengthSeconds)}.`);
    const connection = await voiceDone;
    if (!connection.ok) throw connection.error;
    if (gp.disposed) throw new UserError('Playback has stopped.');
    const position = gp.enqueue(song);
    log(`[${interaction.guildId}] Search + voice completed in ${Date.now() - started}ms, node=${song.nodeName}`);
    // F-19: a playlist URL enqueues every track it returned, up to the queue limit.
    let added = 1, skipped = 0;
    if (song.playlistExtra?.length) {
      for (const extra of song.playlistExtra) {
        if (gp.items.length >= config.queueLimit) { skipped += song.playlistExtra.length - (added - 1); break; }
        if (!extra.isStream && extra.duration > config.maxLengthSeconds) { skipped++; continue; }
        gp.enqueue(extra);
        added++;
      }
    }
    const summary = added > 1
      ? `🎵 Playlist${song.playlistName ? ` **${song.playlistName}**` : ''}: added ${added} songs${skipped ? `, ${skipped} skipped (too long / queue full)` : ''}.`
      : position ? `🎵 Queued (#${position}): **${song.title}** (${fmtTime(song.duration)})` : `▶️ Now playing: **${song.title}** (${fmtTime(song.duration)})`;
    await interaction.editReply({ content: summary, allowedMentions: { parse: [] } });
  } catch (error) {
    // Don't strand an empty bot in voice if lookup fails.
    void voiceDone.then(() => {
      if (!gp.disposed && !gp.current && !gp.items.length) stopPlayer(gp);
    });
    throw error;
  }
}

async function handlePlayNext(interaction) {
  const voice = djGuard(interaction, players.peek(interaction.guildId));
  if (!voice.joinable || !voice.speakable) throw new UserError('Missing Connect/Speak permissions.');
  const existing = players.peek(interaction.guildId);
  if (existing?.items.length >= config.queueLimit) throw new UserError(`The queue is full (${config.queueLimit}).`);
  checkPlayCooldown(interaction.user.id);
  await interaction.deferReply();
  const gp = players.get(interaction.guild);
  gp.textChannel = interaction.channel;
  const voiceDone = gp.ensureConnected(voice).then(() => ({ ok: true }), error => ({ ok: false, error }));
  try {
    const song = await resolveSong(interaction.options.getString('song', true));
    if (!song.isStream && song.duration > config.maxLengthSeconds)
      throw new UserError(`That song is ${fmtTime(song.duration)}. The limit is ${fmtTime(config.maxLengthSeconds)}.`);
    const connection = await voiceDone;
    if (!connection.ok) throw connection.error;
    if (gp.disposed) throw new UserError('Playback has stopped.');
    gp.playNext(song);
    await interaction.editReply({ content: `⏭️ Up next: **${song.title}** (${fmtTime(song.duration)})`, allowedMentions: { parse: [] } });
  } catch (error) {
    void voiceDone.then(() => { if (!gp.disposed && !gp.current && !gp.items.length) stopPlayer(gp); });
    throw error;
  }
}

async function handleRestore(interaction) {
  const voice = djGuard(interaction, players.peek(interaction.guildId));
  if (!voice.joinable || !voice.speakable) throw new UserError('Missing Connect/Speak permissions.');
  const saved = persistence.load()[interaction.guildId];
  if (!saved?.songs?.length) throw new UserError('No saved queue found for this server.');
  await interaction.deferReply();
  const gp = players.get(interaction.guild);
  gp.textChannel = interaction.channel;
  await gp.ensureConnected(voice);
  if (gp.disposed) throw new UserError('Playback has stopped.');
  gp.loopMode = saved.loopMode || 'off';
  gp.sticky = Boolean(saved.sticky);
  gp.autoplay = Boolean(saved.autoplay);
  if (saved.filters) await gp.setFilters(saved.filters).catch(() => {});
  if (Number.isFinite(saved.volume)) gp.volume = saved.volume;
  let restored = 0, failed = 0;
  for (const s of saved.songs) {
    try {
      // Re-resolved from scratch: an old `encoded`/`nodeName` is never safe to reuse
      // across a restart, so this intentionally restores the queue, not an exact state.
      const song = await manager.resolve(s.query || s.url);
      gp.enqueue(song);
      restored++;
    } catch { failed++; }
  }
  await interaction.editReply(`♻️ Queue restored: ${restored} songs${failed ? `, ${failed} could not be found` : ''}.`);
}

async function handleFavorite(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const gp = players.peek(guildId);
  if (sub === 'add') {
    djGuard(interaction, gp);
    if (!gp?.current) throw new UserError('Nothing is playing.');
    const s = gp.current.song;
    await updateLibrary(guildId, lib => lib.favorites.push({ title: s.title, author: s.author, url: s.url, query: s.query, duration: s.duration, isStream: s.isStream }));
    await interaction.reply(`⭐ Added to favorites: **${s.title}**`);
  } else if (sub === 'list') {
    const lib = getLibrary(guildId);
    const lines = lib.favorites.length ? lib.favorites.map((f, i) => `${i + 1}. **${f.title}** (${fmtTime(f.duration)})`) : ['No favorites saved yet.'];
    await interaction.reply(ephemeral(lines.join('\n').slice(0, 1900)));
  } else if (sub === 'play') {
    const voice = djGuard(interaction, gp);
    const lib = getLibrary(guildId);
    const fav = lib.favorites[interaction.options.getInteger('position', true) - 1];
    if (!fav) throw new UserError('Invalid position.');
    await interaction.deferReply();
    const target = players.get(interaction.guild);
    target.textChannel = interaction.channel;
    await target.ensureConnected(voice);
    const song = await resolveSong(fav.query || fav.url);
    target.enqueue(song);
    await interaction.editReply(`⭐ Queued: **${song.title}**`);
  } else if (sub === 'remove') {
    requireDJ(interaction);
    const pos = interaction.options.getInteger('position', true);
    let removed = null;
    await updateLibrary(guildId, lib => { removed = lib.favorites.splice(pos - 1, 1)[0] || null; });
    if (!removed) throw new UserError('Invalid position.');
    await interaction.reply(`🗑️ Removed favorite: **${removed.title}**`);
  }
}

async function handlePlaylist(interaction) {
  const sub = interaction.options.getSubcommand();
  const guildId = interaction.guildId;
  const gp = players.peek(guildId);
  if (sub === 'save') {
    djGuard(interaction, gp);
    if (!gp || (!gp.current && !gp.items.length)) throw new UserError('Nothing to save - the queue is empty.');
    const name = interaction.options.getString('name', true);
    const queue = gp.current ? [gp.current.song, ...gp.items] : gp.items;
    const songs = queue.map(s => ({ title: s.title, author: s.author, url: s.url, query: s.query, duration: s.duration, isStream: s.isStream }));
    await updateLibrary(guildId, lib => { lib.playlists[name] = songs; });
    await interaction.reply(`💾 Saved playlist **${name}** (${songs.length} songs).`);
  } else if (sub === 'list') {
    const lib = getLibrary(guildId);
    const names = Object.keys(lib.playlists);
    const lines = names.length ? names.map((n, i) => `${i + 1}. ${n} (${lib.playlists[n].length} songs)`) : ['No saved playlists.'];
    await interaction.reply(ephemeral(lines.join('\n').slice(0, 1900)));
  } else if (sub === 'delete') {
    requireDJ(interaction);
    const name = interaction.options.getString('name', true);
    const lib = getLibrary(guildId);
    if (!lib.playlists[name]) throw new UserError('No playlist with that name.');
    await updateLibrary(guildId, l => { delete l.playlists[name]; });
    await interaction.reply(`🗑️ Deleted playlist **${name}**.`);
  } else if (sub === 'play') {
    const voice = djGuard(interaction, gp);
    const name = interaction.options.getString('name', true);
    const songs = getLibrary(guildId).playlists[name];
    if (!songs?.length) throw new UserError('No playlist with that name.');
    await interaction.deferReply();
    const target = players.get(interaction.guild);
    target.textChannel = interaction.channel;
    await target.ensureConnected(voice);
    let added = 0, failed = 0;
    for (const s of songs) {
      try { target.enqueue(await resolveSong(s.query || s.url)); added++; } catch { failed++; }
    }
    await interaction.editReply(`📀 Playlist **${name}**: queued ${added} songs${failed ? `, ${failed} failed` : ''}.`);
  }
}

async function handleDiagnose(interaction) {
  if (!interaction.memberPermissions?.has(PermissionFlagsBits.Administrator)) throw new UserError('Administrators only.');
  await interaction.deferReply({ flags: MessageFlags.Ephemeral });
  const lines = diagnostics();
  if (interaction.options.getBoolean('youtube')) {
    const then = Date.now();
    try {
      const song = await manager.resolve('https://www.youtube.com/watch?v=jNQXAC9IVRw');
      lines.push(`YouTube lookup: OK ${Date.now() - then}ms via ${song.nodeName}; NOT a Discord audio test`);
    } catch (e) { lines.push(`YouTube lookup: FAIL (${safeError(e)})`); }
  }
  const gp = players.peek(interaction.guildId);
  if (gp) lines.push(`Guild: current=${gp.current?.song.title || 'none'}, queued=${gp.items.length}, voice=${gp.voiceChannelId ? 'joined' : 'left'}`);
  await interaction.editReply(`\`\`\`\n${lines.join('\n').replace(/\`\`\`/g, "'''").slice(0, 1880)}\n\`\`\``);
}

// F-31: keep one persistent "now playing" message per guild, edited in place
// on every relevant state change (GuildPlayer emits 'update') instead of
// sending a new message each time - avoids channel clutter.
async function refreshController(gp) {
  if (!gp || !gp.textChannel || closing) return;
  if (gp.disposed) {
    if (gp.controllerMessage) { await gp.controllerMessage.delete().catch(() => {}); gp.controllerMessage = null; }
    return;
  }
  const payload = buildControllerPayload(gp);
  try {
    if (gp.controllerMessage) await gp.controllerMessage.edit(payload);
    else gp.controllerMessage = await gp.textChannel.send(payload);
  } catch (e) {
    logErr('Controller update failed:', safeError(e));
    gp.controllerMessage = null;
  }
}
players.on('guildUpdate', gp => { void refreshController(gp); void refreshVoiceStatus(gp); });

client = new Client({ intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates] });
client.on(Events.Raw, packet => players.onRaw(packet, client.user?.id));
client.on(Events.InteractionCreate, async interaction => {
  if (interaction.guildId !== config.guildId || closing) return;

  // F-17/F-18: Discord's own autocomplete dropdown on /play doubles as the
  // "search result picker" - no separate select-menu flow needed.
  if (interaction.isAutocomplete()) {
    if (interaction.commandName === 'playlist') {
      const focused = (interaction.options.getFocused() || '').toLowerCase();
      const names = Object.keys(getLibrary(interaction.guildId).playlists).filter(n => n.toLowerCase().includes(focused)).slice(0, 25);
      await interaction.respond(names.map(n => ({ name: n, value: n }))).catch(() => {});
      return;
    }
    if (interaction.commandName !== 'play') return;
    const focused = interaction.options.getFocused();
    if (!focused || focused.length < 2 || /^https?:\/\//i.test(focused)) { await interaction.respond([]).catch(() => {}); return; }
    try {
      const results = await manager.search(focused);
      await interaction.respond(results.map(r => ({
        name: `${r.title}${r.author ? ` - ${r.author}` : ''}`.slice(0, 100),
        value: (r.url || r.title).slice(0, 100),
      })));
    } catch { await interaction.respond([]).catch(() => {}); }
    return;
  }

  if (interaction.isButton()) {
    const [ns, action, curId] = interaction.customId.split(':');
    const gp = players.peek(interaction.guildId);
    try {
      if (ns === 'qpage') {
        await interaction.update(buildQueuePayload(gp || { items: [] }, Number(action) || 0));
        return;
      }
      if (ns !== 'tctl') return;
      if (action === 'queue') { await interaction.reply({ ...buildQueuePayload(gp || { items: [] }, 0), flags: MessageFlags.Ephemeral }); return; }
      if (!gp) { await interaction.reply(ephemeral('Nothing is playing.')); return; }
      djGuard(interaction, gp);
      // Stale-button guard: reject a click that refers to a track that has
      // since ended, rather than silently acting on whatever is current now.
      if (curId !== '0' && gp.current?.id !== curId && ['playpause', 'skip'].includes(action)) {
        await interaction.reply(ephemeral('This control is no longer valid (the song has changed).'));
        return;
      }
      switch (action) {
        case 'playpause': await gp.setPaused(!gp.current?.paused); break;
        case 'skip': gp.skip(); break;
        case 'stop': stopPlayer(gp); break;
        case 'shuffle': gp.shuffle(); break;
        case 'loop': gp.setLoop(gp.loopMode === 'off' ? 'queue' : gp.loopMode === 'queue' ? 'track' : 'off'); break;
        default: await interaction.reply(ephemeral('Unknown action.')); return;
      }
      await interaction.deferUpdate();
    } catch (error) {
      const message = error instanceof UserError ? error.message : safeError(error);
      await interaction.reply(ephemeral(`Error: ${message}`)).catch(() => {});
    }
    return;
  }

  if (!interaction.isChatInputCommand()) return;
  try {
    const gp = players.peek(interaction.guildId);
    switch (interaction.commandName) {
      case 'play': await handlePlay(interaction); break;
      case 'skip': {
        djGuard(interaction, gp);
        const skipped = gp?.skip();
        await interaction.reply(skipped ? `⏭️ Skipped: **${skipped.title}**` : ephemeral('Nothing is playing.'));
        break;
      }
      case 'stop': {
        djGuard(interaction, gp);
        if (gp) { stopPlayer(gp); await interaction.reply('⏹️ Stopped.'); }
        else await interaction.reply(ephemeral('Nothing is playing.'));
        break;
      }
      case 'previous': {
        djGuard(interaction, gp);
        const prev = gp?.previous();
        await interaction.reply(prev ? `⏮️ Back to: **${prev.title}**` : ephemeral('No previous song in history.'));
        break;
      }
      case 'replay': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        await gp.replay();
        await interaction.reply('🔂 Replaying from the start.');
        break;
      }
      case 'autoplay': {
        djGuard(interaction, gp);
        const gp2 = gp || players.get(interaction.guild);
        gp2.autoplay = interaction.options.getBoolean('enabled', true);
        await interaction.reply(gp2.autoplay ? '📻 Autoplay enabled.' : '📻 Autoplay disabled.');
        break;
      }
      case 'history': {
        const lines = gp?.history.length ? gp.history.slice(-10).reverse().map((s, i) => `${i + 1}. ${s.title} (${fmtTime(s.duration)})`) : ['No playback history yet.'];
        await interaction.reply(ephemeral(lines.join('\n').slice(0, 1900)));
        break;
      }
      case 'favorite': await handleFavorite(interaction); break;
      case 'playlist': await handlePlaylist(interaction); break;
      case 'queue': {
        const lines = [gp?.current ? `▶️ ${gp.current.song.title} (${fmtTime(gp.current.song.duration)})` : 'Nothing is playing.'];
        if (gp) lines.push(...gp.items.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${fmtTime(t.duration)})`));
        if (gp?.items.length > 10) lines.push(`...and ${gp.items.length - 10} more`);
        await interaction.reply({ content: lines.join('\n').slice(0, 1900), allowedMentions: { parse: [] } });
        break;
      }
      case 'pause': {
        djGuard(interaction, gp);
        if (!gp?.current) throw new UserError('Nothing is playing.');
        await gp.setPaused(true);
        await interaction.reply('⏸️ Paused.');
        break;
      }
      case 'resume': {
        djGuard(interaction, gp);
        if (!gp?.current) throw new UserError('Nothing is playing.');
        await gp.setPaused(false);
        await interaction.reply('▶️ Playback resumed.');
        break;
      }
      case 'volume': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const level = interaction.options.getInteger('level', true);
        await gp.setVolume(level);
        await interaction.reply(`🔊 Volume: ${level}%`);
        break;
      }
      case 'nowplaying': {
        const cur = gp?.current;
        const elapsed = cur?.song.isStream ? 'LIVE' : `${fmtTime(Math.round((cur?.position || 0) / 1000))} / ${fmtTime(cur?.song.duration)}`;
        await interaction.reply(cur ? `🎶 **${cur.song.title}** | ${cur.song.author} | ${elapsed} | ${cur.node?.name || 'loading'}` : ephemeral('Nothing is playing.'));
        break;
      }
      case 'loop': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const mode = interaction.options.getString('mode', true);
        gp.setLoop(mode);
        const label = { off: 'Off', track: 'Current track', queue: 'Whole queue' }[mode];
        await interaction.reply(`🔁 Repeat: ${label}`);
        break;
      }
      case 'shuffle': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const count = gp.shuffle();
        await interaction.reply(count ? `🔀 Queue shuffled (${count} songs).` : ephemeral('The queue is empty.'));
        break;
      }
      case 'remove': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const removed = gp.removeAt(interaction.options.getInteger('position', true));
        await interaction.reply(removed ? `🗑️ Removed: **${removed.title}**` : ephemeral('Invalid position.'));
        break;
      }
      case 'seek': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        await gp.seek(interaction.options.getInteger('seconds', true));
        await interaction.reply(`⏩ Jumped to ${fmtTime(interaction.options.getInteger('seconds', true))}.`);
        break;
      }
      case 'clear': {
        djGuard(interaction, gp);
        const count = gp ? gp.clear() : 0;
        await interaction.reply(count ? `🧹 Cleared (${count} songs).` : ephemeral('The queue is already empty.'));
        break;
      }
      case 'movequeue': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const ok = gp.move(interaction.options.getInteger('from', true), interaction.options.getInteger('to', true));
        await interaction.reply(ok ? '↕️ Moved.' : ephemeral('Invalid positions.'));
        break;
      }
      case 'playnext': await handlePlayNext(interaction); break;
      case 'dedupe': {
        djGuard(interaction, gp);
        const count = gp ? gp.dedupe() : 0;
        await interaction.reply(count ? `🧹 Removed ${count} duplicate songs.` : ephemeral('No duplicates found.'));
        break;
      }
      case 'filters': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        const preset = interaction.options.getString('preset', true);
        await gp.setFilters(FILTER_PRESETS[preset]);
        await interaction.reply(`🎛️ Effect applied: ${preset}`);
        break;
      }
      case 'resetfilters': {
        djGuard(interaction, gp);
        if (!gp) throw new UserError('Nothing is playing.');
        await gp.resetFilters();
        await interaction.reply('🎛️ Effects reset.');
        break;
      }
      case '247': {
        djGuard(interaction, gp);
        const gp2 = gp || players.get(interaction.guild);
        gp2.sticky = interaction.options.getBoolean('enabled', true);
        await interaction.reply(gp2.sticky ? '♾️ 24/7 mode enabled.' : '♾️ 24/7 mode disabled.');
        break;
      }
      case 'restore': await handleRestore(interaction); break;
      case 'stoplocal': {
        djGuard(interaction);
        if (!fallback?.engine.active) { await interaction.reply(ephemeral('The local fallback engine is not active.')); break; }
        fallback.engine.stop();
        await interaction.reply('⏹️ Local engine stopped. Lavalink can be used again with /play.');
        break;
      }
      case 'diagnose': await handleDiagnose(interaction); break;
    }
  } catch (error) {
    const message = error instanceof UserError ? error.message : safeError(error);
    if (!(error instanceof UserError)) logErr(`/${interaction.commandName} failed: ${safeError(error)}`);
    const output = `Error: ${message}`.slice(0, 1800);
    if (interaction.deferred || interaction.replied) await interaction.editReply({ content: output, allowedMentions: { parse: [] } }).catch(() => {});
    else await interaction.reply(ephemeral(output)).catch(() => {});
  }
});
client.once(Events.ClientReady, async () => {
  log(`Discord connected: ${client.user.tag}`);
  manager.start(client.user.id);
  for (const line of diagnostics()) log(line);
  try {
    const rest = new REST({ version: '10' }).setToken(config.token);
    await rest.put(Routes.applicationGuildCommands(client.user.id, config.guildId), { body: commands });
    log(`Slash commands registered: ${commands.map(c => c.name).join('/')}`);
  } catch (error) { logErr('Slash registration:', safeError(error)); }
  client.user.setPresence({ activities: [{ name: 'music', type: 2 }], status: 'online' }); // type 2 = Listening
  persistence.startAutosave(AUTOSAVE_MS, () => players.snapshotAll());
});
client.on(Events.Error, e => logErr('Discord error:', safeError(e)));
client.on(Events.ShardDisconnect, (_event, id) => log(`Discord shard ${id} disconnected`));
client.on(Events.ShardResume, id => log(`Discord shard ${id} resumed`));

if (!process.stdin.isTTY) {
  input = readline.createInterface({ input: process.stdin }).on('line', line => {
    const command = line.trim().toLowerCase();
    if (command === 'diagnose' || command === 'status') diagnostics().forEach(log);
    else if (command === 'stop' || command === 'exit') void shutdown('console stop');
    else if (command) log('Console: diagnose | stop');
  });
}
try { await client.login(config.token); }
catch (error) { logErr('Discord login:', safeError(error)); await shutdown('login failed', 1); }

// Only Discord and Lavalink are required. All public nodes below are configurable.
// APP_DIR/CACHE_DIR and the yt-dlp/FFmpeg/cookies fields below exist for the
// local-extraction FALLBACK engine only (src/localEngine.mjs, used when every
// Lavalink node is unavailable) - the primary Lavalink v4 path never reads them.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
export const CACHE_DIR = path.join(APP_DIR, '.cache');

const env = process.env;
const bool = (name, fallback) => {
  const raw = env[name]?.trim().toLowerCase();
  return raw == null || raw === '' ? fallback : ['1', 'yes', 'true', 'on'].includes(raw);
};
const number = (name, fallback, min, max) => {
  const n = Number.parseInt(env[name], 10);
  return Number.isInteger(n) && n >= min && n <= max ? n : fallback;
};

// Published public v4 nodes. These are convenience defaults, not guaranteed uptime.
// They can be replaced entirely using LAVALINK_NODES.
const DEFAULT_NODES = [
  { name: 'Trinium', host: 'lavalink-v4.triniumhost.com', port: 443, password: 'free', secure: true },
  { name: 'Serenetia', host: 'lavalinkv4.serenetia.com', port: 443, password: 'https://seretia.link/discord', secure: true },
  { name: 'Jirayu', host: 'lavalink.jirayu.net', port: 443, password: 'youshallnotpass', secure: true },
  { name: 'Nazha', host: 'lavalink.nazha.online', port: 443, password: 'nazhafreelava', secure: true },
];

function parseNodes(raw) {
  if (!raw?.trim()) return DEFAULT_NODES;
  let nodes;
  if (raw.trim().startsWith('[')) {
    nodes = JSON.parse(raw);
  } else {
    nodes = raw.split(';').filter(Boolean).map(record => {
      const [name, host, port, password, secure = 'true'] = record.split('|');
      return { name, host, port: Number(port), password, secure: secure.toLowerCase() !== 'false' };
    });
  }
  if (!Array.isArray(nodes) || !nodes.length || nodes.length > 10) throw new Error('LAVALINK_NODES must have 1 to 10 entries');
  for (const n of nodes) {
    if (!n.name || !/^[\w.-]{1,80}$/.test(n.host || '') || !Number.isInteger(Number(n.port)) || Number(n.port) < 1 || Number(n.port) > 65535 || !n.password)
      throw new Error('Invalid Lavalink node entry. Use name|host|port|password|secure');
    n.port = Number(n.port);
    n.secure = n.secure !== false && String(n.secure).toLowerCase() !== 'false';
  }
  if (new Set(nodes.map(n => n.name)).size !== nodes.length) throw new Error('Lavalink node names must be unique');
  return nodes;
}

export function loadConfig() {
  const problems = [];
  if (!env.DISCORD_TOKEN?.trim()) problems.push('DISCORD_TOKEN missing');
  if (!/^\d{17,22}$/.test(env.GUILD_ID?.trim() || '')) problems.push('GUILD_ID missing or invalid');
  let nodes = [];
  try { nodes = parseNodes(env.LAVALINK_NODES); } catch (e) { problems.push(e.message); }
  const prefix = env.LAVALINK_SEARCH_PREFIX?.trim() || 'ytsearch';
  if (!['ytsearch', 'ytmsearch', 'scsearch'].includes(prefix)) problems.push('LAVALINK_SEARCH_PREFIX invalid');
  const cookiesPath = env.COOKIES_FILE?.trim() || path.join(APP_DIR, 'cookies.txt');
  return {
    token: env.DISCORD_TOKEN?.trim() || '', guildId: env.GUILD_ID?.trim() || '', nodes, problems,
    queueLimit: number('QUEUE_LIMIT', 30, 1, 200),
    maxLengthSeconds: number('MAX_SONG_MINUTES', 20, 1, 180) * 60,
    idleMs: number('IDLE_MINUTES', 15, 1, 120) * 60000,
    searchPrefix: prefix,
    searchFallback: bool('LAVALINK_SEARCH_FALLBACK', true),
    // F-30 local fallback engine only (binaries.mjs / youtube.mjs / potProvider.mjs):
    ytdlpPath: env.YTDLP_PATH?.trim() || null,
    ffmpegPath: env.FFMPEG_PATH?.trim() || null,
    autoInstallBinaries: bool('AUTO_INSTALL_BINARIES', true),
    cookiesFile: fs.existsSync(cookiesPath) ? cookiesPath : null,
    ipArgs: [],
    playerClients: env.YT_PLAYER_CLIENTS?.trim() || null,
    potEnabled: bool('POT_PROVIDER', false),
    potBaseUrl: env.POT_BASE_URL?.trim() || null,
    potPort: number('POT_PORT', 4416, 1, 65535),
    // Optional DJ role: when set, playback-control commands require it (or Administrator).
    // Unset (default) preserves the original "anyone in the voice channel" behavior.
    djRoleId: env.DJ_ROLE_ID?.trim() || null,
    // F-36 Spotify metadata resolution: requires the operator to register a
    // Spotify app and provide these. Without them, /play with a Spotify link
    // fails with a clear, specific error instead of silently doing nothing.
    spotifyClientId: env.SPOTIFY_CLIENT_ID?.trim() || null,
    spotifyClientSecret: env.SPOTIFY_CLIENT_SECRET?.trim() || null,
    playCooldownMs: number('PLAY_COOLDOWN_MS', 2000, 0, 60_000),
  };
}

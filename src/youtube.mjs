// YouTube resolution and live audio probing. Never cache signed media URLs.
import { execFile, spawn } from 'node:child_process';
import path from 'node:path';
import { promisify } from 'node:util';
import { childEnv } from './binaries.mjs';
import { CACHE_DIR } from './config.mjs';

const execFileAsync = promisify(execFile);
const YT_HOSTS = new Set(['youtube.com', 'www.youtube.com', 'm.youtube.com', 'music.youtube.com', 'youtu.be']);
const isWindows = process.platform === 'win32';
const METADATA_CACHE_MS = 10 * 60_000;
const METADATA_CACHE_MAX = 80;

function stopProbe(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return;
  try {
    if (!isWindows && child.pid) process.kill(-child.pid, 'SIGTERM');
    else child.kill('SIGTERM');
  } catch { try { child.kill('SIGTERM'); } catch { /* process already exited */ } }
  const timer = setTimeout(() => {
    if (child.exitCode === null && child.signalCode === null) {
      try { if (!isWindows && child.pid) process.kill(-child.pid, 'SIGKILL'); else child.kill('SIGKILL'); }
      catch { /* process already exited */ }
    }
  }, 2000);
  timer.unref();
  child.once('exit', () => clearTimeout(timer));
}

export class YouTube {
  constructor(config, runtime) {
    this.config = config;
    this.runtime = runtime;
    this.preferFallback = false; // learns working route from the real-byte probe
    this.metadataCache = new Map(); // reduce repeated searches, never cache signed audio URLs
  }

  get clients() {
    if (this.config.playerClients) return this.config.playerClients;
    // Using one client is faster than querying three clients per video.
    // With no working provider, let yt-dlp choose its own default clients.
    return this.runtime.potReady ? 'mweb' : null;
  }

  get hasAlternateRoute() {
    return Boolean(this.runtime.potReady || this.config.playerClients);
  }

  baseArgs({ fallback = false, metadataOnly = false } = {}) {
    const args = [
      ...this.config.ipArgs, '--ignore-config', '--no-warnings', '--no-progress', '--no-playlist',
      '--cache-dir', path.join(CACHE_DIR, 'yt-dlp'),
      '--js-runtimes', `node:${process.execPath}`,
      '--ffmpeg-location', this.runtime.ffmpeg.path,
      '--socket-timeout', '15',
    ];
    // On fallback deliberately avoid the provider/client override. This is
    // yt-dlp's independent extraction route, not a repeat of the same 403.
    if (!fallback && !metadataOnly && this.runtime.potReady) args.push(...this.runtime.pot.ytdlpArgs());
    else args.push('--no-plugin-dirs');
    if (!fallback && !metadataOnly && this.clients) {
      args.push('--extractor-args', `youtube:player_client=${this.clients}`);
    }
    if (this.config.cookiesFile) args.push('--cookies', this.config.cookiesFile);
    return args;
  }

  async run(args, timeout = 45_000, options = {}) {
    return execFileAsync(this.runtime.ytdlp.path, [...this.baseArgs(options), ...args], {
      timeout, maxBuffer: 8 * 1024 * 1024, env: childEnv(), windowsHide: true, killSignal: 'SIGKILL',
    });
  }

  async resolve(query) {
    const key = query.trim();
    const cached = this.metadataCache.get(key);
    if (cached) {
      if (cached.expires > Date.now()) {
        // Clone because command-specific timings must never leak between plays.
        this.metadataCache.delete(key);
        this.metadataCache.set(key, cached); // LRU
        return { ...cached.song };
      }
      this.metadataCache.delete(key);
    }
    const isUrl = /^https?:\/\//i.test(query);
    if (isUrl) {
      let parsed;
      try { parsed = new URL(query); } catch { throw new UserError('Invalid link.'); }
      if (!YT_HOSTS.has(parsed.hostname) || parsed.protocol !== 'https:') {
        throw new UserError('Only YouTube links or a search by name are accepted.');
      }
    }
    const target = isUrl ? query : `ytsearch1:${query}`;
    // Flat search avoids full media extraction when adding songs to the queue.
    const extra = isUrl ? ['-f', 'bestaudio/best'] : ['--flat-playlist'];
    let stdout;
    const args = [...extra, '--skip-download', '--print', '%(.{id,title,duration,live_status})j', '--', target];
    try {
      ({ stdout } = await this.run(args, 45_000, isUrl ? { fallback: this.preferFallback } : { metadataOnly: true }));
    } catch (e) {
      if (!isUrl || !isRecoverableYoutubeError(e?.stderr || e?.message)) throw new UserError(diagnose(e));
      try {
        ({ stdout } = await this.run(args, 45_000, { fallback: !this.preferFallback }));
      } catch (second) { throw new UserError(diagnose(second)); }
    }
    const line = stdout.trim().split('\n').find(Boolean);
    if (!line) throw new UserError('No results found.');
    let info;
    try { info = JSON.parse(line); }
    catch { throw new UserError('YouTube returned invalid metadata.'); }
    if (!info.id || !/^[\w-]{11}$/.test(info.id)) throw new UserError('Could not get a valid YouTube video.');
    if (info.live_status === 'is_live' || info.live_status === 'is_upcoming') throw new UserError('Live streams are not supported.');
    if (!Number.isFinite(Number(info.duration)) || Number(info.duration) <= 0) throw new UserError('Could not determine the song duration (live or unavailable).');
    if (Number(info.duration) > this.config.maxLengthSeconds) {
      throw new UserError(`The limit is ${this.config.maxLengthSeconds / 60} minutes per song.`);
    }
    const song = {
      id: info.id,
      title: String(info.title || 'YouTube').slice(0, 150),
      duration: Number(info.duration),
      url: `https://www.youtube.com/watch?v=${info.id}`,
    };
    this.metadataCache.set(key, { song, expires: Date.now() + METADATA_CACHE_MS });
    if (this.metadataCache.size > METADATA_CACHE_MAX) {
      this.metadataCache.delete(this.metadataCache.keys().next().value);
    }
    return { ...song };
  }

  // yt-dlp writes actual audio to stdout; FFmpeg converts it to Discord Opus.
  // No full-track downloads to disk and no signed media URLs stored in memory.
  streamArgs(url, { fallback = this.preferFallback } = {}) {
    return [
      ...this.baseArgs({ fallback }), '--quiet',
      '--max-filesize', '60M',
      '--match-filter', `duration <= ${this.config.maxLengthSeconds}`,
      '-f', 'bestaudio/best', '-o', '-', '--', url,
    ];
  }

  async probeStream({ fallback = false, timeoutMs = 30_000 } = {}) {
    const started = Date.now();
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    return new Promise(resolve => {
      const child = spawn(this.runtime.ytdlp.path, this.streamArgs(url, { fallback }), {
        stdio: ['ignore', 'pipe', 'pipe'], env: childEnv(), windowsHide: true,
        detached: !isWindows,
      });
      let bytes = 0;
      let stderr = '';
      let settled = false;
      const timeout = setTimeout(() => finish(false, 'No audio within probe timeout'), timeoutMs);
      timeout.unref?.();
      function finish(ok, detail) {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        stopProbe(child);
        resolve({ ok, detail: ok ? `received ${bytes} audio bytes in ${Date.now() - started} ms${fallback ? ' (fallback)' : ''}` : detail });
      }
      child.stderr.on('data', chunk => { stderr = (stderr + chunk).slice(-4000); });
      child.stdout.on('data', chunk => {
        bytes += chunk.length;
        if (bytes >= 64 * 1024) finish(true);
      });
      child.on('error', error => finish(false, diagnose(error)));
      child.on('close', code => {
        if (settled) return;
        if (code === 0 && bytes > 0) finish(true);
        else finish(false, diagnose({ stderr: stderr || `yt-dlp exited (${code}) without playable audio` }));
      });
    });
  }

  // Unlike --skip-download, this checks that the remote endpoint delivers
  // actual media bytes, not merely that yt-dlp can list available formats.
  async selfTest() {
    const primary = await this.probeStream();
    if (primary.ok) { this.preferFallback = false; return primary; }
    if (!this.hasAlternateRoute) return primary; // avoid repeating identical requests
    const fallback = await this.probeStream({ fallback: true });
    if (fallback.ok) {
      this.preferFallback = true; // avoid paying for the same failed request on every song
      return { ...fallback, detail: `${fallback.detail}; primary failed: ${primary.detail}` };
    }
    return { ok: false, detail: `primary: ${primary.detail}; fallback: ${fallback.detail}` };
  }
}

export class UserError extends Error {}

export function redact(text) {
  return String(text ?? '')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/[A-Za-z0-9_-]{23,28}\.[A-Za-z0-9_-]{6,7}\.[A-Za-z0-9_-]{27,}/g, '[token]');
}

export function isRecoverableYoutubeError(reason) {
  return /403|po token|requested format|no video formats|no playable audio|n challenge|botguard|sign in to confirm|not a bot|429/i.test(String(reason));
}

export function diagnose(error) {
  const raw = String(error?.stderr || error?.message || error || '');
  const lower = raw.toLowerCase();
  const tail = redact(raw.trim().split('\n').filter(l => /error/i.test(l)).slice(-1)[0] || raw.trim().split('\n').slice(-1)[0] || '').slice(0, 300);
  let hint = null;
  if (error?.code === 'ENOENT') hint = 'yt-dlp/FFmpeg missing (ENOENT).';
  else if (error?.code === 'EACCES') hint = 'Executable permission denied (EACCES).';
  else if (error?.killed || error?.signal === 'SIGKILL') hint = 'yt-dlp timed out; check YouTube/network.';
  else if (lower.includes('sign in to confirm') || lower.includes('not a bot')) hint = 'YouTube blocked this request (login/bot check). Cookies may help, but are not guaranteed.';
  else if (lower.includes('http error 429') || lower.includes('too many requests')) hint = 'YouTube rate limit (HTTP 429).';
  else if (lower.includes('http error 403')) hint = 'YouTube refused audio (HTTP 403). PO Token, access rights or server IP may be involved.';
  else if (lower.includes('requested format is not available') || lower.includes('only images are available')) hint = 'No playable audio formats (client/PO Token/JS challenge).';
  else if (lower.includes('n challenge') || lower.includes('javascript runtime') || lower.includes('js runtime') || lower.includes('ejs')) hint = 'YouTube JS challenge failed.';
  else if (lower.includes('po token') && (lower.includes('fail') || lower.includes('error'))) hint = 'PO Token provider error.';
  else if (lower.includes('private video') || lower.includes('video unavailable') || lower.includes('removed')) hint = 'Video unavailable or private.';
  else if (lower.includes('confirm your age')) hint = 'Age-restricted video.';
  else if (/getaddrinfo|name resolution|network is unreachable|timed out|connection refused|connection reset/.test(lower)) hint = 'Network problem reaching YouTube.';
  return hint ? `${hint}${tail ? ` [${tail}]` : ''}` : (tail || 'Eroare necunoscuta');
}

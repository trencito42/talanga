// Runs the BgUtils PO Token HTTP server (bgutil-ytdlp-pot-provider 2.0.2,
// vendored in vendor/bgutil-server) as a child of this Node process. It binds
// to 127.0.0.1 only, so nothing is exposed outside the container.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APP_DIR, CACHE_DIR } from './config.mjs';

export const POT_SERVER_DIR = path.join(APP_DIR, 'vendor', 'bgutil-server');
export const PLUGIN_DIR = path.join(APP_DIR, 'plugins');

const MAX_RESTARTS = 5;
const RESTART_WINDOW_MS = 10 * 60_000;

export class PotProvider {
  constructor(config, log = console.log) {
    this.config = config;
    this.log = log;
    this.external = Boolean(config.potBaseUrl);
    this.baseUrl = config.potBaseUrl || `http://127.0.0.1:${config.potPort}`;
    this.child = null;
    this.stopping = false;
    this.restarts = [];
    this.lastError = null;
    this.version = null;
    this.ready = false;
    this.onStatusChange = null;
  }

  setReady(value) {
    if (this.ready === value) return;
    this.ready = value;
    this.onStatusChange?.(value);
  }

  get pluginPresent() {
    return fs.existsSync(path.join(PLUGIN_DIR, 'bgutil-ytdlp-pot-provider', 'yt_dlp_plugins', 'extractor', 'getpot_bgutil_http.py'));
  }

  async start() {
    if (!this.config.potEnabled) { this.lastError = 'disabled by POT_PROVIDER=0'; return false; }
    if (!this.pluginPresent) { this.lastError = 'yt-dlp plugin missing in plugins/'; return false; }
    if (this.external) return this.waitReady(10_000);
    const entry = path.join(POT_SERVER_DIR, 'build', 'main.js');
    if (!fs.existsSync(entry)) { this.lastError = 'vendor/bgutil-server/build/main.js missing'; return false; }
    if (await this.ping()) {
      // Something already answers on the port (e.g. a previous instance that
      // survived a hard restart). It is localhost-only, so reuse it.
      this.log(`PO Token provider already running on ${this.baseUrl}, reusing it`);
      return true;
    }
    this.spawnChild(entry);
    return this.waitReady(45_000);
  }

  spawnChild(entry) {
    this.lastError = null;
    const child = spawn(process.execPath, [
      '--max-old-space-size=384', entry, '--port', String(this.config.potPort), '--host', '127.0.0.1',
    ], {
      cwd: POT_SERVER_DIR,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...minimalEnv(), XDG_CACHE_HOME: CACHE_DIR },
      windowsHide: true,
    });
    this.child = child;
    const forward = stream => {
      let buf = '';
      stream.on('data', chunk => {
        buf += chunk;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i).trim();
          buf = buf.slice(i + 1);
          // PO/integrity tokens are short-lived credentials: never log them.
          if (line) this.log(`[pot] ${line.replace(/https?:\/\/\S+/g, '[url]').replace(/[A-Za-z0-9+/_=-]{32,}/g, '[redacted]').slice(0, 300)}`);
        }
        if (buf.length > 4000) buf = buf.slice(-1000);
      });
    };
    forward(child.stdout);
    forward(child.stderr);
    child.on('error', e => { this.lastError = `spawn failed: ${e.code || e.message}`; });
    child.on('exit', (code, signal) => {
      if (this.child === child) this.child = null;
      this.setReady(false);
      if (this.stopping) return;
      this.lastError = `exited (${signal || code})`;
      this.log(`PO Token provider ${this.lastError}`);
      const now = Date.now();
      this.restarts = this.restarts.filter(t => now - t < RESTART_WINDOW_MS);
      if (this.restarts.length >= MAX_RESTARTS) {
        this.log('PO Token provider keeps crashing; not restarting it. Playback continues without PO Tokens.');
        return;
      }
      this.restarts.push(now);
      const delay = 2000 * this.restarts.length;
      setTimeout(() => {
        if (!this.stopping && !this.child) {
          this.spawnChild(entry);
          // Recovery must also update runtime.potReady, not merely restart
          // the child while continuing to use the dead provider forever.
          void this.waitReady(20_000);
        }
      }, delay).unref();
    });
  }

  async ping() {
    try {
      const res = await fetch(`${this.baseUrl}/ping`, { signal: AbortSignal.timeout(3000) });
      if (!res.ok) return false;
      const body = await res.json();
      this.version = body.version || null;
      this.setReady(true);
      return true;
    } catch { return false; }
  }

  async waitReady(timeoutMs) {
    const until = Date.now() + timeoutMs;
    while (Date.now() < until) {
      if (await this.ping()) { this.lastError = null; return true; }
      if (!this.external && !this.child) break;
      await new Promise(r => setTimeout(r, 750));
    }
    this.lastError ||= `no response from ${this.baseUrl}/ping`;
    this.setReady(false);
    return false;
  }

  // yt-dlp arguments that load the plugin and point it at this provider.
  ytdlpArgs() {
    return [
      '--plugin-dirs', PLUGIN_DIR,
      '--extractor-args', `youtubepot-bgutilhttp:base_url=${this.baseUrl}`,
    ];
  }

  async stop() {
    this.stopping = true;
    this.setReady(false);
    const child = this.child;
    if (!child || child.exitCode !== null) return;
    await new Promise(resolve => {
      const t = setTimeout(() => { child.kill('SIGKILL'); resolve(); }, 3000);
      child.once('exit', () => { clearTimeout(t); resolve(); });
      child.kill('SIGTERM');
    });
  }
}

// The provider does not need the Discord token or other secrets.
function minimalEnv() {
  const keep = ['PATH', 'HOME', 'USERPROFILE', 'SYSTEMROOT', 'TEMP', 'TMP', 'LANG', 'TZ', 'HTTPS_PROXY', 'HTTP_PROXY', 'ALL_PROXY', 'NO_PROXY', 'TOKEN_TTL'];
  const out = {};
  for (const k of keep) if (process.env[k]) out[k] = process.env[k];
  return out;
}

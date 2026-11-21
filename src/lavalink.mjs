// Talanga Lavalink v4 transport: multiple hot standby nodes, REST + WebSocket.
// No yt-dlp, FFmpeg, local audio files, or Discord voice encoder is used.
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';

export class UserError extends Error { constructor(message) { super(message); this.name = 'UserError'; } }
export const safeError = e => String(e?.message || e || 'Unknown error')
  .replace(/(Authorization|password|token|secret)(\s*[:=]\s*)[^\s,}\]]+/ig, '$1$2[redacted]')
  .replace(/https?:\/\/[^\s/@]+:[^\s/@]+@/g, 'https://[redacted]@')
  .slice(0, 320);

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
// REL-01: how long to wait for a node that was playing to come back and
// resume its Lavalink session (server-side state, incl. exact position)
// before treating it as actually unavailable and triggering a failover.
const RESUME_GRACE_MS = 4000;

export class LavalinkNode extends EventEmitter {
  constructor(config, { log = () => {}, fetchImpl = fetch, WebSocketImpl = WebSocket } = {}) {
    super();
    this.config = config;
    this.name = config.name;
    this.log = log;
    this.fetchImpl = fetchImpl;
    this.WebSocketImpl = WebSocketImpl;
    this.ready = false;
    this.sessionId = null;
    this.ws = null;
    this.closed = false;
    this.retry = null;
    this.heartbeat = null;
    this.graceTimer = null;
    this.backoff = 1500;
    this.quarantineUntil = 0;
    this.lastError = null;
    this.failures = 0;
    this.userId = null;
    this.stats = null;
    this.latency = null;
  }
  get usable() { return this.ready && Date.now() >= this.quarantineUntil; }
  get baseUrl() { return `${this.config.secure ? 'https' : 'http'}://${this.config.host}:${this.config.port}`; }
  start(userId) { this.userId = userId; this.closed = false; this.connect(); }
  connect() {
    if (this.closed || !this.userId || this.ws) return;
    const previousSession = this.sessionId;
    const address = `${this.config.secure ? 'wss' : 'ws'}://${this.config.host}:${this.config.port}/v4/websocket`;
    let socket;
    try {
      socket = new this.WebSocketImpl(address, {
        headers: {
          Authorization: this.config.password,
          'User-Id': this.userId,
          'Client-Name': 'Talanga/3.0.0',
          ...(previousSession ? { 'Session-Id': previousSession } : {}),
        }, handshakeTimeout: 8000,
      });
    } catch (error) {
      this.lastError = safeError(error);
      this.scheduleReconnect();
      return;
    }
    this.ws = socket;
    let everReady = false;
    const handshakeTimer = setTimeout(() => { if (this.ws === socket && !this.ready) socket.terminate(); }, 11000);
    handshakeTimer.unref?.();
    socket.on('message', bytes => {
      if (this.ws !== socket) return;
      let data;
      try { data = JSON.parse(bytes.toString()); } catch { return; }
      if (data.op === 'ready' && data.sessionId) {
        everReady = true;
        this.ready = true;
        this.sessionId = data.sessionId;
        this.lastError = null;
        this.failures = 0;
        this.quarantineUntil = 0;
        this.backoff = 1500;
        clearTimeout(handshakeTimer);
        clearTimeout(this.graceTimer); this.graceTimer = null;
        this.log(`[Lavalink] ${this.name} ready${data.resumed ? ' (resumed)' : ''}`);
        this.emit('ready', this);
        if (previousSession && !data.resumed) this.emit('sessionLost', this);
        this.request(`/v4/sessions/${encodeURIComponent(this.sessionId)}`, {
          method: 'PATCH', body: { resuming: true, timeout: 60 }, timeout: 5000,
        }).catch(() => {});
      } else if (data.op === 'event' || data.op === 'playerUpdate') this.emit('playerEvent', this, data);
      else if (data.op === 'stats') this.stats = data;
    });
    socket.on('pong', () => { this.lastPong = Date.now(); });
    socket.on('error', error => { this.lastError = safeError(error); });
    socket.on('close', (code) => {
      clearTimeout(handshakeTimer);
      if (this.ws !== socket) return;
      this.ws = null;
      this.ready = false;
      if (!everReady && !this.lastError) this.lastError = `WebSocket closed (${code})`;
      if (everReady) {
        this.log(`[Lavalink] ${this.name} disconnected (${code}), waiting up to ${RESUME_GRACE_MS}ms for it to come back`);
        // Give the node a short window to reconnect (Lavalink keeps the player/session
        // alive server-side for `resuming.timeout`). Only announce it as actually
        // unavailable - and let GuildPlayer fail the track over - if that window expires.
        clearTimeout(this.graceTimer);
        this.graceTimer = setTimeout(() => {
          this.graceTimer = null;
          if (!this.ready) {
            this.log(`[Lavalink] ${this.name} did not come back in time`);
            this.emit('unavailable', this);
          }
        }, RESUME_GRACE_MS);
        this.graceTimer.unref?.();
      }
      this.scheduleReconnect();
    });
    this.lastPong = Date.now();
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        const ws = this.ws;
        if (ws?.readyState === this.WebSocketImpl.OPEN) {
          if (Date.now() - this.lastPong > 65000) ws.terminate();
          else ws.ping();
        }
      }, 25000);
      this.heartbeat.unref?.();
    }
  }
  scheduleReconnect() {
    if (this.closed || this.retry) return;
    this.retry = setTimeout(() => {
      this.retry = null;
      this.connect();
    }, this.backoff);
    this.retry.unref?.();
    this.backoff = Math.min(this.backoff * 1.7, 30000);
  }
  stop() {
    this.closed = true;
    this.ready = false;
    clearTimeout(this.retry); this.retry = null;
    clearTimeout(this.graceTimer); this.graceTimer = null;
    clearInterval(this.heartbeat); this.heartbeat = null;
    const ws = this.ws; this.ws = null;
    if (ws) ws.terminate();
  }
  fail(error, seconds = 15) {
    this.lastError = safeError(error);
    this.failures++;
    this.quarantineUntil = Date.now() + seconds * 1000;
    this.log(`[Lavalink] ${this.name}: ${this.lastError} (try another node)`);
  }
  async request(path, { method = 'GET', body, timeout = 9000 } = {}) {
    if (!this.ready || !this.sessionId) throw new Error(`${this.name} disconnected`);
    const start = Date.now();
    let res;
    try {
      res = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          Authorization: this.config.password,
          'Content-Type': 'application/json',
          'Client-Name': 'Talanga/3.0.0',
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(timeout),
      });
    } catch (error) {
      throw new Error(`${this.name} network: ${safeError(error)}`);
    }
    if (!res.ok) {
      let reason = `HTTP ${res.status}`;
      try { const data = await res.json(); reason += ` ${String(data?.message || '').slice(0, 120)}`; } catch {}
      throw new Error(`${this.name}: ${reason}`);
    }
    this.latency = Date.now() - start;
    if (res.status === 204) return null;
    return res.json();
  }
  load(identifier) { return this.request(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`); }
  patch(guildId, data) {
    return this.request(`/v4/sessions/${encodeURIComponent(this.sessionId)}/players/${encodeURIComponent(guildId)}`, { method: 'PATCH', body: data });
  }
  destroy(guildId) {
    return this.request(`/v4/sessions/${encodeURIComponent(this.sessionId)}/players/${encodeURIComponent(guildId)}`, { method: 'DELETE', timeout: 5000 });
  }
}

export function normalizeIdentifier(raw, prefix = 'ytsearch') {
  const query = String(raw || '').trim();
  if (!query || query.length > 400) throw new UserError('Enter a link or song name (400 characters max).');
  if (/^https?:\/\//i.test(query)) {
    let url;
    try { url = new URL(query); } catch { throw new UserError('Invalid link.'); }
    // Only ordinary media URLs; never let a public node probe arbitrary private hosts.
    const h = url.hostname.toLowerCase();
    if (!['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com', 'youtu.be', 'soundcloud.com', 'www.soundcloud.com'].includes(h))
      throw new UserError('Only YouTube or SoundCloud links are accepted.');
    return url.href;
  }
  if (/^\w+:\/\//.test(query)) throw new UserError('Unsupported link protocol.');
  return `${prefix}:${query}`;
}

export function unwrapTrack(data) {
  if (!data) return null;
  if (data.loadType === 'error') throw new Error(safeError(data.data?.message || 'Track load failed'));
  let t = null;
  if (data.loadType === 'track') t = data.data;
  else if (data.loadType === 'search') t = data.data?.[0];
  else if (data.loadType === 'playlist') t = data.data?.tracks?.[0];
  return t?.encoded && t?.info ? t : null;
}

function toSong(track, nodeName, input) {
  return {
    title: String(track.info.title || 'Unknown').slice(0, 170),
    author: String(track.info.author || '').slice(0, 120),
    url: track.info.uri || input,
    query: input,
    duration: Math.round((track.info.length || 0) / 1000),
    isStream: !!track.info.isStream,
    encoded: track.encoded,
    nodeName,
  };
}

export class LavalinkManager extends EventEmitter {
  constructor(config, options = {}) {
    super();
    this.config = config;
    this.log = options.log || (() => {});
    this.nodes = config.nodes.map(n => new LavalinkNode(n, options));
    this.active = null;
    this.closed = false;
    for (const n of this.nodes) {
      n.on('ready', () => this.emit('ready'));
      n.on('unavailable', node => { this.emit('unavailable', node); });
      n.on('sessionLost', node => this.emit('sessionLost', node));
      n.on('playerEvent', (node, event) => this.emit('playerEvent', node, event));
    }
  }
  start(botId) { this.closed = false; for (const n of this.nodes) n.start(botId); }
  stop() { this.closed = true; for (const n of this.nodes) n.stop(); }
  // REL-02: prefer the currently active node, then fewer recent failures
  // (a node that keeps failing shouldn't be picked over a clean one just
  // because it happens to have lower latency), then lower measured latency.
  list(exclude = []) {
    const excluded = new Set(exclude);
    return this.nodes.filter(n => n.usable && !excluded.has(n.name))
      .sort((a, b) => {
        if (a === this.active) return -1;
        if (b === this.active) return 1;
        if (a.failures !== b.failures) return a.failures - b.failures;
        return (a.latency ?? Infinity) - (b.latency ?? Infinity);
      });
  }
  async available(exclude = [], timeout = 7000) {
    const immediate = this.list(exclude);
    if (immediate.length) return immediate;
    const start = Date.now();
    while (Date.now() - start < timeout && !this.closed) {
      await sleep(200);
      const candidates = this.list(exclude);
      if (candidates.length) return candidates;
    }
    return [];
  }
  // F-18: lightweight search for slash-command autocomplete. Must answer
  // within Discord's ~3s interaction window, so this tries exactly one node
  // and gives up quietly (empty list) rather than iterating/retrying - an
  // empty autocomplete dropdown is harmless, a timed-out interaction is not.
  // Short-lived cache: Discord fires a new autocomplete request on almost
  // every keystroke, and re-hitting a public Lavalink node for "a", "ab",
  // "abc", ... is most of why typing feels sluggish - a few seconds of
  // per-prefix caching removes nearly all of that without stale-feeling results.
  async search(query, { limit = 5 } = {}) {
    const key = query.trim().toLowerCase();
    const cached = this._searchCache?.get(key);
    if (cached && cached.expires > Date.now()) return cached.results;
    const [node] = this.list();
    if (!node) return [];
    let identifier;
    try { identifier = normalizeIdentifier(query, this.config.searchPrefix); } catch { return []; }
    if (/^https?:\/\//.test(identifier)) return [];
    let results = [];
    try {
      const data = await node.request(`/v4/loadtracks?identifier=${encodeURIComponent(identifier)}`, { timeout: 2500 });
      if (data?.loadType === 'search' && Array.isArray(data.data)) {
        results = data.data.slice(0, limit)
          .filter(t => t?.encoded && t?.info)
          .map(t => ({ title: String(t.info.title || 'Unknown').slice(0, 90), author: String(t.info.author || '').slice(0, 60), url: t.info.uri || '' }));
      }
    } catch { return cached?.results || []; } // a timed-out refresh still serves the last good (if stale) result
    this._searchCache ??= new Map();
    this._searchCache.set(key, { results, expires: Date.now() + 20_000 });
    if (this._searchCache.size > 200) this._searchCache.delete(this._searchCache.keys().next().value);
    return results;
  }
  // Iterate nodes until the track can actually be resolved on one of them.
  async resolve(input, { exclude = [], preferred = null } = {}) {
    const candidates = await this.available(exclude);
    if (preferred?.usable && !exclude.includes(preferred.name)) {
      const i = candidates.indexOf(preferred);
      if (i >= 0) candidates.splice(i, 1);
      candidates.unshift(preferred);
    }
    if (!candidates.length) throw new UserError('No Lavalink node available. Try again or check /diagnose.');
    let lastError;
    for (const node of candidates) {
      const first = normalizeIdentifier(input, this.config.searchPrefix);
      const identifiers = [first];
      if (!/^https?:\/\//.test(first) && this.config.searchFallback) {
        if (!first.startsWith('ytmsearch:')) identifiers.push(normalizeIdentifier(input, 'ytmsearch'));
        if (!first.startsWith('scsearch:')) identifiers.push(normalizeIdentifier(input, 'scsearch'));
      }
      for (const identifier of identifiers) {
        try {
          const data = await node.load(identifier);
          const track = unwrapTrack(data);
          if (!track) continue;
          this.active = node;
          const song = toSong(track, node.name, input);
          // F-19: a playlist load returns every track; don't discard all but the first.
          if (data.loadType === 'playlist' && Array.isArray(data.data?.tracks) && data.data.tracks.length > 1) {
            song.playlistName = String(data.data.info?.name || '').slice(0, 120) || null;
            song.playlistExtra = data.data.tracks.slice(1)
              .filter(t => t?.encoded && t?.info)
              .map(t => toSong(t, node.name, t.info.uri || input));
          }
          return song;
        } catch (error) {
          lastError = error;
          if (/network|HTTP 5\d\d|HTTP 429|HTTP 401|HTTP 403|disconnected/i.test(safeError(error))) {
            node.fail(error);
            break;
          }
        }
      }
    }
    throw new UserError(lastError ? `No node could load this track: ${safeError(lastError)}` : 'Could not find that song on any available node.');
  }
  async trackOnNode(song, node) {
    if (song.nodeName === node.name && song.encoded) return song.encoded;
    const reference = song.url?.startsWith('https://') ? song.url : song.query;
    let encoded;
    try {
      encoded = unwrapTrack(await node.load(normalizeIdentifier(reference, this.config.searchPrefix)))?.encoded;
    } catch (err) {
      if (!song.query || song.query === reference) throw err;
    }
    if (!encoded && song.query && song.query !== reference) {
      encoded = unwrapTrack(await node.load(normalizeIdentifier(song.query, this.config.searchPrefix)))?.encoded;
    }
    if (!encoded) throw new Error(`${node.name}: no playable track`);
    song.encoded = encoded;
    song.nodeName = node.name;
    return encoded;
  }
  report() {
    return this.nodes.map(n => `${n.name}: ${n.ready ? n.usable ? 'READY' : 'COOLDOWN' : 'DOWN'}${n.latency == null ? '' : ` ${n.latency}ms`}${n.ready ? '' : n.lastError ? ` (${n.lastError})` : ' (connecting)'}`);
  }
}

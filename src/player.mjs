// Guild queue and Discord voice gateway bridge for Lavalink v4.
// Lavalink sends encrypted voice packets; this process never handles audio bytes.
import { EventEmitter } from 'node:events';
import { UserError, safeError } from './lavalink.mjs';

const VOICE_TIMEOUT_MS = 16000;
const START_TIMEOUT_MS = 27000;
let nextId = 0;

// FEAT-01: named Lavalink v4 filter presets. Plain JSON bodies for the
// player PATCH `filters` field; Lavalink applies them, nothing local to encode.
export const FILTER_PRESETS = {
  bassboost: { equalizer: [{ band: 0, gain: 0.25 }, { band: 1, gain: 0.2 }, { band: 2, gain: 0.15 }, { band: 3, gain: 0.1 }] },
  nightcore: { timescale: { speed: 1.2, pitch: 1.2, rate: 1 } },
  vaporwave: { timescale: { speed: 0.8, pitch: 0.8, rate: 1 } },
  '8d': { rotation: { rotationHz: 0.2 } },
  karaoke: { karaoke: { level: 1, monoLevel: 1, filterBand: 220, filterWidth: 100 } },
};

export class GuildPlayer extends EventEmitter {
  constructor(guild, manager, config, log = () => {}, onDispose = () => {}) {
    super();
    this.guild = guild;
    this.manager = manager;
    this.config = config;
    this.log = msg => log(`[${guild.id}] ${msg}`);
    this.onDispose = onDispose;
    this.voiceChannelId = null;
    this.voice = { sessionId: null, token: null, endpoint: null, channelId: null };
    this.joinPromise = null;
    this.joinResolve = null;
    this.joinReject = null;
    this.joinTimer = null;
    this.textChannel = null;
    this.controllerMessage = null; // live Discord message reference, never persisted
    this.items = [];
    this.current = null;
    this.disposed = false;
    this.transitioning = false;
    this.idleTimer = null;
    this.volume = 100;
    this.loopMode = 'off'; // 'off' | 'track' | 'queue'
    this.filters = null; // Lavalink v4 filters object, resent on every (re)launch
    this.sticky = false; // 24/7: skip idle auto-disconnect
    this.autoplay = false;
    this.autoplayPending = false;
    this.history = []; // most-recently-played last; capped, used by previous()/replay()/"/history"
    this.prefetching = null;
    this.operation = Promise.resolve();
    this.playInFlight = Promise.resolve();
  }
  announce(message) { this.textChannel?.send({ content: message.slice(0, 1900), allowedMentions: { parse: [] } }).catch(() => {}); }
  cancelIdle() { clearTimeout(this.idleTimer); this.idleTimer = null; }
  armIdle() {
    this.cancelIdle();
    if (this.disposed || this.current || this.items.length || this.sticky) return;
    this.idleTimer = setTimeout(() => this.stop(), this.config.idleMs);
    this.idleTimer.unref?.();
  }
  isSameVoice(channelId) { return !this.voiceChannelId || this.voiceChannelId === channelId; }
  async ensureConnected(channel) {
    if (this.disposed) throw new UserError('The bot has been stopped.');
    if (!this.isSameVoice(channel.id)) throw new UserError('Already playing in another voice channel.');
    if (this.voice.channelId === channel.id && this.voice.sessionId && this.voice.token && this.voice.endpoint) return;
    if (this.joinPromise) return this.joinPromise;
    this.voiceChannelId = channel.id;
    this.voice = { sessionId: null, token: null, endpoint: null, channelId: null };
    const promise = new Promise((resolve, reject) => {
      this.joinResolve = resolve;
      this.joinReject = reject;
      this.joinTimer = setTimeout(() => reject(new UserError('Discord Voice did not respond within 16 seconds.')), VOICE_TIMEOUT_MS);
      this.joinTimer.unref?.();
    });
    this.joinPromise = promise;
    try {
      this.guild.shard.send({
        op: 4,
        d: { guild_id: this.guild.id, channel_id: channel.id, self_mute: false, self_deaf: true },
      });
    } catch (e) { this.joinReject?.(e); }
    try { await promise; }
    finally { this.joinPromise = null; this.joinResolve = null; this.joinReject = null; clearTimeout(this.joinTimer); this.joinTimer = null; }
  }
  onVoicePacket(packet, botId) {
    if (this.disposed || !packet?.d || packet.d.guild_id !== this.guild.id) return;
    const d = packet.d;
    if (packet.t === 'VOICE_STATE_UPDATE' && d.user_id === botId) {
      if (!d.channel_id) {
        this.voice.sessionId = null;
        this.voice.channelId = null;
        if (this.voiceChannelId) {
          this.log('Discord disconnected bot from voice');
          this.stop();
        }
        return;
      }
      this.voice.channelId = d.channel_id;
      this.voice.sessionId = d.session_id;
      this.voiceChannelId = d.channel_id;
    } else if (packet.t === 'VOICE_SERVER_UPDATE') {
      this.voice.token = d.token;
      this.voice.endpoint = d.endpoint;
    } else return;
    if (this.voice.sessionId && this.voice.token && this.voice.endpoint && this.voice.channelId) {
      this.joinResolve?.();
      // A moved voice server can rotate its token mid-playback.
      if (this.current?.node?.ready && this.current.startedAt) {
        this.current.node.patch(this.guild.id, { voice: this.voicePayload() })
          .catch(e => this.log(`Voice update: ${safeError(e)}`));
      }
    }
  }
  voicePayload() {
    const { token, endpoint, sessionId, channelId } = this.voice;
    if (!token || !endpoint || !sessionId || !channelId) throw new UserError('Incomplete Discord voice handshake.');
    return { token, endpoint, sessionId, channelId };
  }
  enqueue(song) {
    if (this.disposed) throw new UserError('The bot has been stopped.');
    if (this.items.length >= this.config.queueLimit) throw new UserError('The queue is full.');
    this.cancelIdle();
    this.items.push(song);
    const position = this.current ? this.items.length : this.items.length - 1;
    this.startNext();
    this.prefetchNext();
    this.emit('update');
    return position;
  }
  startNext() {
    if (this.disposed || this.transitioning || this.current) return;
    const song = this.items.shift();
    if (!song) { this.armIdle(); return; }
    const cur = { id: String(++nextId), song, node: null, startedAt: null, startingAt: Date.now(), tried: new Set(), retryCount: 0, position: 0, paused: false, startTimer: null };
    this.current = cur;
    this.log(`Starting: ${song.title}`);
    this.launch(cur);
    this.prefetchNext();
  }
  launch(cur) {
    if (this.disposed || this.current !== cur) return;
    if (cur.playTask) { cur.retryRequested = true; return; }
    const task = this.playCurrent(cur);
    cur.playTask = task;
    this.playInFlight = task.catch(() => {});
    void task.catch(e => this.log(`Start failed: ${safeError(e)}`)).finally(() => {
      if (cur.playTask === task) cur.playTask = null;
      if (cur.retryRequested && !this.disposed && this.current === cur) {
        cur.retryRequested = false;
        // The running attempt may already have migrated to a healthy backup.
        if (!cur.node?.usable) this.launch(cur);
      }
    });
  }
  async playCurrent(cur) {
    let lastErr;
    while (!this.disposed && this.current === cur && cur.tried.size < this.manager.nodes.length) {
      const nodes = await this.manager.available([...cur.tried], 6000);
      if (!nodes.length) break;
      for (const node of nodes) {
        if (this.disposed || this.current !== cur) return;
        cur.node = node;
        cur.tried.add(node.name);
        try {
          const encoded = await this.manager.trackOnNode(cur.song, node);
          if (this.disposed || this.current !== cur) return;
          await this.ensureVoiceReady();
          if (this.disposed || this.current !== cur) return;
          if (!node.usable) throw new Error(`${node.name} disconnected before playback`);
          cur.startingAt = Date.now();
          await node.patch(this.guild.id, {
            voice: this.voicePayload(),
            track: { encoded, userData: { talangaId: cur.id } },
            // BUG-05: a live stream has no seekable timeline; never forward a position for one.
            ...(cur.position && !cur.song.isStream ? { position: cur.position } : {}),
            volume: this.volume,
            // BUG-07: a track paused right before a failover must stay paused on the new node.
            paused: cur.paused,
            ...(this.filters ? { filters: this.filters } : {}),
          });
          if (this.disposed || this.current !== cur) return;
          clearTimeout(cur.startTimer);
          cur.startTimer = setTimeout(() => {
            if (this.current === cur && !cur.startedAt) this.failCurrent(cur, 'Lavalink track start timeout');
          }, START_TIMEOUT_MS);
          cur.startTimer.unref?.();
          this.log(`Sent to ${node.name}: ${cur.song.title}`);
          this.prefetchNext();
          return;
        } catch (error) {
          lastErr = error;
          this.log(`Cannot start via ${node.name}: ${safeError(error)}`);
          if (/HTTP 5\d\d|HTTP 429|HTTP 401|HTTP 403|network|disconnected/i.test(safeError(error))) node.fail(error, 20);
        }
      }
    }
    if (this.current === cur && !this.disposed) {
      this.log(`Failed: ${cur.song.title}: ${safeError(lastErr || 'no nodes available')}`);
      this.announce(`⚠️ Could not play **${cur.song.title}**: ${safeError(lastErr || 'no available Lavalink node')}`);
      this.current = null;
      clearTimeout(cur.startTimer);
      this.startNext();
    }
  }
  async ensureVoiceReady() {
    if (this.voice.sessionId && this.voice.token && this.voice.endpoint && this.voice.channelId) return;
    if (this.joinPromise) return this.joinPromise;
    throw new UserError('Not connected to the voice channel.');
  }
  onNodeEvent(node, e) {
    if (this.disposed || !this.current || this.current.node !== node) return;
    const cur = this.current;
    if (e.op === 'playerUpdate') {
      if (Number.isFinite(e.state?.position)) cur.position = e.state.position;
      return;
    }
    if (e.op !== 'event') return;
    const eventId = e.track?.userData?.talangaId;
    if (eventId && eventId !== cur.id) return;
    if (!eventId && e.track?.encoded && e.track.encoded !== cur.song.encoded) return;
    if (e.type === 'TrackStartEvent') {
      clearTimeout(cur.startTimer);
      if (!cur.startedAt) {
        cur.startedAt = Date.now();
        this.log(`Audio playing: ${cur.song.title} | node=${node.name} | since-start=${cur.startedAt - cur.startingAt}ms`);
        this.emit('update');
      }
      this.prefetchNext();
    } else if (e.type === 'TrackEndEvent') {
      if (e.reason === 'finished') this.finishCurrent(cur);
      else if (e.reason === 'loadFailed') this.failCurrent(cur, 'Failed loading track');
    } else if (e.type === 'TrackExceptionEvent' || e.type === 'TrackStuckEvent') {
      const reason = e.exception?.message || e.type;
      this.failCurrent(cur, reason);
    } else if (e.type === 'WebSocketClosedEvent' && [4006, 4014].includes(e.code)) {
      this.log(`Discord voice rejected session: ${e.code}`);
      this.rejoinVoice();
    }
  }
  pushHistory(song) {
    this.history.push(song);
    if (this.history.length > 20) this.history.shift();
  }
  finishCurrent(cur) {
    if (this.current !== cur || this.disposed) return;
    clearTimeout(cur.startTimer);
    this.log(`Finished: ${cur.song.title}`);
    this.current = null;
    this.pushHistory(cur.song);
    if (this.loopMode === 'track') this.items.unshift(cur.song);
    else if (this.loopMode === 'queue') this.items.push(cur.song);
    this.startNext();
    // F-23 autoplay: only when loop didn't just refill the queue and nothing else is queued.
    if (this.autoplay && this.loopMode === 'off' && !this.items.length && !this.current) void this.triggerAutoplay(cur.song);
    this.emit('update');
  }
  // F-23: fetch a related track once the queue runs dry, instead of just
  // going idle. Best-effort - a failed/empty search silently leaves the
  // queue empty rather than erroring out the finished track.
  async triggerAutoplay(lastSong) {
    if (this.disposed || !this.autoplay || this.autoplayPending || this.current || this.items.length) return;
    this.autoplayPending = true;
    try {
      const query = `${lastSong.author || ''} ${lastSong.title}`.trim() || lastSong.title;
      const candidates = await this.manager.search(query, { limit: 5 });
      const pick = candidates.find(c => c.url && c.url !== lastSong.url) || candidates[0];
      if (!pick || this.disposed || this.current || this.items.length) return;
      const song = await this.manager.resolve(pick.url);
      if (this.disposed || this.current || this.items.length) return;
      this.enqueue(song);
      this.announce(`📻 Autoplay: **${song.title}**`);
    } catch (e) {
      this.log(`Autoplay failed: ${safeError(e)}`);
    } finally {
      this.autoplayPending = false;
    }
  }
  // F-14/F-15: go back to the previously played track, or restart the current one.
  previous() {
    if (!this.history.length) return null;
    const prev = this.history.pop();
    if (this.current) {
      this.items.unshift(this.current.song);
      this.items.unshift(prev);
      this.skip({ recordHistory: false });
    } else {
      this.items.unshift(prev);
      this.startNext();
    }
    return prev;
  }
  async replay() {
    if (!this.current?.node?.ready) throw new UserError('Nothing is playing.');
    await this.seek(0);
  }
  failCurrent(cur, reason) {
    if (this.current !== cur || this.disposed) return;
    this.log(`Playback failure: ${safeError(reason)}`);
    clearTimeout(cur.startTimer);
    const failedNode = cur.node;
    cur.node = null; // ignore any late events from this failed track/node
    failedNode?.fail(reason, 10);
    if (failedNode?.ready) void failedNode.destroy(this.guild.id).catch(() => {});
    cur.startedAt = null;
    // A failed track can retry on another node, but not indefinitely.
    if (cur.tried.size < this.manager.nodes.length) {
      this.launch(cur);
    } else {
      this.announce(`⚠️ **${cur.song.title}** failed to play on every Lavalink node.`);
      this.current = null;
      this.startNext();
    }
    this.emit('update');
  }
  onNodeUnavailable(node) {
    const cur = this.current;
    if (cur && cur.node === node && !this.disposed) {
      this.log(`Failover: ${node.name} down, trying another node`);
      clearTimeout(cur.startTimer);
      cur.node = null;
      cur.startedAt = null;
      this.launch(cur);
    }
  }
  prefetchNext() {
    if (this.disposed || !this.current?.node?.usable || !this.items.length) return;
    const song = this.items[0];
    const node = this.current.node;
    if (song.nodeName === node.name && song.encoded) return;
    if (this.prefetching?.song === song && this.prefetching.node === node) return;
    const marker = { song, node };
    this.prefetching = marker;
    this.manager.trackOnNode(song, node).catch(e => {
      this.log(`Next song prefetch skipped: ${safeError(e)}`);
    }).finally(() => { if (this.prefetching === marker) this.prefetching = null; });
  }
  skip({ recordHistory = true } = {}) {
    if (this.disposed) return null;
    if (!this.current) {
      const removed = this.items.shift();
      if (removed) this.startNext();
      return removed || null;
    }
    const old = this.current;
    this.current = null;
    if (recordHistory) this.pushHistory(old.song);
    clearTimeout(old.startTimer);
    this.transitioning = true;
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.playInFlight;
      if (old.node?.ready) await old.node.patch(this.guild.id, { track: { encoded: null } }).catch(() => {});
    }).finally(() => { this.transitioning = false; this.startNext(); this.emit('update'); });
    this.emit('update');
    return old.song;
  }
  async setPaused(paused) {
    if (!this.current?.node?.ready) throw new UserError('Nothing is playing.');
    this.current.paused = paused;
    await this.current.node.patch(this.guild.id, { paused });
    this.emit('update');
  }
  async setVolume(value) {
    this.volume = value;
    if (this.current?.node?.ready) await this.current.node.patch(this.guild.id, { volume: value });
    this.emit('update');
  }
  setLoop(mode) { this.loopMode = mode; this.emit('update'); }
  async setFilters(filters) {
    this.filters = filters && Object.keys(filters).length ? filters : null;
    if (this.current?.node?.ready) await this.current.node.patch(this.guild.id, { filters: this.filters || {} });
    this.emit('update');
  }
  resetFilters() { return this.setFilters(null); }
  shuffle() {
    for (let i = this.items.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [this.items[i], this.items[j]] = [this.items[j], this.items[i]];
    }
    this.emit('update');
    return this.items.length;
  }
  removeAt(position) {
    const index = position - 1;
    if (index < 0 || index >= this.items.length) return null;
    const removed = this.items.splice(index, 1)[0];
    this.emit('update');
    return removed;
  }
  clear() {
    const count = this.items.length;
    this.items.length = 0;
    this.emit('update');
    return count;
  }
  move(from, to) {
    const fi = from - 1, ti = to - 1;
    if (fi < 0 || fi >= this.items.length || ti < 0 || ti >= this.items.length) return false;
    const [song] = this.items.splice(fi, 1);
    this.items.splice(ti, 0, song);
    this.emit('update');
    return true;
  }
  playNext(song) {
    if (this.disposed) throw new UserError('The bot has been stopped.');
    if (this.items.length >= this.config.queueLimit) throw new UserError('The queue is full.');
    this.cancelIdle();
    this.items.unshift(song);
    this.startNext();
    this.prefetchNext();
    this.emit('update');
  }
  dedupe() {
    const seen = new Set();
    const before = this.items.length;
    this.items = this.items.filter(song => {
      const key = song.url || song.query;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    this.emit('update');
    return before - this.items.length;
  }
  async seek(seconds) {
    if (!this.current?.node?.ready) throw new UserError('Nothing is playing.');
    if (this.current.song.isStream) throw new UserError('You cannot seek a live stream.');
    const ms = Math.max(0, Math.round(seconds * 1000));
    if (ms > this.current.song.duration * 1000) throw new UserError('That position is past the end of the song.');
    await this.current.node.patch(this.guild.id, { position: ms });
    this.current.position = ms;
  }
  // PERS-01: a plain, re-resolvable snapshot. Deliberately drops `encoded`/`nodeName` -
  // those are tied to a specific Lavalink session and are never safe to reuse after a restart.
  snapshot() {
    const queue = this.current ? [this.current.song, ...this.items] : this.items;
    if (!this.voiceChannelId && !queue.length) return null;
    return {
      voiceChannelId: this.voiceChannelId,
      volume: this.volume,
      loopMode: this.loopMode,
      filters: this.filters,
      sticky: this.sticky,
      autoplay: this.autoplay,
      songs: queue.map(s => ({ title: s.title, author: s.author, url: s.url, query: s.query, duration: s.duration, isStream: s.isStream })),
    };
  }
  rejoinVoice() {
    if (!this.voiceChannelId || this.disposed) return;
    const channelId = this.voiceChannelId;
    this.voice = { sessionId: null, token: null, endpoint: null, channelId: null };
    this.guild.shard.send({ op: 4, d: { guild_id: this.guild.id, channel_id: null, self_mute: false, self_deaf: true } });
    setTimeout(() => {
      if (this.disposed) return;
      this.guild.shard.send({ op: 4, d: { guild_id: this.guild.id, channel_id: channelId, self_mute: false, self_deaf: true } });
    }, 500).unref?.();
  }
  stop() {
    if (this.disposed) return;
    this.disposed = true;
    this.cancelIdle();
    clearTimeout(this.joinTimer);
    this.joinReject?.(new UserError('Playback has stopped.'));
    this.joinPromise = null;
    this.items.length = 0;
    const old = this.current;
    this.current = null;
    clearTimeout(old?.startTimer);
    const guildId = this.guild.id;
    this.operation = this.operation.catch(() => {}).then(async () => {
      await this.playInFlight;
      // A previous failover may leave an orphaned player on an old node.
      await Promise.allSettled(this.manager.nodes.filter(n => n.ready).map(n => n.destroy(guildId)));
    }).catch(() => {});
    try { this.guild.shard.send({ op: 4, d: { guild_id: guildId, channel_id: null, self_mute: false, self_deaf: true } }); } catch {}
    this.voiceChannelId = null;
    this.emit('update');
    this.onDispose(this);
  }
}

export class Players extends EventEmitter {
  constructor({ manager, config, log }) {
    super();
    this.manager = manager;
    this.config = config;
    this.log = log;
    this.guilds = new Map();
    manager.on('playerEvent', (node, e) => this.guilds.get(e.guildId)?.onNodeEvent(node, e));
    manager.on('unavailable', node => { for (const p of this.guilds.values()) p.onNodeUnavailable(node); });
    manager.on('sessionLost', node => { for (const p of this.guilds.values()) p.onNodeUnavailable(node); });
  }
  get(guild) {
    let p = this.guilds.get(guild.id);
    if (!p || p.disposed) {
      p = new GuildPlayer(guild, this.manager, this.config, this.log, player => {
        if (this.guilds.get(guild.id) === player) this.guilds.delete(guild.id);
      });
      p.on('update', () => this.emit('guildUpdate', p));
      this.guilds.set(guild.id, p);
    }
    return p;
  }
  peek(id) { return this.guilds.get(id); }
  snapshotAll() {
    const out = {};
    for (const [id, gp] of this.guilds) {
      const snap = gp.snapshot();
      if (snap) out[id] = snap;
    }
    return out;
  }
  onRaw(packet, userId) {
    if (packet?.t !== 'VOICE_STATE_UPDATE' && packet?.t !== 'VOICE_SERVER_UPDATE') return;
    this.guilds.get(packet.d?.guild_id)?.onVoicePacket(packet, userId);
  }
  shutdown() { for (const p of [...this.guilds.values()]) p.stop(); }
}

// F-30: isolated local-playback fallback engine, used ONLY when every
// Lavalink node is unavailable. Pipes yt-dlp's raw audio stream straight into
// @discordjs/voice (which transcodes via its own bundled ffmpeg/opus path),
// reusing the existing yt-dlp binary/cookies infrastructure for extraction
// only - never for anything Lavalink already handles.
//
// Hard invariant this file exists to protect: a guild must never have both
// Lavalink and this engine driving its voice connection at once. This module
// does not enforce that itself - the caller (bot.mjs) is responsible for
// never calling `join()` while a GuildPlayer already owns that guild's voice
// connection, and vice versa. See bot.mjs's handlePlay/handlePlayLocal guards.
import { spawn } from 'node:child_process';
import {
  joinVoiceChannel, createAudioPlayer, createAudioResource, entersState,
  AudioPlayerStatus, VoiceConnectionStatus, StreamType,
} from '@discordjs/voice';

// Real @discordjs/voice bindings, overridable in tests via the constructor.
const REAL_VOICE_API = { joinVoiceChannel, createAudioPlayer, createAudioResource, entersState, AudioPlayerStatus, VoiceConnectionStatus, StreamType };

export class LocalEngine {
  constructor(youtube, { log = () => {}, spawnImpl = spawn, voiceApi = REAL_VOICE_API } = {}) {
    this.youtube = youtube;
    this.log = log;
    this.spawnImpl = spawnImpl;
    this.voiceApi = voiceApi;
    this.connection = null;
    this.player = null;
    this.channelId = null;
    this.guildId = null;
    this.queue = [];
    this.current = null;
    this.process = null;
    this.disposed = false;
  }

  get active() { return Boolean(this.connection) && !this.disposed; }

  async join(channel) {
    if (this.disposed) throw new Error('engine already stopped');
    if (this.connection && this.channelId === channel.id) return;
    this.teardownConnection();
    const { joinVoiceChannel: join, createAudioPlayer: mkPlayer, entersState: waitFor, VoiceConnectionStatus: Status, AudioPlayerStatus: PlayerStatus } = this.voiceApi;
    this.connection = join({ channelId: channel.id, guildId: channel.guild.id, adapterCreator: channel.guild.voiceAdapterCreator, selfDeaf: true });
    this.channelId = channel.id;
    this.guildId = channel.guild.id;
    this.player = mkPlayer();
    this.connection.subscribe(this.player);
    this.player.on(PlayerStatus.Idle, () => { this.killProcess(); this.current = null; void this.playNext(); });
    this.player.on('error', e => { this.log(`[local] player error: ${e.message}`); this.killProcess(); this.current = null; void this.playNext(); });
    await waitFor(this.connection, Status.Ready, 15_000);
  }

  enqueue(song) {
    if (this.disposed) throw new Error('engine already stopped');
    this.queue.push(song);
    void this.playNext();
    return this.queue.length;
  }

  async playNext() {
    if (this.disposed || this.current || !this.queue.length || !this.player) return;
    const song = this.queue.shift();
    this.current = song;
    try {
      const child = this.spawnImpl(this.youtube.runtime.ytdlp.path, this.youtube.streamArgs(song.url), { stdio: ['ignore', 'pipe', 'pipe'] });
      this.process = child;
      let stderrTail = '';
      child.stderr?.on('data', chunk => { stderrTail = (stderrTail + chunk).slice(-2000); });
      child.on('error', e => this.log(`[local] yt-dlp spawn failed: ${e.message}`));
      child.once('exit', (code) => { if (code && code !== 0 && this.current === song) this.log(`[local] yt-dlp exited ${code} for "${song.title}": ${stderrTail.slice(-300)}`); });
      const resource = this.voiceApi.createAudioResource(child.stdout, { inputType: this.voiceApi.StreamType.Arbitrary });
      this.player.play(resource);
      this.log(`[local] playing "${song.title}" via local fallback`);
    } catch (e) {
      this.log(`[local] failed to start "${song.title}": ${e.message}`);
      this.current = null;
      void this.playNext();
    }
  }

  skip() {
    if (!this.current) return null;
    const skipped = this.current;
    this.player?.stop(true); // triggers Idle -> killProcess + playNext
    return skipped;
  }

  killProcess() {
    if (this.process && this.process.exitCode === null) { try { this.process.kill('SIGTERM'); } catch { /* already gone */ } }
    this.process = null;
  }

  teardownConnection() {
    this.killProcess();
    try { this.connection?.destroy(); } catch { /* already destroyed */ }
    this.connection = null;
    this.player = null;
    this.channelId = null;
  }

  stop() {
    this.disposed = true;
    this.queue = [];
    this.current = null;
    this.teardownConnection();
  }
}

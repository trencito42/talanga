// F-30 LocalEngine: fully mocked @discordjs/voice + spawn, no real voice
// connection, no real yt-dlp process, no real Discord. Verifies the engine's
// own queue/state logic and the ownership-relevant `active` flag - NOT actual
// audio output, which cannot be verified without a live Discord voice session.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { LocalEngine } from '../src/localEngine.mjs';

function fakeVoiceApi() {
  const players = [];
  return {
    api: {
      joinVoiceChannel: () => ({ subscribe() {}, destroy() {}, _fake: true }),
      createAudioPlayer: () => {
        const p = new EventEmitter();
        p.play = () => {};
        p.stop = () => { p.emit('idle'); };
        players.push(p);
        return p;
      },
      createAudioResource: (stream) => ({ stream }),
      entersState: async () => {},
      AudioPlayerStatus: { Idle: 'idle' },
      VoiceConnectionStatus: { Ready: 'ready' },
      StreamType: { Arbitrary: 'arbitrary' },
    },
    players,
  };
}

function fakeChannel() {
  return { id: 'vc-1', guild: { id: 'g-1', voiceAdapterCreator: () => {} } };
}

function fakeYoutube() {
  return { runtime: { ytdlp: { path: '/bin/yt-dlp' } }, streamArgs: () => ['--fake'] };
}

function fakeSpawn() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.kill = () => { child.exitCode = 0; };
  child.exitCode = null;
  return () => child;
}

test('join() is a no-op if already connected to the same channel', async () => {
  const { api } = fakeVoiceApi();
  const engine = new LocalEngine(fakeYoutube(), { voiceApi: api, spawnImpl: fakeSpawn() });
  const channel = fakeChannel();
  await engine.join(channel);
  const firstConnection = engine.connection;
  await engine.join(channel);
  assert.equal(engine.connection, firstConnection, 'rejoining the same channel must not tear down and recreate the connection');
});

test('enqueue() starts playback immediately when idle, then advances on Idle', async () => {
  const { api, players } = fakeVoiceApi();
  const engine = new LocalEngine(fakeYoutube(), { voiceApi: api, spawnImpl: fakeSpawn() });
  await engine.join(fakeChannel());
  engine.enqueue({ title: 'A', url: 'u1' });
  engine.enqueue({ title: 'B', url: 'u2' });
  await new Promise(r => setTimeout(r, 5));
  assert.equal(engine.current.title, 'A');
  assert.equal(engine.queue.length, 1);

  players[0].emit('idle'); // simulate track A finishing
  await new Promise(r => setTimeout(r, 5));
  assert.equal(engine.current.title, 'B');
  assert.equal(engine.queue.length, 0);
});

test('active reflects connection state and goes false after stop()', async () => {
  const { api } = fakeVoiceApi();
  const engine = new LocalEngine(fakeYoutube(), { voiceApi: api, spawnImpl: fakeSpawn() });
  assert.equal(engine.active, false);
  await engine.join(fakeChannel());
  assert.equal(engine.active, true);
  engine.stop();
  assert.equal(engine.active, false);
  assert.throws(() => engine.enqueue({ title: 'X', url: 'u' }), /stopped/);
});

test('skip() clears current and lets playNext run again', async () => {
  const { api, players } = fakeVoiceApi();
  const engine = new LocalEngine(fakeYoutube(), { voiceApi: api, spawnImpl: fakeSpawn() });
  await engine.join(fakeChannel());
  engine.enqueue({ title: 'A', url: 'u1' });
  await new Promise(r => setTimeout(r, 5));
  const skipped = engine.skip();
  assert.equal(skipped.title, 'A');
  players[0].emit('idle');
  await new Promise(r => setTimeout(r, 5));
  assert.equal(engine.current, null);
});

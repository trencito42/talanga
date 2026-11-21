// TEST-01: unit tests for the pure helpers + mocked-transport behavior of
// LavalinkNode/LavalinkManager. No real network or WebSocket is used -
// WebSocketImpl/fetchImpl are injected fakes. This is NOT a live Lavalink
// integration test; it verifies the client's own logic only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import {
  LavalinkNode, LavalinkManager, normalizeIdentifier, unwrapTrack, safeError,
} from '../src/lavalink.mjs';

class FakeSocket extends EventEmitter {
  static OPEN = 1;
  constructor() {
    super();
    this.readyState = FakeSocket.OPEN;
    this.terminated = false;
  }
  ping() {}
  send() {}
  terminate() { this.terminated = true; this.emit('close', 1006); }
}

function makeNode(name = 'A') {
  let lastSocket = null;
  const WebSocketImpl = class extends FakeSocket {
    constructor() { super(); lastSocket = this; }
  };
  WebSocketImpl.OPEN = FakeSocket.OPEN;
  const node = new LavalinkNode(
    { name, host: 'localhost', port: 2333, password: 'x', secure: false },
    { log: () => {}, WebSocketImpl, fetchImpl: async () => ({ ok: true, status: 200, json: async () => ({}) }) },
  );
  return { node, socketOf: () => lastSocket };
}

test('normalizeIdentifier accepts allowed hosts only', () => {
  assert.equal(normalizeIdentifier('song name'), 'ytsearch:song name');
  assert.equal(normalizeIdentifier('https://www.youtube.com/watch?v=abc'), 'https://www.youtube.com/watch?v=abc');
  assert.throws(() => normalizeIdentifier('https://evil.example.com/x'));
  assert.throws(() => normalizeIdentifier('file:///etc/passwd'));
  assert.throws(() => normalizeIdentifier(''));
});

test('unwrapTrack handles all Lavalink v4 loadTypes', () => {
  assert.equal(unwrapTrack(null), null);
  assert.throws(() => unwrapTrack({ loadType: 'error', data: { message: 'boom' } }));
  assert.deepEqual(unwrapTrack({ loadType: 'track', data: { encoded: 'E', info: {} } }), { encoded: 'E', info: {} });
  assert.deepEqual(unwrapTrack({ loadType: 'search', data: [{ encoded: 'E', info: {} }] }), { encoded: 'E', info: {} });
  assert.equal(unwrapTrack({ loadType: 'playlist', data: { tracks: [] } }), null);
});

test('safeError redacts credentials and truncates', () => {
  const msg = safeError(new Error('Authorization: topsecret failed against https://user:pw@host/path'));
  assert.ok(!msg.includes('topsecret'));
  assert.ok(!msg.includes('user:pw'));
});

test('F-19: resolve() surfaces every extra track from a playlist load, not just the first', async () => {
  const playlistResponse = {
    loadType: 'playlist',
    data: {
      info: { name: 'My Mix' },
      tracks: [
        { encoded: 'E1', info: { title: 'One', uri: 'u1', length: 1000 } },
        { encoded: 'E2', info: { title: 'Two', uri: 'u2', length: 2000 } },
        { encoded: 'E3', info: { title: 'Three', uri: 'u3', length: 3000 } },
      ],
    },
  };
  const node = { name: 'A', usable: true, ready: true, failures: 0, latency: 1, async load() { return playlistResponse; }, fail() {} };
  const manager = new LavalinkManager({ nodes: [], searchPrefix: 'ytsearch', searchFallback: false }, { log: () => {} });
  manager.nodes = [node];
  const song = await manager.resolve('https://www.youtube.com/playlist?list=x');
  assert.equal(song.title, 'One');
  assert.equal(song.playlistName, 'My Mix');
  assert.equal(song.playlistExtra.length, 2);
  assert.deepEqual(song.playlistExtra.map(s => s.title), ['Two', 'Three']);
});

test('F-18: search() returns short autocomplete choices and never for raw URLs', async () => {
  const searchResponse = { loadType: 'search', data: [
    { encoded: 'E1', info: { title: 'One', author: 'Artist', uri: 'u1' } },
    { encoded: 'E2', info: { title: 'Two', author: 'Artist', uri: 'u2' } },
  ] };
  const node = { name: 'A', usable: true, ready: true, failures: 0, latency: 1, async request() { return searchResponse; } };
  const manager = new LavalinkManager({ nodes: [], searchPrefix: 'ytsearch', searchFallback: false }, { log: () => {} });
  manager.nodes = [node];
  const results = await manager.search('some song');
  assert.equal(results.length, 2);
  assert.equal(results[0].title, 'One');

  assert.deepEqual(await manager.search('https://www.youtube.com/watch?v=abc'), []);

  const emptyManager = new LavalinkManager({ nodes: [], searchPrefix: 'ytsearch' }, { log: () => {} });
  assert.deepEqual(await emptyManager.search('x'), []);
});

test('F-18: search() caches identical queries instead of re-hitting the node every keystroke-repeat', async () => {
  let calls = 0;
  const node = {
    name: 'A', usable: true, ready: true, failures: 0, latency: 1,
    async request() { calls++; return { loadType: 'search', data: [{ encoded: 'E1', info: { title: 'One', uri: 'u1' } }] }; },
  };
  const manager = new LavalinkManager({ nodes: [], searchPrefix: 'ytsearch' }, { log: () => {} });
  manager.nodes = [node];
  await manager.search('same query');
  await manager.search('same query');
  await manager.search('SAME QUERY'); // case-insensitive cache key
  assert.equal(calls, 1, 'identical queries within the cache window must not re-hit the node');
});

test('REL-02: list() ranks active node first, then fewer failures, then lower latency', () => {
  const manager = new LavalinkManager({ nodes: [] }, { log: () => {} });
  const good = Object.assign(new LavalinkNode({ name: 'good', host: 'h', port: 1, password: 'p' }), { ready: true, quarantineUntil: 0, failures: 0, latency: 200 });
  const flaky = Object.assign(new LavalinkNode({ name: 'flaky', host: 'h', port: 1, password: 'p' }), { ready: true, quarantineUntil: 0, failures: 3, latency: 10 });
  const fast = Object.assign(new LavalinkNode({ name: 'fast', host: 'h', port: 1, password: 'p' }), { ready: true, quarantineUntil: 0, failures: 0, latency: 10 });
  manager.nodes = [good, flaky, fast];
  const order = manager.list().map(n => n.name);
  assert.deepEqual(order, ['fast', 'good', 'flaky']);
  manager.active = good;
  assert.equal(manager.list()[0].name, 'good');
});

test('REL-01: a brief WS close does not immediately emit "unavailable", and resuming before the grace window cancels it', async () => {
  const { node, socketOf } = makeNode();
  node.start('bot-id');
  const socket = socketOf();
  assert.ok(socket, 'connect() should have created a socket');
  socket.emit('message', JSON.stringify({ op: 'ready', sessionId: 'sess-1' }));
  assert.equal(node.ready, true);

  let unavailableFired = false;
  node.on('unavailable', () => { unavailableFired = true; });

  socket.emit('close', 1006);
  assert.equal(unavailableFired, false, 'must not fire synchronously on close');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(unavailableFired, false, 'must not fire within the grace window');
  assert.ok(node.graceTimer, 'a grace timer should be pending');

  // Simulate the node reconnecting and resuming within the grace window.
  node.ws = null; // allow connect() to run again as scheduleReconnect() would trigger
  node.connect();
  socketOf().emit('message', JSON.stringify({ op: 'ready', sessionId: 'sess-1', resumed: true }));
  assert.equal(node.graceTimer, null, 'ready should cancel the pending grace timer');
  await new Promise(r => setTimeout(r, 20));
  assert.equal(unavailableFired, false, 'resuming in time must prevent the failover signal entirely');
  node.stop();
});

// TEST-01: GuildPlayer unit tests with a fully fake Lavalink manager/node -
// no network, no Discord gateway, no real WebSocket. These are mocked
// regression tests for BUG-05/BUG-07/queue ops, not live verification.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { GuildPlayer } from '../src/player.mjs';

function fakeGuild() {
  return { id: 'guild-1', shard: { send() {} } };
}

function fakeNode(name) {
  return {
    name,
    ready: true,
    usable: true,
    patches: [],
    async patch(guildId, body) { this.patches.push(body); },
    async destroy() {},
  };
}

function fakeManager(nodes) {
  return {
    nodes,
    async available(exclude = []) { return nodes.filter(n => !exclude.includes(n.name)); },
    async trackOnNode(song) { return song.encoded || 'ENCODED'; },
  };
}

function readyGuildPlayer(nodes) {
  const manager = fakeManager(nodes);
  const gp = new GuildPlayer(fakeGuild(), manager, { idleMs: 60_000, queueLimit: 30 }, () => {});
  gp.voiceChannelId = 'vc-1';
  gp.voice = { sessionId: 's', token: 't', endpoint: 'e', channelId: 'vc-1' };
  return gp;
}

async function waitForPatch(node, countBefore) {
  for (let i = 0; i < 50 && node.patches.length <= countBefore; i++) await new Promise(r => setTimeout(r, 5));
  assert.ok(node.patches.length > countBefore, `expected a new patch on ${node.name}`);
  return node.patches[node.patches.length - 1];
}

test('queue ops: shuffle/removeAt/clear/move/dedupe', () => {
  const gp = readyGuildPlayer([fakeNode('A')]);
  gp.items = [{ title: '1', url: 'u1' }, { title: '2', url: 'u2' }, { title: '2dup', url: 'u2' }];
  assert.equal(gp.dedupe(), 1);
  assert.equal(gp.items.length, 2);
  assert.equal(gp.move(1, 2), true);
  assert.equal(gp.items[0].title, '2');
  const removed = gp.removeAt(1);
  assert.equal(removed.title, '2');
  assert.equal(gp.clear(), 1);
  assert.equal(gp.items.length, 0);
});

test('BUG-07: pause state survives a failover to another node', async () => {
  const A = fakeNode('A'), B = fakeNode('B');
  const gp = readyGuildPlayer([A, B]);
  gp.enqueue({ title: 'Song', duration: 100, isStream: false, query: 'q', url: 'u' });
  await waitForPatch(A, 0);
  assert.equal(A.patches[0].paused, false);

  await gp.setPaused(true);
  assert.equal(A.patches.at(-1).paused, true);

  gp.onNodeUnavailable(A);
  const bodyOnB = await waitForPatch(B, 0);
  assert.equal(bodyOnB.paused, true, 'the new node must receive paused:true, not the hardcoded false from before the fix');
});

test('BUG-05: a live stream never gets a `position` field, even after a failover with accumulated position', async () => {
  const A = fakeNode('A'), B = fakeNode('B');
  const gp = readyGuildPlayer([A, B]);
  gp.enqueue({ title: 'Live', duration: 0, isStream: true, query: 'q', url: 'u' });
  await waitForPatch(A, 0);

  // Simulate playerUpdate ticks accumulating a "position" for the stream.
  gp.onNodeEvent(A, { op: 'playerUpdate', state: { position: 12345 } });
  assert.equal(gp.current.position, 12345);

  gp.onNodeUnavailable(A);
  const bodyOnB = await waitForPatch(B, 0);
  assert.ok(!('position' in bodyOnB), 'a stream failover must omit position entirely');
});

test('regular (non-stream) failover forwards the last known position', async () => {
  const A = fakeNode('A'), B = fakeNode('B');
  const gp = readyGuildPlayer([A, B]);
  gp.enqueue({ title: 'Song', duration: 200, isStream: false, query: 'q', url: 'u' });
  await waitForPatch(A, 0);
  gp.onNodeEvent(A, { op: 'playerUpdate', state: { position: 5000 } });

  gp.onNodeUnavailable(A);
  const bodyOnB = await waitForPatch(B, 0);
  assert.equal(bodyOnB.position, 5000);
});

test('FEAT-01: active filters are resent on failover', async () => {
  const A = fakeNode('A'), B = fakeNode('B');
  const gp = readyGuildPlayer([A, B]);
  gp.enqueue({ title: 'Song', duration: 200, isStream: false, query: 'q', url: 'u' });
  await waitForPatch(A, 0);
  await gp.setFilters({ timescale: { speed: 1.2 } });

  gp.onNodeUnavailable(A);
  const bodyOnB = await waitForPatch(B, 0);
  assert.deepEqual(bodyOnB.filters, { timescale: { speed: 1.2 } });
});

test('F-14/F-15: previous() restores the last history entry and puts the current track back ahead of it', async () => {
  const A = fakeNode('A');
  const gp = readyGuildPlayer([A]);
  gp.enqueue({ title: 'Song1', duration: 100, isStream: false, query: 'q1', url: 'u1' });
  await waitForPatch(A, 0);
  gp.finishCurrent(gp.current); // "Song1" finishes -> history=[Song1], nothing queued next
  assert.equal(gp.history.length, 1);
  assert.equal(gp.history[0].title, 'Song1');

  gp.enqueue({ title: 'Song2', duration: 100, isStream: false, query: 'q2', url: 'u2' });
  await waitForPatch(A, 1);
  assert.equal(gp.current.song.title, 'Song2');

  const prev = gp.previous();
  assert.equal(prev.title, 'Song1');
  assert.equal(gp.history.length, 0, 'the restored entry is consumed from history');
  await waitForPatch(A, 2);
  assert.equal(gp.current.song.title, 'Song1', 'previous() must make the history entry current again');
  assert.equal(gp.items[0].title, 'Song2', 'the track we navigated away from goes back into the queue, not lost');
});

test('previous() with nothing playing but history available queues and starts it', () => {
  const gp = readyGuildPlayer([fakeNode('A')]);
  gp.history = [{ title: 'Old', duration: 10, isStream: false, query: 'q', url: 'u' }];
  const prev = gp.previous();
  assert.equal(prev.title, 'Old');
  assert.equal(gp.current.song.title, 'Old');
});

test('previous() returns null when there is no history', () => {
  const gp = readyGuildPlayer([fakeNode('A')]);
  assert.equal(gp.previous(), null);
});

test('F-23 autoplay: triggers a related search only when the queue actually runs dry with autoplay on', async () => {
  const A = fakeNode('A');
  const gp = readyGuildPlayer([A]);
  gp.autoplay = true;
  gp.manager.search = async () => [{ title: 'Related', url: 'related-url' }];
  gp.manager.resolve = async () => ({ title: 'Related', author: '', url: 'related-url', query: 'related-url', duration: 120, isStream: false });
  gp.enqueue({ title: 'Last', author: 'Artist', duration: 100, isStream: false, query: 'q', url: 'u' });
  await waitForPatch(A, 0);
  gp.finishCurrent(gp.current);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(gp.current.song.title, 'Related', 'autoplay should have queued and started a related track');
});

test('autoplay does nothing when disabled, even with an empty queue at finish', async () => {
  const A = fakeNode('A');
  const gp = readyGuildPlayer([A]);
  gp.autoplay = false;
  let searched = false;
  gp.manager.search = async () => { searched = true; return []; };
  gp.enqueue({ title: 'Last', duration: 100, isStream: false, query: 'q', url: 'u' });
  await waitForPatch(A, 0);
  gp.finishCurrent(gp.current);
  await new Promise(r => setTimeout(r, 10));
  assert.equal(searched, false);
  assert.equal(gp.current, null);
});

test('persistence snapshot round-trips title/query/volume/loopMode', () => {
  const gp = readyGuildPlayer([fakeNode('A')]);
  gp.items = [{ title: 'Song', author: 'Artist', url: 'u', query: 'q', duration: 10, isStream: false }];
  gp.volume = 55;
  gp.loopMode = 'queue';
  const snap = gp.snapshot();
  assert.equal(snap.volume, 55);
  assert.equal(snap.loopMode, 'queue');
  assert.equal(snap.songs.length, 1);
  assert.equal(snap.songs[0].title, 'Song');
  assert.equal('encoded' in snap.songs[0], false, 'encoded must never be persisted');
});

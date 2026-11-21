// Pure-function tests for the controller/queue-browser payload builders.
// This verifies the PAYLOAD SHAPE and the stale-button customId contract -
// it does NOT verify how Discord actually renders it (no live client here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildControllerPayload, buildQueuePayload } from '../src/controller.mjs';

function gpStub(overrides = {}) {
  return { current: null, items: [], volume: 100, loopMode: 'off', sticky: false, ...overrides };
}

test('controller: no track playing disables playpause/skip/stop and encodes curId=0', () => {
  const payload = buildControllerPayload(gpStub());
  const row = payload.components[0];
  const data = row.toJSON();
  const playpause = data.components.find(c => c.custom_id.startsWith('tctl:playpause:'));
  assert.equal(playpause.custom_id, 'tctl:playpause:0');
  assert.equal(playpause.disabled, true);
});

test('controller: a playing, paused track enables controls and shows the real curId', () => {
  const gp = gpStub({ current: { id: '42', paused: true, position: 30_000, song: { title: 'Song', author: 'Artist', duration: 200, isStream: false }, node: { name: 'A' } } });
  const payload = buildControllerPayload(gp);
  const data = payload.components[0].toJSON();
  const playpause = data.components.find(c => c.custom_id === 'tctl:playpause:42');
  assert.ok(playpause, 'customId must embed the current track id');
  assert.equal(playpause.disabled, false);
  assert.equal(payload.embeds[0].data.title, 'Song');
});

test('controller: a live stream shows LIVE instead of a position fraction', () => {
  const gp = gpStub({ current: { id: '1', paused: false, position: 999, song: { title: 'Radio', duration: 0, isStream: true }, node: { name: 'A' } } });
  const payload = buildControllerPayload(gp);
  const progress = payload.embeds[0].data.fields.find(f => f.name === 'Progress');
  assert.equal(progress.value, 'LIVE');
});

test('queue browser: pagination clamps out-of-range pages and disables edge buttons', () => {
  const items = Array.from({ length: 25 }, (_, i) => ({ title: `Song ${i + 1}`, duration: 100 }));
  const gp = gpStub({ items });
  const first = buildQueuePayload(gp, 0).components[0].toJSON();
  assert.equal(first.components[0].disabled, true, 'prev disabled on first page');
  assert.equal(first.components[1].disabled, false);

  const last = buildQueuePayload(gp, 999).components[0].toJSON(); // out-of-range -> clamp to last real page
  assert.equal(last.components[1].disabled, true, 'next disabled on last page');

  const empty = buildQueuePayload(gpStub(), 0);
  assert.match(empty.embeds[0].data.description, /empty/);
});

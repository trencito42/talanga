import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { Persistence } from '../src/persistence.mjs';

function tmpFile() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'talanga-test-')), 'state.json');
}

test('load() on a missing file returns {} without throwing', () => {
  const p = new Persistence(tmpFile());
  assert.deepEqual(p.load(), {});
});

test('save() then load() round-trips, and a corrupt file is treated as empty', async () => {
  const file = tmpFile();
  const p = new Persistence(file);
  await p.save({ g1: { volume: 70, songs: [] } });
  assert.deepEqual(p.load(), { g1: { volume: 70, songs: [] } });

  fs.writeFileSync(file, 'not json');
  assert.deepEqual(p.load(), {});
});

test('save() never leaves a .tmp file behind on success', async () => {
  const file = tmpFile();
  const p = new Persistence(file);
  await p.save({});
  const dir = fs.readdirSync(path.dirname(file));
  assert.ok(!dir.some(f => f.includes('.tmp-')));
});

test('F-20/F-21: saveLibrary() and save() do not clobber each other', async () => {
  const file = tmpFile();
  const p = new Persistence(file);
  await p.save({ g1: { volume: 70 } });
  await p.saveLibrary({ g1: { favorites: [{ title: 'Fav' }], playlists: {} } });
  assert.deepEqual(p.load(), { g1: { volume: 70 } }, 'a later saveLibrary() must not erase the queue snapshot');
  assert.deepEqual(p.loadLibrary(), { g1: { favorites: [{ title: 'Fav' }], playlists: {} } });

  await p.save({ g1: { volume: 99 } });
  assert.deepEqual(p.loadLibrary(), { g1: { favorites: [{ title: 'Fav' }], playlists: {} } }, 'a later save() must not erase the library');
});

test('loadLibrary() on a missing file returns {} without throwing', () => {
  const p = new Persistence(tmpFile());
  assert.deepEqual(p.loadLibrary(), {});
});

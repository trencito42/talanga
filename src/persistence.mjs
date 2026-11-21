// PERS-01: crash-resistant queue/settings snapshotting, plus a separate
// "library" section for saved playlists/favorites (F-20/F-21). Plain JSON,
// atomic write (tmp file + rename so a crash mid-write can never corrupt the
// previous good file), periodic + on-shutdown saves for the queue snapshot;
// the library is written immediately whenever a playlist/favorite command
// changes it, since it must never be lost to a stale autosave overwrite.
// Deliberately does NOT persist encoded tracks or exact playback position:
// an encoded track is tied to one Lavalink node's session and a position can
// go stale the instant the process restarts, so re-claiming either as exact
// after a restart would be dishonest. What is restorable: the queue (by
// title/url/query), volume, loop mode, filters, and the voice channel to
// rejoin - via the explicit /restore command, never automatically on boot.
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';

const FILE_VERSION = 2;

export class Persistence {
  constructor(filePath, log = () => {}) {
    this.filePath = filePath;
    this.log = log;
    this.saving = Promise.resolve();
    this.timer = null;
  }

  // Internal: read the whole file as-is, tolerating both the old (v1,
  // guilds-only) shape and the current one; never throws.
  _readRaw() {
    try {
      const raw = fs.readFileSync(this.filePath, 'utf8');
      const data = JSON.parse(raw);
      if (!data || typeof data !== 'object') return { guilds: {}, library: {} };
      return { guilds: data.guilds || {}, library: data.library || {} };
    } catch (e) {
      if (e.code !== 'ENOENT') this.log(`[persistence] file unreadable, starting empty (${e.message})`);
      return { guilds: {}, library: {} };
    }
  }

  load() { return this._readRaw().guilds; }
  loadLibrary() { return this._readRaw().library; }

  // Serialized: never let two saves race and interleave writes to the same
  // file - each call reads-modifies-writes on top of the last queued write,
  // so a queue autosave and a library update never clobber one another.
  save(guildsSnapshot) {
    this.saving = this.saving.catch(() => {}).then(() => this._writeAtomic(current => ({ ...current, guilds: guildsSnapshot })));
    return this.saving;
  }

  saveLibrary(libraryData) {
    this.saving = this.saving.catch(() => {}).then(() => this._writeAtomic(current => ({ ...current, library: libraryData })));
    return this.saving;
  }

  async _writeAtomic(mutate) {
    const next = mutate(this._readRaw());
    const payload = JSON.stringify({ version: FILE_VERSION, savedAt: Date.now(), guilds: next.guilds, library: next.library }, null, 0);
    const tmp = `${this.filePath}.tmp-${process.pid}`;
    try {
      await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
      await fsp.writeFile(tmp, payload, 'utf8');
      await fsp.rename(tmp, this.filePath);
    } catch (e) {
      this.log(`[persistence] save failed: ${e.message}`);
      await fsp.rm(tmp, { force: true }).catch(() => {});
    }
  }

  startAutosave(intervalMs, getSnapshot) {
    this.stopAutosave();
    this.timer = setInterval(() => { void this.save(getSnapshot()); }, intervalMs);
    this.timer.unref?.();
  }

  stopAutosave() {
    clearInterval(this.timer);
    this.timer = null;
  }
}

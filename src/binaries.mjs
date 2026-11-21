// Locates, verifies and (only if missing) installs the yt-dlp and FFmpeg
// executables inside the application directory. Nothing here needs root,
// apt or a global PATH entry.
import { execFile } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { promisify } from 'node:util';
import { createGunzip } from 'node:zlib';
import { APP_DIR, CACHE_DIR } from './config.mjs';

const execFileAsync = promisify(execFile);
export const BIN_DIR = path.join(APP_DIR, 'bin');

// Pinned, versioned fallback downloads. Hashes for yt-dlp come from the
// release's official SHA2-256SUMS; FFmpeg hashes were computed from the
// ffmpeg-static GitHub release assets (the same files `ffmpeg-static@5.3.0`
// downloads in its postinstall script).
const YTDLP_VERSION = '2026.08.19';
const YTDLP_ASSETS = {
  'linux-x64-glibc': ['yt-dlp_linux', '58162f9bfdc27458ea47bfcb311cf47028f17d8154a8bf7d689861d46399230a'],
  'linux-arm64-glibc': ['yt-dlp_linux_aarch64', 'b16e4dab368a816cd05d477d698a605a6ae87ccee1c8ffd38fa21d7254141fcc'],
  'linux-x64-musl': ['yt-dlp_musllinux', 'f3dec9cfeaf304cec98290fe41c6ad465d4b747d302473559643e7af24929722'],
  'linux-arm64-musl': ['yt-dlp_musllinux_aarch64', '17b164c4d258be92bb1ad146cb7c336b783aedb380814aabbcb7d52937f77e57'],
};
const FFMPEG_TAG = 'b6.1.1';
const FFMPEG_ASSETS = {
  'linux-x64': ['ffmpeg-linux-x64.gz', 'bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa'],
  'linux-arm64': ['ffmpeg-linux-arm64.gz', '754a678672298bc68156adff58aa7385a592c2b30b1d0ae8750c45c915c4bac0'],
};
const MAX_DOWNLOAD_BYTES = 200 * 1024 * 1024;

const exe = process.platform === 'win32' ? '.exe' : '';

export function platformInfo() {
  let libc = null;
  if (process.platform === 'linux') {
    try {
      process.report.excludeNetwork = true;
      libc = process.report.getReport().header.glibcVersionRuntime ? 'glibc' : 'musl';
    } catch { libc = 'unknown'; }
  }
  const glibcVersion = libc === 'glibc' ? process.report.getReport().header.glibcVersionRuntime : null;
  return { platform: process.platform, arch: process.arch, libc, glibcVersion };
}

// Reads the ELF header so a wrong-architecture binary is reported clearly
// instead of failing later with a confusing ENOEXEC/ENOENT.
async function elfArch(file) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const buf = Buffer.alloc(20);
    await fh.read(buf, 0, 20, 0);
    if (buf.readUInt32BE(0) !== 0x7f454c46) return null;
    const machine = buf.readUInt16LE(18);
    return { 0x3e: 'x64', 0xb7: 'arm64', 0x28: 'arm', 0x03: 'ia32' }[machine] || `0x${machine.toString(16)}`;
  } catch { return null; } finally { await fh?.close(); }
}

async function ensureExecutable(file) {
  if (process.platform === 'win32') return null;
  try {
    const st = await fsp.stat(file);
    if ((st.mode & 0o111) === 0o111) return null;
    await fsp.chmod(file, st.mode | 0o755);
    return null;
  } catch (e) {
    return `chmod failed (${e.code || e.message})`;
  }
}

function explainSpawnError(e, file) {
  if (e.code === 'ENOENT') {
    return fs.existsSync(file)
      ? 'ENOENT although the file exists: its loader/libc is missing (e.g. a glibc build on a musl system)'
      : 'ENOENT: file not found';
  }
  if (e.code === 'EACCES') return 'EACCES: not executable (missing +x or the volume is mounted noexec)';
  if (e.code === 'ENOEXEC') return 'ENOEXEC: wrong binary format/architecture for this machine';
  if (e.killed || e.signal) return `timed out / killed (${e.signal || 'timeout'})`;
  return String(e.stderr || e.message || e).trim().split('\n').slice(-2).join(' ').slice(0, 300);
}

export function childEnv() {
  // Keep PyInstaller/yt-dlp temporary and cache files inside the app volume.
  // Child processes never receive the Discord token.
  const { DISCORD_TOKEN: _omit, ...rest } = process.env;
  return {
    ...rest,
    TMPDIR: path.join(CACHE_DIR, 'tmp'),
    XDG_CACHE_HOME: CACHE_DIR,
  };
}

async function probe(file, args, timeout) {
  const { stdout } = await execFileAsync(file, args, {
    timeout, maxBuffer: 4 * 1024 * 1024, env: childEnv(), windowsHide: true,
  });
  return stdout;
}

async function checkYtdlp(file, source) {
  const result = { path: file, source, ok: false, version: null, arch: await elfArch(file), error: null };
  if (!path.isAbsolute(file) || fs.existsSync(file)) result.chmodError = await ensureExecutable(file);
  try {
    result.version = (await probe(file, ['--version'], 60_000)).trim();
    result.ok = /^\d{4}\.\d{2}\.\d{2}/.test(result.version);
    if (!result.ok) result.error = 'unexpected --version output';
  } catch (e) { result.error = explainSpawnError(e, file); }
  return result;
}

async function checkFfmpeg(file, source) {
  const result = { path: file, source, ok: false, version: null, arch: await elfArch(file), opusEncoder: null, oggMuxer: false, error: null };
  if (!path.isAbsolute(file) || fs.existsSync(file)) result.chmodError = await ensureExecutable(file);
  try {
    const version = await probe(file, ['-hide_banner', '-version'], 20_000);
    result.version = version.match(/ffmpeg version (\S+)/)?.[1] || 'unknown';
    const encoders = await probe(file, ['-hide_banner', '-encoders'], 20_000);
    if (/^\s*A\S*\s+libopus\s/m.test(encoders)) result.opusEncoder = 'libopus';
    else if (/^\s*A\S*\s+opus\s/m.test(encoders)) result.opusEncoder = 'opus';
    const muxers = await probe(file, ['-hide_banner', '-muxers'], 20_000);
    result.oggMuxer = /^\s*E\s+opus\s/m.test(muxers);
    result.ok = Boolean(result.opusEncoder && result.oggMuxer);
    if (!result.ok) result.error = `missing ${result.opusEncoder ? '' : 'Opus encoder '}${result.oggMuxer ? '' : 'Ogg/Opus muxer'}`.trim();
  } catch (e) { result.error = explainSpawnError(e, file); }
  return result;
}

function hashingPassThrough(hash, limit) {
  let total = 0;
  return new Transform({
    transform(chunk, _enc, cb) {
      total += chunk.length;
      if (total > limit) return cb(new Error('download exceeds size limit'));
      hash.update(chunk);
      cb(null, chunk);
    },
  });
}

// Download -> verify SHA-256 -> chmod -> atomic rename. A partial or
// tampered download never replaces a working binary.
export async function installVerified(url, expectedSha, dest, { gunzip = false } = {}, log) {
  await fsp.mkdir(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.download-${process.pid}`;
  const hash = createHash('sha256');
  log(`Downloading ${url}`);
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(10 * 60_000) });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);
    const stages = [Readable.fromWeb(res.body), hashingPassThrough(hash, MAX_DOWNLOAD_BYTES)];
    if (gunzip) stages.push(createGunzip());
    stages.push(fs.createWriteStream(tmp, { mode: 0o755 }));
    await pipeline(stages);
    const actual = hash.digest('hex');
    if (actual !== expectedSha) throw new Error(`SHA-256 mismatch (got ${actual})`);
    await fsp.chmod(tmp, 0o755);
    await fsp.rename(tmp, dest);
    log(`Installed ${path.relative(APP_DIR, dest)} (sha256 verified)`);
  } finally {
    await fsp.rm(tmp, { force: true });
  }
}

function platformKey(info) {
  if (info.platform !== 'linux') return null;
  return `linux-${info.arch}`;
}

async function firstWorking(candidates, check, attempts) {
  for (const [file, source] of candidates) {
    if (path.isAbsolute(file) && !fs.existsSync(file)) {
      attempts.push({ path: file, source, ok: false, error: 'not present' });
      continue;
    }
    const r = await check(file, source);
    if (r.ok) return r;
    attempts.push(r);
  }
  return null;
}

export async function resolveBinaries(config, log = console.log) {
  const info = platformInfo();
  const key = platformKey(info);
  await fsp.mkdir(path.join(CACHE_DIR, 'tmp'), { recursive: true });

  // ---- yt-dlp ----
  const ytAsset = YTDLP_ASSETS[`${key}-${info.libc}`];
  const ytCandidates = [];
  if (config.ytdlpPath) ytCandidates.push([config.ytdlpPath, 'YTDLP_PATH']);
  ytCandidates.push([path.join(BIN_DIR, 'yt-dlp', `yt-dlp_linux${exe}`), 'bundled (onedir)']);
  if (ytAsset) ytCandidates.push([path.join(BIN_DIR, ytAsset[0]), 'auto-installed']);
  ytCandidates.push([`yt-dlp${exe}`, 'system PATH']);

  const ytAttempts = [];
  let ytdlp = await firstWorking(ytCandidates, checkYtdlp, ytAttempts);
  if (!ytdlp && config.autoInstallBinaries && ytAsset) {
    const dest = path.join(BIN_DIR, ytAsset[0]);
    try {
      await installVerified(`https://github.com/yt-dlp/yt-dlp/releases/download/${YTDLP_VERSION}/${ytAsset[0]}`, ytAsset[1], dest, {}, log);
      ytdlp = await checkYtdlp(dest, 'auto-installed');
    } catch (e) {
      ytdlp = { path: dest, source: 'auto-install', ok: false, error: `auto-install failed: ${e.message}` };
    }
  }
  if (!ytdlp) {
    const last = ytCandidates[0];
    ytdlp = { path: last[0], source: last[1], ok: false, error: ytAsset ? 'no working yt-dlp found' : `no working yt-dlp and no pinned download for ${info.platform}-${info.arch}${info.libc ? `-${info.libc}` : ''}` };
  }
  ytdlp.attempts = ytAttempts;

  // ---- FFmpeg ----
  const ffAsset = FFMPEG_ASSETS[key];
  const ffCandidates = [];
  if (config.ffmpegPath) ffCandidates.push([config.ffmpegPath, 'FFMPEG_PATH']);
  ffCandidates.push([path.join(BIN_DIR, `ffmpeg${exe}`), 'bundled']);
  try {
    const mod = await import('ffmpeg-static'); // optional, only if the user installed it
    if (mod.default) ffCandidates.push([mod.default, 'ffmpeg-static']);
  } catch { /* not installed */ }
  ffCandidates.push([`ffmpeg${exe}`, 'system PATH']);

  const ffAttempts = [];
  let ffmpeg = await firstWorking(ffCandidates, checkFfmpeg, ffAttempts);
  if (!ffmpeg && config.autoInstallBinaries && ffAsset) {
    const dest = path.join(BIN_DIR, 'ffmpeg');
    try {
      await installVerified(`https://github.com/eugeneware/ffmpeg-static/releases/download/${FFMPEG_TAG}/${ffAsset[0]}`, ffAsset[1], dest, { gunzip: true }, log);
      ffmpeg = await checkFfmpeg(dest, 'auto-installed');
    } catch (e) {
      ffmpeg = { path: dest, source: 'auto-install', ok: false, error: `auto-install failed: ${e.message}` };
    }
  }
  if (!ffmpeg) ffmpeg = { path: ffCandidates[0][0], source: ffCandidates[0][1], ok: false, error: ffAsset ? 'no working FFmpeg found' : `no working FFmpeg and no pinned download for ${info.platform}-${info.arch}` };
  ffmpeg.attempts = ffAttempts;

  return { info, ytdlp, ffmpeg };
}

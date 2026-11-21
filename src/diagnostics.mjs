// Startup/admin diagnostics. Prints only presence of secrets, never values.
import path from 'node:path';
import { APP_DIR } from './config.mjs';

const rel = p => (p && path.isAbsolute(p) ? path.relative(APP_DIR, p) || p : p);

export function audioProblems(runtime) {
  const out = [];
  if (!runtime.ytdlp?.ok) out.push(`yt-dlp: ${runtime.ytdlp?.error || 'not checked'}`);
  if (!runtime.ffmpeg?.ok) out.push(`FFmpeg: ${runtime.ffmpeg?.error || 'not checked'}`);
  return out;
}

export function formatDiagnostics(config, runtime, { discordUser = null } = {}) {
  const { info, ytdlp, ffmpeg, pot } = runtime;
  const lines = [];
  lines.push(`Node.js ${process.version} | ${info.platform} ${info.arch}${info.libc ? ` ${info.libc}${info.glibcVersion ? ` ${info.glibcVersion}` : ''}` : ''} | RSS ${Math.round(process.memoryUsage().rss / 1048576)} MB`);
  lines.push(`Discord config: DISCORD_TOKEN ${config.token ? 'set' : 'MISSING'}, GUILD_ID ${config.guildId ? 'set' : 'MISSING'}, IP_FAMILY=${config.family}${config.problems.length ? ` (problems: ${config.problems.join('; ')})` : ''}`);
  lines.push(`Discord: ${discordUser ? `connected as ${discordUser}` : 'not connected'}`);
  if (ytdlp) {
    lines.push(`yt-dlp: ${ytdlp.ok ? 'OK' : 'FAIL'} ${ytdlp.version || ''} [${ytdlp.source}] ${rel(ytdlp.path)}${ytdlp.arch ? ` (ELF ${ytdlp.arch})` : ''}${ytdlp.ok ? ', executable' : ` - ${ytdlp.error}`}`);
    for (const a of ytdlp.attempts || []) if (!a.ok) lines.push(`  tried ${rel(a.path)} [${a.source}]: ${a.error}`);
  }
  if (ffmpeg) {
    lines.push(`FFmpeg: ${ffmpeg.ok ? 'OK' : 'FAIL'} ${ffmpeg.version || ''} [${ffmpeg.source}] ${rel(ffmpeg.path)}${ffmpeg.arch ? ` (ELF ${ffmpeg.arch})` : ''}${ffmpeg.ok ? `, encoder ${ffmpeg.opusEncoder}, ogg/opus muxer` : ` - ${ffmpeg.error}`}`);
    for (const a of ffmpeg.attempts || []) if (!a.ok) lines.push(`  tried ${rel(a.path)} [${a.source}]: ${a.error}`);
  }
  if (pot) {
    const where = pot.external ? `external ${pot.baseUrl}` : `local child ${pot.baseUrl}`;
    lines.push(`PO Token provider: ${runtime.potReady ? `OK bgutil ${pot.version || '?'} (${where})` : `UNAVAILABLE (${pot.lastError || 'starting'})`}`);
  }
  lines.push(`YouTube strategy: ${runtime.youtube?.preferFallback ? 'yt-dlp defaults (working fallback)' : `primary ${runtime.youtube?.clients || 'yt-dlp defaults'}`}${config.cookiesFile ? ' + cookies file configured' : ''}; alternate tried on failures`);
  if (runtime.ytTest) lines.push(`YouTube self-test: ${runtime.ytTest.ok ? 'OK' : 'FAIL'} - ${runtime.ytTest.detail}`);
  const problems = audioProblems(runtime);
  lines.push(`Audio playback: ${runtime.initializing ? 'INITIALIZING' : problems.length ? `NOT READY (${problems.join('; ')})` : runtime.ytTest && !runtime.ytTest.ok ? 'YouTube live audio probe FAILED' : runtime.ytTest?.ok ? 'live stream probe passed; voice untested' : 'binaries ready; YouTube untested'}`);
  return lines;
}

// F-31/F-32: persistent now-playing controller + paginated queue browser.
// Deliberately built on Components V1 (ActionRowBuilder/ButtonBuilder) rather
// than Components V2 containers: V1 buttons are long-stable in discord.js and
// render identically on mobile/desktop; V2's container/section layout needs a
// specific discord.js version and the IS_COMPONENTS_V2 message flag, which
// this environment has no way to verify live. Pure, discord.js-only module -
// no Lavalink/Discord-gateway calls here, so it's unit-testable in isolation.
import { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder } from 'discord.js';

const fmt = seconds => `${Math.floor((seconds || 0) / 60)}:${String(Math.floor((seconds || 0) % 60)).padStart(2, '0')}`;
const LOOP_LABEL = { off: 'Off', track: 'Track', queue: 'Queue' };
const LOOP_ICON = { off: '🔁', track: '🔂', queue: '🔁' };

// curId is embedded in every control button's customId so a click against a
// track that has since ended (stale interaction) can be detected and rejected
// instead of silently acting on whatever is "current" by then.
export function buildControllerPayload(gp) {
  const cur = gp.current;
  const curId = cur?.id ?? '0';
  const hasTrack = Boolean(cur);
  const button = (action, label, style, disabled = false) =>
    new ButtonBuilder().setCustomId(`tctl:${action}:${curId}`).setLabel(label).setStyle(style).setDisabled(disabled);

  const row = new ActionRowBuilder().addComponents(
    button('playpause', cur?.paused ? '▶️ Play' : '⏸️ Pause', ButtonStyle.Primary, !hasTrack),
    button('skip', '⏭️ Skip', ButtonStyle.Secondary, !hasTrack),
    button('stop', '⏹️ Stop', ButtonStyle.Danger, !hasTrack && !gp.items.length),
    button('shuffle', '🔀 Shuffle', ButtonStyle.Secondary, gp.items.length < 2),
    button('loop', `${LOOP_ICON[gp.loopMode]} ${LOOP_LABEL[gp.loopMode]}`, ButtonStyle.Secondary),
  );
  const row2 = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qpage:0`).setLabel(`📜 Queue (${gp.items.length})`).setStyle(ButtonStyle.Secondary),
  );

  const embed = new EmbedBuilder()
    .setTitle(hasTrack ? cur.song.title.slice(0, 250) : 'Nothing playing')
    .setColor(hasTrack ? 0x1db954 : 0x4f545c)
    .addFields(
      { name: 'Progress', value: !hasTrack ? '-' : cur.song.isStream ? 'LIVE' : `${fmt(cur.position / 1000)} / ${fmt(cur.song.duration)}`, inline: true },
      { name: 'Volume', value: `${gp.volume}%`, inline: true },
      { name: 'Loop', value: LOOP_LABEL[gp.loopMode], inline: true },
      { name: 'Queued', value: String(gp.items.length), inline: true },
      { name: '24/7', value: gp.sticky ? 'On' : 'Off', inline: true },
      { name: 'Node', value: cur?.node?.name || '-', inline: true },
    );
  if (hasTrack && cur.song.author) embed.setDescription(cur.song.author.slice(0, 200));

  return { embeds: [embed], components: hasTrack || gp.items.length ? [row, row2] : [row] };
}

const PAGE_SIZE = 10;

export function buildQueuePayload(gp, page = 0) {
  const totalPages = Math.max(1, Math.ceil(gp.items.length / PAGE_SIZE));
  const clamped = Math.min(Math.max(0, page), totalPages - 1);
  const slice = gp.items.slice(clamped * PAGE_SIZE, clamped * PAGE_SIZE + PAGE_SIZE);
  const lines = slice.length
    ? slice.map((s, i) => `${clamped * PAGE_SIZE + i + 1}. **${s.title}** (${fmt(s.duration)})`)
    : ['The queue is empty.'];
  const embed = new EmbedBuilder()
    .setTitle(`📜 Queue - page ${clamped + 1}/${totalPages}`)
    .setDescription(lines.join('\n').slice(0, 4000))
    .setColor(0x1db954);
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder().setCustomId(`qpage:${clamped - 1}`).setLabel('◀️').setStyle(ButtonStyle.Secondary).setDisabled(clamped <= 0),
    new ButtonBuilder().setCustomId(`qpage:${clamped + 1}`).setLabel('▶️').setStyle(ButtonStyle.Secondary).setDisabled(clamped >= totalPages - 1),
  );
  return { embeds: [embed], components: [row] };
}

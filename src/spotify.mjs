// F-36: Spotify metadata resolution ONLY - Spotify's API never returns
// playable audio, so this turns a Spotify link into search queries (artist +
// title), which are then resolved through the normal YouTube/SoundCloud path
// exactly like any other /play search. Never claim this plays "from Spotify".
// Requires SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET (operator-provided, not
// available in this environment) - without them `configured` is false and
// `resolve()` throws a clear, specific UserError instead of doing nothing.
import { UserError } from './lavalink.mjs';

const TOKEN_URL = 'https://accounts.spotify.com/api/token';
const API_BASE = 'https://api.spotify.com/v1';

export class SpotifyResolver {
  constructor(config, { fetchImpl = fetch } = {}) {
    this.clientId = config.spotifyClientId;
    this.clientSecret = config.spotifyClientSecret;
    this.fetchImpl = fetchImpl;
    this.token = null;
    this.tokenExpires = 0;
  }

  get configured() { return Boolean(this.clientId && this.clientSecret); }

  static isSpotifyUrl(input) { return /^https?:\/\/open\.spotify\.com\//i.test(String(input || '')); }

  static parseUrl(url) {
    const m = String(url).match(/open\.spotify\.com\/(?:intl-\w+\/)?(track|playlist|album)\/([A-Za-z0-9]+)/);
    return m ? { type: m[1], id: m[2] } : null;
  }

  async getToken() {
    if (this.token && Date.now() < this.tokenExpires) return this.token;
    const res = await this.fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        Authorization: `Basic ${Buffer.from(`${this.clientId}:${this.clientSecret}`).toString('base64')}`,
      },
      body: 'grant_type=client_credentials',
    });
    if (!res.ok) throw new Error(`Spotify auth failed: HTTP ${res.status}`);
    const data = await res.json();
    this.token = data.access_token;
    this.tokenExpires = Date.now() + Math.max(0, (data.expires_in || 3600) - 60) * 1000;
    return this.token;
  }

  async request(path) {
    const token = await this.getToken();
    const res = await this.fetchImpl(`${API_BASE}${path}`, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Spotify API: HTTP ${res.status}`);
    return res.json();
  }

  static trackToQuery(t) {
    const artists = (t.artists || []).map(a => a.name).join(' ');
    return { query: `${artists} ${t.name}`.trim(), title: t.name, author: (t.artists || []).map(a => a.name).join(', ') };
  }

  // Returns [{query, title, author}, ...] - search queries, never audio URLs.
  async resolve(url, { limit = 25 } = {}) {
    if (!this.configured) throw new UserError('Spotify integration is not configured on this bot (missing SPOTIFY_CLIENT_ID/SPOTIFY_CLIENT_SECRET).');
    const parsed = SpotifyResolver.parseUrl(url);
    if (!parsed) throw new UserError('Not a recognized Spotify track, playlist, or album link.');
    if (parsed.type === 'track') {
      const t = await this.request(`/tracks/${parsed.id}`);
      return [SpotifyResolver.trackToQuery(t)];
    }
    const endpoint = parsed.type === 'playlist' ? `/playlists/${parsed.id}/tracks` : `/albums/${parsed.id}/tracks`;
    const data = await this.request(`${endpoint}?limit=${Math.min(limit, 50)}`);
    const items = (data.items || []).map(it => it.track || it).filter(Boolean);
    return items.map(SpotifyResolver.trackToQuery);
  }
}

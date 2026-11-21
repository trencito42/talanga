// F-36: SpotifyResolver tests with a fully fake fetch - no real Spotify
// credentials or network. Verifies query-building and the "not configured"
// error path; does NOT verify a real Spotify API call (no credentials here).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SpotifyResolver } from '../src/spotify.mjs';

test('resolve() throws a specific error when not configured, without any network call', async () => {
  const resolver = new SpotifyResolver({ spotifyClientId: null, spotifyClientSecret: null }, {
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  await assert.rejects(() => resolver.resolve('https://open.spotify.com/track/abc'), /not configured/);
});

test('parseUrl recognizes track/playlist/album links and rejects everything else', () => {
  assert.deepEqual(SpotifyResolver.parseUrl('https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC'), { type: 'track', id: '4uLU6hMCjMI75M1A2tKUQC' });
  assert.deepEqual(SpotifyResolver.parseUrl('https://open.spotify.com/playlist/37i9dQZF1DXcBWIGoYBM5M'), { type: 'playlist', id: '37i9dQZF1DXcBWIGoYBM5M' });
  assert.equal(SpotifyResolver.parseUrl('https://open.spotify.com/artist/xyz'), null);
  assert.equal(SpotifyResolver.parseUrl('https://youtube.com/watch?v=x'), null);
});

test('isSpotifyUrl only matches open.spotify.com links', () => {
  assert.equal(SpotifyResolver.isSpotifyUrl('https://open.spotify.com/track/x'), true);
  assert.equal(SpotifyResolver.isSpotifyUrl('https://www.youtube.com/watch?v=x'), false);
  assert.equal(SpotifyResolver.isSpotifyUrl('not a url'), false);
});

function fakeFetch({ token = 'tok', trackResponses = {} } = {}) {
  return async (url, opts) => {
    if (String(url).startsWith('https://accounts.spotify.com/api/token')) {
      return { ok: true, json: async () => ({ access_token: token, expires_in: 3600 }) };
    }
    for (const [path, body] of Object.entries(trackResponses)) {
      if (String(url).includes(path)) return { ok: true, json: async () => body };
    }
    return { ok: false, status: 404 };
  };
}

test('resolve() turns a track link into one artist+title search query, never an audio URL', async () => {
  const resolver = new SpotifyResolver({ spotifyClientId: 'id', spotifyClientSecret: 'secret' }, {
    fetchImpl: fakeFetch({ trackResponses: { '/tracks/abc': { name: 'Song', artists: [{ name: 'Artist' }] } } }),
  });
  const results = await resolver.resolve('https://open.spotify.com/track/abc');
  assert.equal(results.length, 1);
  assert.equal(results[0].query, 'Artist Song');
  assert.equal(results[0].title, 'Song');
});

test('resolve() turns a playlist link into one query per track', async () => {
  const resolver = new SpotifyResolver({ spotifyClientId: 'id', spotifyClientSecret: 'secret' }, {
    fetchImpl: fakeFetch({
      trackResponses: {
        '/playlists/p1/tracks': {
          items: [
            { track: { name: 'One', artists: [{ name: 'A' }] } },
            { track: { name: 'Two', artists: [{ name: 'B' }] } },
          ],
        },
      },
    }),
  });
  const results = await resolver.resolve('https://open.spotify.com/playlist/p1');
  assert.equal(results.length, 2);
  assert.equal(results[1].query, 'B Two');
});

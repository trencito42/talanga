# Third-party components shipped with Talanga

| Component | Version | Location | License | Source |
|---|---|---|---|---|
| yt-dlp (Linux x64 standalone, onedir build `yt-dlp_linux.zip`) | 2026.08.19 | `bin/yt-dlp/` | Unlicense (public domain); bundled libraries listed in `bin/yt-dlp/_internal/THIRD_PARTY_LICENSES.txt` | https://github.com/yt-dlp/yt-dlp/releases/tag/2026.08.19 |
| FFmpeg static build by John Van Sickle, as redistributed by ffmpeg-static | 7.0.2 (ffmpeg-static release `b6.1.1`, asset `ffmpeg-linux-x64`) | `bin/ffmpeg` | GPL-3.0 (`ffmpeg-LICENSE.txt`, build details in `ffmpeg-README.txt`) | https://github.com/eugeneware/ffmpeg-static/releases/tag/b6.1.1 · https://johnvansickle.com/ffmpeg/ · https://ffmpeg.org/download.html |
| bgutil-ytdlp-pot-provider: server (compiled from TypeScript, unmodified) and yt-dlp plugin (unmodified) | 2.0.2 | `vendor/bgutil-server/`, `plugins/bgutil-ytdlp-pot-provider/` | GPL-3.0-only (`bgutil-ytdlp-pot-provider-LICENSE.txt`) | https://github.com/Brainicism/bgutil-ytdlp-pot-provider/tree/2.0.2 |

These programs run as separate processes and are not linked into Talanga.

GPL source offer: the exact source code for the GPL components is available at
the URLs above (the tagged releases). FFmpeg source for the 7.0.2 release is at
https://ffmpeg.org/releases/ffmpeg-7.0.2.tar.xz.

SHA-256 of the shipped binaries:

- `yt-dlp_linux.zip` (onedir archive, as published): `32e72032766bef9199d99d15beb69fd52e46df8f8b06f0d8745db59e04d339e9` (matches the release's official `SHA2-256SUMS`)
- `ffmpeg-linux-x64.gz` (as published): `bfe8a8fc511530457b528c48d77b5737527b504a3797a9bc4866aeca69c2dffa`
- `bgutil-ytdlp-pot-provider.zip` plugin (as published): see the 2.0.2 release

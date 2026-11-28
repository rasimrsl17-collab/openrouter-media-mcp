// import_media: bring the user's OWN image / audio / video from a link (direct https, Google Drive
// "Anyone with the link", Dropbox) into MEDIA_DIR, so it can be used in assemble_short / assemble_long /
// make_thumbnail / social_publish like anything this server generated.
// Same download safety as the long-video loader (https only, SSRF-safe DNS, size cap). Files are re-encoded
// or re-muxed, never stored as uploaded: what lands in /media is always a plain image, mp3 or mp4.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { config } from './config.js';
import { directUrl, download, SourceError } from './clips.js';
import { probe, run } from './studio.js';
import { saveMediaFile } from './storage.js';

const IMAGE_FORMATS = new Set(['jpeg', 'png', 'webp', 'gif', 'heif', 'avif', 'tiff']);

export async function importMedia(url) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'import-'));
  try {
    const src = path.join(tmp, 'src');
    await download(directUrl(url), src, 5, config.maxImportMb);

    // 1) image?
    let meta = null;
    try {
      meta = await sharp(src, { animated: false }).metadata();
    } catch {
      /* not an image */
    }
    if (meta && IMAGE_FORMATS.has(meta.format)) {
      const alpha = !!meta.hasAlpha;
      const out = path.join(tmp, alpha ? 'out.png' : 'out.jpg');
      let img = sharp(src, { animated: false }).rotate().resize(4096, 4096, { fit: 'inside', withoutEnlargement: true });
      img = alpha ? img.png() : img.jpeg({ quality: 92 });
      const info = await img.toFile(out);
      return { kind: 'image', ...saveMediaFile(out, alpha ? 'png' : 'jpg'), width: info.width, height: info.height };
    }

    // 2) audio / video?
    let info;
    try {
      info = await probe(src);
    } catch {
      throw new SourceError('This file is not an image, audio or video file that can be read.');
    }
    if (!(info.seconds > 0)) throw new SourceError('This file is not an image, audio or video file that can be read.');
    if (info.seconds > config.maxSourceMinutes * 60) {
      throw new SourceError(`The file is ${Math.ceil(info.seconds / 60)} min long; the limit is ${config.maxSourceMinutes} min.`);
    }
    const ff = (args, ms) => run(config.ffmpegPath, ['-hide_banner', '-loglevel', 'error', '-y', '-i', src, ...args], ms);
    if (info.hasVideo) {
      const out = path.join(tmp, 'out.mp4');
      try {
        await ff(['-map', '0:v:0', '-map', '0:a:0?', '-c', 'copy', '-movflags', '+faststart', out], 120_000);
      } catch {
        // codecs mp4 cannot hold: re-encode (slow for long files, but rare)
        await ff(
          ['-map', '0:v:0', '-map', '0:a:0?', '-c:v', 'libx264', '-preset', 'veryfast', '-crf', '22', '-pix_fmt', 'yuv420p',
            '-c:a', 'aac', '-b:a', '160k', '-movflags', '+faststart', out],
          Math.max(240_000, info.seconds * 4000),
        );
      }
      return { kind: 'video', ...saveMediaFile(out, 'mp4'), seconds: info.seconds, width: info.width, height: info.height };
    }
    if (info.hasAudio) {
      const out = path.join(tmp, 'out.mp3');
      await ff(['-vn', '-c:a', 'libmp3lame', '-b:a', '192k', out], Math.max(120_000, info.seconds * 1000));
      return { kind: 'audio', ...saveMediaFile(out, 'mp3'), seconds: info.seconds };
    }
    throw new SourceError('This file has no picture or sound.');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

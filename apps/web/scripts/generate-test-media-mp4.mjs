// Generates the synthetic MP4 (H.264/AAC) video fixture used by the Playwright
// local-player tests.
//
// Picture and sound come from FFmpeg's built-in lavfi generators: testsrc2
// (a moving test pattern with a frame counter) and sine (a 440 Hz tone). The
// fixture contains no recorded, personal, or third-party material. It is a
// local <video> playback fixture only and says nothing about Progressive
// Watch, which the application does not implement.
//
// The FFmpeg build must include libx264, the native AAC encoder, the lavfi
// input device, and the MP4 muxer. Playwright's bundled FFmpeg does not
// include libx264; the ffmpeg-static 5.3.0 npm package (FFmpeg 6.0) does.
//
//   FFMPEG=/path/to/ffmpeg npm run test-media:mp4
//
// Encoding is single-threaded with bit-exact flags and no metadata, so one
// FFmpeg build produces identical bytes on every run. Other builds may not.
// The committed fixture and its recorded SHA-256 digest in e2e/media/README.md
// are authoritative; regenerate only deliberately and update that record.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const OUTPUT_DIRECTORY = join(import.meta.dirname, '..', 'e2e', 'media');
const FILE = 'synthetic-320x180-8s-h264-aac.mp4';
const SECONDS = 8;

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    const stderr = [];
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve();
      } else {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(`${command} exited with ${String(code)}: ${message}`));
      }
    });
  });
}

const outputPath = join(OUTPUT_DIRECTORY, FILE);
await mkdir(OUTPUT_DIRECTORY, { recursive: true });
await run(FFMPEG, [
  '-hide_banner',
  '-loglevel',
  'error',
  '-f',
  'lavfi',
  '-i',
  `testsrc2=size=320x180:rate=30:duration=${String(SECONDS)}`,
  '-f',
  'lavfi',
  '-i',
  `sine=frequency=440:sample_rate=48000:duration=${String(SECONDS)}`,
  '-map',
  '0:v',
  '-map',
  '1:a',
  // H.264 High profile with B-frames and a keyframe every second, as typical
  // encoder output has, at a low bitrate to keep the file small.
  '-c:v',
  'libx264',
  '-profile:v',
  'high',
  '-level:v',
  '3.0',
  '-pix_fmt',
  'yuv420p',
  '-preset',
  'medium',
  '-threads',
  '1',
  '-g',
  '30',
  '-keyint_min',
  '30',
  '-sc_threshold',
  '0',
  '-bf',
  '2',
  '-b:v',
  '100k',
  '-maxrate',
  '150k',
  '-bufsize',
  '300k',
  // AAC-LC stereo at 48 kHz from FFmpeg's native encoder.
  '-c:a',
  'aac',
  '-b:a',
  '64k',
  '-ac',
  '2',
  '-ar',
  '48000',
  '-shortest',
  // The index (moov) precedes the media data, as in files prepared for
  // progressive download.
  '-movflags',
  '+faststart',
  '-map_metadata',
  '-1',
  '-map_chapters',
  '-1',
  '-fflags',
  '+bitexact',
  '-flags:v',
  '+bitexact',
  '-flags:a',
  '+bitexact',
  '-brand',
  'mp42',
  '-f',
  'mp4',
  '-y',
  outputPath,
]);

const mp4 = await readFile(outputPath);
const digest = createHash('sha256').update(mp4).digest('hex');
console.log(`${FILE}  ${String(mp4.length)} bytes  sha256 ${digest}`);

// Deterministic synthetic color + tone. Same FFmpeg build yields same bytes.
// Local-only fixture: never commit the generated MP4.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const OUTPUT_DIRECTORY = process.argv[2];
if (!OUTPUT_DIRECTORY) throw new Error('Specify an ignored local output directory');
const FILE = 'synthetic-320x180-35m-h264-aac.mp4';
const SECONDS = 2100;

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
  `color=c=0x204060:size=320x180:rate=30:duration=${String(SECONDS)}`,
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
  '40k',
  '-maxrate',
  '60k',
  '-bufsize',
  '120k',
  // AAC-LC stereo at 48 kHz from FFmpeg's native encoder.
  '-c:a',
  'aac',
  '-b:a',
  '32k',
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

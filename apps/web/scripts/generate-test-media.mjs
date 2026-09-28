// Generates the synthetic video fixtures used by the Playwright tests.
//
// Every frame is drawn here from a fixed pattern, so the fixtures contain no
// recorded, personal, or third-party material. Frames are written as PPM,
// compressed to baseline JPEG by cjpeg (libjpeg-turbo), and piped as MJPEG to
// FFmpeg, which encodes VP8 video into WebM without audio. Any FFmpeg build
// with the image2pipe demuxer, MJPEG decoder, libvpx encoder, and WebM muxer
// works; Playwright's bundled FFmpeg is sufficient.
//
//   CJPEG=/path/to/cjpeg FFMPEG=/path/to/ffmpeg npm run test-media
//
// Output bytes depend on the libjpeg-turbo and libvpx versions. The committed
// fixtures and their recorded SHA-256 digests in e2e/media/README.md are
// authoritative; regenerate only deliberately and update that record.
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const CJPEG = process.env.CJPEG ?? 'cjpeg';
const FFMPEG = process.env.FFMPEG ?? 'ffmpeg';
const OUTPUT_DIRECTORY = join(import.meta.dirname, '..', 'e2e', 'media');

const FIXTURES = [
  {
    file: 'synthetic-320x180-10s.webm',
    width: 320,
    height: 180,
    fps: 15,
    seconds: 10,
    palette: [
      [200, 40, 40],
      [40, 160, 60],
      [40, 70, 200],
      [210, 170, 30],
      [150, 50, 170],
      [30, 160, 170],
      [220, 110, 30],
      [90, 90, 90],
      [170, 30, 100],
      [60, 120, 40],
    ],
  },
  {
    file: 'synthetic-256x144-6s.webm',
    width: 256,
    height: 144,
    fps: 15,
    seconds: 6,
    palette: [
      [30, 30, 120],
      [120, 30, 30],
      [30, 120, 30],
      [120, 120, 30],
      [30, 120, 120],
      [120, 30, 120],
    ],
  },
];

// A solid background whose color changes every second, one marker block per
// elapsed second along the top edge, and a white bar that sweeps across the
// frame once per second. Features are 8-pixel aligned to suit JPEG blocks.
function drawFrame({ width, height, fps, palette }, index) {
  const second = Math.floor(index / fps);
  const background = palette[second % palette.length];
  const barX = Math.floor((((index % fps) / fps) * (width - 16)) / 8) * 8;
  const header = Buffer.from(`P6\n${String(width)} ${String(height)}\n255\n`, 'ascii');
  const pixels = Buffer.alloc(width * height * 3);

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const isBar = x >= barX && x < barX + 16 && y >= 32;
      const isMarker = y >= 8 && y < 24 && x >= 8 && x < 8 + (second + 1) * 16 && x % 16 < 8;
      const [r, g, b] = isBar || isMarker ? [255, 255, 255] : background;
      const offset = (y * width + x) * 3;
      pixels[offset] = r;
      pixels[offset + 1] = g;
      pixels[offset + 2] = b;
    }
  }
  return Buffer.concat([header, pixels]);
}

function run(command, args, input) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['pipe', 'pipe', 'pipe'] });
    const stdout = [];
    const stderr = [];
    child.stdout.on('data', (chunk) => stdout.push(chunk));
    child.stderr.on('data', (chunk) => stderr.push(chunk));
    child.on('error', reject);
    child.on('close', (code) => {
      if (code === 0) {
        resolve(Buffer.concat(stdout));
      } else {
        const message = Buffer.concat(stderr).toString('utf8').trim();
        reject(new Error(`${command} exited with ${String(code)}: ${message}`));
      }
    });
    child.stdin.end(input);
  });
}

async function generate(fixture) {
  const frameCount = fixture.fps * fixture.seconds;
  const jpegFrames = [];
  for (let index = 0; index < frameCount; index += 1) {
    jpegFrames.push(
      await run(CJPEG, ['-quality', '90', '-baseline', '-dct', 'int'], drawFrame(fixture, index)),
    );
  }

  // FFmpeg writes the file itself: the WebM muxer can record the duration and
  // seek cues only on seekable output, not on a pipe.
  const outputPath = join(OUTPUT_DIRECTORY, fixture.file);
  await run(
    FFMPEG,
    [
      '-hide_banner',
      '-loglevel',
      'error',
      '-f',
      'image2pipe',
      '-framerate',
      String(fixture.fps),
      '-c:v',
      'mjpeg',
      '-i',
      'pipe:0',
      '-an',
      '-c:v',
      'libvpx',
      '-pix_fmt',
      'yuv420p',
      '-deadline',
      'good',
      '-cpu-used',
      '0',
      '-threads',
      '1',
      '-auto-alt-ref',
      '0',
      '-g',
      String(fixture.fps),
      '-b:v',
      '120k',
      '-map_metadata',
      '-1',
      '-fflags',
      '+bitexact',
      '-flags',
      '+bitexact',
      '-f',
      'webm',
      '-y',
      outputPath,
    ],
    Buffer.concat(jpegFrames),
  );

  const webm = await readFile(outputPath);
  const digest = createHash('sha256').update(webm).digest('hex');
  console.log(`${fixture.file}  ${String(webm.length)} bytes  sha256 ${digest}`);
}

await mkdir(OUTPUT_DIRECTORY, { recursive: true });
for (const fixture of FIXTURES) {
  await generate(fixture);
}

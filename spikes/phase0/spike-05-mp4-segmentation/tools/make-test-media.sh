#!/usr/bin/env bash
# Generate synthetic Spike 0.5 test media into the Git-ignored test-media directory.
#
# Every file is produced from FFmpeg's built-in lavfi test sources (testsrc2, sine,
# noise). No camera, screen, or third-party content is used. Nothing here is committed.
#
# Usage (from the repository root):
#   FFMPEG=/path/to/ffmpeg spikes/phase0/spike-05-mp4-segmentation/tools/make-test-media.sh [--large]
#
# --large additionally builds the ~90-minute multi-GB files (MP-03/MP-11). They need
# about 10 GB of free disk space and are written with stream copy after one encode.
set -euo pipefail

FFMPEG="${FFMPEG:-ffmpeg}"
PHASE0="$(cd "$(dirname "$0")/../.." && pwd)"
OUT="$PHASE0/test-media/spike-05"
WORK="$OUT/.work"
mkdir -p "$OUT" "$WORK"

ff() { "$FFMPEG" -hide_banner -loglevel error -y "$@"; }

# 10 s, 640x360@30, H.264 Main, fixed 2 s GOP, AAC-LC 48 kHz stereo, moov first.
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -t 10 -ac 2 -c:v libx264 -profile:v main -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -movflags +faststart "$OUT/mp01-small-faststart.mp4"

# 5 min, 1280x720@30, H.264 High with B-frames, irregular GOP (forced keyframes at
# pseudo-random 0.5-6 s spacing), AAC-LC 44.1 kHz stereo, FFmpeg default layout (moov last).
KF="$(awk 'BEGIN{srand(5); t=0; s="0"; while (t < 300) { t += 0.5 + rand()*5.5; s = s "," sprintf("%.3f", t) } print s}')"
ff -f lavfi -i "testsrc2=size=1280x720:rate=30" -f lavfi -i "sine=frequency=330:sample_rate=44100" \
  -t 300 -ac 2 -c:v libx264 -preset veryfast -profile:v high -pix_fmt yuv420p -bf 3 \
  -x264-params "keyint=300:min-keyint=15:scenecut=0" -force_key_frames "$KF" \
  -c:a aac -b:a 128k "$OUT/mp02-typical-720p-moov-last.mp4"

# Same media as MP-02, remuxed with moov first (no re-encode).
ff -i "$OUT/mp02-typical-720p-moov-last.mp4" -c copy -movflags +faststart "$OUT/mp05-typical-720p-faststart.mp4"

# Fragmented source (moof/mdat per keyframe, empty moov).
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=550:sample_rate=48000" \
  -t 60 -ac 2 -c:v libx264 -profile:v main -pix_fmt yuv420p -g 60 -keyint_min 60 -sc_threshold 0 \
  -c:a aac -b:a 128k -movflags frag_keyframe+empty_moov+default_base_moof "$OUT/mp07-fragmented-source.mp4"

# Non-target cases.
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=sample_rate=48000" -t 10 -ac 2 \
  -c:v libx265 -tag:v hvc1 -pix_fmt yuv420p -x265-params log-level=error -c:a aac -movflags +faststart \
  "$OUT/mp04a-hevc-aac.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=sample_rate=48000" -t 10 -ac 2 \
  -c:v libx264 -pix_fmt yuv420p -c:a libmp3lame -movflags +faststart "$OUT/mp04b-avc-mp3.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=sample_rate=48000" -t 10 -ac 2 \
  -c:v libx264 -pix_fmt yuv420p -c:a libopus -movflags +faststart "$OUT/mp04c-avc-opus.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=sample_rate=48000" -t 10 -ac 2 \
  -c:v libvpx-vp9 -b:v 500k -c:a libopus "$OUT/mp04d-vp9-opus.webm"
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -t 10 \
  -c:v libx264 -pix_fmt yuv420p -g 60 -movflags +faststart "$OUT/mp04e-avc-video-only.mp4"
ff -f lavfi -i "testsrc2=size=640x360:rate=30" -f lavfi -i "sine=frequency=440:sample_rate=48000" \
  -f lavfi -i "sine=frequency=880:sample_rate=48000" -t 20 -map 0:v -map 1:a -map 2:a -ac 2 \
  -c:v libx264 -pix_fmt yuv420p -g 60 -c:a aac -movflags +faststart "$OUT/mp04f-avc-two-aac.mp4"

# Malformed inputs derived from MP-01/MP-02 plus pure noise.
SMALL="$OUT/mp01-small-faststart.mp4"
head -c $(( $(wc -c < "$SMALL") * 6 / 10 )) "$SMALL" > "$OUT/mp08a-truncated-faststart.mp4"
MOOVLAST="$OUT/mp02-typical-720p-moov-last.mp4"
head -c $(( $(wc -c < "$MOOVLAST") - 200000 )) "$MOOVLAST" > "$OUT/mp08b-truncated-moov-missing.mp4"
head -c 1048576 /dev/urandom > "$OUT/mp08c-random-bytes.mp4"
# ftyp followed by a box whose declared size far exceeds the file.
node -e '
const fs = require("fs");
const b = Buffer.alloc(64);
b.writeUInt32BE(24, 0); b.write("ftyp", 4); b.write("isom", 8); b.writeUInt32BE(512, 12); b.write("isomavc1", 16);
b.writeUInt32BE(0xfffffff0, 24); b.write("moov", 28);
fs.writeFileSync(process.argv[1], b);' "$OUT/mp08d-oversize-moov-claim.mp4"

if [[ "${1:-}" == "--large" ]]; then
  # One 60 s high-bitrate chunk (noise keeps x264 near the target rate), then 90 stream copies.
  ff -f lavfi -i "testsrc2=size=1280x720:rate=30,noise=alls=24:allf=t" -f lavfi -i "sine=frequency=220:sample_rate=48000" \
    -t 60 -ac 2 -c:v libx264 -preset ultrafast -pix_fmt yuv420p -b:v 6500k -maxrate 6500k -bufsize 13000k \
    -g 60 -keyint_min 60 -sc_threshold 0 -c:a aac -b:a 128k "$WORK/chunk60.mp4"
  : > "$WORK/list.txt"
  for _ in $(seq 1 90); do echo "file 'chunk60.mp4'" >> "$WORK/list.txt"; done
  ff -f concat -safe 0 -i "$WORK/list.txt" -c copy "$OUT/mp03-large-90min-moov-last.mp4"
  ff -i "$OUT/mp03-large-90min-moov-last.mp4" -c copy -movflags +faststart "$OUT/mp03f-large-90min-faststart.mp4"
fi

rm -rf "$WORK"
ls -l "$OUT"

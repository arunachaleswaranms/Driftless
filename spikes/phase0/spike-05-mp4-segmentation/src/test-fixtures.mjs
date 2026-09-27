// Test-only builder for tiny, deterministic, non-fragmented MP4 byte streams.
// Sample payloads are placeholder bytes (not decodable video/audio); the structure is
// valid ISO BMFF so MP4Box.js parses, indexes, and fragments it like real media.

const enc = new TextEncoder();

function concat(parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let o = 0;
  for (const p of parts) { out.set(p, o); o += p.length; }
  return out;
}

const u8 = (...v) => Uint8Array.from(v);
function u16(v) { const b = new Uint8Array(2); new DataView(b.buffer).setUint16(0, v); return b; }
function u32(v) { const b = new Uint8Array(4); new DataView(b.buffer).setUint32(0, v >>> 0); return b; }
const zeros = (n) => new Uint8Array(n);
const str = (s) => enc.encode(s);

export function box(type, ...parts) {
  const payload = concat(parts);
  return concat([u32(8 + payload.length), str(type), payload]);
}

export function fullBox(type, version, flags, ...parts) {
  return box(type, u8(version, (flags >> 16) & 0xff, (flags >> 8) & 0xff, flags & 0xff), ...parts);
}

const MATRIX = concat([u32(0x00010000), u32(0), u32(0), u32(0), u32(0x00010000), u32(0), u32(0), u32(0), u32(0x40000000)]);

function mvhd(timescale, duration, nextTrackId) {
  return fullBox("mvhd", 0, 0, u32(0), u32(0), u32(timescale), u32(duration), u32(0x00010000), u16(0x0100), zeros(10), MATRIX, zeros(24), u32(nextTrackId));
}

function tkhd(id, duration, width, height, isAudio) {
  return fullBox("tkhd", 0, 3, u32(0), u32(0), u32(id), u32(0), u32(duration), zeros(8), u16(0), u16(isAudio ? 1 : 0), u16(isAudio ? 0x0100 : 0), u16(0), MATRIX, u32(width << 16), u32(height << 16));
}

function avc1Entry(width, height) {
  const sps = u8(0x67, 0x4d, 0x40, 0x1e, 0xab, 0x40);
  const pps = u8(0x68, 0xee, 0x3c, 0x80);
  const avcC = box("avcC", u8(1, 0x4d, 0x40, 0x1e, 0xff, 0xe1), u16(sps.length), sps, u8(1), u16(pps.length), pps);
  return box("avc1", zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), avcC);
}

function hvc1Entry(width, height) {
  // Minimal hvcC header (general profile Main, no NAL arrays).
  const hvcC = box("hvcC", u8(1, 0x01, 0x60, 0, 0, 0, 0x90, 0, 0, 0, 0, 0, 0x5d, 0xf0, 0, 0xfc, 0xfd, 0xf8, 0xf8, 0, 0, 0x0f, 0));
  return box("hvc1", zeros(6), u16(1), u16(0), u16(0), zeros(12), u16(width), u16(height), u32(0x00480000), u32(0x00480000), u32(0), u16(1), zeros(32), u16(0x0018), u16(0xffff), hvcC);
}

function mp4aEntry(sampleRate, channels, objectTypeIndication) {
  const dsi = u8(0x11, 0x90); // AAC-LC, 48 kHz, stereo
  const decSpecific = concat([u8(0x05, dsi.length), dsi]);
  const decConfigBody = concat([u8(objectTypeIndication, 0x15), u8(0, 0, 0), u32(128000), u32(128000), objectTypeIndication === 0x40 ? decSpecific : new Uint8Array(0)]);
  const decConfig = concat([u8(0x04, decConfigBody.length), decConfigBody]);
  const sl = u8(0x06, 1, 0x02);
  const esBody = concat([u16(1), u8(0), decConfig, sl]);
  const es = concat([u8(0x03, esBody.length), esBody]);
  const esds = fullBox("esds", 0, 0, es);
  return box("mp4a", zeros(6), u16(1), zeros(8), u16(channels), u16(16), u16(0), u16(0), u32(sampleRate << 16), esds);
}

function sttsBox(durations) {
  const runs = [];
  for (const d of durations) {
    const last = runs[runs.length - 1];
    if (last && last[1] === d) last[0] += 1;
    else runs.push([1, d]);
  }
  return fullBox("stts", 0, 0, u32(runs.length), ...runs.flatMap(([c, d]) => [u32(c), u32(d)]));
}

/**
 * Build a track description. `syncFrames` lists sync sample indexes for video.
 */
function trackSamples(t) {
  const samples = [];
  let dts = 0;
  for (let i = 0; i < t.count; i += 1) {
    const sync = t.kind === "audio" ? true : t.syncSet.has(i);
    const size = t.kind === "audio" ? 24 + (i % 3) : (sync ? 400 : 120 + (i % 7) * 10);
    samples.push({ index: i, dts, duration: t.delta, size, sync, trackId: t.id });
    dts += t.delta;
  }
  return samples;
}

function samplePayload(trackId, index, size) {
  const b = new Uint8Array(size);
  for (let k = 0; k < size; k += 1) b[k] = (trackId * 97 + index * 31 + k) & 0xff;
  return b;
}

/**
 * Build an MP4. Options:
 *   seconds, moov: 'first' | 'last', video: {gopFrames | syncFrames, codec}, audio: [{oti}],
 *   interleaveSeconds, stszOverride: {trackIndex, sampleSize, count}
 * Returns { bytes, layout: {moovOffset, moovSize, mdatOffset}, tracks: [{id, kind, samples}] }.
 */
export function buildMp4({ seconds = 10, moov: moovPlacement = "first", video = { gopFrames: 30 }, audio = [{ oti: 0x40 }], interleaveSeconds = 0.5, stszOverride } = {}) {
  const tracks = [];
  let nextId = 1;
  if (video) {
    const count = Math.round(seconds * 30);
    const syncSet = new Set(video.syncFrames ?? Array.from({ length: Math.ceil(count / video.gopFrames) }, (_, k) => k * video.gopFrames));
    tracks.push({ id: nextId++, kind: "video", timescale: 15360, delta: 512, count, syncSet, codec: video.codec ?? "avc1", width: 320, height: 180 });
  }
  for (const a of audio ?? []) {
    tracks.push({ id: nextId++, kind: "audio", timescale: 48000, delta: 1024, count: Math.round((seconds * 48000) / 1024), oti: a.oti ?? 0x40 });
  }
  for (const t of tracks) t.samples = trackSamples(t);

  // Interleave: for each window, emit one chunk per track holding its samples in the window.
  const chunks = [];
  for (let w = 0; w * interleaveSeconds < seconds + 1; w += 1) {
    const end = (w + 1) * interleaveSeconds;
    for (const t of tracks) {
      const inWindow = t.samples.filter((s) => s.chunk === undefined && s.dts / t.timescale < end);
      if (!inWindow.length) continue;
      const chunk = { trackId: t.id, samples: inWindow };
      for (const s of inWindow) s.chunk = chunk;
      chunks.push(chunk);
    }
  }
  const payloadParts = [];
  let payloadOffset = 0;
  for (const c of chunks) {
    c.payloadOffset = payloadOffset;
    for (const s of c.samples) {
      s.payloadOffset = payloadOffset;
      payloadParts.push(samplePayload(s.trackId, s.index, s.size));
      payloadOffset += s.size;
    }
  }
  const mdatPayload = concat(payloadParts);
  const ftyp = box("ftyp", str("isom"), u32(512), str("isom"), str("iso2"), str("avc1"), str("mp41"));

  const buildMoov = (mdatPayloadStart) => {
    const traks = tracks.map((t, ti) => {
      const own = chunks.filter((c) => c.trackId === t.id);
      const duration = t.count * t.delta;
      const entry = t.kind === "video" ? (t.codec === "hvc1" ? hvc1Entry(t.width, t.height) : avc1Entry(t.width, t.height)) : mp4aEntry(48000, 2, t.oti);
      const stsd = fullBox("stsd", 0, 0, u32(1), entry);
      const stsc = fullBox("stsc", 0, 0, u32(own.length), ...own.flatMap((c, i) => [u32(i + 1), u32(c.samples.length), u32(1)]));
      const stco = fullBox("stco", 0, 0, u32(own.length), ...own.map((c) => u32(mdatPayloadStart + c.payloadOffset)));
      let stsz = fullBox("stsz", 0, 0, u32(0), u32(t.count), ...t.samples.map((s) => u32(s.size)));
      if (stszOverride && stszOverride.trackIndex === ti) stsz = fullBox("stsz", 0, 0, u32(stszOverride.sampleSize), u32(stszOverride.count));
      const stblParts = [stsd, sttsBox(t.samples.map((s) => s.duration)), stsc, stsz, stco];
      if (t.kind === "video") stblParts.splice(2, 0, fullBox("stss", 0, 0, u32(t.syncSet.size), ...[...t.syncSet].sort((a, b) => a - b).map((i) => u32(i + 1))));
      const mediaHeader = t.kind === "video" ? fullBox("vmhd", 0, 1, zeros(8)) : fullBox("smhd", 0, 0, zeros(4));
      const dinf = box("dinf", fullBox("dref", 0, 0, u32(1), fullBox("url ", 0, 1)));
      const minf = box("minf", mediaHeader, dinf, box("stbl", ...stblParts));
      const hdlr = fullBox("hdlr", 0, 0, u32(0), str(t.kind === "video" ? "vide" : "soun"), zeros(12), u8(0));
      const mdia = box("mdia", fullBox("mdhd", 0, 0, u32(0), u32(0), u32(t.timescale), u32(duration), u16(0x55c4), u16(0)), hdlr, minf);
      const movieDuration = Math.round((duration / t.timescale) * 1000);
      return box("trak", tkhd(t.id, movieDuration, t.width ?? 0, t.height ?? 0, t.kind === "audio"), mdia);
    });
    return box("moov", mvhd(1000, Math.round(seconds * 1000), nextId), ...traks);
  };

  const moovSize = buildMoov(0).length;
  const mdatHeader = 8;
  let bytes;
  let layout;
  if (moovPlacement === "first") {
    const mdatStart = ftyp.length + moovSize;
    const moov = buildMoov(mdatStart + mdatHeader);
    bytes = concat([ftyp, moov, box("mdat", mdatPayload)]);
    layout = { moovOffset: ftyp.length, moovSize, mdatOffset: mdatStart };
  } else {
    const mdatStart = ftyp.length;
    const moov = buildMoov(mdatStart + mdatHeader);
    bytes = concat([ftyp, box("mdat", mdatPayload), moov]);
    layout = { moovOffset: ftyp.length + mdatHeader + mdatPayload.length, moovSize, mdatOffset: mdatStart };
  }
  return { bytes, layout, tracks: tracks.map((t) => ({ id: t.id, kind: t.kind, timescale: t.timescale, samples: t.samples.map(({ chunk, ...s }) => s) })) };
}

/** Minimal Blob-like source over a Uint8Array that records every slice request. */
export function memorySource(bytes) {
  const slices = [];
  const make = (start, end) => ({
    size: end - start,
    slice(s = 0, e = end - start) {
      const a = start + s;
      const b = start + Math.min(e, end - start);
      slices.push([a, b]);
      return make(a, b);
    },
    async arrayBuffer() { return bytes.slice(start, end).buffer; },
  });
  const root = make(0, bytes.length);
  root.slices = slices;
  return root;
}

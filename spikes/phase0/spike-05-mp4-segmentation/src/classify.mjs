// Target-media classification from parser metadata. This is a structural
// classification only: it says nothing about whether a browser can decode the media.

export const TARGET = "TARGET COMPATIBLE";
export const NON_TARGET = "NON-TARGET / EXPERIMENTAL";
export const UNPARSEABLE = "NOT PARSEABLE AS MP4";

// AVC sample entries and AAC object types (LC, HE-AAC/SBR, HE-AACv2/PS) within MPEG-4 Audio.
const AVC_CODEC = /^(avc1|avc3)\.[0-9a-fA-F]{6}$/;
const AAC_CODEC = /^mp4a\.40\.(2|5|29)$/;

function trackSummary(t) {
  return {
    id: t.id,
    type: t.type,
    codec: t.codec,
    timescale: t.timescale,
    duration: t.duration,
    durationSeconds: t.timescale ? t.duration / t.timescale : undefined,
    samples: t.nb_samples,
    bytes: t.size,
    bitrate: Number.isFinite(t.bitrate) ? Math.round(t.bitrate) : undefined,
    width: t.video?.width,
    height: t.video?.height,
    channels: t.audio?.channel_count,
    sampleRate: t.audio?.sample_rate,
    language: t.language,
    hasEditList: Array.isArray(t.edits) && t.edits.length > 0,
    editCount: Array.isArray(t.edits) ? t.edits.length : 0,
  };
}

/**
 * Classify MP4Box.js `Movie` info. Returns the verdict, reasons, the selected
 * track ids for the target pair (when present), and normalised track summaries.
 */
export function classifyMovie(info) {
  if (!info || !info.hasMoov) return { verdict: UNPARSEABLE, reasons: ["No moov box was parsed"], tracks: [], selected: undefined };
  const tracks = (info.tracks ?? []).map(trackSummary);
  const video = tracks.filter((t) => t.type === "video");
  const audio = tracks.filter((t) => t.type === "audio");
  const other = tracks.filter((t) => t.type !== "video" && t.type !== "audio");
  const reasons = [];
  const notes = [];

  const encrypted = tracks.filter((t) => /^(encv|enca|drmi|drms)/.test(t.codec ?? ""));
  if (encrypted.length) reasons.push(`Encrypted/protected sample entry: ${encrypted.map((t) => t.codec).join(", ")}`);
  if (video.length === 0) reasons.push("No video track");
  if (video.length > 1) reasons.push(`${video.length} video tracks (track selection not defined for the target)`);
  if (audio.length === 0) reasons.push("No audio track");
  if (audio.length > 1) reasons.push(`${audio.length} audio tracks (track selection not defined for the target)`);
  for (const v of video) if (!AVC_CODEC.test(v.codec ?? "")) reasons.push(`Video track ${v.id} codec '${v.codec}' is not H.264/AVC`);
  for (const a of audio) if (!AAC_CODEC.test(a.codec ?? "")) reasons.push(`Audio track ${a.id} codec '${a.codec}' is not AAC (mp4a.40.2/5/29)`);
  if (other.length) notes.push(`Non-audio/video tracks present and ignored: ${other.map((t) => `${t.id}:${t.type}:${t.codec}`).join(", ")}`);
  // Spike 0.5 observed MP4Box.js retaining every fragmented-source buffer (and an mdat copy)
  // for the whole run, and only a partial sample index at onReady.
  if (info.isFragmented) reasons.push("Source is already fragmented (moov contains mvex); bounded-memory handling not demonstrated in Spike 0.5");
  for (const t of tracks) if (!t.timescale || !t.samples) reasons.push(`Track ${t.id} has no timescale or no samples`);

  const verdict = reasons.length === 0 ? TARGET : NON_TARGET;
  const selected = {
    videoTrackId: video.find((v) => AVC_CODEC.test(v.codec ?? ""))?.id ?? video[0]?.id,
    audioTrackId: audio.find((a) => AAC_CODEC.test(a.codec ?? ""))?.id ?? audio[0]?.id,
  };
  return {
    verdict,
    reasons,
    notes,
    tracks,
    selected,
    unexpectedTracks: other.map((t) => t.id),
    caveat: "Structural classification from container metadata only; browser decode/MSE support is not established here.",
  };
}

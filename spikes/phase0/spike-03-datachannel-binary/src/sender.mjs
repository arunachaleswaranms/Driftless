import {
  DIGEST_BYTES,
  HEADER_BYTES,
  chunkLength,
  fillPattern,
  malformedFrame,
  toHex,
  writeChunkHeader,
} from "./framing.mjs";

let activeWaiters = 0;

export function activeBackpressureWaiters() {
  return activeWaiters;
}

function abortError(signal) {
  return signal.reason instanceof Error ? signal.reason : new Error("transfer aborted");
}

// Resolves once the channel's bufferedAmount falls to bufferedAmountLowThreshold. Event-driven:
// no polling. Rejects if the channel closes or the transfer is aborted while paused.
export function waitForBufferedAmountLow(channel, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError(signal));
      return;
    }
    if (channel.readyState !== "open") {
      reject(new Error(`data channel is ${channel.readyState}`));
      return;
    }
    if (channel.bufferedAmount <= channel.bufferedAmountLowThreshold) {
      resolve();
      return;
    }

    activeWaiters += 1;
    const cleanup = () => {
      activeWaiters -= 1;
      channel.removeEventListener("bufferedamountlow", onLow);
      channel.removeEventListener("close", onClose);
      signal?.removeEventListener("abort", onAbort);
    };
    const onLow = () => {
      cleanup();
      resolve();
    };
    const onClose = () => {
      cleanup();
      reject(new Error("data channel closed while the sender was paused for backpressure"));
    };
    const onAbort = () => {
      cleanup();
      reject(abortError(signal));
    };
    channel.addEventListener("bufferedamountlow", onLow);
    channel.addEventListener("close", onClose);
    signal?.addEventListener("abort", onAbort);
  });
}

// Deterministic, explicit fault injection for BT-06. The fault targets the middle chunk.
export function* sendSchedule(totalChunks, faultMode = "none") {
  const target = Math.floor(totalChunks / 2);
  for (let sequence = 0; sequence < totalChunks; sequence += 1) {
    if (sequence !== target || faultMode === "none") {
      yield { action: "send", sequence };
      continue;
    }
    switch (faultMode) {
      case "corrupt-byte":
        yield { action: "send", sequence, corrupt: true };
        break;
      case "drop-chunk":
        yield { action: "skip", sequence };
        break;
      case "duplicate-chunk":
        yield { action: "send", sequence };
        yield { action: "send", sequence };
        break;
      case "reorder-chunks":
        if (sequence + 1 < totalChunks) {
          yield { action: "send", sequence: sequence + 1 };
          yield { action: "send", sequence };
          sequence += 1;
        } else {
          yield { action: "send", sequence };
        }
        break;
      case "malformed-frame":
        yield { action: "malformed" };
        yield { action: "send", sequence };
        break;
      default:
        throw new Error(`unknown fault mode ${faultMode}`);
    }
  }
}

export function createSenderStats() {
  return {
    framesSent: 0,
    chunkFramesSent: 0,
    bytesSent: 0,
    wireBytesSent: 0,
    maxBufferedAmount: 0,
    backpressurePauses: 0,
    backpressureResumes: 0,
    pausedMs: 0,
    prepMs: 0,
    lastPauseAtBufferedAmount: null,
    lastResumeAtBufferedAmount: null,
  };
}

export async function buildChunkFrame({ plan, sequence, transferId, seed, digest }) {
  const length = chunkLength(plan, sequence);
  const frame = new Uint8Array(HEADER_BYTES + length);
  const payload = frame.subarray(HEADER_BYTES);
  fillPattern(payload, sequence * plan.chunkSize, seed);
  const hash = new Uint8Array(await digest(payload));
  writeChunkHeader(frame, {
    transferId,
    sequence,
    totalChunks: plan.totalChunks,
    payloadBytes: length,
    digest: hash,
  });
  return { frame, hash };
}

// Sends every chunk of the plan, pausing whenever bufferedAmount exceeds highWaterBytes and
// resuming on the bufferedamountlow event at lowWaterBytes. At most one frame is enqueued past
// the high-water mark, so the browser send queue stays bounded by highWaterBytes + frameBytes.
export async function runSender({
  channel,
  plan,
  transferId,
  seed,
  faultMode = "none",
  highWaterBytes,
  lowWaterBytes,
  digest,
  signal,
  stats = createSenderStats(),
  now = () => performance.now(),
}) {
  if (!(lowWaterBytes >= 0 && highWaterBytes > lowWaterBytes)) {
    throw new RangeError("high-water mark must exceed the low-water mark");
  }
  channel.bufferedAmountLowThreshold = lowWaterBytes;
  const digests = new Uint8Array(plan.totalChunks * DIGEST_BYTES);

  const send = (frame) => {
    if (channel.readyState !== "open") throw new Error(`data channel is ${channel.readyState}`);
    channel.send(frame);
    stats.framesSent += 1;
    stats.wireBytesSent += frame.byteLength;
    stats.maxBufferedAmount = Math.max(stats.maxBufferedAmount, channel.bufferedAmount);
  };

  for (const step of sendSchedule(plan.totalChunks, faultMode)) {
    if (signal?.aborted) throw abortError(signal);

    if (channel.bufferedAmount > highWaterBytes) {
      stats.backpressurePauses += 1;
      stats.lastPauseAtBufferedAmount = channel.bufferedAmount;
      const pausedAt = now();
      await waitForBufferedAmountLow(channel, signal);
      stats.pausedMs += now() - pausedAt;
      stats.backpressureResumes += 1;
      stats.lastResumeAtBufferedAmount = channel.bufferedAmount;
    }

    if (step.action === "malformed") {
      send(malformedFrame());
      continue;
    }

    const preparedAt = now();
    const { frame, hash } = await buildChunkFrame({ plan, sequence: step.sequence, transferId, seed, digest });
    stats.prepMs += now() - preparedAt;
    if (signal?.aborted) throw abortError(signal);
    digests.set(hash, step.sequence * DIGEST_BYTES);
    if (step.action === "skip") continue;
    if (step.corrupt) frame[HEADER_BYTES] ^= 0xff;

    send(frame);
    stats.chunkFramesSent += 1;
    stats.bytesSent += frame.byteLength - HEADER_BYTES;
  }

  const manifestSha256 = toHex(new Uint8Array(await digest(digests)));
  return { manifestSha256, stats };
}

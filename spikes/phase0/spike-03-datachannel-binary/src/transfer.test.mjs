import assert from "node:assert/strict";
import test from "node:test";

import {
  FAULT_MODES,
  HEADER_BYTES,
  KiB,
  LIMITS,
  MiB,
  chunkLength,
  decodeChunkFrame,
  fillPattern,
  findPatternMismatch,
  malformedFrame,
  parseControlMessage,
  planTransfer,
  writeChunkHeader,
} from "./framing.mjs";
import { formatBytes, formatLabThroughput, throughputMiBps } from "./metrics.mjs";
import { TransferReceiver } from "./receiver.mjs";
import {
  activeBackpressureWaiters,
  buildChunkFrame,
  runSender,
  sendSchedule,
  waitForBufferedAmountLow,
} from "./sender.mjs";

const sha256 = (data) => crypto.subtle.digest("SHA-256", data);

class FakeChannel extends EventTarget {
  readyState = "open";
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  #queue = [];

  constructor(deliver = () => {}) {
    super();
    this.deliver = deliver;
  }

  send(data) {
    const copy = data.slice().buffer;
    this.#queue.push(copy);
    this.bufferedAmount += copy.byteLength;
  }

  drain(maxBytes = Infinity) {
    const before = this.bufferedAmount;
    let drained = 0;
    while (this.#queue.length > 0 && drained < maxBytes) {
      const frame = this.#queue.shift();
      drained += frame.byteLength;
      this.bufferedAmount -= frame.byteLength;
      this.deliver(frame);
    }
    if (before > this.bufferedAmountLowThreshold && this.bufferedAmount <= this.bufferedAmountLowThreshold) {
      this.dispatchEvent(new Event("bufferedamountlow"));
    }
  }

  close() {
    this.readyState = "closed";
    this.dispatchEvent(new Event("close"));
  }
}

async function transferThroughFake({ totalBytes, chunkSize, faultMode = "none", highWaterBytes, lowWaterBytes }) {
  const { plan } = planTransfer({ totalBytes, chunkSize });
  const receiver = new TransferReceiver({ digest: sha256 });
  const transferId = 7;
  const seed = 0x1234abcd;
  const begin = { type: "begin", transferId, seed, faultMode, ...plan };
  assert.equal(receiver.begin(begin).type, "accept");

  const channel = new FakeChannel((frame) => receiver.acceptFrame(frame));
  const network = setInterval(() => channel.drain(3 * chunkSize), 0);
  try {
    const { manifestSha256, stats } = await runSender({
      channel,
      plan,
      transferId,
      seed,
      faultMode,
      highWaterBytes,
      lowWaterBytes,
      digest: sha256,
    });
    channel.drain();
    const result = await receiver.finish({
      type: "end",
      transferId,
      totalChunks: plan.totalChunks,
      totalBytes: plan.totalBytes,
      framesSent: stats.framesSent,
      manifestSha256,
    });
    return { plan, stats, result };
  } finally {
    clearInterval(network);
  }
}

test("planTransfer enforces bounds and negotiated maxMessageSize", () => {
  const planned = planTransfer({ totalBytes: MiB + 5, chunkSize: 64 * KiB });
  assert.equal(planned.ok, true);
  assert.equal(planned.plan.totalChunks, 17);
  assert.equal(chunkLength(planned.plan, 0), 64 * KiB);
  assert.equal(chunkLength(planned.plan, 16), 5);

  assert.equal(planTransfer({ totalBytes: 0, chunkSize: 64 * KiB }).ok, false);
  assert.equal(planTransfer({ totalBytes: LIMITS.maxTotalBytes + 1, chunkSize: 64 * KiB }).ok, false);
  assert.equal(planTransfer({ totalBytes: MiB, chunkSize: 1024 }).ok, false);
  assert.equal(planTransfer({ totalBytes: MiB, chunkSize: 2 * MiB }).ok, false);
  assert.equal(planTransfer({ totalBytes: MiB, chunkSize: 1.5 * KiB * 10 + 0.5 }).ok, false);

  const tooLarge = planTransfer({ totalBytes: MiB, chunkSize: 256 * KiB, maxMessageSize: 256 * KiB });
  assert.equal(tooLarge.ok, false);
  assert.match(tooLarge.error, /maxMessageSize/);
  assert.equal(planTransfer({ totalBytes: MiB, chunkSize: 256 * KiB - HEADER_BYTES, maxMessageSize: 256 * KiB }).ok, true);
});

test("deterministic pattern is offset-addressable and detects single-byte changes", () => {
  const whole = new Uint8Array(4099);
  fillPattern(whole, 0, 99);
  for (const [offset, length] of [[0, 4099], [1, 10], [5, 300], [4096, 3]]) {
    const part = new Uint8Array(length);
    fillPattern(part, offset, 99);
    assert.deepEqual(part, whole.subarray(offset, offset + length));
    assert.equal(findPatternMismatch(part, offset, 99), -1);
  }
  const other = new Uint8Array(4099);
  fillPattern(other, 0, 100);
  assert.notDeepEqual(other, whole);

  const changed = whole.slice();
  changed[1234] ^= 1;
  assert.equal(findPatternMismatch(changed, 0, 99), 1234);
  assert.equal(findPatternMismatch(whole.subarray(4, 20), 0, 99), 0);
});

test("chunk frame header round-trips and malformed frames are rejected", async () => {
  const { plan } = planTransfer({ totalBytes: 20 * KiB, chunkSize: 16 * KiB });
  const { frame, hash } = await buildChunkFrame({ plan, sequence: 1, transferId: 3, seed: 5, digest: sha256 });
  const decoded = decodeChunkFrame(frame.buffer, { maxPayloadBytes: plan.chunkSize });
  assert.equal(decoded.ok, true);
  assert.equal(decoded.frame.sequence, 1);
  assert.equal(decoded.frame.totalChunks, 2);
  assert.equal(decoded.frame.payloadBytes, 4 * KiB);
  assert.deepEqual(decoded.frame.digest, hash);
  assert.equal(findPatternMismatch(decoded.frame.payload, 16 * KiB, 5), -1);

  assert.match(decodeChunkFrame(frame).error, /ArrayBuffer/);
  assert.match(decodeChunkFrame(new ArrayBuffer(10)).error, /shorter/);
  assert.match(decodeChunkFrame(malformedFrame().buffer).error, /magic/);
  assert.match(decodeChunkFrame(frame.buffer, { maxPayloadBytes: 1024 }).error, /bound/);

  const truncated = frame.slice(0, frame.length - 1);
  assert.match(decodeChunkFrame(truncated.buffer).error, /length/);
  const badVersion = frame.slice();
  badVersion[4] = 9;
  assert.match(decodeChunkFrame(badVersion.buffer).error, /version/);

  const empty = new Uint8Array(HEADER_BYTES);
  writeChunkHeader(empty, { transferId: 1, sequence: 0, totalChunks: 1, payloadBytes: 0, digest: hash });
  assert.match(decodeChunkFrame(empty.buffer).error, /bound/);
});

test("control messages are bounded and schema-checked", () => {
  const begin = { type: "begin", transferId: 1, totalBytes: MiB, chunkSize: 16 * KiB, totalChunks: 64, seed: 1, faultMode: "none" };
  assert.equal(parseControlMessage(JSON.stringify(begin)).ok, true);
  assert.equal(parseControlMessage(JSON.stringify({ ...begin, totalChunks: 63 })).ok, false);
  assert.equal(parseControlMessage(JSON.stringify({ ...begin, totalBytes: LIMITS.maxTotalBytes * 2 })).ok, false);
  assert.equal(parseControlMessage(JSON.stringify({ ...begin, faultMode: "random" })).ok, false);
  assert.equal(parseControlMessage(JSON.stringify({ ...begin, transferId: -1 })).ok, false);
  assert.equal(parseControlMessage("x".repeat(LIMITS.maxControlChars + 1)).ok, false);
  assert.equal(parseControlMessage("not json").ok, false);
  assert.equal(parseControlMessage("[]").ok, false);
  assert.equal(parseControlMessage(JSON.stringify({ type: "exec", transferId: 1 })).ok, false);
  assert.equal(parseControlMessage(new ArrayBuffer(4)).ok, false);

  const end = { type: "end", transferId: 1, totalChunks: 64, totalBytes: MiB, framesSent: 64, manifestSha256: "a".repeat(64) };
  assert.equal(parseControlMessage(JSON.stringify(end)).ok, true);
  assert.equal(parseControlMessage(JSON.stringify({ ...end, manifestSha256: "xyz" })).ok, false);

  const result = { type: "result", transferId: 1, ok: true, reasons: [], bytesReceived: 1, chunksReceived: 1, maxPendingBytes: 0, receiveMs: 2 };
  assert.equal(parseControlMessage(JSON.stringify(result)).ok, true);
  assert.equal(parseControlMessage(JSON.stringify({ ...result, reasons: new Array(21).fill("x") })).ok, false);
  assert.equal(parseControlMessage(JSON.stringify({ ...result, ok: "yes" })).ok, false);
});

test("fault schedules are deterministic and explicit", () => {
  const sequenceOf = (mode) => Array.from(sendSchedule(6, mode), (step) => `${step.action}:${step.sequence ?? "-"}${step.corrupt ? "!" : ""}`);
  assert.deepEqual(sequenceOf("none"), ["send:0", "send:1", "send:2", "send:3", "send:4", "send:5"]);
  assert.deepEqual(sequenceOf("corrupt-byte"), ["send:0", "send:1", "send:2", "send:3!", "send:4", "send:5"]);
  assert.deepEqual(sequenceOf("drop-chunk"), ["send:0", "send:1", "send:2", "skip:3", "send:4", "send:5"]);
  assert.deepEqual(sequenceOf("duplicate-chunk"), ["send:0", "send:1", "send:2", "send:3", "send:3", "send:4", "send:5"]);
  assert.deepEqual(sequenceOf("reorder-chunks"), ["send:0", "send:1", "send:2", "send:4", "send:3", "send:5"]);
  assert.deepEqual(sequenceOf("malformed-frame"), ["send:0", "send:1", "send:2", "malformed:-", "send:3", "send:4", "send:5"]);
});

test("waitForBufferedAmountLow is event-driven and removes its listeners", async () => {
  const channel = new FakeChannel();
  channel.bufferedAmountLowThreshold = 10;
  await waitForBufferedAmountLow(channel);

  channel.send(new Uint8Array(100));
  const waiting = waitForBufferedAmountLow(channel);
  assert.equal(activeBackpressureWaiters(), 1);
  channel.drain();
  await waiting;
  assert.equal(activeBackpressureWaiters(), 0);

  channel.send(new Uint8Array(100));
  const closed = waitForBufferedAmountLow(channel);
  channel.close();
  await assert.rejects(closed, /closed/);
  assert.equal(activeBackpressureWaiters(), 0);

  const open = new FakeChannel();
  open.send(new Uint8Array(100));
  const controller = new AbortController();
  const aborted = waitForBufferedAmountLow(open, controller.signal);
  controller.abort(new Error("lab abort"));
  await assert.rejects(aborted, /lab abort/);
  assert.equal(activeBackpressureWaiters(), 0);
});

test("end-to-end transfer verifies integrity while keeping the send queue bounded", async () => {
  const highWaterBytes = 64 * KiB;
  const { plan, stats, result } = await transferThroughFake({
    totalBytes: MiB + 777,
    chunkSize: 16 * KiB,
    highWaterBytes,
    lowWaterBytes: 16 * KiB,
  });
  assert.equal(result.ok, true, result.reasons.join("; "));
  assert.equal(result.bytesReceived, plan.totalBytes);
  assert.equal(result.chunksReceived, plan.totalChunks);
  assert.equal(result.manifestMatch, true);
  assert.ok(stats.backpressurePauses > 0);
  assert.equal(stats.backpressurePauses, stats.backpressureResumes);
  assert.ok(stats.maxBufferedAmount <= highWaterBytes + plan.frameBytes);
  assert.equal(activeBackpressureWaiters(), 0);
});

test("every explicit fault mode is detected by the receiver", async () => {
  const expectations = {
    "corrupt-byte": (r) => r.digestMismatches === 1 && r.patternMismatches === 1 && !r.manifestMatch,
    "drop-chunk": (r) => r.chunksReceived === r.totalChunksExpected - 1 && r.unexpectedSequences === 1 && !r.manifestMatch,
    "duplicate-chunk": (r) => r.duplicateChunks === 1 && r.manifestMatch,
    "reorder-chunks": (r) => r.unexpectedSequences === 2 && r.manifestMatch,
    "malformed-frame": (r) => r.rejectedFrames === 1 && r.manifestMatch,
  };
  for (const faultMode of FAULT_MODES.filter((mode) => mode !== "none")) {
    const { plan, result } = await transferThroughFake({
      totalBytes: 256 * KiB,
      chunkSize: 16 * KiB,
      faultMode,
      highWaterBytes: 64 * KiB,
      lowWaterBytes: 16 * KiB,
    });
    assert.equal(result.ok, false, `${faultMode} must fail integrity`);
    assert.ok(result.reasons.length > 0);
    assert.ok(expectations[faultMode]({ ...result, totalChunksExpected: plan.totalChunks }), `${faultMode}: ${JSON.stringify(result)}`);
  }
});

test("receiver rejects out-of-transfer data, busy begins, and unbounded verification backlog", async () => {
  const receiver = new TransferReceiver({ digest: sha256 });
  receiver.acceptFrame(new ArrayBuffer(100));
  assert.equal(receiver.rejectedOutsideTransfer, 1);

  const begin = { type: "begin", transferId: 1, totalBytes: 64 * KiB, chunkSize: 16 * KiB, totalChunks: 4, seed: 2, faultMode: "none" };
  assert.equal(receiver.begin(begin).type, "accept");
  assert.equal(receiver.begin({ ...begin, transferId: 2 }).type, "reject");
  receiver.reset();
  assert.equal(receiver.state, "idle");

  const stalled = new TransferReceiver({ digest: () => new Promise(() => {}), maxPendingBytes: 32 * KiB });
  const { plan } = planTransfer(begin);
  assert.equal(stalled.begin(begin).type, "accept");
  for (let sequence = 0; sequence < plan.totalChunks; sequence += 1) {
    const { frame } = await buildChunkFrame({ plan, sequence, transferId: 1, seed: 2, digest: sha256 });
    stalled.acceptFrame(frame.buffer);
  }
  assert.equal(stalled.state, "aborted");
  assert.equal(stalled.pendingVerifications, 0);
});

test("metrics label same-host throughput as laboratory evidence", () => {
  assert.equal(formatBytes(64 * MiB), "64.00 MiB");
  assert.equal(formatBytes(16 * KiB), "16.0 KiB");
  assert.equal(throughputMiBps(10 * MiB, 1000), 10);
  assert.equal(throughputMiBps(1, 0), null);
  assert.match(formatLabThroughput(10 * MiB, 1000), /LAB ONLY/);
});

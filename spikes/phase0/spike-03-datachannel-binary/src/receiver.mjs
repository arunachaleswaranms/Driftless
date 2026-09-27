import {
  DIGEST_BYTES,
  LIMITS,
  MiB,
  bytesEqual,
  chunkLength,
  decodeChunkFrame,
  findPatternMismatch,
  planTransfer,
  toHex,
} from "./framing.mjs";

// Verifies each chunk as it arrives and then drops the payload. The receiver retains only a
// seen-bitmap and one SHA-256 digest per chunk, never a reassembled copy of the transfer.
export class TransferReceiver {
  #digest;
  #now;
  #maxPendingBytes;
  #generation = 0;
  #pending = new Set();
  #reasons = [];

  constructor({ digest, now = () => performance.now(), maxPendingBytes = 64 * MiB }) {
    this.#digest = digest;
    this.#now = now;
    this.#maxPendingBytes = maxPendingBytes;
    this.state = "idle";
    this.transfer = null;
    this.rejectedOutsideTransfer = 0;
    this.lastRejection = null;
  }

  get pendingVerifications() {
    return this.#pending.size;
  }

  begin(message) {
    if (this.state === "receiving") {
      return { type: "reject", transferId: message.transferId, reason: "receiver is busy with another transfer" };
    }
    const planned = planTransfer(message);
    if (!planned.ok) return { type: "reject", transferId: message.transferId, reason: planned.error };

    this.#generation += 1;
    this.#pending.clear();
    this.#reasons = [];
    const { plan } = planned;
    this.transfer = {
      id: message.transferId,
      seed: message.seed,
      plan,
      seen: new Uint8Array(plan.totalChunks),
      digests: new Uint8Array(plan.totalChunks * DIGEST_BYTES),
      nextSequence: 0,
      chunksReceived: 0,
      bytesReceived: 0,
      duplicateChunks: 0,
      unexpectedSequences: 0,
      digestMismatches: 0,
      patternMismatches: 0,
      rejectedFrames: 0,
      pendingBytes: 0,
      maxPendingBytes: 0,
      firstChunkAt: null,
      lastChunkAt: null,
      finishedAt: null,
      result: null,
    };
    this.state = "receiving";
    return { type: "accept", transferId: message.transferId };
  }

  #issue(counter, reason) {
    if (counter) this.transfer[counter] += 1;
    if (this.#reasons.length < LIMITS.maxReasons) this.#reasons.push(reason.slice(0, LIMITS.maxReasonChars));
  }

  #rejectOutside(reason) {
    this.rejectedOutsideTransfer += 1;
    this.lastRejection = reason;
  }

  acceptFrame(data) {
    const transfer = this.transfer;
    if (this.state !== "receiving") {
      this.#rejectOutside("binary frame received while no transfer is receiving");
      return;
    }

    const decoded = decodeChunkFrame(data, { maxPayloadBytes: transfer.plan.chunkSize });
    if (!decoded.ok) {
      this.#issue("rejectedFrames", `rejected frame: ${decoded.error}`);
      return;
    }
    const frame = decoded.frame;
    if (frame.transferId !== transfer.id) {
      this.#issue("rejectedFrames", `rejected frame for unexpected transfer ${frame.transferId}`);
      return;
    }
    if (frame.totalChunks !== transfer.plan.totalChunks) {
      this.#issue("rejectedFrames", "rejected frame with inconsistent totalChunks");
      return;
    }
    if (frame.sequence >= transfer.plan.totalChunks) {
      this.#issue("rejectedFrames", `rejected out-of-range sequence ${frame.sequence}`);
      return;
    }
    if (frame.payloadBytes !== chunkLength(transfer.plan, frame.sequence)) {
      this.#issue("rejectedFrames", `rejected sequence ${frame.sequence} with unexpected payload length`);
      return;
    }
    if (transfer.seen[frame.sequence]) {
      this.#issue("duplicateChunks", `duplicate sequence ${frame.sequence}`);
      return;
    }
    if (frame.sequence !== transfer.nextSequence) {
      this.#issue(
        "unexpectedSequences",
        `unexpected sequence: expected ${transfer.nextSequence}, received ${frame.sequence}`,
      );
    }

    const now = this.#now();
    transfer.firstChunkAt ??= now;
    transfer.lastChunkAt = now;
    transfer.seen[frame.sequence] = 1;
    transfer.chunksReceived += 1;
    transfer.bytesReceived += frame.payloadBytes;
    transfer.nextSequence = Math.max(transfer.nextSequence, frame.sequence + 1);

    const offset = frame.sequence * transfer.plan.chunkSize;
    const mismatch = findPatternMismatch(frame.payload, offset, transfer.seed);
    if (mismatch >= 0) {
      this.#issue(
        "patternMismatches",
        `sequence ${frame.sequence} differs from the deterministic pattern at byte ${offset + mismatch}`,
      );
    }

    this.#verifyDigest(frame);
  }

  #verifyDigest(frame) {
    const transfer = this.transfer;
    const generation = this.#generation;
    transfer.pendingBytes += frame.payloadBytes;
    transfer.maxPendingBytes = Math.max(transfer.maxPendingBytes, transfer.pendingBytes);
    if (transfer.pendingBytes > this.#maxPendingBytes) {
      this.#issue(null, "receiver verification backlog exceeded its bound");
      this.abort("receiver verification backlog exceeded its bound");
      return;
    }

    const task = Promise.resolve()
      .then(() => this.#digest(frame.payload))
      .then((result) => {
        if (generation !== this.#generation) return;
        const actual = new Uint8Array(result);
        transfer.digests.set(actual, frame.sequence * DIGEST_BYTES);
        if (!bytesEqual(actual, frame.digest)) {
          this.#issue("digestMismatches", `sequence ${frame.sequence} SHA-256 does not match its header`);
        }
      })
      .catch((error) => {
        if (generation === this.#generation) this.#issue(null, `digest failed: ${error?.name ?? "Error"}`);
      })
      .finally(() => {
        this.#pending.delete(task);
        if (generation === this.#generation) transfer.pendingBytes -= frame.payloadBytes;
      });
    this.#pending.add(task);
  }

  async finish(message) {
    const transfer = this.transfer;
    if (this.state !== "receiving" || message.transferId !== transfer?.id) {
      this.#rejectOutside("end received for a transfer that is not receiving");
      return null;
    }
    this.state = "verifying";
    const generation = this.#generation;
    await Promise.all(this.#pending);
    if (generation !== this.#generation) return null;

    const { plan } = transfer;
    if (message.totalChunks !== plan.totalChunks || message.totalBytes !== plan.totalBytes) {
      this.#issue(null, "end totals do not match the accepted begin message");
    }
    const missing = plan.totalChunks - transfer.chunksReceived;
    if (missing > 0) this.#issue(null, `${missing} chunk(s) missing at end of transfer`);
    if (transfer.bytesReceived !== plan.totalBytes) {
      this.#issue(null, `received ${transfer.bytesReceived} bytes; expected ${plan.totalBytes}`);
    }

    const manifest = toHex(new Uint8Array(await this.#digest(transfer.digests)));
    if (generation !== this.#generation) return null;
    const manifestMatch = manifest === message.manifestSha256;
    if (!manifestMatch) this.#issue(null, "chunk-digest manifest SHA-256 does not match the sender");

    transfer.finishedAt = this.#now();
    const ok = this.#reasons.length === 0;
    transfer.result = {
      type: "result",
      transferId: transfer.id,
      ok,
      reasons: [...this.#reasons],
      bytesReceived: transfer.bytesReceived,
      chunksReceived: transfer.chunksReceived,
      duplicateChunks: transfer.duplicateChunks,
      unexpectedSequences: transfer.unexpectedSequences,
      digestMismatches: transfer.digestMismatches,
      patternMismatches: transfer.patternMismatches,
      rejectedFrames: transfer.rejectedFrames,
      manifestMatch,
      manifestSha256: manifest,
      maxPendingBytes: transfer.maxPendingBytes,
      receiveMs: transfer.firstChunkAt === null ? 0 : transfer.lastChunkAt - transfer.firstChunkAt,
    };
    this.state = ok ? "complete" : "failed";
    return transfer.result;
  }

  abort(reason) {
    if (this.state === "receiving" || this.state === "verifying") {
      this.#generation += 1;
      this.#pending.clear();
      if (this.transfer) this.transfer.abortReason = reason;
      this.state = "aborted";
    }
  }

  reset() {
    this.abort("reset");
    this.#generation += 1;
    this.#pending.clear();
    this.transfer = null;
    this.state = "idle";
  }
}

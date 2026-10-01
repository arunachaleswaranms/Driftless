import { createHash, createHmac } from 'node:crypto';
import {
  parseServerMessage,
  resumeProofInput,
  resumeSecretBytes,
  type ParticipantId,
  type ResumeChallenge,
  type ResumeProof,
  type ResumeSecret,
  type ServerMessage,
  type ServerMessageType,
  type SessionId,
} from '@driftless/protocol';
import type { RandomSource } from '../src/credentials.js';
import type { ScheduledTask, Scheduler } from '../src/scheduler.js';

/**
 * Deterministic byte source for tests only: every call returns a new,
 * distinct pattern. Production code always uses the crypto source.
 */
export function sequentialRandom(): RandomSource {
  let call = 0;
  return (size) => {
    call += 1;
    const bytes = new Uint8Array(size);
    for (let index = 0; index < size; index += 1) bytes[index] = (call * 31 + index) % 256;
    return bytes;
  };
}

/** A clock the test moves explicitly. */
export class FakeClock {
  now: number;
  constructor(now = 1_760_000_000_000) {
    this.now = now;
  }
  readonly read = (): number => this.now;
  advance(ms: number): void {
    this.now += ms;
  }
}

/**
 * Runs periodic tasks only when the test calls `tick()`, so time never passes
 * on its own. `tick(intervalMs)` runs only the tasks scheduled at that
 * interval, so the expiry sweep and the liveness check can be driven apart.
 */
export class ManualScheduler implements Scheduler {
  readonly tasks = new Map<() => void, number>();
  every(intervalMs: number, task: () => void): ScheduledTask {
    this.tasks.set(task, intervalMs);
    return {
      cancel: () => {
        this.tasks.delete(task);
      },
    };
  }
  tick(intervalMs?: number): void {
    for (const [task, interval] of [...this.tasks]) {
      if (intervalMs === undefined || interval === intervalMs) task();
    }
  }
}

/** Parses a server message strictly; fails the test if it does not conform. */
export function parseStrict(text: string): ServerMessage {
  const result = parseServerMessage(text);
  if (!result.ok) throw new Error(`Server sent a non-conforming message: ${result.reason}`);
  return result.message;
}

export function expectType<Type extends ServerMessageType>(
  message: ServerMessage | undefined,
  type: Type,
): Extract<ServerMessage, { type: Type }> {
  if (message?.type !== type) {
    throw new Error(`Expected ${type}, received ${message?.type ?? 'nothing'}`);
  }
  return message as Extract<ServerMessage, { type: Type }>;
}

export function clientMessage(
  type: string,
  payload: unknown,
  sequence: number,
  extra: object = {},
): string {
  return JSON.stringify({ protocolVersion: 1, type, sequence, sentAt: 0, payload, ...extra });
}

/**
 * A client's resume proof, computed here directly with Node's crypto over the
 * shared input, independently of the service's verification code.
 */
export function proofFor(
  secret: ResumeSecret,
  sessionId: SessionId,
  participantId: ParticipantId,
  challenge: ResumeChallenge,
): ResumeProof {
  const bytes = resumeSecretBytes(secret);
  const input = resumeProofInput(sessionId, participantId, challenge);
  if (bytes === undefined || input === undefined) throw new Error('invalid proof input');
  const key = createHash('sha256').update(bytes).digest();
  return createHmac('sha256', key).update(input).digest('base64url') as ResumeProof;
}

/** A canonical value of the same kind with one bit flipped. */
export function flipped<Value extends string>(value: Value, index = 0): Value {
  const bytes = Buffer.from(value, 'base64url');
  bytes[index] = (bytes[index] ?? 0) ^ 1;
  return bytes.toString('base64url') as Value;
}

import {
  parseServerMessage,
  type ServerMessage,
  type ServerMessageType,
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

/** Runs periodic tasks only when the test calls `tick()`. */
export class ManualScheduler implements Scheduler {
  readonly tasks = new Set<() => void>();
  every(_intervalMs: number, task: () => void): ScheduledTask {
    this.tasks.add(task);
    return {
      cancel: () => {
        this.tasks.delete(task);
      },
    };
  }
  tick(): void {
    for (const task of [...this.tasks]) task();
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

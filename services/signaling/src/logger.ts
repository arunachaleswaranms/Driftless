import type {
  ErrorCode,
  ParseFailureReason,
  ParticipantLeftReason,
  RoomClosedReason,
} from '@driftless/protocol';
import type { NegotiationStep } from './roomStore.js';

/** Why a client message was not processed. Fixed tokens only. */
export type RejectionDetail =
  | ParseFailureReason
  | 'stale_sequence'
  | 'binary_message'
  | 'rate_limited'
  | 'violation_limit'
  | 'room_request'
  | 'negotiation_request'
  | 'relay_too_large';

/** Transport-level failure classes. Fixed tokens only. */
export type TransportErrorDetail = 'oversized' | 'invalid_frame' | 'socket';

/**
 * Every event the service may log. The union is closed and each field is a
 * number or a fixed token, so a secret, identifier, payload, URL, header, or
 * IP address cannot be logged without changing this type. Connections are
 * identified only by a process-local counter; room, participant, and
 * negotiation IDs are never logged, nor is any session description, ICE
 * candidate, or username fragment. Individual candidates are not logged at
 * all.
 */
export type LogEvent =
  | { readonly event: 'server_started'; readonly host: string; readonly port: number }
  | { readonly event: 'server_stopped' }
  | {
      readonly event: 'upgrade_rejected';
      readonly reason: 'path' | 'query' | 'origin' | 'capacity' | 'stopping';
      readonly status: number;
    }
  | { readonly event: 'connection_opened'; readonly connection: number }
  | { readonly event: 'connection_closed'; readonly connection: number; readonly code: number }
  | { readonly event: 'room_created'; readonly connection: number }
  | { readonly event: 'participant_joined'; readonly connection: number }
  | {
      readonly event: 'participant_left';
      readonly connection: number;
      readonly reason: ParticipantLeftReason;
    }
  | { readonly event: 'room_closed'; readonly reason: RoomClosedReason }
  | {
      readonly event: 'negotiation_relayed';
      readonly connection: number;
      readonly step: Exclude<NegotiationStep, 'candidate'>;
    }
  | {
      readonly event: 'message_rejected';
      readonly connection: number;
      readonly code: ErrorCode;
      readonly detail: RejectionDetail;
    }
  | {
      readonly event: 'transport_error';
      readonly connection: number;
      readonly detail: TransportErrorDetail;
    }
  | { readonly event: 'internal_error'; readonly context: 'dispatch' | 'sweep' };

export interface Logger {
  log(event: LogEvent): void;
}

/** Writes one JSON object per line to the given sink (stdout by default). */
export function createJsonLogger(
  write: (line: string) => void = (line) => {
    process.stdout.write(line);
  },
  clock: () => number = Date.now,
): Logger {
  return {
    log(event) {
      write(`${JSON.stringify({ time: new Date(clock()).toISOString(), ...event })}\n`);
    },
  };
}

/** Keeps events in memory; for tests. */
export function createMemoryLogger(): Logger & { readonly events: LogEvent[] } {
  const events: LogEvent[] = [];
  return {
    events,
    log(event) {
      events.push(event);
    },
  };
}

export const silentLogger: Logger = {
  log() {
    // Intentionally discards every event.
  },
};

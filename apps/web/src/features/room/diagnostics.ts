import type { SelectedPath } from './connectionStats.ts';
import type { IceTransportPolicy } from './iceServers.ts';

/**
 * Whether the current peer connection's configuration offered a TURN server.
 *
 * - `offered`: the service's configuration included TURN.
 * - `not_configured`: the service answered, with no TURN server.
 * - `unavailable`: no usable answer arrived in time, or it was invalid.
 * - `not_requested`: this controller does not ask the service.
 */
export type TurnAvailability = 'offered' | 'not_configured' | 'unavailable' | 'not_requested';

/**
 * A browser-local, observational snapshot of the current peer connection.
 * It holds only states, candidate types, protocols, and counts: never an
 * address, port, candidate string, session description, ICE credential,
 * certificate fingerprint, TURN credential, or any room, session, or
 * participant identifier. It is never sent anywhere.
 *
 * `status` is `none` when no peer connection exists, `collecting` while
 * statistics are being read, and `ready` once they were. A snapshot always
 * describes the current peer connection: it is discarded when that
 * connection is replaced or closed.
 */
export interface ConnectionDiagnostics {
  readonly status: 'none' | 'collecting' | 'ready';
  readonly peerConnection: RTCPeerConnectionState | null;
  readonly iceConnection: RTCIceConnectionState | null;
  readonly dataChannel: RTCDataChannelState | null;
  readonly path: SelectedPath;
  /** Negotiations this guest membership has used, of the most it may use. */
  readonly negotiation: { readonly count: number; readonly max: number } | null;
  readonly turn: TurnAvailability | null;
  readonly icePolicy: IceTransportPolicy;
  /** Local clock when the statistics were read. */
  readonly collectedAt: number | null;
}

export const NO_DIAGNOSTICS = (icePolicy: IceTransportPolicy): ConnectionDiagnostics => ({
  status: 'none',
  peerConnection: null,
  iceConnection: null,
  dataChannel: null,
  path: { classification: 'UNKNOWN', reason: 'no_report' },
  negotiation: null,
  turn: null,
  icePolicy,
  collectedAt: null,
});

export const PATH_TEXT: Readonly<Record<SelectedPath['classification'], string>> = {
  DIRECT: 'Direct (not relayed)',
  TURN_RELAY: 'TURN relay',
  UNKNOWN: 'Unknown',
};

export const TURN_TEXT: Readonly<Record<TurnAvailability, string>> = {
  offered: 'Available',
  not_configured: 'Not configured',
  unavailable: 'Unavailable',
  not_requested: 'Not requested',
};

/** What the export says about this browser's signaling connection. */
export type DiagnosticsSignaling = 'connected' | 'reconnecting' | 'not in a room';

/**
 * The copyable diagnostic summary. Every line comes from a fixed label and a
 * fixed vocabulary or a number, so the text cannot carry an address,
 * identifier, or secret.
 */
export function diagnosticsText(
  diagnostics: ConnectionDiagnostics,
  context: {
    readonly role: 'host' | 'guest' | null;
    readonly signaling: DiagnosticsSignaling;
    readonly build: string;
  },
): string {
  const { path } = diagnostics;
  const lines = [
    'Driftless connection diagnostics',
    `Build: ${context.build}`,
    `Collected: ${diagnostics.collectedAt === null ? 'not collected' : new Date(diagnostics.collectedAt).toISOString()}`,
    `Role: ${context.role ?? 'none'}`,
    `Signaling: ${context.signaling}`,
    `Peer connection: ${diagnostics.peerConnection ?? 'none'}`,
    `ICE connection: ${diagnostics.iceConnection ?? 'none'}`,
    `Data channel: ${diagnostics.dataChannel ?? 'none'}`,
    `Path: ${path.classification}`,
  ];
  if (path.classification === 'UNKNOWN') {
    lines.push(`Path detail: ${path.reason}`);
  } else {
    lines.push(
      `Local candidate type: ${path.localCandidateType}`,
      `Remote candidate type: ${path.remoteCandidateType}`,
      `Transport: ${path.protocol ?? 'not reported'}`,
    );
    if (path.localCandidateType === 'relay') {
      lines.push(`Relay protocol: ${path.relayProtocol ?? 'not reported'}`);
    }
  }
  lines.push(
    `Negotiation: ${diagnostics.negotiation === null ? 'none' : `${String(diagnostics.negotiation.count)} of ${String(diagnostics.negotiation.max)}`}`,
    `TURN configuration: ${diagnostics.turn === null ? 'none' : diagnostics.turn}`,
    `ICE transport policy: ${diagnostics.icePolicy}`,
  );
  return `${lines.join('\n')}\n`;
}

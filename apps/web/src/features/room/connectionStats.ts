/**
 * Selected-path classification from WebRTC statistics (Phase 2D).
 *
 * This reads an `RTCPeerConnection.getStats()` report and says which ICE
 * path the connection is using, from the standard selected candidate pair:
 *
 *   transport.selectedCandidatePairId
 *     → candidate-pair (succeeded; see `pairHasSucceeded`)
 *     → localCandidateId / remoteCandidateId
 *     → local-candidate / remote-candidate (candidateType)
 *
 * - `TURN_RELAY`: a candidate on either side of the selected pair is `relay`.
 * - `DIRECT`: the selected pair is known and neither candidate is `relay`
 *   (host, srflx, or prflx). It means "not relayed through TURN", not that
 *   both peers are on one network.
 * - `UNKNOWN`: anything less certain. Nothing is inferred from the ICE server
 *   configuration, and a missing, conflicting, or unfamiliar report is never
 *   guessed at.
 *
 * Only candidate types and transport protocols are read and returned.
 * Addresses, ports, candidate strings, URLs, usernames, and every other
 * field of the report are never read into the result, so the result can be
 * shown and exported without exposing network identifiers.
 */

export type SelectedPathClass = 'DIRECT' | 'TURN_RELAY' | 'UNKNOWN';

export const CANDIDATE_TYPES = ['host', 'srflx', 'prflx', 'relay'] as const;
export type CandidateType = (typeof CANDIDATE_TYPES)[number];

export type TransportProtocol = 'udp' | 'tcp';

/** How a TURN client reaches its relay: plain UDP, TCP, or TLS over TCP. */
export type RelayProtocol = 'udp' | 'tcp' | 'tls';

/** Why the path could not be classified. Fixed tokens; no report content. */
export type UnknownPathReason =
  /** No usable report: getStats failed, or returned nothing recognisable. */
  | 'no_report'
  /** Neither the transport nor any candidate pair names a selected pair. */
  | 'no_selected_pair'
  /** Several transports or pairs name different selected pairs. */
  | 'ambiguous_selected_pair'
  /** The named selected pair is missing, or is not a candidate pair. */
  | 'missing_pair'
  /** The selected pair shows no success (for example, it failed). */
  | 'pair_not_succeeded'
  /** A candidate the pair names is missing from the report. */
  | 'missing_candidate'
  /** A candidate's type is absent or not one of the four ICE types. */
  | 'unknown_candidate_type';

export type SelectedPath =
  | {
      readonly classification: 'DIRECT' | 'TURN_RELAY';
      readonly localCandidateType: CandidateType;
      readonly remoteCandidateType: CandidateType;
      /** The local candidate's transport, if reported. */
      readonly protocol: TransportProtocol | null;
      /** For a local relay candidate, how it reaches the TURN server, if reported. */
      readonly relayProtocol: RelayProtocol | null;
    }
  | { readonly classification: 'UNKNOWN'; readonly reason: UnknownPathReason };

/**
 * The part of `RTCStatsReport` this reads: a map-like whose `forEach` passes
 * each stats object. Values are treated as untrusted and unknown.
 */
export interface StatsReportLike {
  forEach(callback: (value: unknown) => void): void;
}

type StatsRecord = Readonly<Record<string, unknown>>;

function unknownPath(reason: UnknownPathReason): SelectedPath {
  return { classification: 'UNKNOWN', reason };
}

/** Classifies the selected ICE path of one report. Never throws. */
export function classifySelectedPath(report: StatsReportLike | undefined): SelectedPath {
  if (report === undefined) return unknownPath('no_report');
  const byId = new Map<string, StatsRecord>();
  try {
    report.forEach((value) => {
      if (!isRecord(value)) return;
      const { id, type } = value;
      if (typeof id === 'string' && id !== '' && typeof type === 'string') byId.set(id, value);
    });
  } catch {
    return unknownPath('no_report');
  }
  if (byId.size === 0) return unknownPath('no_report');

  const selected = selectedPairId(byId);
  if (typeof selected !== 'string') return unknownPath(selected.reason);

  const pair = byId.get(selected);
  if (pair?.type !== 'candidate-pair') return unknownPath('missing_pair');
  if (!pairHasSucceeded(pair)) return unknownPath('pair_not_succeeded');

  const local = candidate(byId, pair.localCandidateId, 'local-candidate');
  const remote = candidate(byId, pair.remoteCandidateId, 'remote-candidate');
  if (local === undefined || remote === undefined) return unknownPath('missing_candidate');
  const localType = candidateType(local.candidateType);
  const remoteType = candidateType(remote.candidateType);
  if (localType === undefined || remoteType === undefined) {
    return unknownPath('unknown_candidate_type');
  }
  const relayed = localType === 'relay' || remoteType === 'relay';
  return {
    classification: relayed ? 'TURN_RELAY' : 'DIRECT',
    localCandidateType: localType,
    remoteCandidateType: remoteType,
    protocol: oneOf(local.protocol, ['udp', 'tcp'] as const),
    relayProtocol: localType === 'relay' ? oneOf(local.relayProtocol, RELAY_PROTOCOLS) : null,
  };
}

const RELAY_PROTOCOLS = ['udp', 'tcp', 'tls'] as const;

/**
 * The selected pair's ID. Standard reports name it on the transport. A
 * browser that does not may mark the pair itself with `selected: true`; that
 * is used only when exactly one pair is marked and no transport says
 * otherwise.
 */
function selectedPairId(
  byId: ReadonlyMap<string, StatsRecord>,
): string | { reason: UnknownPathReason } {
  const fromTransports = new Set<string>();
  const markedPairs = new Set<string>();
  for (const [id, stats] of byId) {
    if (stats.type === 'transport') {
      const pairId = stats.selectedCandidatePairId;
      if (typeof pairId === 'string' && pairId !== '') fromTransports.add(pairId);
    } else if (stats.type === 'candidate-pair' && stats.selected === true) {
      markedPairs.add(id);
    }
  }
  if (fromTransports.size > 1 || markedPairs.size > 1) return { reason: 'ambiguous_selected_pair' };
  const [transportPair] = fromTransports;
  const [markedPair] = markedPairs;
  if (transportPair !== undefined) {
    // A pair marked selected must agree with the transport.
    if (markedPair !== undefined && markedPair !== transportPair) {
      return { reason: 'ambiguous_selected_pair' };
    }
    return transportPair;
  }
  return markedPair ?? { reason: 'no_selected_pair' };
}

/**
 * Whether the selected pair has succeeded. `succeeded` is accepted as is.
 * Chrome also reports the selected, working pair as `in-progress` while one
 * of its periodic connectivity re-checks is outstanding (observed in Chrome
 * 154 on a connected pair); that is accepted only with evidence of an
 * earlier success, at least one connectivity check response received.
 * `failed`, `waiting`, `frozen`, an absent state, and an `in-progress` pair
 * without responses are not.
 */
function pairHasSucceeded(pair: StatsRecord): boolean {
  if (pair.state === 'succeeded') return true;
  const { responsesReceived } = pair;
  return (
    pair.state === 'in-progress' &&
    typeof responsesReceived === 'number' &&
    Number.isSafeInteger(responsesReceived) &&
    responsesReceived > 0
  );
}

function candidate(
  byId: ReadonlyMap<string, StatsRecord>,
  id: unknown,
  type: 'local-candidate' | 'remote-candidate',
): StatsRecord | undefined {
  if (typeof id !== 'string') return undefined;
  const stats = byId.get(id);
  return stats?.type === type ? stats : undefined;
}

function candidateType(value: unknown): CandidateType | undefined {
  return oneOf(value, CANDIDATE_TYPES) ?? undefined;
}

function oneOf<Value extends string>(value: unknown, allowed: readonly Value[]): Value | null {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as Value)
    : null;
}

function isRecord(value: unknown): value is StatsRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

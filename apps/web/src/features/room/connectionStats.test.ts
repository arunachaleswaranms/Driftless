import { describe, expect, it } from 'vitest';
import { classifySelectedPath, type StatsReportLike } from './connectionStats.ts';

// Synthetic reports shaped like Chromium's and Firefox's getStats() output.
// Every address, port, URL, and candidate string is a recognisable marker so
// the tests can show that none of them reaches the result.

const MARKERS = [
  '192.0.2.10',
  '198.51.100.20',
  '203.0.113.30',
  '2001:db8::1',
  'f00d-mdns.local',
  '54400',
  'turn:relay.example.org',
  'candidate:842163049',
  'ufragMARK',
];

type Stats = Record<string, unknown>;

function report(...stats: Stats[]): StatsReportLike {
  return new Map(stats.map((entry) => [String(entry.id), entry]));
}

function local(id: string, candidateType: unknown, extra: Stats = {}): Stats {
  return {
    id,
    type: 'local-candidate',
    timestamp: 1,
    transportId: 'T01',
    candidateType,
    protocol: 'udp',
    address: '192.0.2.10',
    ip: '192.0.2.10',
    port: 54400,
    relatedAddress: '198.51.100.20',
    url: 'turn:relay.example.org',
    usernameFragment: 'ufragMARK',
    foundation: 'candidate:842163049',
    ...extra,
  };
}

function remote(id: string, candidateType: unknown, extra: Stats = {}): Stats {
  return {
    id,
    type: 'remote-candidate',
    timestamp: 1,
    transportId: 'T01',
    candidateType,
    protocol: 'udp',
    address: '203.0.113.30',
    port: 61000,
    ...extra,
  };
}

function pair(id: string, extra: Stats = {}): Stats {
  return {
    id,
    type: 'candidate-pair',
    transportId: 'T01',
    localCandidateId: 'L1',
    remoteCandidateId: 'R1',
    state: 'succeeded',
    nominated: true,
    currentRoundTripTime: 0.012,
    ...extra,
  };
}

function transport(selectedCandidatePairId: unknown, id = 'T01'): Stats {
  return {
    id,
    type: 'transport',
    dtlsState: 'connected',
    iceState: 'connected',
    selectedCandidatePairId,
    localCertificateId: 'CF-fingerprint-AA:BB',
  };
}

function expectNoMarkers(value: unknown): void {
  const text = JSON.stringify(value);
  for (const marker of MARKERS) expect(text).not.toContain(marker);
}

describe('classifySelectedPath', () => {
  it('follows the transport to the selected pair: host to host is direct', () => {
    const result = classifySelectedPath(
      report(transport('CP1'), pair('CP1'), local('L1', 'host'), remote('R1', 'host')),
    );
    expect(result).toStrictEqual({
      classification: 'DIRECT',
      localCandidateType: 'host',
      remoteCandidateType: 'host',
      protocol: 'udp',
      relayProtocol: null,
    });
    expectNoMarkers(result);
  });

  it('classifies server-reflexive and peer-reflexive pairs as direct', () => {
    for (const [l, r] of [
      ['srflx', 'srflx'],
      ['srflx', 'prflx'],
      ['prflx', 'host'],
      ['host', 'prflx'],
    ] as const) {
      const result = classifySelectedPath(
        report(transport('CP1'), pair('CP1'), local('L1', l), remote('R1', r)),
      );
      expect(result).toMatchObject({
        classification: 'DIRECT',
        localCandidateType: l,
        remoteCandidateType: r,
      });
    }
  });

  it('classifies a relay candidate on either or both sides as TURN relay', () => {
    const localRelay = classifySelectedPath(
      report(
        transport('CP1'),
        pair('CP1'),
        local('L1', 'relay', { relayProtocol: 'tls', protocol: 'udp' }),
        remote('R1', 'srflx'),
      ),
    );
    expect(localRelay).toStrictEqual({
      classification: 'TURN_RELAY',
      localCandidateType: 'relay',
      remoteCandidateType: 'srflx',
      protocol: 'udp',
      relayProtocol: 'tls',
    });
    expectNoMarkers(localRelay);

    const remoteRelay = classifySelectedPath(
      report(transport('CP1'), pair('CP1'), local('L1', 'host'), remote('R1', 'relay')),
    );
    expect(remoteRelay).toMatchObject({
      classification: 'TURN_RELAY',
      localCandidateType: 'host',
      remoteCandidateType: 'relay',
      relayProtocol: null,
    });

    const both = classifySelectedPath(
      report(
        transport('CP1'),
        pair('CP1'),
        local('L1', 'relay', { relayProtocol: 'udp' }),
        remote('R1', 'relay'),
      ),
    );
    expect(both).toMatchObject({
      classification: 'TURN_RELAY',
      localCandidateType: 'relay',
      remoteCandidateType: 'relay',
      relayProtocol: 'udp',
    });
  });

  it('uses only the selected pair among many', () => {
    const result = classifySelectedPath(
      report(
        transport('CP2'),
        pair('CP1', { localCandidateId: 'L1', remoteCandidateId: 'R1', state: 'failed' }),
        pair('CP2', { localCandidateId: 'L2', remoteCandidateId: 'R2' }),
        pair('CP3', { localCandidateId: 'L3', remoteCandidateId: 'R1', state: 'succeeded' }),
        local('L1', 'host'),
        local('L2', 'relay'),
        local('L3', 'srflx'),
        remote('R1', 'host'),
        remote('R2', 'srflx'),
      ),
    );
    expect(result).toMatchObject({ classification: 'TURN_RELAY', localCandidateType: 'relay' });
  });

  it('accepts a single pair marked selected when no transport names one', () => {
    const result = classifySelectedPath(
      report(
        pair('CP1', { selected: true }),
        pair('CP2', { localCandidateId: 'L2', selected: false }),
        local('L1', 'srflx', { protocol: 'tcp' }),
        local('L2', 'relay'),
        remote('R1', 'srflx'),
      ),
    );
    expect(result).toMatchObject({ classification: 'DIRECT', protocol: 'tcp' });
  });

  it('is unknown when no pair is selected, even if one has succeeded', () => {
    for (const transportPair of [undefined, '', null, 7]) {
      expect(
        classifySelectedPath(
          report(
            transport(transportPair),
            pair('CP1', { nominated: true }),
            local('L1', 'host'),
            remote('R1', 'host'),
          ),
        ),
      ).toStrictEqual({ classification: 'UNKNOWN', reason: 'no_selected_pair' });
    }
  });

  it('is unknown when the selected pair is ambiguous', () => {
    const base = [pair('CP1'), pair('CP2'), local('L1', 'host'), remote('R1', 'host')];
    expect(
      classifySelectedPath(report(transport('CP1', 'T01'), transport('CP2', 'T02'), ...base)),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'ambiguous_selected_pair' });
    expect(
      classifySelectedPath(
        report(pair('CP1', { selected: true }), pair('CP2', { selected: true }), ...base.slice(2)),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'ambiguous_selected_pair' });
    expect(
      classifySelectedPath(
        report(transport('CP1'), pair('CP1'), pair('CP2', { selected: true }), ...base.slice(2)),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'ambiguous_selected_pair' });
    // Two transports naming the same pair are not ambiguous.
    expect(
      classifySelectedPath(report(transport('CP1', 'T01'), transport('CP1', 'T02'), ...base)),
    ).toMatchObject({ classification: 'DIRECT' });
  });

  it('is unknown when the selected pair is missing, not a pair, or has not succeeded', () => {
    expect(
      classifySelectedPath(report(transport('CP9'), local('L1', 'host'), remote('R1', 'host'))),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_pair' });
    expect(
      classifySelectedPath(
        report(transport('L1'), pair('CP1'), local('L1', 'host'), remote('R1', 'host')),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_pair' });
    for (const state of ['failed', 'in-progress', 'waiting', 'frozen', undefined, 'SUCCEEDED']) {
      expect(
        classifySelectedPath(
          report(
            transport('CP1'),
            pair('CP1', { state }),
            local('L1', 'relay'),
            remote('R1', 'host'),
          ),
        ),
      ).toStrictEqual({ classification: 'UNKNOWN', reason: 'pair_not_succeeded' });
    }
  });

  it('is unknown when a candidate is missing or of the wrong kind', () => {
    expect(
      classifySelectedPath(report(transport('CP1'), pair('CP1'), remote('R1', 'relay'))),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_candidate' });
    expect(
      classifySelectedPath(report(transport('CP1'), pair('CP1'), local('L1', 'relay'))),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_candidate' });
    // The local ID names a remote candidate.
    expect(
      classifySelectedPath(
        report(
          transport('CP1'),
          pair('CP1', { localCandidateId: 'R1' }),
          local('L1', 'host'),
          remote('R1', 'host'),
        ),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_candidate' });
    expect(
      classifySelectedPath(
        report(
          transport('CP1'),
          pair('CP1', { localCandidateId: undefined }),
          local('L1', 'host'),
          remote('R1', 'host'),
        ),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'missing_candidate' });
  });

  it('is unknown for unfamiliar candidate types instead of guessing', () => {
    for (const type of [undefined, '', 'Relay', 'relayed', 'serverreflexive', 3, null]) {
      expect(
        classifySelectedPath(
          report(transport('CP1'), pair('CP1'), local('L1', type), remote('R1', 'host')),
        ),
      ).toStrictEqual({ classification: 'UNKNOWN', reason: 'unknown_candidate_type' });
      expect(
        classifySelectedPath(
          report(transport('CP1'), pair('CP1'), local('L1', 'host'), remote('R1', type)),
        ),
      ).toStrictEqual({ classification: 'UNKNOWN', reason: 'unknown_candidate_type' });
    }
  });

  it('ignores unknown browser fields and reports unfamiliar protocols as not reported', () => {
    const result = classifySelectedPath(
      report(
        { id: 'X1', type: 'codec', mimeType: 'video/whatever', address: '192.0.2.10' },
        { id: 'X2', type: 'future-stat', selectedCandidatePairId: 'CP1' },
        transport('CP1'),
        pair('CP1', { vendorField: { nested: '2001:db8::1' } }),
        local('L1', 'relay', { protocol: 'sctp', relayProtocol: 'quic' }),
        remote('R1', 'host', { protocol: 'UDP' }),
      ),
    );
    expect(result).toStrictEqual({
      classification: 'TURN_RELAY',
      localCandidateType: 'relay',
      remoteCandidateType: 'host',
      protocol: null,
      relayProtocol: null,
    });
    expectNoMarkers(result);
  });

  it('is unknown for no report, an empty report, a non-object report, and a throwing report', () => {
    expect(classifySelectedPath(undefined)).toStrictEqual({
      classification: 'UNKNOWN',
      reason: 'no_report',
    });
    expect(classifySelectedPath(new Map())).toStrictEqual({
      classification: 'UNKNOWN',
      reason: 'no_report',
    });
    expect(
      classifySelectedPath(
        new Map<string, unknown>([
          ['a', 'text'],
          ['b', null],
          ['c', [1]],
        ]),
      ),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'no_report' });
    expect(
      classifySelectedPath({
        forEach() {
          throw new Error('stats unavailable');
        },
      }),
    ).toStrictEqual({ classification: 'UNKNOWN', reason: 'no_report' });
  });

  it('never returns an address, port, URL, or candidate string, whatever the report', () => {
    const results = [
      classifySelectedPath(
        report(transport('CP1'), pair('CP1'), local('L1', 'relay'), remote('R1', 'srflx')),
      ),
      classifySelectedPath(report(transport('CP1'), pair('CP1', { state: 'failed' }))),
      classifySelectedPath(report(local('L1', 'host'), remote('R1', 'host'))),
    ];
    for (const result of results) {
      expectNoMarkers(result);
      expect(Object.keys(result).every((key) => !/address|ip|port|url|candidate$/i.test(key))).toBe(
        true,
      );
    }
  });
});

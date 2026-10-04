import { useState, useSyncExternalStore, type ReactNode } from 'react';
import type { UnknownPathReason } from './connectionStats.ts';
import {
  PATH_TEXT,
  TURN_TEXT,
  diagnosticsText,
  type ConnectionDiagnostics,
  type DiagnosticsSignaling,
} from './diagnostics.ts';
import type { RoomController, RoomState } from './roomController.ts';

/** The revision this build was made from, or `unversioned`. */
export const BUILD_REVISION: string = __DRIFTLESS_BUILD__;

const UNKNOWN_TEXT: Readonly<Record<UnknownPathReason, string>> = {
  no_report: 'The browser reported no usable connection statistics.',
  no_selected_pair: 'The browser has not reported a selected candidate pair.',
  ambiguous_selected_pair: 'The browser reported conflicting selected candidate pairs.',
  missing_pair: 'The selected candidate pair is missing from the statistics.',
  pair_not_succeeded: 'The selected candidate pair has not succeeded.',
  missing_candidate: 'A selected candidate is missing from the statistics.',
  unknown_candidate_type: 'A selected candidate has an unrecognised type.',
};

const STATUS_TEXT: Readonly<Record<ConnectionDiagnostics['status'], string>> = {
  none: 'No peer connection to describe yet.',
  collecting: 'Reading connection statistics…',
  ready: 'Statistics read from this browser.',
};

interface ConnectionDiagnosticsViewProps {
  controller: RoomController;
  state: Extract<RoomState, { phase: 'in-room' }>;
}

/**
 * A collapsible, read-only view of the current peer connection as this
 * browser sees it: states, the selected path's classification and candidate
 * types, and counts. It never shows an address, candidate, session
 * description, credential, or identifier, and it sends nothing anywhere.
 * Statistics are read when a connection becomes connected and when Refresh
 * is pressed; there is no polling.
 */
export function ConnectionDiagnosticsView({ controller, state }: ConnectionDiagnosticsViewProps) {
  const diagnostics = useSyncExternalStore(
    controller.subscribeDiagnostics,
    controller.getDiagnostics,
  );
  const [copyStatus, setCopyStatus] = useState('');
  const { path } = diagnostics;
  const signaling: DiagnosticsSignaling = state.signaling;

  function copy() {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    const text = diagnosticsText(diagnostics, {
      role: state.role,
      signaling,
      build: BUILD_REVISION,
    });
    if (clipboard === undefined) {
      setCopyStatus('Could not copy the diagnostics.');
      return;
    }
    clipboard.writeText(text).then(
      () => {
        setCopyStatus('Copied the diagnostics.');
      },
      () => {
        setCopyStatus('Could not copy the diagnostics.');
      },
    );
  }

  return (
    <details className="room-diagnostics">
      <summary>Connection diagnostics</summary>
      <p className="room-note">
        This browser&apos;s own view of the current connection. Network addresses are never shown,
        and nothing here is sent anywhere.
      </p>
      <p className="room-note">{STATUS_TEXT[diagnostics.status]}</p>
      <dl className="room-facts">
        <Fact label="Signaling">
          {state.signaling === 'connected' ? 'Connected' : 'Reconnecting'}
        </Fact>
        <Fact label="Peer connection">{diagnostics.peerConnection ?? 'Not yet'}</Fact>
        <Fact label="ICE connection">{diagnostics.iceConnection ?? 'Not yet'}</Fact>
        <Fact label="Data channel">{diagnostics.dataChannel ?? 'Not yet'}</Fact>
        <Fact label="Path">{PATH_TEXT[path.classification]}</Fact>
        {path.classification === 'UNKNOWN' ? (
          diagnostics.status === 'none' ? null : (
            <Fact label="Path detail">{UNKNOWN_TEXT[path.reason]}</Fact>
          )
        ) : (
          <>
            <Fact label="Local candidate type">{path.localCandidateType}</Fact>
            <Fact label="Remote candidate type">{path.remoteCandidateType}</Fact>
            <Fact label="Transport">{path.protocol?.toUpperCase() ?? 'Not reported'}</Fact>
            {path.localCandidateType === 'relay' ? (
              <Fact label="Relay protocol">
                {path.relayProtocol?.toUpperCase() ?? 'Not reported'}
              </Fact>
            ) : null}
          </>
        )}
        <Fact label="Negotiation">
          {diagnostics.negotiation === null
            ? 'None'
            : `${String(diagnostics.negotiation.count)} of ${String(diagnostics.negotiation.max)}`}
        </Fact>
        <Fact label="TURN configuration">
          {diagnostics.turn === null ? 'Not yet' : TURN_TEXT[diagnostics.turn]}
        </Fact>
        <Fact label="ICE transport policy">
          {diagnostics.icePolicy === 'relay' ? 'Relay only (qualification build)' : 'All'}
        </Fact>
        <Fact label="Build">{BUILD_REVISION}</Fact>
      </dl>
      <div className="room-actions">
        <button
          type="button"
          className="button button-secondary"
          onClick={() => {
            controller.refreshDiagnostics();
          }}
        >
          Refresh diagnostics
        </button>
        <button type="button" className="button button-secondary" onClick={copy}>
          Copy diagnostics
        </button>
      </div>
      <p className="room-note" aria-live="polite">
        {copyStatus}
      </p>
    </details>
  );
}

function Fact({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div>
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

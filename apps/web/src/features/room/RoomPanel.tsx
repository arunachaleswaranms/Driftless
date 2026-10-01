import { useEffect, useRef, useState, useSyncExternalStore, type SubmitEvent } from 'react';
import { ConnectionDiagnosticsView } from './ConnectionDiagnosticsView.tsx';
import { createBrowserRoomController } from './browserRoomController.ts';
import type {
  PeerConnectionView,
  RoomController,
  RoomState,
  SignalingView,
} from './roomController.ts';
import { noticeError, peerFailureText, statusText } from './roomText.ts';

interface RoomPanelProps {
  /** The controller to render. Defaults to one wired to this page's browser APIs. */
  controller?: RoomController;
}

const CONNECTION_TEXT: Readonly<Record<PeerConnectionView, string>> = {
  negotiating: 'Setting up',
  connecting: 'Connecting',
  connected: 'Connected',
  recovering: 'Recovering',
  failed: 'Failed',
};

const SIGNALING_TEXT: Readonly<Record<SignalingView, string>> = {
  connected: 'Connected',
  reconnecting: 'Reconnecting',
};

/** Shown in place of the invite secret until the host reveals it. */
const MASK = '•'.repeat(16);

/**
 * The private two-person room: create or join, share the invite, follow the
 * peer connection, and leave. It renders the controller's state and calls its
 * actions; signaling and WebRTC live in the controller.
 */
export function RoomPanel({ controller: provided }: RoomPanelProps) {
  const [controller] = useState(() => provided ?? createBrowserRoomController());
  const state = useSyncExternalStore(controller.subscribe, controller.getState);
  const headingRef = useRef<HTMLHeadingElement>(null);

  // Leaving releases the room, its connections, and its credentials.
  useEffect(
    () => () => {
      controller.shutdown();
    },
    [controller],
  );

  // When the control that had focus disappears with the view it belonged to,
  // keep keyboard users in the room panel rather than at the top of the page.
  // Only on a change of view, never when the panel first mounts.
  const { phase } = state;
  const previousPhase = useRef(phase);
  useEffect(() => {
    if (previousPhase.current === phase) return;
    previousPhase.current = phase;
    if (document.activeElement === document.body) headingRef.current?.focus();
  }, [phase]);

  const error = state.phase === 'idle' ? noticeError(state.notice) : null;
  const peerFailure =
    state.phase === 'in-room' && state.peer?.connection === 'failed'
      ? peerFailureText(state.role, state.peer.failure)
      : null;

  return (
    <section className="panel room" aria-labelledby="room-heading">
      <div>
        <h2 id="room-heading" ref={headingRef} tabIndex={-1}>
          Room
        </h2>
        <p className="panel-status">
          Connect this browser directly to one other person&apos;s browser in a private two-person
          room. The signaling service only helps the two browsers find each other. Nothing is shared
          or played together yet.
        </p>
      </div>

      <p className="room-status" role="status">
        {statusText(state)}
      </p>
      {error !== null || peerFailure !== null ? (
        <div className="room-alert" role="alert">
          {error ?? peerFailure}
        </div>
      ) : null}

      <RoomBody
        state={state}
        onCreate={() => {
          controller.createRoom();
        }}
        onJoin={(roomId, inviteSecret) => {
          controller.joinRoom(roomId, inviteSecret);
        }}
        onLeave={() => {
          controller.leaveRoom();
        }}
      />
      {state.phase === 'in-room' ? (
        <ConnectionDiagnosticsView controller={controller} state={state} />
      ) : null}
    </section>
  );
}

interface RoomBodyProps {
  state: RoomState;
  onCreate: () => void;
  onJoin: (roomId: string, inviteSecret: string) => void;
  onLeave: () => void;
}

function RoomBody({ state, onCreate, onJoin, onLeave }: RoomBodyProps) {
  switch (state.phase) {
    case 'idle':
      return <RoomEntry onCreate={onCreate} onJoin={onJoin} />;
    case 'opening':
      return (
        <div className="room-actions">
          <button type="button" className="button button-secondary" onClick={onLeave}>
            Cancel
          </button>
        </div>
      );
    case 'leaving':
      return null;
    case 'in-room':
      return (
        <div className="room-session">
          {state.role === 'host' ? (
            <InviteDetails roomId={state.roomId} inviteSecret={state.inviteSecret} />
          ) : null}
          <dl className="room-facts">
            <div>
              <dt>Your role</dt>
              <dd>{state.role === 'host' ? 'Host' : 'Guest'}</dd>
            </div>
            {state.role === 'guest' ? (
              <div>
                <dt>Room ID</dt>
                <dd>
                  <code className="room-value">{state.roomId}</code>
                </dd>
              </div>
            ) : null}
            <div>
              <dt>Signaling</dt>
              <dd>{SIGNALING_TEXT[state.signaling]}</dd>
            </div>
            {state.peer === null ? null : (
              <div>
                <dt>Other participant&apos;s signaling</dt>
                <dd>{SIGNALING_TEXT[state.peer.signaling]}</dd>
              </div>
            )}
            <div>
              <dt>Peer connection</dt>
              <dd>
                {state.peer === null
                  ? 'Waiting for a guest'
                  : CONNECTION_TEXT[state.peer.connection]}
              </dd>
            </div>
          </dl>
          {state.peer?.connection === 'connected' ? (
            <p className="room-note">
              The two browsers have a working WebRTC data channel between them. This build does not
              use it for anything yet: synchronized playback is not available.
            </p>
          ) : null}
          <div className="room-actions">
            <button type="button" className="button button-secondary" onClick={onLeave}>
              Leave room
            </button>
          </div>
        </div>
      );
  }
}

interface RoomEntryProps {
  onCreate: () => void;
  onJoin: (roomId: string, inviteSecret: string) => void;
}

/** Create or join. The join details live only in this form's state, and only until it is used. */
function RoomEntry({ onCreate, onJoin }: RoomEntryProps) {
  const [roomId, setRoomId] = useState('');
  const [inviteSecret, setInviteSecret] = useState('');

  function handleJoin(event: SubmitEvent<HTMLFormElement>) {
    event.preventDefault();
    const secret = inviteSecret;
    // The secret is not kept in the form once it has been submitted.
    setInviteSecret('');
    onJoin(roomId, secret);
  }

  return (
    <div className="room-entry">
      <div className="room-option">
        <h3>Start a room</h3>
        <p className="room-note">You become the host and get an invite to share with one person.</p>
        <div className="room-actions">
          <button type="button" className="button" onClick={onCreate}>
            Create room
          </button>
        </div>
      </div>

      <form className="room-option" aria-labelledby="room-join-heading" onSubmit={handleJoin}>
        <h3 id="room-join-heading">Join a room</h3>
        <div className="room-field">
          <label htmlFor="room-join-id">Room ID</label>
          <input
            id="room-join-id"
            className="room-input"
            value={roomId}
            onChange={(event) => {
              setRoomId(event.currentTarget.value);
            }}
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="room-field">
          <label htmlFor="room-join-secret">Invite secret</label>
          <p id="room-join-secret-hint" className="room-note">
            Sensitive: treat it like a password. It is used only to join and is not saved.
          </p>
          <input
            id="room-join-secret"
            className="room-input"
            value={inviteSecret}
            onChange={(event) => {
              setInviteSecret(event.currentTarget.value);
            }}
            aria-describedby="room-join-secret-hint"
            autoComplete="off"
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            required
          />
        </div>
        <div className="room-actions">
          <button type="submit" className="button">
            Join room
          </button>
        </div>
      </form>
    </div>
  );
}

interface InviteDetailsProps {
  roomId: string;
  inviteSecret: string;
}

/**
 * The host's invite. The secret is masked until explicitly revealed, and can
 * be copied without revealing it. Nothing here writes it anywhere but the
 * clipboard, and only when asked.
 */
function InviteDetails({ roomId, inviteSecret }: InviteDetailsProps) {
  const [revealed, setRevealed] = useState(false);
  const [copyStatus, setCopyStatus] = useState('');

  function copy(value: string, what: string) {
    const clipboard = navigator.clipboard as Clipboard | undefined;
    if (clipboard === undefined) {
      setCopyStatus(`Could not copy the ${what}. Select it and copy it manually.`);
      return;
    }
    clipboard.writeText(value).then(
      () => {
        setCopyStatus(`Copied the ${what}.`);
      },
      () => {
        setCopyStatus(`Could not copy the ${what}. Select it and copy it manually.`);
      },
    );
  }

  return (
    <div className="room-invite" role="group" aria-labelledby="room-invite-heading">
      <h3 id="room-invite-heading">Invite</h3>
      <p className="room-note">
        Share both values with one person you trust, privately. Anyone with them can join while this
        room is open. They are not saved anywhere, and they stop working when you leave.
      </p>
      <dl className="room-facts">
        <div>
          <dt>Room ID</dt>
          <dd className="room-credential">
            <code className="room-value">{roomId}</code>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                copy(roomId, 'room ID');
              }}
            >
              Copy room ID
            </button>
          </dd>
        </div>
        <div>
          <dt>
            Invite secret <span className="room-sensitive">(sensitive)</span>
          </dt>
          <dd className="room-credential">
            <code className="room-value">
              {revealed ? (
                inviteSecret
              ) : (
                <>
                  <span aria-hidden="true">{MASK}</span>
                  <span className="visually-hidden">Hidden</span>
                </>
              )}
            </code>
            <button
              type="button"
              className="button button-secondary"
              aria-pressed={revealed}
              onClick={() => {
                setRevealed((value) => !value);
              }}
            >
              Show invite secret
            </button>
            <button
              type="button"
              className="button button-secondary"
              onClick={() => {
                copy(inviteSecret, 'invite secret');
              }}
            >
              Copy invite secret
            </button>
          </dd>
        </div>
      </dl>
      <p className="room-note" aria-live="polite">
        {copyStatus}
      </p>
    </div>
  );
}

import type { PeerFailure } from './peerSession.ts';
import type { PeerConnectionView, RoomNotice, RoomState } from './roomController.ts';

/** Information about how the room view last changed. */
const INFO_NOTICES: Partial<Record<RoomNotice, string>> = {
  left: 'You left the room.',
  host_left: 'The host closed the room.',
  host_disconnected: 'The host disconnected, so the room is closed.',
  room_expired: 'The room expired.',
  guest_left: 'The guest left.',
  guest_disconnected: 'The guest disconnected.',
};

/**
 * Problems the user should act on. The text is fixed per notice: it never
 * contains anything received from the service or the peer.
 */
const ERROR_NOTICES: Partial<Record<RoomNotice, string>> = {
  signaling_lost:
    'The connection to the signaling service was lost, and the peer connection was closed. Create or join a room to start again.',
  connect_failed: 'Could not reach the signaling service. Check your connection and try again.',
  protocol_error:
    'The signaling service sent a message this version does not accept, so the connection was closed. Try again.',
  room_unavailable:
    'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
  room_full: 'That room already has two participants.',
  rate_limited: 'Too many messages were sent, so the connection was closed. Try again.',
  request_rejected: 'The signaling service could not complete the request. Try again.',
  invalid_join_details: 'Enter the room ID and invite secret exactly as the host shared them.',
  insecure_origin:
    'Rooms need a secure connection. Open Driftless over HTTPS to create or join a room.',
  invalid_ice_config: 'This build has an invalid STUN server setting, so rooms are unavailable.',
};

export function noticeError(notice: RoomNotice | null): string | null {
  return notice === null ? null : (ERROR_NOTICES[notice] ?? null);
}

const PEER_STATUS: Readonly<Record<'host' | 'guest', Record<PeerConnectionView, string>>> = {
  host: {
    negotiating: 'A guest joined. Setting up the peer connection…',
    connecting: 'Connecting to the guest…',
    connected: 'Peer data channel is connected.',
    failed: 'The peer connection to the guest failed.',
  },
  guest: {
    negotiating: 'Joined the room. Setting up the peer connection…',
    connecting: 'Connecting to the host…',
    connected: 'Peer data channel is connected.',
    failed: 'The peer connection to the host failed.',
  },
};

/**
 * One sentence for the live status region. It changes only on meaningful
 * transitions, never per ICE candidate.
 */
export function statusText(state: RoomState): string {
  switch (state.phase) {
    case 'idle': {
      const info = state.notice === null ? undefined : INFO_NOTICES[state.notice];
      return info === undefined ? 'Not in a room.' : `${info} You are not in a room.`;
    }
    case 'opening':
      return state.intent === 'create' ? 'Creating a room…' : 'Joining the room…';
    case 'leaving':
      return 'Leaving the room…';
    case 'in-room':
      if (state.role === 'host' && state.peer === null) {
        const info = state.notice === null ? '' : `${INFO_NOTICES[state.notice] ?? ''} `;
        return `${info}Room created. Waiting for a guest to join.`;
      }
      return PEER_STATUS[state.role][state.peer?.connection ?? 'negotiating'];
  }
}

const PEER_FAILURES: Readonly<Record<PeerFailure, string>> = {
  connection_failed: 'The two browsers could not connect to each other.',
  connection_lost: 'The connection between the two browsers was lost.',
  channel_closed: 'The peer data channel closed.',
  negotiation_failed: 'The browsers could not agree on a connection.',
  unexpected_channel:
    'The other browser opened an unexpected channel, so the connection was closed.',
  peer_protocol: 'The other browser sent an unexpected message, so the connection was closed.',
  candidate_limit: 'The other browser sent too much connection data, so the connection was closed.',
  signaling_unavailable: 'Connection details could not be sent through the signaling service.',
};

/** The alert for a failed peer connection, with what the user can do next. */
export function peerFailureText(role: 'host' | 'guest', failure: PeerFailure | null): string {
  const reason = failure === null ? 'The peer connection failed.' : PEER_FAILURES[failure];
  const action =
    role === 'host'
      ? 'Driftless does not retry. Leave the room to close it, or wait for the guest to leave and join again.'
      : 'Driftless does not retry. Leave the room, then join again to start a new connection.';
  return `${reason} ${action}`;
}

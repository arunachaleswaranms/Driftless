import type {
  InviteSecret,
  NegotiationId,
  ParticipantId,
  ResumeSecret,
  RoomId,
  SessionId,
} from '@driftless/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import {
  FakePeerConnection,
  FakeTimers,
  FakeWebSocket,
  STATS_ADDRESSES,
  fakeProver,
  flush,
  peerMessage,
  statsReport,
} from '../../test/room.ts';
import { RoomController } from './roomController.ts';
import { RoomPanel } from './RoomPanel.tsx';

const ROOM_ID = `${'R'.repeat(21)}Q` as RoomId;
const SECRET = `${'S'.repeat(42)}E` as InviteSecret;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const RESUME_SECRET = 'r'.repeat(44) as ResumeSecret;

function setup() {
  const timers = new FakeTimers();
  const sockets: FakeWebSocket[] = [];
  const connections: FakePeerConnection[] = [];
  const controller = new RoomController({
    signalingUrl: { ok: true, url: 'ws://localhost/v1/signaling' },
    iceServers: { ok: true, iceServers: [] },
    createWebSocket: (url) => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket;
    },
    createPeerConnection: (configuration) => {
      const connection = new FakePeerConnection(configuration);
      connections.push(connection);
      return connection.asPeerConnection();
    },
    createNegotiationId: () => 'N'.repeat(24) as NegotiationId,
    proveResume: fakeProver().prove,
    clock: () => 0,
    timers,
  });
  const view = render(<RoomPanel controller={controller} />);
  const region = screen.getByRole('region', { name: 'Room' });
  const socket = () => {
    const current = sockets.at(-1);
    if (current === undefined) throw new Error('no socket');
    return current;
  };
  return { controller, sockets, connections, view, region, socket, timers };
}

async function createdRoom() {
  const harness = setup();
  fireEvent.click(within(harness.region).getByRole('button', { name: 'Create room' }));
  await act(async () => {
    harness.socket().open();
    await flush();
  });
  act(() => {
    harness.socket().deliver({
      type: 'ROOM_CREATED',
      payload: {
        roomId: ROOM_ID,
        sessionId: 'Q'.repeat(27) as SessionId,
        inviteSecret: SECRET,
        resumeSecret: RESUME_SECRET,
        participantId: HOST_ID,
        role: 'host',
        expiresAt: 1,
      },
    });
  });
  return harness;
}

/** jsdom has no clipboard; installs one for the current test. */
function stubClipboard(writeText: (text: string) => Promise<void>): void {
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
  onTestFinished(() => {
    Reflect.deleteProperty(navigator, 'clipboard');
  });
}

describe('RoomPanel', () => {
  it('offers labelled create and join controls and connects nothing on mount', () => {
    const { region, sockets } = setup();
    expect(within(region).getByRole('status').textContent).toBe('Not in a room.');
    expect(within(region).getByRole('button', { name: 'Create room' })).toBeDefined();
    expect(within(region).getByLabelText('Room ID')).toBeDefined();
    const secret = within(region).getByLabelText('Invite secret');
    expect(secret.getAttribute('autocomplete')).toBe('off');
    expect(secret.getAttribute('aria-describedby')).toBe('room-join-secret-hint');
    expect(within(region).getByRole('button', { name: 'Join room' })).toBeDefined();
    expect(sockets).toHaveLength(0);
  });

  it('opens nothing when rendered in StrictMode', () => {
    const create = vi.fn(() => new FakeWebSocket('x'));
    const controller = new RoomController({
      signalingUrl: { ok: true, url: 'ws://localhost/v1/signaling' },
      iceServers: { ok: true, iceServers: [] },
      createWebSocket: create,
      createPeerConnection: (configuration) =>
        new FakePeerConnection(configuration).asPeerConnection(),
      createNegotiationId: () => 'N'.repeat(24) as NegotiationId,
      proveResume: fakeProver().prove,
      clock: () => 0,
      timers: new FakeTimers(),
    });
    render(
      <StrictMode>
        <RoomPanel controller={controller} />
      </StrictMode>,
    );
    expect(create).not.toHaveBeenCalled();
  });

  it('shows the host invite masked, reveals it on request, and states the role', async () => {
    const { region } = await createdRoom();
    expect(within(region).getByRole('status').textContent).toBe(
      'Room created. Waiting for a guest to join.',
    );
    const invite = within(region).getByRole('group', { name: 'Invite' });
    expect(invite.textContent).toContain(ROOM_ID);
    expect(invite.textContent).not.toContain(SECRET);
    expect(within(invite).getByText('(sensitive)')).toBeDefined();
    const reveal = within(invite).getByRole('button', { name: 'Show invite secret' });
    expect(reveal.getAttribute('aria-pressed')).toBe('false');
    fireEvent.click(reveal);
    expect(reveal.getAttribute('aria-pressed')).toBe('true');
    expect(invite.textContent).toContain(SECRET);
    fireEvent.click(reveal);
    expect(invite.textContent).not.toContain(SECRET);
    expect(region.textContent).toContain('Host');
  });

  it('copies the secret through the clipboard without revealing it', async () => {
    const writeText = vi.fn(() => Promise.resolve());
    stubClipboard(writeText);
    const { region } = await createdRoom();
    const invite = within(region).getByRole('group', { name: 'Invite' });
    await act(async () => {
      fireEvent.click(within(invite).getByRole('button', { name: 'Copy invite secret' }));
      await flush();
    });
    expect(writeText).toHaveBeenCalledExactlyOnceWith(SECRET);
    expect(invite.textContent).toContain('Copied the invite secret.');
    expect(invite.textContent).not.toContain(SECRET);
  });

  it('reports a copy failure with a manual fallback', async () => {
    stubClipboard(() => Promise.reject(new Error('denied')));
    const { region } = await createdRoom();
    const invite = within(region).getByRole('group', { name: 'Invite' });
    await act(async () => {
      fireEvent.click(within(invite).getByRole('button', { name: 'Copy room ID' }));
      await flush();
    });
    expect(invite.textContent).toContain('Could not copy the room ID.');
  });

  it('submits the join form, clears its fields, and shows a sanitized error', async () => {
    const { region, socket } = setup();
    fireEvent.change(within(region).getByLabelText('Room ID'), { target: { value: ROOM_ID } });
    fireEvent.change(within(region).getByLabelText('Invite secret'), { target: { value: SECRET } });
    fireEvent.click(within(region).getByRole('button', { name: 'Join room' }));
    expect(within(region).getByRole('status').textContent).toBe('Joining the room…');
    await act(async () => {
      socket().open();
      await flush();
    });
    expect(socket().sentOfType('ROOM_JOIN')).toHaveLength(1);
    act(() => {
      socket().deliver({
        type: 'ERROR',
        payload: { code: 'ROOM_UNAVAILABLE', message: 'server text', recoverable: true },
      });
    });
    const alert = within(region).getByRole('alert');
    expect(alert.textContent).toBe(
      'That room is not available. Check the room ID and invite secret, or ask the host for a new invite.',
    );
    expect(alert.textContent).not.toContain('server text');
    // The form is rebuilt empty: nothing typed survives the attempt.
    expect(within(region).getByLabelText<HTMLInputElement>('Invite secret').value).toBe('');
    expect(within(region).getByLabelText<HTMLInputElement>('Room ID').value).toBe('');
  });

  it('shows connection progress and recovery as text, alerting only when recovery stops', async () => {
    const { region, socket, connections, timers } = await createdRoom();
    act(() => {
      socket().deliver({
        type: 'ROOM_PARTICIPANT_JOINED',
        payload: { participant: { participantId: GUEST_ID, role: 'guest' } },
      });
    });
    expect(within(region).getByRole('status').textContent).toBe(
      'A guest joined. Setting up the peer connection…',
    );
    expect(region.textContent).toContain('Setting up');
    for (let index = 0; index < 4; index += 1) {
      await act(async () => {
        connections[index]?.setConnectionState('failed');
        await timers.advance(1000);
      });
      if (index < 3) {
        expect(within(region).getByRole('status').textContent).toBe(
          'Peer connection lost. Recovering…',
        );
        expect(region.textContent).toContain('Recovering');
        expect(within(region).queryByRole('alert')).toBeNull();
      }
    }
    expect(within(region).getByRole('status').textContent).toBe(
      'The peer connection to the guest could not be recovered.',
    );
    expect(within(region).getByRole('alert').textContent).toContain(
      'Driftless stopped trying to recover it.',
    );
    expect(region.textContent).toContain('Failed');
    expect(within(region).getByRole('button', { name: 'Leave room' })).toBeDefined();
  });

  it('shows signaling reconnect without retry details and keeps Leave usable', async () => {
    const { region, socket, timers, sockets } = await createdRoom();
    const status = within(region).getByRole('status');
    act(() => {
      socket().drop();
    });
    expect(status.textContent).toBe('Reconnecting to signaling…');
    expect(region.textContent).toContain('Reconnecting');
    // Retries change nothing on the page: no attempt counts or timers are shown.
    await act(async () => {
      await timers.advance(0);
      sockets.at(-1)?.drop();
      await flush();
      await timers.advance(250);
    });
    expect(status.textContent).toBe('Reconnecting to signaling…');
    expect(region.textContent).not.toMatch(/attempt|challenge|proof|\d+\s*ms/i);
    fireEvent.click(within(region).getByRole('button', { name: 'Leave room' }));
    // The leave is being made authoritative; the room controls are gone.
    expect(status.textContent).toBe('Leaving the room…');
    expect(within(region).queryByRole('button', { name: 'Leave room' })).toBeNull();
    // The service cannot be reached: after the finite leave schedule, the
    // room is left locally, without alarming the user.
    await act(async () => {
      for (const delay of [0, 250, 500, 1000, 2000]) {
        await timers.advance(delay);
        sockets.at(-1)?.drop();
        await flush();
      }
    });
    expect(status.textContent).toBe('You left the room. You are not in a room.');
    expect(within(region).queryByRole('alert')).toBeNull();
    expect(timers.pendingCount).toBe(0);
  });

  it('says when the room session could not be recovered', async () => {
    const { region, socket, timers, sockets } = await createdRoom();
    act(() => {
      socket().drop();
    });
    await act(async () => {
      for (const delay of [0, 250, 500, 1000, 2000, 4000, 4000, 4000]) {
        await timers.advance(delay);
        sockets.at(-1)?.drop();
        await flush();
      }
    });
    expect(within(region).getByRole('alert').textContent).toBe(
      'The room session could not be recovered, and the peer connection was closed. Create or join a room to start again.',
    );
    expect(within(region).getByRole('button', { name: 'Create room' })).toBeDefined();
  });

  it('leaves the room, drops the invite from the page, and keeps focus in the panel', async () => {
    const { region, socket, view } = await createdRoom();
    const leave = within(region).getByRole('button', { name: 'Leave room' });
    leave.focus();
    fireEvent.click(leave);
    act(() => {
      socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    });
    expect(within(region).getByRole('status').textContent).toBe(
      'You left the room. You are not in a room.',
    );
    expect(view.container.innerHTML).not.toContain(SECRET);
    expect(view.container.innerHTML).not.toContain(ROOM_ID);
    expect(document.activeElement).toBe(within(region).getByRole('heading', { name: 'Room' }));
  });

  it('shuts the controller down when unmounted', async () => {
    const { view, socket } = await createdRoom();
    const current = socket();
    view.unmount();
    expect(current.closeCalls).toStrictEqual([1000]);
  });
});

describe('connection diagnostics', () => {
  async function connectedHost() {
    const harness = await createdRoom();
    act(() => {
      harness.socket().deliver({
        type: 'ROOM_PARTICIPANT_JOINED',
        payload: { participant: { participantId: GUEST_ID, role: 'guest' } },
      });
    });
    await act(flush);
    const pc = harness.connections[0];
    if (pc === undefined) throw new Error('no connection');
    pc.stats = statsReport('relay', 'srflx', { relayProtocol: 'tcp' });
    await act(async () => {
      await pc.settle('createOffer');
      await pc.settle('setLocalDescription');
    });
    const negotiationId = 'N'.repeat(24) as NegotiationId;
    await act(async () => {
      harness.socket().deliver({
        type: 'RTC_ANSWER',
        payload: { negotiationId, sdp: 'v=0\r\n' },
      });
      await flush();
      await pc.settle('setRemoteDescription');
    });
    const channel = pc.channels[0];
    if (channel === undefined) throw new Error('no channel');
    const fromGuest = {
      sessionId: 'Q'.repeat(27) as SessionId,
      negotiationId,
      senderId: GUEST_ID,
      recipientId: HOST_ID,
    };
    await act(async () => {
      pc.connectionState = 'connected';
      pc.iceConnectionState = 'connected';
      channel.open();
      channel.receive(peerMessage('PEER_HELLO', fromGuest, 0));
      channel.receive(peerMessage('PEER_READY', fromGuest, 1));
      await flush();
    });
    return { ...harness, pc };
  }

  function details(region: HTMLElement): HTMLDetailsElement {
    const summary = within(region).getByText('Connection diagnostics');
    const element = summary.closest('details');
    if (element === null) throw new Error('no details');
    return element;
  }

  it('is a collapsed section that appears only in a room', async () => {
    const harness = setup();
    expect(within(harness.region).queryByText('Connection diagnostics')).toBeNull();
    harness.view.unmount();
    const room = await createdRoom();
    const section = details(room.region);
    expect(section.open).toBe(false);
    expect(within(section).getByText('No peer connection to describe yet.')).toBeDefined();
  });

  it('shows the selected path and safe fields, never an address or credential', async () => {
    const { region, pc } = await connectedHost();
    const section = details(region);
    const text = section.textContent;
    expect(text).toContain('TURN relay');
    expect(text).toContain('relay');
    expect(text).toContain('srflx');
    expect(text).toContain('UDP');
    expect(text).toContain('TCP');
    expect(text).toContain('1 of 4');
    expect(text).toContain('Not requested');
    expect(text).toContain('All');
    for (const value of [...STATS_ADDRESSES, SECRET, RESUME_SECRET, ROOM_ID, HOST_ID, GUEST_ID]) {
      expect(text).not.toContain(value);
    }
    expect(pc.getStatsCalls).toBe(1);
  });

  it('refreshes only when asked', async () => {
    const { region, pc, timers } = await connectedHost();
    await act(() => timers.advance(600_000));
    expect(pc.getStatsCalls).toBe(1);
    pc.stats = statsReport('host', 'host');
    await act(async () => {
      fireEvent.click(within(details(region)).getByRole('button', { name: 'Refresh diagnostics' }));
      await flush();
    });
    expect(pc.getStatsCalls).toBe(2);
    expect(details(region).textContent).toContain('Direct (not relayed)');
  });

  it('copies a summary of safe fields only', async () => {
    const copied: string[] = [];
    stubClipboard((text) => {
      copied.push(text);
      return Promise.resolve();
    });
    const { region } = await connectedHost();
    await act(async () => {
      fireEvent.click(within(details(region)).getByRole('button', { name: 'Copy diagnostics' }));
      await flush();
    });
    expect(copied).toHaveLength(1);
    const [text = ''] = copied;
    expect(text).toMatch(/^Driftless connection diagnostics\n/);
    expect(text).toContain('Path: TURN_RELAY\n');
    expect(text).toContain('Local candidate type: relay\n');
    expect(text).toContain('Remote candidate type: srflx\n');
    expect(text).toContain('Relay protocol: tcp\n');
    expect(text).toContain('Negotiation: 1 of 4\n');
    expect(text).toContain('Role: host\n');
    for (const value of [...STATS_ADDRESSES, SECRET, RESUME_SECRET, ROOM_ID, HOST_ID, GUEST_ID]) {
      expect(text).not.toContain(value);
    }
    expect(text).not.toMatch(/\b\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}\b/);
    expect(within(region).getByText('Copied the diagnostics.')).toBeDefined();
  });
});

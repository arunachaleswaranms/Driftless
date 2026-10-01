import type { InviteSecret, NegotiationId, ParticipantId, RoomId } from '@driftless/protocol';
import { act, fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, onTestFinished, vi } from 'vitest';
import { FakePeerConnection, FakeWebSocket, flush } from '../../test/room.ts';
import { RoomController } from './roomController.ts';
import { RoomPanel } from './RoomPanel.tsx';

const ROOM_ID = `${'R'.repeat(21)}Q` as RoomId;
const SECRET = `${'S'.repeat(42)}E` as InviteSecret;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;

function setup() {
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
    clock: () => 0,
  });
  const view = render(<RoomPanel controller={controller} />);
  const region = screen.getByRole('region', { name: 'Room' });
  const socket = () => {
    const current = sockets.at(-1);
    if (current === undefined) throw new Error('no socket');
    return current;
  };
  return { controller, sockets, connections, view, region, socket };
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
        inviteSecret: SECRET,
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
      clock: () => 0,
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

  it('shows connection progress as text and a failure with the next step', async () => {
    const { region, socket, connections } = await createdRoom();
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
    act(() => {
      connections[0]?.setConnectionState('failed');
    });
    expect(within(region).getByRole('status').textContent).toBe(
      'The peer connection to the guest failed.',
    );
    expect(within(region).getByRole('alert').textContent).toContain('Driftless does not retry.');
    expect(region.textContent).toContain('Failed');
    expect(within(region).getByRole('button', { name: 'Leave room' })).toBeDefined();
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

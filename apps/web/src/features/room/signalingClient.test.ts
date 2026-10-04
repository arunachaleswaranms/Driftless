import { MAX_SIGNALING_MESSAGE_BYTES, type ServerMessage } from '@driftless/protocol';
import { describe, expect, it, vi } from 'vitest';
import { FakeWebSocket } from '../../test/room.ts';
import { SignalingClient, type SignalingCloseReason } from './signalingClient.ts';

const URL_ = 'ws://localhost:4173/v1/signaling';
const ROOM_ID = 'A'.repeat(21) + 'Q';
const SECRET = 'B'.repeat(42) + 'E';

function setup() {
  const sockets: FakeWebSocket[] = [];
  const messages: ServerMessage[] = [];
  const closes: SignalingCloseReason[] = [];
  const createWebSocket = vi.fn((url: string) => {
    const socket = new FakeWebSocket(url);
    sockets.push(socket);
    return socket;
  });
  const client = new SignalingClient({
    url: URL_,
    createWebSocket,
    clock: () => 1234,
    onMessage: (message) => messages.push(message),
    onClose: (reason) => closes.push(reason),
  });
  const socket = () => {
    const current = sockets.at(-1);
    if (current === undefined) throw new Error('no socket');
    return current;
  };
  return { client, sockets, messages, closes, createWebSocket, socket };
}

async function opened() {
  const harness = setup();
  const opening = harness.client.open();
  harness.socket().open();
  await opening;
  return harness;
}

describe('SignalingClient', () => {
  it('opens nothing until asked, then exactly one socket to the given URL', async () => {
    const { client, createWebSocket, socket } = setup();
    expect(createWebSocket).not.toHaveBeenCalled();
    const opening = client.open();
    expect(client.open()).toBe(opening);
    expect(createWebSocket).toHaveBeenCalledExactlyOnceWith(URL_);
    expect(client.isOpen).toBe(false);
    socket().open();
    await opening;
    expect(client.isOpen).toBe(true);
  });

  it('numbers create, join, and leave with strictly increasing sequences across rooms', async () => {
    const { client, socket } = await opened();
    expect(client.send({ type: 'ROOM_CREATE', payload: {} })).toBe(true);
    expect(client.send({ type: 'ROOM_LEAVE', payload: {} })).toBe(true);
    expect(
      client.send({
        type: 'ROOM_JOIN',
        payload: { roomId: ROOM_ID, inviteSecret: SECRET },
      } as never),
    ).toBe(true);
    expect(client.send({ type: 'ROOM_LEAVE', payload: {} })).toBe(true);
    expect(
      socket().sent.map(({ type, sequence, sentAt }) => ({ type, sequence, sentAt })),
    ).toStrictEqual([
      { type: 'ROOM_CREATE', sequence: 0, sentAt: 1234 },
      { type: 'ROOM_LEAVE', sequence: 1, sentAt: 1234 },
      { type: 'ROOM_JOIN', sequence: 2, sentAt: 1234 },
      { type: 'ROOM_LEAVE', sequence: 3, sentAt: 1234 },
    ]);
  });

  it('refuses to send before opening or a message over the shared bound', async () => {
    const { client, socket } = setup();
    expect(client.send({ type: 'ROOM_CREATE', payload: {} })).toBe(false);
    const opening = client.open();
    expect(client.send({ type: 'ROOM_CREATE', payload: {} })).toBe(false);
    socket().open();
    await opening;
    const sdp = 'é'.repeat(MAX_SIGNALING_MESSAGE_BYTES / 2);
    expect(
      client.send({ type: 'RTC_OFFER', payload: { negotiationId: 'N'.repeat(24), sdp } } as never),
    ).toBe(false);
    expect(socket().sentText).toStrictEqual([]);
    // The refused message consumed no sequence number.
    client.send({ type: 'ROOM_CREATE', payload: {} });
    expect(socket().sent[0]?.sequence).toBe(0);
  });

  it('delivers only messages that pass the shared parser, in sequence', async () => {
    const { socket, messages } = await opened();
    socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    socket().deliver({ type: 'ROOM_CLOSED', payload: { reason: 'EXPIRED' } });
    expect(messages.map((message) => message.type)).toStrictEqual(['ROOM_LEFT', 'ROOM_CLOSED']);
  });

  it.each([
    ['malformed JSON', '{'],
    ['an unknown type', '{"protocolVersion":1,"type":"PLAY","sequence":0,"sentAt":0,"payload":{}}'],
    [
      'a client message type',
      '{"protocolVersion":1,"type":"ROOM_CREATE","sequence":0,"sentAt":0,"payload":{}}',
    ],
    [
      'an extra field',
      '{"protocolVersion":1,"type":"ROOM_LEFT","sequence":0,"sentAt":0,"payload":{},"x":1}',
    ],
    ['an oversized message', ' '.repeat(MAX_SIGNALING_MESSAGE_BYTES + 1)],
    ['binary data', new ArrayBuffer(4)],
  ])('fails closed on %s without delivering anything', async (_name, data) => {
    const { client, socket, messages, closes } = await opened();
    socket().deliverRaw(data);
    expect(messages).toStrictEqual([]);
    expect(closes).toStrictEqual(['protocol_error']);
    expect(socket().closeCalls).toStrictEqual([1002]);
    expect(client.isOpen).toBe(false);
    // Nothing after the failure reaches the owner.
    socket().deliver({ type: 'ROOM_LEFT', payload: {} });
    socket().drop();
    expect(messages).toStrictEqual([]);
    expect(closes).toStrictEqual(['protocol_error']);
  });

  it('fails closed on a repeated or lower server sequence', async () => {
    const { socket, messages, closes } = await opened();
    socket().deliverRaw(
      '{"protocolVersion":1,"type":"ROOM_LEFT","sequence":5,"sentAt":0,"payload":{}}',
    );
    socket().deliverRaw(
      '{"protocolVersion":1,"type":"ROOM_LEFT","sequence":5,"sentAt":0,"payload":{}}',
    );
    expect(messages).toHaveLength(1);
    expect(closes).toStrictEqual(['protocol_error']);
  });

  it('reports a dropped connection once and never reconnects', async () => {
    vi.useFakeTimers();
    try {
      const { client, socket, sockets, closes, createWebSocket } = await opened();
      socket().drop();
      expect(closes).toStrictEqual(['closed']);
      expect(client.isOpen).toBe(false);
      expect(client.send({ type: 'ROOM_CREATE', payload: {} })).toBe(false);
      await vi.advanceTimersByTimeAsync(60_000);
      expect(createWebSocket).toHaveBeenCalledOnce();
      expect(sockets).toHaveLength(1);
      // Opening again returns the finished attempt; it creates no new socket.
      await client.open();
      expect(createWebSocket).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it('rejects open when the socket cannot be opened, without a close callback', async () => {
    const { client, socket, closes } = setup();
    const opening = client.open();
    socket().drop();
    await expect(opening).rejects.toThrow();
    expect(closes).toStrictEqual([]);
  });

  it('rejects a pending open when closed, and detaches every handler', async () => {
    const { client, socket, closes, messages } = setup();
    const opening = client.open();
    client.close();
    await expect(opening).rejects.toThrow();
    const closed = socket();
    expect(closed.closeCalls).toStrictEqual([1000]);
    expect([closed.onopen, closed.onmessage, closed.onclose, closed.onerror]).toStrictEqual([
      null,
      null,
      null,
      null,
    ]);
    client.close();
    expect(closed.closeCalls).toHaveLength(1);
    expect(closes).toStrictEqual([]);
    expect(messages).toStrictEqual([]);
  });

  it('closes an open connection quietly on request', async () => {
    const { client, socket, closes } = await opened();
    client.close();
    expect(socket().closeCalls).toStrictEqual([1000]);
    expect(closes).toStrictEqual([]);
    expect(client.isOpen).toBe(false);
  });

  it('stores nothing in browser storage', async () => {
    const setItem = vi.spyOn(Storage.prototype, 'setItem');
    const { client, socket } = await opened();
    client.send({ type: 'ROOM_JOIN', payload: { roomId: ROOM_ID, inviteSecret: SECRET } } as never);
    socket().deliver({
      type: 'ROOM_CREATED',
      payload: {
        roomId: ROOM_ID as never,
        sessionId: 'Q'.repeat(27) as never,
        inviteSecret: SECRET as never,
        resumeSecret: 'R'.repeat(44) as never,
        participantId: 'C'.repeat(16) as never,
        role: 'host',
        expiresAt: 1,
      },
    });
    expect(setItem).not.toHaveBeenCalled();
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

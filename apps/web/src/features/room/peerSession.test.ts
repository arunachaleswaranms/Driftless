import {
  type ApplicationBody,
  MAX_ICE_CANDIDATES_PER_NEGOTIATION,
  PEER_CONTROL_CHANNEL_LABEL,
  type NegotiationId,
  type ParticipantId,
  type SessionId,
} from '@driftless/protocol';
import { describe, expect, it } from 'vitest';
import {
  FakeDataChannel,
  FakePeerConnection,
  flush,
  nativeCandidate,
  peerMessage,
  remoteCandidate,
} from '../../test/room.ts';
import {
  MAX_QUEUED_REMOTE_CANDIDATE_BYTES,
  PEER_APPLICATION_RATE_BURST,
  PEER_APPLICATION_RATE_PER_SECOND,
  PeerSession,
  type NegotiationBody,
  type PeerFailure,
  type PeerSessionState,
} from './peerSession.ts';

const NEGOTIATION = 'N'.repeat(24) as NegotiationId;
const OTHER_NEGOTIATION = 'M'.repeat(24) as NegotiationId;
const HOST_ID = 'H'.repeat(16) as ParticipantId;
const GUEST_ID = 'G'.repeat(16) as ParticipantId;
const STRANGER_ID = 'S'.repeat(16) as ParticipantId;
const SESSION_ID = 'Q'.repeat(27) as SessionId;
const OTHER_SESSION_ID = 'P'.repeat(26).concat('A') as SessionId;

function setup(
  role: 'host' | 'guest',
  options: {
    signal?: (body: NegotiationBody) => boolean;
    onApplicationMessage?: (body: ApplicationBody) => void;
    previousNegotiationId?: NegotiationId;
    configuration?: RTCConfiguration | (() => RTCConfiguration);
    clock?: () => number;
    negotiationId?: NegotiationId;
  } = {},
) {
  const connections: FakePeerConnection[] = [];
  const signals: NegotiationBody[] = [];
  const states: { state: PeerSessionState; failure: PeerFailure | undefined }[] = [];
  const session = new PeerSession({
    role,
    ...(options.onApplicationMessage ? { onApplicationMessage: options.onApplicationMessage } : {}),
    sessionId: SESSION_ID,
    negotiationId: options.negotiationId ?? NEGOTIATION,
    ...(options.previousNegotiationId === undefined
      ? {}
      : { previousNegotiationId: options.previousNegotiationId }),
    localParticipantId: role === 'host' ? HOST_ID : GUEST_ID,
    remoteParticipantId: role === 'host' ? GUEST_ID : HOST_ID,
    configuration: options.configuration ?? { iceServers: [{ urls: ['stun:stun.example.org'] }] },
    createPeerConnection: (configuration) => {
      const connection = new FakePeerConnection(configuration);
      connections.push(connection);
      return connection.asPeerConnection();
    },
    signal:
      options.signal ??
      ((body) => {
        signals.push(body);
        return true;
      }),
    clock: options.clock ?? (() => 7),
    onStateChange: (state, failure) => states.push({ state, failure }),
  });
  const connection = () => {
    const current = connections[0];
    if (current === undefined) throw new Error('no connection');
    return current;
  };
  return { session, connections, connection, signals, states };
}

/** A host session whose offer has been sent. */
async function offeredHost() {
  const harness = setup('host');
  void harness.session.start();
  await flush();
  await harness.connection().settle('createOffer');
  await harness.connection().settle('setLocalDescription');
  return harness;
}

/** A guest session that has answered. */
async function answeredGuest() {
  const harness = setup('guest');
  void harness.session.acceptOffer('v=0\r\nremote-offer\r\n');
  await flush();
  await harness.connection().settle('setRemoteDescription');
  await harness.connection().settle('createAnswer');
  await harness.connection().settle('setLocalDescription');
  return harness;
}

const hello = (
  sequence: number,
  payload = {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
    senderId: GUEST_ID,
    recipientId: HOST_ID,
  },
) => peerMessage('PEER_HELLO', payload, sequence);
const ready = (
  sequence: number,
  payload = {
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
    senderId: GUEST_ID,
    recipientId: HOST_ID,
  },
) => peerMessage('PEER_READY', payload, sequence);

describe('host negotiation', () => {
  it('creates exactly one ordered, reliable control channel and sends the offer', async () => {
    const { connection, connections, signals, session } = await offeredHost();
    expect(connections).toHaveLength(1);
    expect(connection().configuration).toStrictEqual({
      iceServers: [{ urls: ['stun:stun.example.org'] }],
    });
    expect(connection().channels.map((channel) => [channel.label, channel.init])).toStrictEqual([
      [PEER_CONTROL_CHANNEL_LABEL, { ordered: true }],
    ]);
    const [channel] = connection().channels;
    expect(channel?.maxRetransmits).toBeNull();
    expect(channel?.maxPacketLifeTime).toBeNull();
    expect(signals).toStrictEqual([
      { type: 'RTC_OFFER', payload: { negotiationId: NEGOTIATION, sdp: 'v=0\r\nfake-offer\r\n' } },
    ]);
    expect(session.state).toBe('negotiating');
    // No media of any kind.
    expect(connection().calls).not.toContain('addTrack');
    expect(connection().calls).not.toContain('addTransceiver');
  });

  it('applies the answer once, then moves to connecting', async () => {
    const { connection, session, states } = await offeredHost();
    void session.acceptAnswer('v=0\r\nanswer\r\n');
    void session.acceptAnswer('v=0\r\nsecond\r\n');
    await flush();
    await connection().settle('setRemoteDescription');
    expect(connection().remoteDescriptions).toStrictEqual([
      { type: 'answer', sdp: 'v=0\r\nanswer\r\n' },
    ]);
    expect(connection().hasPending('setRemoteDescription')).toBe(false);
    expect(states).toStrictEqual([{ state: 'connecting', failure: undefined }]);
  });

  it('ignores guest-only operations', async () => {
    const { session, connections } = setup('host');
    await session.acceptOffer('v=0\r\n');
    expect(connections).toHaveLength(0);
  });

  it('fails without retry when the offer cannot be created', async () => {
    const { session, connection, states, signals } = setup('host');
    void session.start();
    await flush();
    await connection().settle('createOffer', 'reject');
    expect(states).toStrictEqual([{ state: 'failed', failure: 'negotiation_failed' }]);
    expect(connection().closed).toBe(true);
    expect(connection().calls.filter((call) => call === 'createOffer')).toHaveLength(1);
    expect(signals).toStrictEqual([]);
  });
});

describe('guest negotiation', () => {
  it('applies the offer, sends the answer, and creates no channel of its own', async () => {
    const { connection, signals, states } = await answeredGuest();
    expect(connection().remoteDescriptions).toStrictEqual([
      { type: 'offer', sdp: 'v=0\r\nremote-offer\r\n' },
    ]);
    expect(connection().calls).not.toContain('createDataChannel');
    expect(signals).toStrictEqual([
      {
        type: 'RTC_ANSWER',
        payload: { negotiationId: NEGOTIATION, sdp: 'v=0\r\nfake-answer\r\n' },
      },
    ]);
    expect(states).toStrictEqual([{ state: 'connecting', failure: undefined }]);
  });

  it('accepts the expected control channel and binds it for binary-safe reads', async () => {
    const { connection, states } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    connection().announceChannel(channel);
    expect(channel.closed).toBe(false);
    expect(channel.binaryType).toBe('arraybuffer');
    expect(states.at(-1)?.state).toBe('connecting');
  });

  it.each([
    ['another label', new FakeDataChannel('driftless-media', { ordered: true })],
    ['an unordered channel', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: false })],
    ['partial reliability', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { maxRetransmits: 0 })],
    [
      'a lifetime limit',
      new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { maxPacketLifeTime: 100 }),
    ],
    ['a subprotocol', new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { protocol: 'x' })],
    [
      'a pre-negotiated channel',
      new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { negotiated: true, id: 0 }),
    ],
  ])('closes and fails on %s', async (_name, channel) => {
    const { connection, states } = await answeredGuest();
    connection().announceChannel(channel);
    expect(channel.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
    expect(connection().closed).toBe(true);
  });

  it('does not trust a second channel', async () => {
    const { connection, states } = await answeredGuest();
    const first = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    const second = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    connection().announceChannel(first);
    connection().announceChannel(second);
    expect(second.closed).toBe(true);
    expect(first.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
  });

  it('host rejects any channel the peer opens', async () => {
    const { connection, states } = await offeredHost();
    const intruder = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
    connection().announceChannel(intruder);
    expect(intruder.closed).toBe(true);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'unexpected_channel' });
  });

  it('fails when the offer cannot be applied', async () => {
    const { session, connection, states, signals } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    await connection().settle('setRemoteDescription', 'reject');
    expect(states).toStrictEqual([{ state: 'failed', failure: 'negotiation_failed' }]);
    expect(signals).toStrictEqual([]);
  });
});

describe('local ICE', () => {
  it('sends validated plain candidates after the description, then completion', async () => {
    const { session, connection, signals } = setup('host');
    void session.start();
    await flush();
    // Candidates gathered before the offer is sent are held, in order.
    connection().emitCandidate(nativeCandidate(1));
    await connection().settle('createOffer');
    connection().emitCandidate(nativeCandidate(2));
    connection().emitCandidate(null);
    expect(signals).toStrictEqual([]);
    await connection().settle('setLocalDescription');
    connection().emitCandidate(nativeCandidate(3));
    expect(signals.map((body) => body.type)).toStrictEqual([
      'RTC_OFFER',
      'ICE_CANDIDATE',
      'ICE_CANDIDATE',
      'ICE_COMPLETE',
    ]);
    expect(signals[1]).toStrictEqual({
      type: 'ICE_CANDIDATE',
      payload: { negotiationId: NEGOTIATION, candidate: nativeCandidate(1) },
    });
    // Nothing after completion is sent.
    expect(signals).toHaveLength(4);
  });

  it('serializes only the four browser fields, never the candidate object itself', async () => {
    const { connection, signals } = await offeredHost();
    connection().emitCandidate({
      ...nativeCandidate(1),
      address: '192.0.2.1',
      port: 1,
      toJSON: () => ({ leaked: true }),
    } as unknown as RTCIceCandidate);
    const body = signals.at(-1);
    if (body?.type !== 'ICE_CANDIDATE') throw new Error('expected a candidate');
    expect(Object.keys(body.payload.candidate)).toStrictEqual([
      'candidate',
      'sdpMid',
      'sdpMLineIndex',
      'usernameFragment',
    ]);
  });

  it('skips end-of-generation markers and out-of-bound candidates', async () => {
    const { connection, signals } = await offeredHost();
    connection().emitCandidate({ ...nativeCandidate(1), candidate: '' });
    connection().emitCandidate({ ...nativeCandidate(2), candidate: 'x'.repeat(2000) });
    connection().emitCandidate({ ...nativeCandidate(3), sdpMid: null, sdpMLineIndex: null });
    expect(signals.map((body) => body.type)).toStrictEqual(['RTC_OFFER']);
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION + 5; index += 1) {
      connection().emitCandidate(nativeCandidate(index));
    }
    expect(signals.filter((body) => body.type === 'ICE_CANDIDATE')).toHaveLength(
      MAX_ICE_CANDIDATES_PER_NEGOTIATION,
    );
  });

  it('fails when signaling cannot take a message', async () => {
    let accept = true;
    const { session, connection, states } = setup('host', { signal: () => accept });
    void session.start();
    await flush();
    await connection().settle('createOffer');
    await connection().settle('setLocalDescription');
    accept = false;
    connection().emitCandidate(nativeCandidate(1));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'signaling_unavailable' });
  });
});

describe('remote ICE', () => {
  it('holds candidates that arrive before the remote description, then applies them in order', async () => {
    const { session, connection } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    session.addRemoteCandidate(remoteCandidate(1));
    session.addRemoteCandidate(remoteCandidate(2));
    expect(connection().addedCandidates).toStrictEqual([]);
    await connection().settle('setRemoteDescription');
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1), remoteCandidate(2)]);
    session.addRemoteCandidate(remoteCandidate(3));
    expect(connection().addedCandidates.at(-1)).toStrictEqual(remoteCandidate(3));
  });

  it('host holds guest candidates until the answer is applied', async () => {
    const { session, connection } = await offeredHost();
    void session.acceptAnswer('v=0\r\n');
    session.addRemoteCandidate(remoteCandidate(1));
    await flush();
    expect(connection().addedCandidates).toStrictEqual([]);
    await connection().settle('setRemoteDescription');
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1)]);
  });

  it('bounds the hold by aggregate size', async () => {
    const { session, connection, states } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    const large = { ...remoteCandidate(1), candidate: `candidate:${'x'.repeat(1000)}` };
    const fits = Math.floor(MAX_QUEUED_REMOTE_CANDIDATE_BYTES / (large.candidate.length + 5));
    for (let index = 0; index < fits; index += 1) session.addRemoteCandidate(large);
    expect(states).toStrictEqual([]);
    session.addRemoteCandidate(large);
    expect(states).toStrictEqual([{ state: 'failed', failure: 'candidate_limit' }]);
    expect(connection().closed).toBe(true);
    // The hold was dropped: settling the description applies nothing.
    expect(connection().addedCandidates).toStrictEqual([]);
  });

  it('bounds the total number of remote candidates', async () => {
    const { session, connection, states } = await answeredGuest();
    for (let index = 0; index < MAX_ICE_CANDIDATES_PER_NEGOTIATION; index += 1) {
      session.addRemoteCandidate(remoteCandidate(index));
    }
    expect(connection().addedCandidates).toHaveLength(MAX_ICE_CANDIDATES_PER_NEGOTIATION);
    session.addRemoteCandidate(remoteCandidate(99));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'candidate_limit' });
  });

  it('refuses candidates after the peer completed gathering', async () => {
    const { session, connection, states } = await answeredGuest();
    session.addRemoteCandidate(remoteCandidate(1));
    session.remoteCandidatesComplete();
    expect(connection().calls.filter((call) => call === 'addIceCandidate')).toHaveLength(1);
    session.addRemoteCandidate(remoteCandidate(2));
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'candidate_limit' });
    expect(connection().addedCandidates).toStrictEqual([remoteCandidate(1)]);
  });

  it('tolerates a candidate the browser cannot use', async () => {
    const { session, connection, states } = await answeredGuest();
    connection().rejectNextCandidate = true;
    session.addRemoteCandidate(remoteCandidate(1));
    session.addRemoteCandidate(remoteCandidate(2));
    await flush();
    expect(connection().addedCandidates).toHaveLength(2);
    expect(states.at(-1)?.state).toBe('connecting');
  });
});

describe('control channel handshake', () => {
  async function hostWithOpenChannel() {
    const harness = await offeredHost();
    const channel = harness.connection().channels[0];
    if (channel === undefined) throw new Error('no channel');
    channel.open();
    return { ...harness, channel };
  }

  it('connects only after each side has received the other handshake message', async () => {
    const { channel, states, session, connection } = await hostWithOpenChannel();
    connection().setConnectionState('connected');
    // A connected peer connection and an open channel are not yet enough.
    expect(session.state).toBe('negotiating');
    expect(channel.sent.map((message) => message.type)).toStrictEqual(['PEER_HELLO']);
    expect(channel.sent[0]?.payload).toStrictEqual({
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: HOST_ID,
      recipientId: GUEST_ID,
    });
    channel.receive(hello(0));
    expect(channel.sent.map((message) => message.type)).toStrictEqual(['PEER_HELLO', 'PEER_READY']);
    expect(session.state).toBe('negotiating');
    channel.receive(ready(1));
    expect(session.state).toBe('connected');
    expect(states.at(-1)).toStrictEqual({ state: 'connected', failure: undefined });
    expect(channel.sent.map((message) => message.sequence)).toStrictEqual([0, 1]);
  });

  it('guest sends nothing until the host greets, then greets and connects symmetrically', async () => {
    const { connection, session } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    channel.readyState = 'open';
    connection().announceChannel(channel);
    channel.open();
    // An open channel alone does not make the guest send: the host's channel
    // may not have opened yet.
    expect(channel.sent).toStrictEqual([]);
    const fromHost = {
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: HOST_ID,
      recipientId: GUEST_ID,
    };
    channel.receive(peerMessage('PEER_HELLO', fromHost, 0));
    expect(channel.sent.map((message) => [message.type, message.sequence])).toStrictEqual([
      ['PEER_HELLO', 0],
      ['PEER_READY', 1],
    ]);
    expect(session.state).toBe('connecting');
    channel.receive(peerMessage('PEER_READY', fromHost, 1));
    expect(session.state).toBe('connected');
  });

  it('guest refuses a PEER_READY that arrives before any greeting', async () => {
    const { connection, states } = await answeredGuest();
    const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL, { ordered: true });
    connection().announceChannel(channel);
    channel.open();
    channel.receive(
      peerMessage(
        'PEER_READY',
        {
          sessionId: SESSION_ID,
          negotiationId: NEGOTIATION,
          senderId: HOST_ID,
          recipientId: GUEST_ID,
        },
        0,
      ),
    );
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
  });

  it.each([
    [
      'a wrong negotiation',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: OTHER_NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'another room session',
      hello(0, {
        sessionId: OTHER_SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'a wrong sender',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: STRANGER_ID,
        recipientId: HOST_ID,
      }),
    ],
    [
      'a wrong recipient',
      hello(0, {
        sessionId: SESSION_ID,
        negotiationId: NEGOTIATION,
        senderId: GUEST_ID,
        recipientId: STRANGER_ID,
      }),
    ],
    ['malformed JSON', '{'],
    [
      'an unknown message',
      '{"protocolVersion":1,"type":"PLAY","sequence":0,"sentAt":0,"payload":{}}',
    ],
    ['an oversized message', ' '.repeat(2000)],
    ['binary data', new ArrayBuffer(8)],
    [
      'a premature PEER_READY carrying the invite secret',
      `{"protocolVersion":1,"type":"PEER_READY","sequence":0,"sentAt":0,"payload":{"inviteSecret":"x"}}`,
    ],
  ])('fails on %s', async (_name, data) => {
    const { channel, states, connection } = await hostWithOpenChannel();
    channel.receive(data);
    expect(states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
    expect(channel.closed).toBe(true);
    expect(connection().closed).toBe(true);
  });

  it('fails on a repeated handshake or a replayed sequence', async () => {
    const first = await hostWithOpenChannel();
    first.channel.receive(hello(0));
    first.channel.receive(hello(1));
    expect(first.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });

    const second = await hostWithOpenChannel();
    second.channel.receive(hello(3));
    second.channel.receive(ready(3));
    expect(second.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });

    const third = await hostWithOpenChannel();
    third.channel.receive(hello(0));
    third.channel.receive(ready(1));
    third.channel.receive(ready(2));
    expect(third.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'peer_protocol' });
  });

  it('fails when the channel closes or the connection is lost, without retry', async () => {
    const closing = await hostWithOpenChannel();
    closing.channel.remoteClose();
    expect(closing.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'channel_closed' });

    const connected = await hostWithOpenChannel();
    connected.channel.receive(hello(0));
    connected.channel.receive(ready(1));
    connected.connection().setConnectionState('disconnected');
    expect(connected.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'connection_lost' });

    const failing = await offeredHost();
    failing.connection().setConnectionState('failed');
    expect(failing.states.at(-1)).toStrictEqual({ state: 'failed', failure: 'connection_failed' });
    // No second connection, offer, or ICE restart follows.
    await flush();
    expect(failing.connections).toHaveLength(1);
    expect(failing.connection().calls.filter((call) => call === 'createOffer')).toHaveLength(1);
  });
});

describe('cleanup and stale callbacks', () => {
  it('closes the channel and connection, detaches handlers, and reports nothing', async () => {
    const { session, connection, states, signals } = await offeredHost();
    const channel = connection().channels[0];
    session.addRemoteCandidate(remoteCandidate(1));
    session.close();
    session.close();
    expect(session.state).toBe('closed');
    expect(connection().closed).toBe(true);
    expect(channel?.closed).toBe(true);
    expect([
      connection().onicecandidate,
      connection().onconnectionstatechange,
      connection().ondatachannel,
      channel?.onopen,
      channel?.onmessage,
      channel?.onclose,
      channel?.onerror,
    ]).toStrictEqual([null, null, null, null, null, null, null]);
    expect(states).toStrictEqual([]);
    const sent = signals.length;
    // Late operations on a closed session do nothing.
    await session.acceptAnswer('v=0\r\n');
    session.addRemoteCandidate(remoteCandidate(2));
    session.remoteCandidatesComplete();
    expect(connection().addedCandidates).toStrictEqual([]);
    expect(signals).toHaveLength(sent);
  });

  it('ignores an async continuation that resolves after close', async () => {
    const { session, connection, signals, states } = setup('host');
    void session.start();
    await flush();
    await connection().settle('createOffer');
    session.close();
    await connection().settle('setLocalDescription');
    expect(signals).toStrictEqual([]);
    expect(states).toStrictEqual([]);
    expect(connection().hasPending('setLocalDescription')).toBe(false);
  });

  it('ignores a guest answer that completes after close', async () => {
    const { session, connection, signals } = setup('guest');
    void session.acceptOffer('v=0\r\n');
    await flush();
    await connection().settle('setRemoteDescription');
    await connection().settle('createAnswer');
    session.close();
    await connection().settle('setLocalDescription');
    expect(signals).toStrictEqual([]);
  });

  it('ignores events captured from a torn-down connection', async () => {
    const { session, connection, states, signals } = await offeredHost();
    const channel = connection().channels[0];
    const { onicecandidate, onconnectionstatechange } = connection();
    const channelMessage = channel?.onmessage;
    session.close();
    // Handlers that a browser had already queued run after teardown.
    onicecandidate?.call(
      connection() as unknown as RTCPeerConnection,
      {
        candidate: nativeCandidate(1),
      } as RTCPeerConnectionIceEvent,
    );
    onconnectionstatechange?.call(connection() as unknown as RTCPeerConnection, new Event('x'));
    channelMessage?.call(
      channel?.asChannel() as RTCDataChannel,
      new MessageEvent('message', { data: hello(0) }),
    );
    expect(states).toStrictEqual([]);
    expect(signals.map((body) => body.type)).toStrictEqual(['RTC_OFFER']);
  });

  it('reports a failure once', async () => {
    const { connection, states } = await offeredHost();
    const channel = connection().channels[0];
    const { onconnectionstatechange } = connection();
    connection().setConnectionState('failed');
    onconnectionstatechange?.call(connection() as unknown as RTCPeerConnection, new Event('x'));
    channel?.remoteClose();
    expect(states).toStrictEqual([{ state: 'failed', failure: 'connection_failed' }]);
  });
});

describe('recovery sessions and signaling loss', () => {
  it('sends a recovery offer naming the negotiation it replaces', async () => {
    const harness = setup('host', { previousNegotiationId: OTHER_NEGOTIATION });
    void harness.session.start();
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    expect(harness.signals[0]).toStrictEqual({
      type: 'RTC_RECOVER',
      payload: {
        previousNegotiationId: OTHER_NEGOTIATION,
        negotiationId: NEGOTIATION,
        sdp: 'v=0\r\nfake-offer\r\n',
      },
    });
    // A fresh connection and a fresh control channel.
    expect(harness.connections).toHaveLength(1);
    expect(harness.connection().channels.map((channel) => channel.label)).toStrictEqual([
      PEER_CONTROL_CHANNEL_LABEL,
    ]);
  });

  it('stays connected when signaling can no longer carry a late candidate', async () => {
    let signalingUp = true;
    const harness = setup('host', { signal: () => signalingUp });
    void harness.session.start();
    await flush();
    await harness.connection().settle('createOffer');
    await harness.connection().settle('setLocalDescription');
    const channel = harness.connection().channels[0];
    if (channel === undefined) throw new Error('no channel');
    channel.open();
    channel.receive(hello(0));
    channel.receive(ready(1));
    expect(harness.session.state).toBe('connected');
    signalingUp = false;
    harness.connection().emitCandidate(nativeCandidate(5));
    harness.connection().emitCandidate(null);
    expect(harness.session.state).toBe('connected');
    expect(harness.states.at(-1)).toStrictEqual({ state: 'connected', failure: undefined });
  });
});

describe('runtime configuration and diagnostics (Phase 2D)', () => {
  it('reads a configuration function once, when the connection is created', async () => {
    let calls = 0;
    const turn = { urls: ['turn:turn.example.org'], username: 'u', credential: 'c' };
    const { session, connection } = setup('host', {
      configuration: () => {
        calls += 1;
        return { iceServers: [turn] };
      },
    });
    expect(calls).toBe(0);
    void session.start();
    await flush();
    expect(calls).toBe(1);
    expect(connection().configuration).toStrictEqual({ iceServers: [turn] });
  });

  it('fails a relay-only session with no TURN server without creating a connection', async () => {
    for (const role of ['host', 'guest'] as const) {
      const harness = setup(role, {
        configuration: {
          iceServers: [{ urls: ['stun:stun.example.org'] }],
          iceTransportPolicy: 'relay',
        },
      });
      if (role === 'host') void harness.session.start();
      else void harness.session.acceptOffer('v=0\r\n');
      await flush();
      expect(harness.connections).toHaveLength(0);
      expect(harness.states).toStrictEqual([{ state: 'failed', failure: 'relay_unavailable' }]);
      expect(harness.signals).toStrictEqual([]);
    }
  });

  it('passes a relay-only policy through when a TURN server is configured', async () => {
    const configuration: RTCConfiguration = {
      iceServers: [{ urls: 'turns:turn.example.org:5349', username: 'u', credential: 'c' }],
      iceTransportPolicy: 'relay',
    };
    const { session, connection } = setup('host', { configuration });
    void session.start();
    await flush();
    expect(connection().configuration).toStrictEqual(configuration);
  });

  it('observes states without changing them, and only while live', async () => {
    const { session, connection } = await offeredHost();
    connection().iceConnectionState = 'checking';
    const before = [...connection().calls];
    expect(session.observe()).toStrictEqual({
      connectionState: 'new',
      iceConnectionState: 'checking',
      channelState: 'connecting',
    });
    expect(connection().calls).toStrictEqual(before);
    session.close();
    expect(session.observe()).toBeUndefined();
    expect(setup('host').session.observe()).toBeUndefined();
  });

  it('reads statistics without ever rejecting or failing the session', async () => {
    const { session, connection, states } = await offeredHost();
    const report = new Map([['a', { id: 'a', type: 'transport' }]]);
    connection().stats = report;
    await expect(session.getStats()).resolves.toBe(report);
    connection().stats = 'reject';
    await expect(session.getStats()).resolves.toBeUndefined();
    expect(states).toStrictEqual([]);
    expect(session.state).toBe('negotiating');
    expect(connection().closed).toBe(false);

    // A report that arrives after the session closed is not returned.
    connection().stats = 'pending';
    const late = session.getStats();
    session.close();
    await connection().resolveStats(report);
    await expect(late).resolves.toBeUndefined();
    await expect(session.getStats()).resolves.toBeUndefined();
  });
});

const appBody: ApplicationBody = {
  type: 'NOT_READY',
  payload: { localSelectionId: null, reason: 'NO_MEDIA' },
};
function incomingApp(
  sequence = 2,
  context: object = {},
  type = 'NOT_READY',
  payload: object = appBody.payload,
) {
  return JSON.stringify({
    protocolVersion: 1,
    type,
    sequence,
    sentAt: 0,
    payload: {
      ...payload,
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: GUEST_ID,
      recipientId: HOST_ID,
      ...context,
    },
  });
}
async function appHost(connected = true, options: Parameters<typeof setup>[1] = {}) {
  const received: ApplicationBody[] = [];
  const h = setup('host', { ...options, onApplicationMessage: (body) => received.push(body) });
  void h.session.start();
  await flush();
  await h.connection().settle('createOffer');
  await h.connection().settle('setLocalDescription');
  const channel = h.connection().channels[0];
  if (!channel) throw new Error('no channel');
  channel.open();
  if (connected) {
    const context = {
      sessionId: SESSION_ID,
      negotiationId: options.negotiationId ?? NEGOTIATION,
      senderId: GUEST_ID,
      recipientId: HOST_ID,
    };
    channel.receive(hello(0, context));
    channel.receive(ready(1, context));
  }
  return { ...h, channel, received };
}
describe('peer application boundary', () => {
  it('rejects application send and receive before the bidirectional handshake', async () => {
    const { session, channel, received, states } = await appHost(false);
    expect(session.sendApplicationMessage(appBody)).toBe(false);
    expect(channel.sent.map((m) => m.type)).toEqual(['PEER_HELLO']);
    channel.receive(incomingApp(0));
    expect(received).toEqual([]);
    expect(states.at(-1)).toEqual({ state: 'failed', failure: 'peer_protocol' });
  });
  it('one sequence spans handshake and applications; caller context cannot forge identities', async () => {
    const { session, channel, received } = await appHost();
    expect(
      session.sendApplicationMessage({
        ...appBody,
        payload: { ...appBody.payload, recipientId: STRANGER_ID },
      } as ApplicationBody),
    ).toBe(true);
    expect(channel.sent.map((m) => m.sequence)).toEqual([0, 1, 2]);
    expect(channel.sent.at(-1)?.payload).toEqual({
      ...appBody.payload,
      sessionId: SESSION_ID,
      negotiationId: NEGOTIATION,
      senderId: HOST_ID,
      recipientId: GUEST_ID,
    });
    channel.receive(incomingApp());
    expect(received).toEqual([appBody]);
    channel.receive(incomingApp(3));
    expect(received).toHaveLength(2);
  });
  it.each([
    ['session', { sessionId: OTHER_SESSION_ID }],
    ['negotiation', { negotiationId: OTHER_NEGOTIATION }],
    ['sender', { senderId: STRANGER_ID }],
    ['recipient', { recipientId: STRANGER_ID }],
  ])('fails closed on wrong application %s', async (_name, context) => {
    const { channel, states, received } = await appHost();
    channel.receive(incomingApp(2, context));
    expect(states.at(-1)).toEqual({ state: 'failed', failure: 'peer_protocol' });
    expect(received).toEqual([]);
  });
  it.each([1, 2])('rejects lower/duplicate application sequence %s', async (sequence) => {
    const { channel, states, received } = await appHost();
    channel.receive(incomingApp(2));
    channel.receive(incomingApp(sequence));
    expect(received).toHaveLength(1);
    expect(states.at(-1)?.failure).toBe('peer_protocol');
  });
  it.each([
    new ArrayBuffer(1),
    incomingApp(2, {}, 'PLAY'),
    incomingApp(2, {}, 'MEDIA_INFO', {}),
    'x'.repeat(1025),
  ])('refuses binary/unknown/malformed/oversized data after handshake', async (data) => {
    const { channel, states, received } = await appHost();
    channel.receive(data);
    expect(received).toEqual([]);
    expect(states.at(-1)?.failure).toBe('peer_protocol');
  });
  it('teardown detaches application callback and stale captured handlers do nothing', async () => {
    const { session, channel, received } = await appHost();
    const handler = channel.onmessage;
    session.close();
    expect(channel.onmessage).toBeNull();
    handler?.call(
      channel as unknown as RTCDataChannel,
      new MessageEvent('message', { data: incomingApp() }),
    );
    expect(received).toEqual([]);
    expect(session.sendApplicationMessage(appBody)).toBe(false);
  });
});

describe('inbound peer application rate bound', () => {
  const burst = PEER_APPLICATION_RATE_BURST;
  const rate = PEER_APPLICATION_RATE_PER_SECOND;
  function consumeBurst(channel: FakeDataChannel, context: object = {}) {
    for (let i = 0; i < burst; i++) channel.receive(incomingApp(i + 2, context));
  }

  it('accepts the exact burst at one instant with the full allowance after handshake', async () => {
    const { channel, received, session } = await appHost();
    consumeBurst(channel);
    expect(received).toHaveLength(burst);
    expect(session.state).toBe('connected');
  });

  it('first excess message fails once, tears down, and makes all captured handlers powerless', async () => {
    const { channel, connection, states, received, session } = await appHost();
    const pc = connection();
    const message = channel.onmessage;
    const closed = channel.onclose;
    const error = channel.onerror;
    const connectionChanged = pc.onconnectionstatechange;
    consumeBurst(channel);
    const sends = channel.sent.length;
    channel.receive(incomingApp(burst + 2));
    expect(received).toHaveLength(burst);
    expect(session.state).toBe('failed');
    expect(states.filter((s) => s.state === 'failed')).toEqual([
      { state: 'failed', failure: 'application_rate_limit' },
    ]);
    expect(channel.closed).toBe(true);
    expect(pc.closed).toBe(true);
    expect([
      channel.onopen,
      channel.onmessage,
      channel.onclose,
      channel.onerror,
      pc.onicecandidate,
      pc.onconnectionstatechange,
      pc.ondatachannel,
    ]).toEqual([null, null, null, null, null, null, null]);
    for (let i = 0; i < 3; i++) {
      message?.call(
        channel.asChannel(),
        new MessageEvent('message', {
          data: incomingApp(burst + 3 + i),
        }),
      );
      closed?.call(channel.asChannel(), new Event('close'));
      error?.call(channel.asChannel(), new Event('error') as RTCErrorEvent);
      connectionChanged?.call(
        pc.asPeerConnection() as RTCPeerConnection,
        new Event('connectionstatechange'),
      );
    }
    expect(received).toHaveLength(burst);
    expect(states.filter((s) => s.state === 'failed')).toHaveLength(1);
    expect(channel.sent).toHaveLength(sends);
    expect(session.sendApplicationMessage(appBody)).toBe(false);
  });

  it('refills exactly one second of messages, then refuses the next immediate message', async () => {
    let now = 1000;
    const { channel, received, states, session } = await appHost(true, { clock: () => now });
    consumeBurst(channel);
    now += 1000;
    for (let i = 0; i < rate; i++) channel.receive(incomingApp(burst + 2 + i));
    expect(received).toHaveLength(burst + rate);
    expect(session.state).toBe('connected');
    channel.receive(incomingApp(burst + rate + 2));
    expect(received).toHaveLength(burst + rate);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('retains fractional refill deterministically across arrivals', async () => {
    let now = 0;
    const { channel, received, session, states } = await appHost(true, { clock: () => now });
    consumeBurst(channel);
    now = 187.5; // 1.5 tokens; one admitted leaves 0.5.
    channel.receive(incomingApp(burst + 2));
    now += 62.5; // Another 0.5 token allows exactly one more.
    channel.receive(incomingApp(burst + 3));
    expect(received).toHaveLength(burst + 2);
    expect(session.state).toBe('connected');
    channel.receive(incomingApp(burst + 4));
    expect(received).toHaveLength(burst + 2);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('refuses admission below one full token', async () => {
    let now = 0;
    const { channel, received, states } = await appHost(true, { clock: () => now });
    consumeBurst(channel);
    now = 124; // 0.992 tokens.
    channel.receive(incomingApp(burst + 2));
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('clamps refill to the burst capacity after an hour idle', async () => {
    let now = 0;
    const { channel, received, states, session } = await appHost(true, { clock: () => now });
    consumeBurst(channel);
    now = 3_600_000;
    for (let i = 0; i < burst; i++) channel.receive(incomingApp(burst + 2 + i));
    expect(received).toHaveLength(2 * burst);
    expect(session.state).toBe('connected');
    channel.receive(incomingApp(2 * burst + 2));
    expect(received).toHaveLength(2 * burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('identical receiver timestamps never refill, regardless of peer sentAt', async () => {
    const { channel, received, states } = await appHost(true, { clock: () => 1000 });
    consumeBurst(channel);
    channel.receive(incomingApp(burst + 2).replace('"sentAt":0', '"sentAt":9007199254740991'));
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('a backwards clock grants no refill and does not throw', async () => {
    let now = 1000;
    const { channel, received, states } = await appHost(true, { clock: () => now });
    consumeBurst(channel);
    now = 0;
    expect(() => {
      channel.receive(incomingApp(burst + 2));
    }).not.toThrow();
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it('clock catch-up does not count a previously observed interval twice', async () => {
    let now = 1000;
    const { channel, received, states, session } = await appHost(true, { clock: () => now });
    for (let i = 0; i < burst - 1; i++) channel.receive(incomingApp(i + 2));
    now = 0;
    channel.receive(incomingApp(burst + 1));
    expect(session.state).toBe('connected');
    now = 1000;
    channel.receive(incomingApp(burst + 2));
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  const pair = {
    localSelectionId: 'A'.repeat(22),
    remoteSelectionId: 'B'.repeat(21) + 'A',
  };
  it.each([
    [
      'MEDIA_INFO',
      {
        selectionId: pair.localSelectionId,
        fingerprintVersion: 1,
        fingerprint: 'A'.repeat(43),
        byteLength: 1,
      },
    ],
    ['MEDIA_MATCH', { ...pair, fingerprint: 'A'.repeat(43) }],
    ['MEDIA_MISMATCH', { ...pair, reason: 'IDENTITY_MISMATCH' }],
    ['READY', { ...pair, fingerprint: 'A'.repeat(43) }],
    ['NOT_READY', appBody.payload],
  ])('counts valid %s against the same application bucket', async (type, payload) => {
    const { channel, received, states } = await appHost();
    consumeBurst(channel);
    channel.receive(incomingApp(burst + 2, {}, type, payload));
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('application_rate_limit');
  });

  it.each([
    ['binary', new ArrayBuffer(1)],
    ['unknown', incomingApp(burst + 2, {}, 'PLAY')],
    ['malformed JSON', '{'],
    ['invalid payload', incomingApp(burst + 2, {}, 'MEDIA_INFO', {})],
    ['oversized', 'x'.repeat(1025)],
    ['version', incomingApp(burst + 2).replace('"protocolVersion":1', '"protocolVersion":2')],
    ['session', incomingApp(burst + 2, { sessionId: OTHER_SESSION_ID })],
    ['negotiation', incomingApp(burst + 2, { negotiationId: OTHER_NEGOTIATION })],
    ['sender', incomingApp(burst + 2, { senderId: STRANGER_ID })],
    ['recipient', incomingApp(burst + 2, { recipientId: STRANGER_ID })],
    ['duplicate sequence', incomingApp(burst + 1)],
    ['lower sequence', incomingApp(1)],
    ['repeated handshake', ready(burst + 2)],
  ])('keeps %s as peer_protocol even with no application tokens left', async (_name, data) => {
    const { channel, received, states } = await appHost();
    consumeBurst(channel);
    channel.receive(data);
    expect(received).toHaveLength(burst);
    expect(states.at(-1)?.failure).toBe('peer_protocol');
  });

  it('a fresh PeerSession and negotiation starts with a full allowance after failure', async () => {
    const old = await appHost();
    consumeBurst(old.channel);
    old.channel.receive(incomingApp(burst + 2));
    expect(old.session.state).toBe('failed');
    const fresh = await appHost(true, { negotiationId: OTHER_NEGOTIATION });
    expect(fresh.connection()).not.toBe(old.connection());
    expect(fresh.channel).not.toBe(old.channel);
    consumeBurst(fresh.channel, { negotiationId: OTHER_NEGOTIATION });
    expect(fresh.received).toHaveLength(burst);
    expect(fresh.session.state).toBe('connected');
    fresh.channel.receive(incomingApp(burst + 2, { negotiationId: OTHER_NEGOTIATION }));
    expect(fresh.received).toHaveLength(burst);
    expect(fresh.states.at(-1)?.failure).toBe('application_rate_limit');
  });
});

async function appGuest(options: Parameters<typeof setup>[1] = {}) {
  const received: ApplicationBody[] = [];
  const h = setup('guest', { ...options, onApplicationMessage: (body) => received.push(body) });
  void h.session.acceptOffer('v=0\r\nremote-offer\r\n');
  await flush();
  await h.connection().settle('setRemoteDescription');
  await h.connection().settle('createAnswer');
  await h.connection().settle('setLocalDescription');
  const channel = new FakeDataChannel(PEER_CONTROL_CHANNEL_LABEL);
  h.connection().announceChannel(channel);
  channel.open();
  const context = {
    senderId: HOST_ID,
    recipientId: GUEST_ID,
    sessionId: SESSION_ID,
    negotiationId: NEGOTIATION,
  };
  channel.receive(hello(0, context));
  channel.receive(ready(1, context));
  return { ...h, channel, received, context };
}
const playbackPayload = {
  localSelectionId: 'A'.repeat(22),
  remoteSelectionId: 'B'.repeat(21) + 'A',
  revision: 1,
  positionMs: 2500,
};
describe('host-only playback transport boundary', () => {
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'host sends %s with injected context and shared sequence',
    async (type) => {
      const h = await appHost();
      h.session.sendApplicationMessage(appBody);
      expect(
        h.session.sendApplicationMessage({ type, payload: playbackPayload } as ApplicationBody),
      ).toBe(true);
      expect(h.channel.sent.at(-1)).toMatchObject({
        type,
        sequence: 3,
        payload: {
          ...playbackPayload,
          sessionId: SESSION_ID,
          negotiationId: NEGOTIATION,
          senderId: HOST_ID,
          recipientId: GUEST_ID,
        },
      });
    },
  );
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'guest outbound %s refused without send',
    async (type) => {
      const h = await appGuest();
      const before = h.channel.sent.length;
      expect(
        h.session.sendApplicationMessage({ type, payload: playbackPayload } as ApplicationBody),
      ).toBe(false);
      expect(h.channel.sent.length).toBe(before);
    },
  );
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'guest receives host %s with context projected out; stale handler powerless',
    async (type) => {
      const h = await appGuest();
      h.channel.receive(incomingApp(2, h.context, type, playbackPayload));
      expect(h.received).toEqual([{ type, payload: playbackPayload }]);
      const handler = h.channel.onmessage;
      h.session.close();
      handler?.call(
        h.channel.asChannel(),
        new MessageEvent('message', { data: incomingApp(3, h.context, type, playbackPayload) }),
      );
      expect(h.received).toHaveLength(1);
    },
  );
  it.each(['PLAY', 'PAUSE', 'SEEK'] as const)(
    'host rejects guest %s before application dispatch',
    async (type) => {
      const h = await appHost();
      h.channel.receive(incomingApp(2, {}, type, playbackPayload));
      expect(h.received).toEqual([]);
      expect(h.states.at(-1)?.failure).toBe('peer_protocol');
    },
  );
  it('all eight applications share one bucket, handshake excluded', async () => {
    const h = await appGuest({ clock: () => 0 });
    const bodies = [
      [
        'MEDIA_INFO',
        {
          selectionId: playbackPayload.localSelectionId,
          fingerprintVersion: 1,
          fingerprint: 'A'.repeat(43),
          byteLength: 1,
        },
      ],
      [
        'MEDIA_MATCH',
        {
          localSelectionId: playbackPayload.localSelectionId,
          remoteSelectionId: playbackPayload.remoteSelectionId,
          fingerprint: 'A'.repeat(43),
        },
      ],
      [
        'MEDIA_MISMATCH',
        {
          localSelectionId: playbackPayload.localSelectionId,
          remoteSelectionId: playbackPayload.remoteSelectionId,
          reason: 'IDENTITY_MISMATCH',
        },
      ],
      [
        'READY',
        {
          localSelectionId: playbackPayload.localSelectionId,
          remoteSelectionId: playbackPayload.remoteSelectionId,
          fingerprint: 'A'.repeat(43),
        },
      ],
      ['NOT_READY', appBody.payload],
      ['PLAY', playbackPayload],
      ['PAUSE', playbackPayload],
      ['SEEK', playbackPayload],
    ] as const;
    for (let i = 0; i < 32; i++) {
      const body = bodies[i % 8];
      if (body) h.channel.receive(incomingApp(i + 2, h.context, body[0], body[1]));
    }
    expect(h.received).toHaveLength(32);
    expect(h.session.state).toBe('connected');
    h.channel.receive(incomingApp(34, h.context, 'PLAY', playbackPayload));
    expect(h.states.at(-1)?.failure).toBe('application_rate_limit');
  });
  it.each(['PLAY', 'PAUSE', 'SEEK'])(
    '%s consumes the existing bucket at exhaustion',
    async (type) => {
      const h = await appGuest({ clock: () => 0 });
      for (let i = 0; i < 32; i++) h.channel.receive(incomingApp(i + 2, h.context));
      h.channel.receive(incomingApp(34, h.context, type, playbackPayload));
      expect(h.states.at(-1)?.failure).toBe('application_rate_limit');
    },
  );
  it('malformed playback remains peer_protocol', async () => {
    const h = await appGuest();
    h.channel.receive(incomingApp(2, h.context, 'PLAY', { ...playbackPayload, revision: 0 }));
    expect(h.states.at(-1)?.failure).toBe('peer_protocol');
    expect(h.received).toEqual([]);
  });
});

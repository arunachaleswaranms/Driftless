import test from "node:test";
import assert from "node:assert/strict";
import { LabPeer } from "./peer.mjs";

test("receiver answers one offer and binds one data channel", async () => {
  const oldPeer = globalThis.RTCPeerConnection;
  const oldSignal = globalThis.BroadcastChannel;
  let answers = 0;
  class FakeChannel extends EventTarget {
    constructor() { super(); this.closed = false; }
    close() { this.closed = true; }
  }
  class FakePeer {
    constructor() { this.signalingState = "stable"; }
    async setRemoteDescription(description) { this.remoteDescription = description; }
    async createAnswer() { answers++; return { type: "answer", sdp: "answer" }; }
    async setLocalDescription(description) { this.localDescription = description; }
    close() { this.signalingState = "closed"; }
  }
  class FakeSignal {
    postMessage() {}
    close() {}
  }
  globalThis.RTCPeerConnection = FakePeer;
  globalThis.BroadcastChannel = FakeSignal;
  try {
    const opened = [];
    const errors = [];
    const peer = new LabPeer({ role: "receiver", room: "test", onChannel: (channel) => opened.push(channel), onError: (error) => errors.push(error) });
    const offer = { from: "host", kind: "description", description: { type: "offer", sdp: "offer" } };
    peer.signal.onmessage({ data: offer });
    peer.signal.onmessage({ data: offer });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(answers, 1);
    assert.deepEqual(errors, []);

    const channel = new FakeChannel();
    peer.pc.ondatachannel({ channel });
    peer.pc.ondatachannel({ channel });
    channel.dispatchEvent(new Event("open"));
    assert.deepEqual(opened, [channel]);
    const unexpected = new FakeChannel();
    peer.pc.ondatachannel({ channel: unexpected });
    assert.equal(unexpected.closed, true);
    peer.close();
  } finally {
    globalThis.RTCPeerConnection = oldPeer;
    globalThis.BroadcastChannel = oldSignal;
  }
});

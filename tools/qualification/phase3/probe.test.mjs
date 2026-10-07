import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { installProbe } from './probe.mjs';
class Events {
  handlers = new Map();
  addEventListener(type, fn) {
    const list = this.handlers.get(type) ?? [];
    list.push(fn);
    this.handlers.set(type, list);
  }
  emit(type, event = {}) {
    for (const fn of this.handlers.get(type) ?? []) fn(event);
  }
}
test('external channel gauge tolerates repeated open/close events and already-open guest channel', () => {
  class Channel extends Events {
    readyState = 'connecting';
    send() {}
  }
  class PC extends Events {
    createDataChannel() {
      return new Channel();
    }
  }
  class WS {
    send() {}
  }
  const win = {};
  runInNewContext(`(${installProbe.toString()})()`, {
    window: win,
    addEventListener() {},
    document: new Events(),
    URL: { createObjectURL() {}, revokeObjectURL() {} },
    RTCPeerConnection: PC,
    RTCDataChannel: Channel,
    WebSocket: WS,
  });
  const pc = new win.RTCPeerConnection();
  const h = pc.createDataChannel();
  h.readyState = 'open';
  h.emit('open');
  h.emit('open');
  assert.equal(win.__phase3Qualification.liveChannels, 1);
  const g = new Channel();
  g.readyState = 'open';
  pc.emit('datachannel', { channel: g });
  g.emit('open');
  assert.equal(win.__phase3Qualification.liveChannels, 2);
  assert.equal(win.__phase3Qualification.channels, 2);
  for (const c of [h, g]) {
    c.readyState = 'closed';
    c.emit('close');
    c.emit('close');
  }
  assert.equal(win.__phase3Qualification.liveChannels, 0);
});

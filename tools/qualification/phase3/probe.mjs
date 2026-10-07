// Installed by external automation only. Fixed-size counters, no wire history,
// secrets, filenames, SDP, addresses or candidate strings retained.
export function installProbe() {
  const p = {
    heartbeats: 0,
    observations: 0,
    authority: 0,
    readySends: 0,
    notReadySends: 0,
    binary: 0,
    invalidControl: 0,
    privateMetadata: 0,
    maxControlBytes: 0,
    signalingPlayback: 0,
    pcs: 0,
    channels: 0,
    liveChannels: 0,
    urlsCreated: 0,
    urlsRevoked: 0,
    seeks: 0,
    unhandled: 0,
    mediaErrors: 0,
    lastHeartbeat: null,
  };
  window.__phase3Qualification = p;
  addEventListener('unhandledrejection', () => p.unhandled++);
  document.addEventListener(
    'error',
    (e) => {
      if (e.target instanceof HTMLMediaElement) p.mediaErrors++;
    },
    true,
  );
  document.addEventListener('seeked', () => p.seeks++, true);
  const create = URL.createObjectURL.bind(URL),
    revoke = URL.revokeObjectURL.bind(URL);
  URL.createObjectURL = (blob) => {
    p.urlsCreated++;
    return create(blob);
  };
  URL.revokeObjectURL = (url) => {
    p.urlsRevoked++;
    return revoke(url);
  };
  const track = (ch) => {
    p.channels++;
    let countedOpen = false;
    const update = () => {
      const isOpen = ch.readyState === 'open';
      if (isOpen !== countedOpen) p.liveChannels += isOpen ? 1 : -1;
      countedOpen = isOpen;
    };
    ch.addEventListener('open', update);
    ch.addEventListener('close', update);
    update();
  };
  const Original = RTCPeerConnection;
  window.RTCPeerConnection = class extends Original {
    constructor(...args) {
      super(...args);
      p.pcs++;
      this.addEventListener('datachannel', (e) => track(e.channel));
    }
    createDataChannel(...args) {
      const ch = super.createDataChannel(...args);
      track(ch);
      return ch;
    }
  };
  const send = RTCDataChannel.prototype.send;
  RTCDataChannel.prototype.send = function (data) {
    if (typeof data !== 'string') p.binary++;
    else {
      const bytes = new TextEncoder().encode(data).length;
      p.maxControlBytes = Math.max(p.maxControlBytes, bytes);
      try {
        const m = JSON.parse(data);
        if (bytes > 1024) p.invalidControl++;
        if (/filename|blob:|contentRoot|chunkDigest|video\/mp4|localPath/.test(data))
          p.privateMetadata++;
        if (['PLAY', 'PAUSE', 'SEEK'].includes(m.type)) p.authority++;
        if (m.type === 'READY') p.readySends++;
        if (m.type === 'NOT_READY') p.notReadySends++;
        if (m.type === 'SYNC' && m.payload.phase === 'HEARTBEAT') {
          p.heartbeats++;
          const s = m.payload;
          p.lastHeartbeat = {
            syncSequence: s.syncSequence,
            revision: s.revision,
            mode: s.mode,
            clockOffsetMs: s.clockOffsetMs,
            roundTripMs: s.roundTripMs,
          };
        }
        if (m.type === 'SYNC' && m.payload.phase === 'OBSERVATION') p.observations++;
      } catch {
        p.invalidControl++;
      }
    }
    return Reflect.apply(send, this, [data]);
  };
  const wsSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function (data) {
    if (typeof data === 'string')
      try {
        if (['PLAY', 'PAUSE', 'SEEK', 'SYNC'].includes(JSON.parse(data).type))
          p.signalingPlayback++;
      } catch {}
    return Reflect.apply(wsSend, this, [data]);
  };
}

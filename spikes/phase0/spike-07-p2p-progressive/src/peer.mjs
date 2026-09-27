// EXPERIMENT ONLY: same-origin BroadcastChannel signaling, with exactly two roles.
import { chooseSelectedPair } from "../../spike-02-webrtc-connectivity/src/diagnostics.mjs";

export class LabPeer {
  constructor({ role, room, onChannel, onState, onError }) {
    if (!["host", "receiver"].includes(role) || !/^[a-z0-9-]{1,32}$/i.test(room)) throw new RangeError("role or room");
    Object.assign(this, { role, room, onChannel, onState, onError });
    this.closed = false;
    this.pending = [];
    this.pc = new RTCPeerConnection({ iceServers: [] });
    this.signal = new BroadcastChannel(`driftless-spike07-${room}`);
    this.signal.onmessage = (e) => { this.#handle(e.data).catch(onError); };
    this.pc.onicecandidate = (e) => { if (e.candidate) this.#send({ kind: "candidate", candidate: e.candidate.toJSON() }); };
    this.pc.onconnectionstatechange = () => onState?.(this.pc.connectionState);
    if (role === "receiver") this.pc.ondatachannel = (e) => this.#setChannel(e.channel);
    if (role === "host") {
      this.#setChannel(this.pc.createDataChannel("media", { ordered: true }));
      this.announce = setInterval(() => this.#send({ kind: "hello" }), 300);
      this.#send({ kind: "hello" });
    }
  }
  #send(value) { if (!this.closed) this.signal.postMessage({ ...value, from: this.role }); }
  #setChannel(channel) {
    if (this.channel) {
      if (this.channel !== channel) channel.close();
      return;
    }
    this.channel = channel;
    channel.binaryType = "arraybuffer";
    channel.addEventListener("open", () => this.onChannel?.(channel));
  }
  async #handle(message) {
    if (this.closed || !message || message.from === this.role) return;
    if (message.kind === "hello" && this.role === "receiver") { this.#send({ kind: "ready" }); return; }
    if (message.kind === "ready" && this.role === "host" && !this.offered) {
      this.offered = true;
      clearInterval(this.announce);
      await this.pc.setLocalDescription(await this.pc.createOffer());
      this.#send({ kind: "description", description: { type: "offer", sdp: this.pc.localDescription.sdp } });
      return;
    }
    if (message.kind === "description") {
      if (message.description?.type === "offer" && this.role === "receiver" && !this.answered) {
        this.answered = true;
        await this.pc.setRemoteDescription(message.description);
        await this.#flush();
        await this.pc.setLocalDescription(await this.pc.createAnswer());
        this.#send({ kind: "description", description: { type: "answer", sdp: this.pc.localDescription.sdp } });
      } else if (message.description?.type === "answer" && this.role === "host") {
        await this.pc.setRemoteDescription(message.description);
        await this.#flush();
      }
      return;
    }
    if (message.kind === "candidate" && message.candidate) {
      if (this.pc.remoteDescription) await this.pc.addIceCandidate(message.candidate);
      else this.pending.push(message.candidate);
    }
  }
  async #flush() { while (this.pending.length) await this.pc.addIceCandidate(this.pending.shift()); }
  async selectedPair() {
    if (this.closed) return null;
    const p = chooseSelectedPair(await this.pc.getStats());
    return p ? { local: p.local?.candidateType, remote: p.remote?.candidateType, protocol: p.local?.protocol, rttSeconds: p.pair.currentRoundTripTime } : null;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.announce);
    this.signal.close();
    this.channel?.close();
    this.pc.close();
    this.pending.length = 0;
  }
}

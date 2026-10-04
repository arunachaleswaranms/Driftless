import { parseIceTransportPolicy, parseStunUrls } from './iceServers.ts';
import { createNegotiationId } from './negotiationId.ts';
import { browserTimers } from './reconnectSchedule.ts';
import { createResumeProver } from './resumeProof.ts';
import { RoomController } from './roomController.ts';
import { signalingUrlFor } from './signalingUrl.ts';

/**
 * The room controller wired to this page's browser APIs. It is created when
 * the room panel mounts, never at import, and opens nothing until the user
 * creates or joins a room.
 */
export function createBrowserRoomController(): RoomController {
  return new RoomController({
    signalingUrl: signalingUrlFor(window.location),
    iceServers: parseStunUrls(import.meta.env.VITE_RTC_STUN_URLS),
    iceTransportPolicy: parseIceTransportPolicy(import.meta.env.VITE_RTC_ICE_TRANSPORT_POLICY),
    // TURN servers and short-lived credentials come from the service after
    // admission; nothing secret is built into this bundle.
    rtcConfigSource: 'service',
    createWebSocket: (url) => new WebSocket(url),
    createPeerConnection: (configuration) => new RTCPeerConnection(configuration),
    createNegotiationId: () => createNegotiationId(),
    // Rooms require a secure context (https, or loopback in development),
    // where Web Crypto is available.
    proveResume: createResumeProver(crypto.subtle),
    clock: () => Date.now(),
    timers: browserTimers,
  });
}

import { parseStunUrls } from './iceServers.ts';
import { createNegotiationId } from './negotiationId.ts';
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
    createWebSocket: (url) => new WebSocket(url),
    createPeerConnection: (configuration) => new RTCPeerConnection(configuration),
    createNegotiationId: () => createNegotiationId(),
    clock: () => Date.now(),
  });
}

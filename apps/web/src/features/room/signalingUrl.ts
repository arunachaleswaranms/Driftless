/** The signaling service's versioned WebSocket endpoint, on the page's own origin. */
export const SIGNALING_PATH = '/v1/signaling';

/** Host names for which plain `ws://` is allowed: loopback development only. */
const LOOPBACK_HOSTNAMES: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

export type SignalingUrlResult =
  | { readonly ok: true; readonly url: string }
  /** The page is not on https and not on loopback, so WSS cannot be guaranteed. */
  | { readonly ok: false; readonly reason: 'insecure_origin' };

/**
 * Derives the signaling WebSocket URL from the page's own origin: `https`
 * pages use `wss`, and plain `ws` is accepted only for a loopback development
 * origin. The URL carries no room ID, invite secret, or query of any kind;
 * room credentials travel only inside validated messages. Deployments and the
 * development and preview servers route this same-origin path to the
 * signaling service, so the Content Security Policy needs no other origin.
 */
export function signalingUrlFor(
  location: Pick<Location, 'protocol' | 'host' | 'hostname'>,
): SignalingUrlResult {
  if (location.protocol === 'https:') {
    return { ok: true, url: `wss://${location.host}${SIGNALING_PATH}` };
  }
  if (location.protocol === 'http:' && LOOPBACK_HOSTNAMES.has(location.hostname)) {
    return { ok: true, url: `ws://${location.host}${SIGNALING_PATH}` };
  }
  return { ok: false, reason: 'insecure_origin' };
}

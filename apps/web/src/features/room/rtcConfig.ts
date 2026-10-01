import { MAX_RTC_CONFIG_TTL_MS, type RtcConfigMessage } from '@driftless/protocol';

/**
 * How long the browser waits for the service's ICE configuration before it
 * starts a peer connection without it (STUN from the build only, no TURN).
 * Provisional.
 */
export const RTC_CONFIG_WAIT_MS = 3000;

/**
 * A configuration closer than this to its expiry is fetched again before a
 * new peer connection uses it, so a TURN credential is never handed to the
 * browser's ICE agent just before it stops working. Provisional.
 */
export const RTC_CONFIG_REFRESH_MARGIN_MS = 60_000;

/**
 * The service's ICE configuration as this browser holds it: in memory only,
 * for peer connections created before `expiresAt` on this browser's clock.
 * The TURN credential it may contain is never rendered, logged, exported,
 * or persisted.
 */
export interface RuntimeIceConfig {
  readonly iceServers: readonly RTCIceServer[];
  /** Whether the service included a TURN server. */
  readonly turn: boolean;
  /** Local clock, milliseconds since the Unix epoch. */
  readonly expiresAt: number;
}

/**
 * Accepts a parsed `RTC_CONFIG`. The shared parser has already bounded and
 * validated its shape, URLs, schemes, and credential text; this adds the
 * lifetime check. The lifetime is `expiresAt - sentAt`, both on the service's
 * clock, so a skewed browser clock does not stretch or shorten it; it must be
 * positive and at most MAX_RTC_CONFIG_TTL_MS. Returns undefined for an
 * unusable configuration.
 */
export function acceptRtcConfig(
  message: RtcConfigMessage,
  receivedAt: number,
): RuntimeIceConfig | undefined {
  const ttl = message.payload.expiresAt - message.sentAt;
  if (!Number.isSafeInteger(ttl) || ttl <= 0 || ttl > MAX_RTC_CONFIG_TTL_MS) return undefined;
  let turn = false;
  const iceServers = message.payload.iceServers.map((server): RTCIceServer => {
    if (server.username === null || server.credential === null) return { urls: [...server.urls] };
    turn = true;
    return { urls: [...server.urls], username: server.username, credential: server.credential };
  });
  return { iceServers, turn, expiresAt: receivedAt + ttl };
}

/** Whether a peer connection configuration names any TURN server. */
export function offersTurn(configuration: RTCConfiguration): boolean {
  return (configuration.iceServers ?? []).some((server) => {
    const urls = typeof server.urls === 'string' ? [server.urls] : server.urls;
    return urls.some((url) => url.startsWith('turn:') || url.startsWith('turns:'));
  });
}

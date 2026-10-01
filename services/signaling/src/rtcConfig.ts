import { createHmac } from 'node:crypto';
import type { ParticipantId, RtcIceServer } from '@driftless/protocol';

/**
 * The ICE servers the service hands to admitted room members (Phase 2D), and
 * the secret TURN credentials are derived from. It comes from the service's
 * own environment; nothing here is ever sent to a browser except the derived,
 * short-lived credentials.
 */
export interface RtcConfigPolicy {
  /** `stun:` or `stuns:` URLs, at most four. */
  readonly stunUrls: readonly string[];
  /** TURN, if configured. */
  readonly turn: TurnPolicy | undefined;
  /** How long one issued configuration, and its TURN credential, may be used. */
  readonly ttlMs: number;
}

export interface TurnPolicy {
  /** `turn:` or `turns:` URLs, at most four. */
  readonly urls: readonly string[];
  /**
   * The TURN server's shared secret (coturn `static-auth-secret`). It never
   * leaves the service: it is not logged, sent, or included in any error.
   */
  readonly secret: string;
}

/** One configuration as sent in `RTC_CONFIG`, and whether it includes TURN. */
export interface IssuedRtcConfig {
  /** Service clock, milliseconds since the Unix epoch. */
  readonly expiresAt: number;
  readonly iceServers: readonly RtcIceServer[];
  readonly turn: boolean;
}

/** Domain separator of the per-participant TURN user label. */
export const TURN_USER_LABEL_DOMAIN = 'driftless-turn-user-v1';

/** Bytes of the per-participant TURN user label, before base64url. */
export const TURN_USER_LABEL_BYTES = 12;

/**
 * Issues ICE server configurations using the time-limited TURN credential
 * mechanism of draft-uberti-behave-turn-rest ("TURN REST API"), which coturn
 * implements as `use-auth-secret` and other TURN servers implement too:
 *
 *   username   = "<expiry, Unix seconds>:<user label>"
 *   credential = base64(HMAC-SHA1(shared secret, username))
 *
 * The TURN server recomputes the credential from the username and its copy
 * of the secret, and refuses a username whose expiry has passed. No state is
 * shared between the two services, and the browser never learns the secret.
 *
 * The user label is a pseudonym of the participant ID, keyed by the secret,
 * so the TURN server's logs and per-user quotas see one stable name per room
 * membership without learning the participant ID. A credential is valid for
 * the configured lifetime, and never beyond the room's own expiry.
 */
export class RtcConfigIssuer {
  readonly #policy: RtcConfigPolicy;

  constructor(policy: RtcConfigPolicy) {
    this.#policy = policy;
  }

  /** Whether issued configurations include TURN. */
  get turnConfigured(): boolean {
    return this.#policy.turn !== undefined;
  }

  issue(participantId: ParticipantId, now: number, roomExpiresAt: number): IssuedRtcConfig {
    const iceServers: RtcIceServer[] = [];
    if (this.#policy.stunUrls.length > 0) {
      iceServers.push({ urls: [...this.#policy.stunUrls], username: null, credential: null });
    }
    const notAfter = Math.min(now + this.#policy.ttlMs, roomExpiresAt);
    const { turn } = this.#policy;
    if (turn === undefined) return { expiresAt: notAfter, iceServers, turn: false };
    // The mechanism counts whole seconds; round down so the credential never
    // outlives the bound.
    const expirySeconds = Math.floor(notAfter / 1000);
    const username = turnUsername(expirySeconds, turnUserLabel(turn.secret, participantId));
    iceServers.push({
      urls: [...turn.urls],
      username,
      credential: turnCredential(turn.secret, username),
    });
    return { expiresAt: expirySeconds * 1000, iceServers, turn: true };
  }
}

/** `<expiry>:<label>`, the TURN REST username. */
export function turnUsername(expirySeconds: number, label: string): string {
  return `${String(expirySeconds)}:${label}`;
}

/** base64(HMAC-SHA1(secret, username)), the TURN REST credential. */
export function turnCredential(secret: string, username: string): string {
  return createHmac('sha1', secret).update(username).digest('base64');
}

/**
 * HMAC-SHA-256(secret, domain ‖ 0x00 ‖ participant ID bytes), truncated to
 * TURN_USER_LABEL_BYTES and base64url-encoded: stable for one participant,
 * unlinkable to the participant ID without the secret.
 */
export function turnUserLabel(secret: string, participantId: ParticipantId): string {
  return createHmac('sha256', secret)
    .update(TURN_USER_LABEL_DOMAIN)
    .update(Buffer.from([0]))
    .update(Buffer.from(participantId, 'base64url'))
    .digest()
    .subarray(0, TURN_USER_LABEL_BYTES)
    .toString('base64url');
}

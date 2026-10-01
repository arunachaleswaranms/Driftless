/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Development setting: comma-separated `stun:` or `stuns:` URLs for the
   * WebRTC ICE configuration. Unset means no ICE servers. Never TURN.
   */
  readonly VITE_RTC_STUN_URLS?: string;
  /**
   * Qualification setting: `relay` restricts peer connections to TURN relay
   * candidates, to prove that TURN carries the data channel. Unset or `all`
   * is the normal policy. Never a secret, and never a TURN credential.
   */
  readonly VITE_RTC_ICE_TRANSPORT_POLICY?: string;
}

/** The Git revision of this build (`DRIFTLESS_BUILD_REVISION`), or `unversioned`. */
declare const __DRIFTLESS_BUILD__: string;

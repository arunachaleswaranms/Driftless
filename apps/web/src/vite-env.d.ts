/// <reference types="vite/client" />

interface ImportMetaEnv {
  /**
   * Development setting: comma-separated `stun:` or `stuns:` URLs for the
   * WebRTC ICE configuration. Unset means no ICE servers. Never TURN.
   */
  readonly VITE_RTC_STUN_URLS?: string;
}

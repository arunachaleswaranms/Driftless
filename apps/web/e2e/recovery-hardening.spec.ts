import { parsePeerMessage, type SyncMessage } from '@driftless/protocol';
import { test, expect } from './support.ts';
import {
  breakDataChannel,
  closePeers,
  frameTypes,
  rtcState,
  status,
  CONNECTED_STATUS,
  CONNECT_TIMEOUT_MS,
  type Peer,
} from './room-support.ts';
import { panel, media, pair, ready, commands, playing, privacy } from './playback-support.ts';

// AUTOMATED SAME-HOST DEVELOPMENT BROWSER EVIDENCE of Phase 3 recovery
// hardening: two browser contexts, a real local signaling service, real
// RTCPeerConnection and RTCDataChannel objects with no ICE server. A peer
// failure is the application's real data channel closed from the page. This
// is not real-network, mobile, cellular, NAT, or TURN evidence, and a
// transient `disconnected` RTCPeerConnection state cannot be produced here
// without a production test hook; that path is proven by unit tests.

test.describe.configure({ mode: 'default', timeout: 240_000 });
test.afterEach(closePeers);

async function syncMessages(p: Peer): Promise<SyncMessage[]> {
  const sends = await p.page.evaluate(() => window.rtcProbe.controlSends.map((s) => s.text));
  return sends.flatMap((s) => {
    const parsed = parsePeerMessage(s);
    return parsed.ok && parsed.message.type === 'SYNC' ? [parsed.message] : [];
  });
}

/** Signaling message types of one kind sent or received on the first socket. */
function count(peer: Peer, direction: 'sent' | 'received', type: string): number {
  return frameTypes(peer, 0, direction).filter((entry) => entry === type).length;
}

test('Local Sync survives five established fresh-peer recoveries and a sixth, each with explicit re-Ready and a fresh baseline', async ({
  browser,
  baseURL,
  pageProblems,
}) => {
  const { host, guest } = await pair(browser, baseURL, pageProblems);
  // Before this hardening, a membership could use four negotiations in all.
  const recoveries = 6;
  for (let cycle = 1; cycle <= recoveries; cycle += 1) {
    const negotiations = cycle;
    // Each established session was reported by both sides and acknowledged.
    for (const peer of [host, guest]) {
      await expect.poll(() => count(peer, 'received', 'RTC_ESTABLISHED_ACK')).toBe(negotiations);
      expect(count(peer, 'sent', 'RTC_ESTABLISHED')).toBe(negotiations);
    }
    await playing(host, guest);
    const before = (await syncMessages(host)).at(-1)?.payload;
    // Alternate the side whose data channel breaks.
    await breakDataChannel(cycle % 2 === 0 ? host : guest);
    for (const p of [host, guest]) {
      await expect
        .poll(async () => (await rtcState(p.page)).peerConnections.length, {
          timeout: CONNECT_TIMEOUT_MS,
        })
        .toBe(negotiations + 1);
      await expect(status(p.page)).toHaveText(CONNECTED_STATUS, { timeout: CONNECT_TIMEOUT_MS });
      // Both players paused at 1x; Ready was reset and must be chosen again.
      await expect.poll(() => media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
      expect(await media(p).evaluate((v: HTMLVideoElement) => v.playbackRate)).toBe(1);
      await expect(panel(p).getByRole('button', { name: "I'm ready", exact: true })).toBeEnabled();
      // One live peer connection and channel; every earlier one stays closed.
      const rtc = await rtcState(p.page);
      expect(rtc.peerConnections.slice(0, -1).every((c) => c.connectionState === 'closed')).toBe(
        true,
      );
      expect(rtc.channels.slice(0, -1).every((c) => c.readyState === 'closed')).toBe(true);
    }
    // Nothing resumes on its own: no heartbeat until both choose Ready again.
    const stopped = (await syncMessages(host)).length;
    await host.page.waitForTimeout(600);
    expect((await syncMessages(host)).length).toBe(stopped);
    await ready(host, guest);
    // A fresh baseline: PAUSE revision 1, then SYNC from sequence 1 with no estimate.
    const baseline = (await commands(host)).at(-1);
    expect(baseline?.type).toBe('PAUSE');
    expect(baseline?.payload.revision).toBe(1);
    await expect.poll(async () => (await syncMessages(host)).length).toBeGreaterThan(stopped);
    const first = (await syncMessages(host))[stopped]?.payload;
    expect(first).toMatchObject({
      syncSequence: 1,
      revision: 1,
      mode: 'paused',
      clockOffsetMs: null,
      roundTripMs: null,
    });
    if (before?.phase === 'HEARTBEAT' && first?.phase === 'HEARTBEAT') {
      expect(first.localReadinessId).not.toBe(before.localReadinessId);
    }
    // Explicit host Play is still required, and works.
    for (const p of [host, guest]) {
      expect(await media(p).evaluate((v: HTMLVideoElement) => v.paused)).toBe(true);
    }
  }
  await playing(host, guest);
  for (const peer of [host, guest]) {
    await expect.poll(() => count(peer, 'received', 'RTC_ESTABLISHED_ACK')).toBe(recoveries + 1);
    // Signaling never dropped: one socket, one membership, no resume.
    expect(peer.sockets).toHaveLength(1);
    expect(frameTypes(peer, 0, 'received')).not.toContain('SESSION_RESUMED');
    // Establishment reports carry nothing but a negotiation ID.
    for (const frame of peer.frames) {
      const message = JSON.parse(frame.text) as { type: string; payload: object };
      if (message.type === 'RTC_ESTABLISHED' || message.type === 'RTC_ESTABLISHED_ACK') {
        expect(Object.keys(message.payload)).toStrictEqual(['negotiationId']);
      }
    }
  }
  expect(frameTypes(host, 0, 'sent').filter((type) => type === 'RTC_RECOVER')).toHaveLength(
    recoveries,
  );
  await privacy(host, guest);
});

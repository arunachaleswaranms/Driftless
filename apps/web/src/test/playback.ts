import type {
  ApplicationBody,
  MediaSelectionId,
  MediaFingerprint,
  PlaybackBody,
  ReadinessId,
} from '@driftless/protocol';
import { LocalSyncController } from '../features/local-sync/localSyncController.ts';
import type { SyncAdapters } from '../features/local-sync/continuousSyncController.ts';
import type { PlaybackMedia } from '../features/local-sync/playbackSyncController.ts';
export const localId = 'A'.repeat(22) as MediaSelectionId;
export const remoteId = ('B'.repeat(21) + 'A') as MediaSelectionId;
export const readinessId = (n: number) => `${String(n).padStart(21, 'R')}A` as ReadinessId;
const fingerprint = 'A'.repeat(43) as MediaFingerprint;
export class FakePlaybackMedia extends EventTarget implements PlaybackMedia {
  currentTime = 2.5;
  duration = 10;
  paused = true;
  playbackRate = 1;
  controls = true;
  rejectPlay = false;
  pendingPlay: Promise<void> | null = null;
  pauses = 0;
  plays = 0;
  play(): Promise<void> {
    this.plays++;
    if (this.rejectPlay) return Promise.reject(new Error('private browser exception'));
    this.paused = false;
    this.emit('play');
    return this.pendingPlay ?? Promise.resolve();
  }
  pause(): void {
    this.pauses++;
    const changed = !this.paused;
    this.paused = true;
    if (changed) this.emit('pause');
  }
  emit(type: string): void {
    this.dispatchEvent(new Event(type));
  }
}
export function playbackHarness(
  role: 'host' | 'guest' = 'host',
  syncAdapters: SyncAdapters = {
    monotonicMs: () => 0,
    setTimeout: () => 0,
    clearTimeout: () => {},
  },
) {
  let generations = 0;
  const c = new LocalSyncController(
    {
      selectionId: () => localId,
      readinessId: () => readinessId(++generations),
      sha256: () => Promise.resolve(new Uint8Array(32)),
    },
    syncAdapters,
  );
  const video = new FakePlaybackMedia();
  const sends: ApplicationBody[] = [];
  c.playback.setRole(role);
  c.setChannel((body) => {
    sends.push(body);
    return true;
  });
  c.dispatch({ type: 'select', selectionId: localId, byteLength: 1 });
  c.dispatch({ type: 'fingerprint', selectionId: localId, fingerprint });
  c.dispatch({ type: 'playback', selectionId: localId, status: 'ready' });
  c.receive({
    type: 'MEDIA_INFO',
    payload: { selectionId: remoteId, fingerprintVersion: 1, fingerprint, byteLength: 1 },
  });
  c.receive({
    type: 'MEDIA_MATCH',
    payload: { localSelectionId: remoteId, remoteSelectionId: localId, fingerprint },
  });
  c.playback.attach(video, localId);
  const peerReady = () => {
    c.receive({
      type: 'READY',
      payload: {
        localSelectionId: remoteId,
        remoteSelectionId: localId,
        fingerprint,
        readinessId: readinessId(50),
      },
    });
  };
  const currentCommand = (type: PlaybackBody['type'], revision: number, positionMs: number) =>
    command(type, revision, positionMs, c.getState().localReadinessId ?? readinessId(1));
  const activate = async () => {
    await c.playback.ready();
    peerReady();
    if (role === 'guest') c.receive(currentCommand('PAUSE', 1, 2500));
  };
  const commands = () => sends.filter((b) => ['PLAY', 'PAUSE', 'SEEK'].includes(b.type));
  return {
    c,
    video,
    sends,
    peerReady,
    activate,
    commands,
    command: currentCommand,
    generations: () => generations,
  };
}
export const command = (
  type: PlaybackBody['type'],
  revision: number,
  positionMs: number,
  guestReadinessId: ReadinessId = readinessId(1),
): PlaybackBody => ({
  type,
  payload: {
    localSelectionId: remoteId,
    remoteSelectionId: localId,
    localReadinessId: readinessId(50),
    remoteReadinessId: guestReadinessId,
    revision,
    positionMs,
  },
});

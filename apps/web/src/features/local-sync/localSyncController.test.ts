import { readinessId } from '../../test/playback.ts';
import { describe, expect, it, vi } from 'vitest';
import {
  type ApplicationBody,
  type MediaFingerprint,
  type MediaSelectionId,
  type SessionId,
} from '@driftless/protocol';
import { bothReady, readinessBlock, type Sha256 } from '@driftless/sync-engine';
import { LocalSyncController } from './localSyncController.ts';
import type { LocalMediaSelection } from '../local-media/localMediaState.ts';
const session = 'A'.repeat(27) as SessionId;
const id = (n: number) => `${String(n).padStart(21, 'A')}A` as MediaSelectionId;
const hash: Sha256 = () => Promise.resolve(new Uint8Array(32));
async function settle() {
  for (let i = 0; i < 30; i++) await Promise.resolve();
}
function selection(
  n: number,
  status: LocalMediaSelection['status'] = 'ready',
  read: () => Promise<ArrayBuffer> = () => Promise.resolve(new ArrayBuffer(1)),
): LocalMediaSelection {
  const file = new File(['x'], `private-${String(n)}.mp4`, { type: 'video/mp4' });
  vi.spyOn(file, 'slice').mockImplementation(() =>
    Object.assign(new Blob(), { arrayBuffer: read }),
  );
  return { id: n, file, status, metadata: null, error: null };
}
function setup(sha256 = hash) {
  let n = 0;
  const sent: ApplicationBody[] = [];
  const controller = new LocalSyncController({
    selectionId: () => id(++n),
    readinessId: () => readinessId(++n),
    sha256,
  });
  controller.setRoom(session);
  controller.setChannel((body) => {
    sent.push(body);
    return true;
  });
  return { controller, sent };
}
function match(controller: LocalSyncController) {
  const local = controller.getState().local;
  if (!local?.fingerprint) throw new Error('no identity');
  const pair = {
    localSelectionId: id(50),
    remoteSelectionId: local.selectionId,
    fingerprint: local.fingerprint,
  };
  controller.receive({
    type: 'MEDIA_INFO',
    payload: {
      selectionId: id(50),
      fingerprintVersion: 1,
      fingerprint: local.fingerprint,
      byteLength: local.byteLength,
    },
  });
  controller.receive({ type: 'MEDIA_MATCH', payload: pair });
  return pair;
}
async function ready() {
  const h = setup();
  h.controller.updateMedia(selection(1));
  await settle();
  const pair = match(h.controller);
  h.controller.dispatch({ type: 'ready', readinessId: readinessId(1) });
  h.controller.receive({ type: 'READY', payload: { ...pair, readinessId: readinessId(50) } });
  expect(bothReady(h.controller.getState())).toBe(true);
  return h;
}
describe('browser Local Sync controller', () => {
  it('selection hashes locally, metadata is separately required and normal wire evidence omits private fields', async () => {
    const { controller, sent } = setup();
    const media = selection(1, 'loading');
    controller.updateMedia(media);
    expect(readinessBlock(controller.getState())).toBe('FINGERPRINTING');
    await settle();
    match(controller);
    expect(readinessBlock(controller.getState())).toBe('METADATA_LOADING');
    controller.updateMedia({ ...media, status: 'ready' });
    expect(readinessBlock(controller.getState())).toBeNull();
    expect(JSON.stringify(sent)).not.toMatch(
      /private-|video\/mp4|blob:|contentRoot|chunkDigest|lastModified/,
    );
  });
  it('selection already loaded before entering room retains metadata usability', async () => {
    let n = 0;
    const controller = new LocalSyncController({
      selectionId: () => id(++n),
      readinessId: () => readinessId(++n),
      sha256: hash,
    });
    controller.updateMedia(selection(1));
    controller.setRoom(session);
    controller.setChannel(() => true);
    await settle();
    match(controller);
    expect(readinessBlock(controller.getState())).toBeNull();
  });
  it('mismatch blocks Ready', async () => {
    const { controller } = await ready();
    controller.receive({
      type: 'MEDIA_INFO',
      payload: {
        selectionId: id(60),
        fingerprintVersion: 1,
        fingerprint: ('B'.repeat(42) + 'A') as MediaFingerprint,
        byteLength: 1,
      },
    });
    controller.dispatch({ type: 'ready', readinessId: readinessId(1) });
    expect(controller.getState().localReady).toBe(false);
  });
  it('replacement cancels A; late completion cannot announce or restore A', async () => {
    let finish: ((bytes: ArrayBuffer) => void) | undefined;
    const { controller, sent } = setup();
    controller.updateMedia(
      selection(
        1,
        'ready',
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      ),
    );
    const old = controller.getState().local?.selectionId;
    controller.updateMedia(selection(2));
    await settle();
    const current = controller.getState().local?.selectionId;
    expect(current).not.toBe(old);
    finish?.(new ArrayBuffer(1));
    await settle();
    expect(controller.getState().local?.selectionId).toBe(current);
    expect(sent.filter((m) => m.type === 'MEDIA_INFO').map((m) => m.payload.selectionId)).toEqual([
      current,
    ]);
    expect(sent[1]?.type).toBe('NOT_READY');
  });
  it('clear immediately withdraws and sends no empty info', async () => {
    const { controller, sent } = await ready();
    const count = sent.length;
    controller.updateMedia(null);
    expect(bothReady(controller.getState())).toBe(false);
    expect(controller.getState().local).toBeNull();
    expect(sent.slice(count).map((m) => m.type)).toEqual(['NOT_READY']);
  });
  it('local playback error withdraws readiness and cannot be healed by late metadata', async () => {
    const { controller, sent } = await ready();
    controller.updateMedia(selection(1, 'error'));
    expect(bothReady(controller.getState())).toBe(false);
    expect(sent.at(-1)).toMatchObject({
      type: 'NOT_READY',
      payload: { reason: 'LOCAL_MEDIA_ERROR' },
    });
    controller.updateMedia(selection(1, 'ready'));
    expect(readinessBlock(controller.getState())).toBe('LOCAL_MEDIA_ERROR');
  });
  it('remote selection changes invalidate both-ready', async () => {
    const { controller } = await ready();
    const local = controller.getState().local;
    if (!local?.fingerprint) throw new Error('no identity');
    controller.receive({
      type: 'MEDIA_INFO',
      payload: {
        selectionId: id(60),
        fingerprintVersion: 1,
        fingerprint: local.fingerprint,
        byteLength: 1,
      },
    });
    expect(bothReady(controller.getState())).toBe(false);
    expect(controller.getState().localReady).toBe(false);
  });
  it('fresh channel clears peer evidence and reannounces without rehashing or replaying Ready', async () => {
    const sha256 = vi.fn(hash);
    const { controller } = setup(sha256);
    controller.updateMedia(selection(1));
    await settle();
    const pair = match(controller);
    controller.dispatch({ type: 'ready', readinessId: readinessId(1) });
    controller.receive({ type: 'READY', payload: { ...pair, readinessId: readinessId(50) } });
    const calls = sha256.mock.calls.length;
    controller.setChannel(undefined);
    expect(controller.getState().remote).toBeNull();
    const fresh: ApplicationBody[] = [];
    controller.setChannel((body) => {
      fresh.push(body);
      return true;
    });
    await settle();
    expect(fresh.map((m) => m.type)).toEqual(['MEDIA_INFO']);
    expect(sha256.mock.calls.length).toBe(calls);
    expect(bothReady(controller.getState())).toBe(false);
  });
  it('signaling reconnect with the same healthy channel preserves ready and sends no duplicates', async () => {
    const { controller, sent } = await ready();
    const previous = controller.getState();
    const count = sent.length;
    controller.setRoom(session);
    controller.setChannel((body) => {
      sent.push(body);
      return true;
    });
    expect(controller.getState()).toBe(previous);
    expect(sent.length).toBe(count);
    expect(bothReady(previous)).toBe(true);
  });
  it.each(['clear', 'leave', 'room-change', 'shutdown'] as const)(
    '%s cancels outstanding identity work',
    async (action) => {
      let finish: ((bytes: ArrayBuffer) => void) | undefined;
      const { controller, sent } = setup();
      controller.updateMedia(
        selection(
          1,
          'ready',
          () =>
            new Promise((resolve) => {
              finish = resolve;
            }),
        ),
      );
      const obsoleteFinish = finish;
      if (action === 'clear') controller.updateMedia(null);
      if (action === 'leave') controller.setRoom(null);
      if (action === 'room-change') controller.setRoom(('B'.repeat(26) + 'A') as SessionId);
      if (action === 'shutdown') controller.shutdown();
      const count = sent.length;
      obsoleteFinish?.(new ArrayBuffer(1));
      await settle();
      expect(sent.length).toBe(count);
      expect(controller.getState().local?.fingerprint ?? null).toBeNull();
    },
  );
  it('failed reads report a fixed category, block Ready, no raw exception', async () => {
    const { controller } = setup();
    controller.updateMedia(
      selection(1, 'ready', async () => {
        await Promise.resolve();
        throw new Error('private filename');
      }),
    );
    await settle();
    expect(controller.getState().local?.failure).toBe('READ_FAILED');
    expect(readinessBlock(controller.getState())).toBe('LOCAL_MEDIA_ERROR');
  });
  it('shutdown is reusable for React StrictMode and late callbacks remain powerless', async () => {
    const { controller } = setup();
    controller.shutdown();
    controller.setRoom(session);
    controller.setChannel(() => true);
    controller.updateMedia(selection(1));
    await settle();
    match(controller);
    expect(readinessBlock(controller.getState())).toBeNull();
  });
});

it('rapid replacement drains one in-flight read and hashes only the latest selection', async () => {
  let finish: ((bytes: ArrayBuffer) => void) | undefined;
  let reads = 0;
  const { controller, sent } = setup();
  controller.updateMedia(
    selection(1, 'ready', () => {
      reads++;
      return new Promise((resolve) => {
        finish = resolve;
      });
    }),
  );
  for (let n = 2; n <= 20; n++)
    controller.updateMedia(
      selection(n, 'ready', () => {
        reads++;
        return Promise.resolve(new ArrayBuffer(1));
      }),
    );
  const latest = controller.getState().local?.selectionId;
  await settle();
  expect(reads).toBe(1);
  finish?.(new ArrayBuffer(1));
  await settle();
  expect(reads).toBe(2);
  expect(controller.getState().local?.fingerprint).not.toBeNull();
  expect(sent.filter((m) => m.type === 'MEDIA_INFO').map((m) => m.payload.selectionId)).toEqual([
    latest,
  ]);
});
it('failed application send invalidates setup readiness without replaying effects', async () => {
  const { controller } = await ready();
  controller.setChannel(() => false);
  controller.dispatch({ type: 'not-ready' });
  expect(controller.getState().connected).toBe(false);
  expect(bothReady(controller.getState())).toBe(false);
});

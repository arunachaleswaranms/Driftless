import { act, fireEvent, render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import type { MediaFingerprint, MediaSelectionId } from '@driftless/protocol';
import { LocalSyncController } from './localSyncController.ts';
import { LocalSyncPanel } from './LocalSyncPanel.tsx';
const localSelectionId = 'A'.repeat(22) as MediaSelectionId;
const remoteSelectionId = ('B'.repeat(21) + 'A') as MediaSelectionId;
const fingerprint = 'A'.repeat(43) as MediaFingerprint;
function setup() {
  const controller = new LocalSyncController();
  controller.setChannel(() => true);
  render(<LocalSyncPanel controller={controller} />);
  return controller;
}
function local(controller: LocalSyncController) {
  controller.dispatch({ type: 'select', selectionId: localSelectionId, byteLength: 1 });
  controller.dispatch({ type: 'fingerprint', selectionId: localSelectionId, fingerprint });
}
function match(controller: LocalSyncController) {
  controller.receive({
    type: 'MEDIA_INFO',
    payload: { selectionId: remoteSelectionId, fingerprintVersion: 1, fingerprint, byteLength: 1 },
  });
  controller.receive({
    type: 'MEDIA_MATCH',
    payload: {
      localSelectionId: remoteSelectionId,
      remoteSelectionId: localSelectionId,
      fingerprint,
    },
  });
}
describe('Local Sync setup accessibility and readiness UI', () => {
  it('empty/identity progress stays blocked and numeric updates are not live announcements', () => {
    const c = setup();
    expect(screen.getByText('Choose a local video.')).toBeTruthy();
    act(() => {
      c.dispatch({ type: 'select', selectionId: localSelectionId, byteLength: 1 });
      c.dispatch({ type: 'progress', selectionId: localSelectionId, progress: 30 });
    });
    expect(screen.getByText('Checking media identity…')).toBeTruthy();
    expect(screen.getByText('30% checked').getAttribute('aria-hidden')).toBe('true');
    expect(screen.getByRole<HTMLButtonElement>('button', { name: "I'm ready" }).disabled).toBe(
      true,
    );
  });
  it('requires metadata, renders explicit Ready/withdrawal and no raw identifiers', () => {
    const c = setup();
    act(() => {
      local(c);
      match(c);
    });
    const button = screen.getByRole<HTMLButtonElement>('button', { name: "I'm ready" });
    expect(button.disabled).toBe(true);
    act(() => {
      c.dispatch({ type: 'playback', selectionId: localSelectionId, status: 'ready' });
    });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(screen.getByRole<HTMLButtonElement>('button', { name: 'Not ready' })).toBeTruthy();
    expect(document.body.textContent).not.toContain(fingerprint);
    expect(document.body.textContent).not.toContain(localSelectionId);
    fireEvent.click(screen.getByRole<HTMLButtonElement>('button', { name: 'Not ready' }));
    expect(c.getState().localReady).toBe(false);
  });
  it('mismatch is expressed in text and blocks Ready', () => {
    const c = setup();
    act(() => {
      local(c);
      c.dispatch({ type: 'playback', selectionId: localSelectionId, status: 'ready' });
      c.receive({
        type: 'MEDIA_INFO',
        payload: {
          selectionId: remoteSelectionId,
          fingerprintVersion: 1,
          fingerprint,
          byteLength: 2,
        },
      });
    });
    expect(screen.getByText('Media does not match.')).toBeTruthy();
    expect(screen.getByRole<HTMLButtonElement>('button').disabled).toBe(true);
  });
  it('current pair both-ready disappears immediately on playback failure', () => {
    const c = setup();
    act(() => {
      local(c);
      match(c);
      c.dispatch({ type: 'playback', selectionId: localSelectionId, status: 'ready' });
      c.dispatch({ type: 'ready' });
      c.receive({
        type: 'READY',
        payload: {
          localSelectionId: remoteSelectionId,
          remoteSelectionId: localSelectionId,
          fingerprint,
        },
      });
    });
    expect(screen.getByText('Both participants are ready.')).toBeTruthy();
    act(() => {
      c.dispatch({ type: 'playback', selectionId: localSelectionId, status: 'error' });
    });
    expect(screen.queryByText('Both participants are ready.')).toBeNull();
    expect(screen.getByText('Local video could not load. Choose another file.')).toBeTruthy();
  });
});

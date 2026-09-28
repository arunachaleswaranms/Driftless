import { fireEvent, render, screen, within } from '@testing-library/react';
import { StrictMode } from 'react';
import { describe, expect, it, vi } from 'vitest';
import {
  installObjectUrlRegistry,
  makeVideoFile,
  reportDurationChange,
  reportLoadedMetadata,
  reportMediaError,
  stubMediaElementMethods,
} from '../../test/media.ts';
import { LocalMediaPanel } from './LocalMediaPanel.tsx';

function setUp({ strict = false } = {}) {
  const urls = installObjectUrlRegistry();
  const media = stubMediaElementMethods();
  const view = render(
    strict ? (
      <StrictMode>
        <LocalMediaPanel />
      </StrictMode>
    ) : (
      <LocalMediaPanel />
    ),
  );
  return { urls, media, view };
}

function fileInput(): HTMLInputElement {
  const input = screen.getByLabelText(/video file$/);
  if (!(input instanceof HTMLInputElement)) {
    throw new Error('The file chooser is not an input element.');
  }
  return input;
}

function choose(file: File | null) {
  fireEvent.change(fileInput(), { target: { files: file ? [file] : [] } });
}

function player(): HTMLVideoElement {
  const element = screen.getByLabelText('Video player');
  if (!(element instanceof HTMLVideoElement)) {
    throw new Error('The player is not a video element.');
  }
  return element;
}

function detail(term: string): string | null {
  const details = screen.getByRole('heading', { name: 'Selected file' }).parentElement;
  if (!details) {
    throw new Error('The file details are not rendered.');
  }
  const termElement = within(details).getByText(term, { selector: 'dt' });
  return termElement.nextElementSibling?.textContent ?? null;
}

function status(): string {
  return screen.getByRole('status').textContent;
}

describe('LocalMediaPanel', () => {
  describe('before a file is chosen', () => {
    it('offers a labelled, single-file video chooser and no player', () => {
      setUp();

      const input = fileInput();
      expect(input.type).toBe('file');
      expect(input.multiple).toBe(false);
      expect(input.accept.split(',')).toContain('video/*');
      expect(screen.getByLabelText('Choose video file')).toBe(input);
      expect(status()).toBe('No video selected.');
      expect(screen.queryByLabelText('Video player')).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear video' })).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Selected file' })).toBeNull();
    });
  });

  describe('choosing a file', () => {
    it('binds the file to a native video element through one object URL', () => {
      const { urls } = setUp();
      const file = makeVideoFile('holiday.mp4', 1_572_864);

      choose(file);

      expect(urls.created).toHaveLength(1);
      const [url] = urls.created;
      expect(urls.objectFor(url ?? '')).toBe(file);
      const video = player();
      expect(video.getAttribute('src')).toBe(url);
      expect(video.controls).toBe(true);
      expect(video.autoplay).toBe(false);
      expect(video.preload).toBe('metadata');
      expect(video.hasAttribute('playsinline')).toBe(true);
      expect(video.hidden).toBe(false);
    });

    it('shows the file details and a loading status until metadata arrives', () => {
      setUp();

      choose(makeVideoFile('holiday.mp4', 1_572_864));

      expect(status()).toBe('Loading video details…');
      expect(detail('Name')).toBe('holiday.mp4');
      expect(detail('Browser-reported type')).toBe('video/mp4');
      expect(detail('Size')).toBe('1.50 MiB (1,572,864 bytes)');
      expect(detail('Duration')).toBe('Loading…');
      expect(detail('Video dimensions')).toBe('Loading…');
      expect(screen.getByLabelText('Replace video file')).toBe(fileInput());
      expect(screen.getByRole('button', { name: 'Clear video' })).toBeDefined();
    });

    it('reports a missing browser type without inferring one', () => {
      setUp();

      choose(makeVideoFile('clip', 10, ''));

      expect(detail('Browser-reported type')).toBe('Not reported');
      expect(detail('Size')).toBe('10 bytes');
    });

    it('keeps the current file when the chooser is cancelled', () => {
      const { urls } = setUp();
      choose(makeVideoFile('a.mp4'));

      choose(null);

      expect(urls.active()).toEqual(urls.created);
      expect(detail('Name')).toBe('a.mp4');
    });

    it('empties the input after each choice so the same file can be chosen again', () => {
      // jsdom never reports a file input value, so observe the reset itself.
      // React captures the setter when the input mounts, so spy first.
      const setValue = vi.spyOn(HTMLInputElement.prototype, 'value', 'set');
      setUp();

      choose(makeVideoFile('a.mp4'));

      expect(setValue).toHaveBeenCalledWith('');
      expect(setValue.mock.contexts).toContain(fileInput());
    });
  });

  describe('media metadata', () => {
    it('shows the duration and dimensions the browser reports', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));

      reportLoadedMetadata(player(), { duration: 3725.4, width: 1920, height: 1080 });

      expect(status()).toBe('Ready. Use the video controls to play, pause, and seek.');
      expect(detail('Duration')).toBe('1:02:05');
      expect(detail('Video dimensions')).toBe('1920 × 1080 pixels');
    });

    it.each([Number.POSITIVE_INFINITY, Number.NaN])(
      'handles an unknown duration (%s) and a later known one',
      (unknown) => {
        setUp();
        choose(makeVideoFile('a.webm'));

        reportLoadedMetadata(player(), { duration: unknown, width: 0, height: 0 });

        expect(status()).toBe('Ready. Use the video controls to play, pause, and seek.');
        expect(detail('Duration')).toBe('Not reported by the browser');
        expect(detail('Video dimensions')).toBe('Not reported by the browser');

        reportDurationChange(player(), 10);
        expect(detail('Duration')).toBe('0:10');
      },
    );
  });

  describe('replacing the file', () => {
    it('detaches and revokes the previous URL and binds only the new one', () => {
      const { urls, media } = setUp();
      choose(makeVideoFile('a.mp4'));
      const first = player();
      const [firstUrl] = urls.created;
      const srcAtRevoke: (string | null)[] = [];
      urls.onRevoke(() => srcAtRevoke.push(first.getAttribute('src')));

      choose(makeVideoFile('b.mp4'));

      expect(urls.revoked).toEqual([firstUrl]);
      expect(srcAtRevoke).toEqual([null]);
      expect(media.pause.mock.contexts).toContain(first);
      expect(media.load.mock.contexts).toContain(first);
      const [, secondUrl] = urls.created;
      expect(urls.active()).toEqual([secondUrl]);
      expect(player()).not.toBe(first);
      expect(player().getAttribute('src')).toBe(secondUrl);
    });

    it('resets metadata and errors from the previous file', () => {
      setUp();
      choose(makeVideoFile('a.mp4', 2048));
      reportLoadedMetadata(player(), { duration: 10, width: 320, height: 180 });
      choose(makeVideoFile('b.mp4', 4096));

      expect(status()).toBe('Loading video details…');
      expect(detail('Name')).toBe('b.mp4');
      expect(detail('Size')).toBe('4.00 KiB (4,096 bytes)');
      expect(detail('Duration')).toBe('Loading…');
      expect(detail('Video dimensions')).toBe('Loading…');

      reportMediaError(player(), 4);
      choose(makeVideoFile('c.mp4'));

      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('Loading video details…');
      expect(player().hidden).toBe(false);
    });

    it('ignores late media events from the replaced file', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));
      const first = player();
      choose(makeVideoFile('b.mp4'));

      reportLoadedMetadata(first, { duration: 99, width: 640, height: 360 });
      reportDurationChange(first, 42);
      reportMediaError(first, 3);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('Loading video details…');
      expect(detail('Duration')).toBe('Loading…');

      reportLoadedMetadata(player(), { duration: 6, width: 256, height: 144 });
      reportMediaError(first, 4);

      expect(screen.queryByRole('alert')).toBeNull();
      expect(detail('Duration')).toBe('0:06');
      expect(detail('Video dimensions')).toBe('256 × 144 pixels');
    });
  });

  describe('clearing the file', () => {
    it('stops playback, releases the URL, and returns to the empty state', () => {
      const { urls, media } = setUp();
      choose(makeVideoFile('a.mp4'));
      const video = player();
      reportLoadedMetadata(video, { duration: 10, width: 320, height: 180 });
      const srcAtRevoke: (string | null)[] = [];
      urls.onRevoke(() => srcAtRevoke.push(video.getAttribute('src')));

      fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));

      expect(urls.revoked).toEqual(urls.created);
      expect(urls.active()).toEqual([]);
      expect(srcAtRevoke).toEqual([null]);
      expect(media.pause.mock.contexts).toContain(video);
      expect(media.load.mock.contexts).toContain(video);
      expect(video.isConnected).toBe(false);
      expect(screen.queryByLabelText('Video player')).toBeNull();
      expect(screen.queryByRole('heading', { name: 'Selected file' })).toBeNull();
      expect(screen.queryByRole('button', { name: 'Clear video' })).toBeNull();
      expect(status()).toBe('No video selected.');
    });

    it('moves focus to the file chooser', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));
      const clear = screen.getByRole('button', { name: 'Clear video' });
      clear.focus();

      fireEvent.click(clear);

      expect(document.activeElement).toBe(fileInput());
      expect(screen.getByLabelText('Choose video file')).toBe(fileInput());
    });

    it('allows the same file to be chosen again', () => {
      const { urls } = setUp();
      const file = makeVideoFile('a.mp4');
      choose(file);
      fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));

      choose(file);

      expect(urls.created).toHaveLength(2);
      const [, secondUrl] = urls.created;
      expect(urls.objectFor(secondUrl ?? '')).toBe(file);
      expect(urls.active()).toEqual([secondUrl]);
      expect(detail('Name')).toBe('a.mp4');
    });

    it('clears an error', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));
      reportMediaError(player(), 4);

      fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));

      expect(screen.queryByRole('alert')).toBeNull();
      expect(status()).toBe('No video selected.');
    });
  });

  describe('playback errors', () => {
    it('reports a conservative message without the browser’s internal detail', () => {
      setUp();
      choose(makeVideoFile('a.mkv', 1024, 'video/x-matroska'));

      reportMediaError(player(), 4, 'DEMUXER_ERROR_COULD_NOT_OPEN: internal detail');

      const alert = screen.getByRole('alert');
      expect(alert.textContent).toContain('This browser could not play the selected media.');
      expect(alert.textContent).toContain('may not be supported by this browser, or the file');
      expect(alert.textContent).not.toMatch(/codec|DEMUXER|internal detail/);
      expect(status()).toBe('');
      expect(player().hidden).toBe(true);
      expect(detail('Name')).toBe('a.mkv');
      expect(detail('Duration')).toBe('Unavailable');
      expect(screen.getByRole('button', { name: 'Clear video' })).toBeDefined();
    });

    it('keeps metadata already reported when playback later fails', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));
      reportLoadedMetadata(player(), { duration: 10, width: 320, height: 180 });

      reportMediaError(player(), 3);

      expect(screen.getByRole('alert').textContent).toContain('problem decoding the file');
      expect(detail('Duration')).toBe('0:10');
    });

    it('does not return to ready after a failure', () => {
      setUp();
      choose(makeVideoFile('a.mp4'));
      reportMediaError(player(), 2);

      reportLoadedMetadata(player(), { duration: 10, width: 320, height: 180 });

      expect(screen.getByRole('alert')).toBeDefined();
      expect(status()).toBe('');
    });
  });

  describe('object URL ownership', () => {
    it('revokes the active URL when the panel unmounts', () => {
      const { urls, view } = setUp();
      choose(makeVideoFile('a.mp4'));

      view.unmount();

      expect(urls.created).toHaveLength(1);
      expect(urls.revoked).toEqual(urls.created);
    });

    it('revokes nothing when the panel unmounts without a file', () => {
      const { urls, view } = setUp();

      view.unmount();

      expect(urls.created).toEqual([]);
      expect(urls.revoked).toEqual([]);
    });

    it('revokes every URL exactly once across repeated replace and clear cycles', () => {
      const { urls } = setUp();

      for (let cycle = 0; cycle < 5; cycle += 1) {
        choose(makeVideoFile(`a-${String(cycle)}.mp4`));
        reportLoadedMetadata(player(), { duration: 10, width: 320, height: 180 });
        choose(makeVideoFile(`b-${String(cycle)}.mp4`));
        reportMediaError(player(), 4);
        choose(makeVideoFile(`c-${String(cycle)}.mp4`));
        expect(urls.active()).toHaveLength(1);
        expect(screen.queryByRole('alert')).toBeNull();
        expect(detail('Duration')).toBe('Loading…');
        fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));
        expect(urls.active()).toEqual([]);
      }

      expect(urls.created).toHaveLength(15);
      expect(urls.revoked).toEqual(urls.created);
      expect(screen.queryByLabelText('Video player')).toBeNull();
      expect(status()).toBe('No video selected.');
    });

    it('keeps exactly one URL active and balances every URL under StrictMode', () => {
      const { urls, view } = setUp({ strict: true });

      choose(makeVideoFile('a.mp4'));
      expect(urls.active()).toHaveLength(1);
      expect(player().getAttribute('src')).toBe(urls.active()[0]);

      choose(makeVideoFile('b.mp4'));
      expect(urls.active()).toHaveLength(1);
      expect(player().getAttribute('src')).toBe(urls.active()[0]);

      fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));
      expect(urls.active()).toEqual([]);

      choose(makeVideoFile('c.mp4'));
      view.unmount();

      expect(urls.active()).toEqual([]);
      expect(new Set(urls.revoked).size).toBe(urls.revoked.length);
      expect([...urls.revoked].sort()).toEqual([...urls.created].sort());
    });
  });

  describe('whole-file safety', () => {
    it('never reads the file contents while choosing, replacing, or clearing', () => {
      setUp();
      const readers = (['arrayBuffer', 'bytes', 'text', 'stream', 'slice'] as const)
        .filter((name) => name in Blob.prototype)
        .map((name) => vi.spyOn(Blob.prototype, name));
      const fileReader = vi.fn();
      vi.stubGlobal('FileReader', fileReader);

      choose(makeVideoFile('a.mp4', 65_536));
      reportLoadedMetadata(player(), { duration: 10, width: 320, height: 180 });
      choose(makeVideoFile('b.mp4', 65_536));
      fireEvent.click(screen.getByRole('button', { name: 'Clear video' }));

      expect(readers.length).toBeGreaterThan(0);
      for (const reader of readers) {
        expect(reader).not.toHaveBeenCalled();
      }
      expect(fileReader).not.toHaveBeenCalled();
    });
  });
});

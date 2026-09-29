/**
 * A safe classification of an `HTMLMediaElement` failure. Categories follow
 * the standard `MediaError` codes only; they are not a diagnosis. In
 * particular, browsers report `MEDIA_ERR_SRC_NOT_SUPPORTED` both for formats
 * they cannot play and for damaged or non-media files, so no category claims
 * a specific codec or container is unsupported.
 */
export type LocalMediaErrorKind = 'aborted' | 'unreadable' | 'decode' | 'source' | 'unknown';

/** The standard `MediaError` code values. */
const MEDIA_ERROR_KINDS: Readonly<Record<number, LocalMediaErrorKind>> = {
  1: 'aborted',
  2: 'unreadable',
  3: 'decode',
  4: 'source',
};

export function classifyMediaError(error: Pick<MediaError, 'code'> | null): LocalMediaErrorKind {
  return (error && MEDIA_ERROR_KINDS[error.code]) ?? 'unknown';
}

/** The primary message shown for every playback failure. */
export const MEDIA_ERROR_SUMMARY = 'This browser could not play the selected media.';

const MEDIA_ERROR_DETAILS: Readonly<Record<LocalMediaErrorKind, string>> = {
  aborted: 'Loading the file was interrupted. Try choosing it again.',
  unreadable:
    'The browser could not read the file. It may have been moved, changed, or deleted since it was chosen.',
  decode: 'The browser reported a problem decoding the file.',
  source:
    'The browser does not recognize the file as media it can play. Its format may not be supported by this browser, or the file may be damaged.',
  unknown: 'The browser did not report a reason.',
};

export function describeMediaError(kind: LocalMediaErrorKind): string {
  return MEDIA_ERROR_DETAILS[kind];
}

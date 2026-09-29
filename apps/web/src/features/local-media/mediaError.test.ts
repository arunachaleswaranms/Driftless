import { describe, expect, it } from 'vitest';
import { classifyMediaError, describeMediaError, type LocalMediaErrorKind } from './mediaError.ts';

describe('classifyMediaError', () => {
  it.each([
    [1, 'aborted'],
    [2, 'unreadable'],
    [3, 'decode'],
    [4, 'source'],
    [0, 'unknown'],
    [99, 'unknown'],
  ])('classifies MediaError code %d as %s', (code, kind) => {
    expect(classifyMediaError({ code })).toBe(kind);
  });

  it('classifies a missing error as unknown', () => {
    expect(classifyMediaError(null)).toBe('unknown');
  });
});

describe('describeMediaError', () => {
  const kinds: LocalMediaErrorKind[] = ['aborted', 'unreadable', 'decode', 'source', 'unknown'];

  it.each(kinds)('never attributes a %s failure to a codec', (kind) => {
    expect(describeMediaError(kind)).not.toMatch(/codec/i);
  });
});

import { describe, expect, it } from 'vitest';
import { formatByteSize, formatDimensions, formatDuration } from './format.ts';

describe('formatByteSize', () => {
  it.each([
    [0, '0 bytes'],
    [1, '1 byte'],
    [1023, '1,023 bytes'],
    [1024, '1.00 KiB (1,024 bytes)'],
    [16_273, '15.9 KiB (16,273 bytes)'],
    [1_572_864, '1.50 MiB (1,572,864 bytes)'],
    [110_544_641, '105 MiB (110,544,641 bytes)'],
    [4_530_000_000, '4.22 GiB (4,530,000,000 bytes)'],
    [2 ** 50, '1024 TiB (1,125,899,906,842,624 bytes)'],
  ])('formats %d bytes as %s', (bytes, expected) => {
    expect(formatByteSize(bytes)).toBe(expected);
  });

  it.each([-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY, 2 ** 53])(
    'reports %d bytes as unknown',
    (bytes) => {
      expect(formatByteSize(bytes)).toBe('Unknown');
    },
  );
});

describe('formatDuration', () => {
  it.each([
    [0, '0:00'],
    [0.4, '0:00'],
    [9.6, '0:10'],
    [59.4, '0:59'],
    [600, '10:00'],
    [3599.5, '1:00:00'],
    [5400, '1:30:00'],
    [36_000 + 61, '10:01:01'],
  ])('formats %d seconds as %s', (seconds, expected) => {
    expect(formatDuration(seconds)).toBe(expected);
  });

  it.each([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY, -1])(
    'returns null for %d',
    (seconds) => {
      expect(formatDuration(seconds)).toBeNull();
    },
  );
});

describe('formatDimensions', () => {
  it('formats reported dimensions', () => {
    expect(formatDimensions(320, 180)).toBe('320 × 180 pixels');
  });

  it.each([
    [0, 0],
    [320, 0],
    [Number.NaN, 180],
    [320.5, 180],
  ])('returns null for %d × %d', (width, height) => {
    expect(formatDimensions(width, height)).toBeNull();
  });
});

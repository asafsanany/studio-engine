import { decodeGraphicVars, encodeGraphicVars, GRAPHIC_SIZES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  GRAPHICS_API_BASE,
  graphicHostUrl,
  graphicLengthSec,
  isShowingOlder,
  PREVIEW_TAIL_SEC,
  playDurationSec,
  sizeRatio,
  sortedValues,
  timeLabel,
  VALUES_DEBOUNCE_MS,
  varsParam,
} from './graphic-preview-logic';

const ID = '5a3e1c0de001';

describe('varsParam', () => {
  it('is empty for no values, so the address stays short and the graphic keeps its defaults', () => {
    expect(varsParam({})).toBe('');
  });

  it('is the shared encoding of the values, which the host decodes back', () => {
    const values = { name: 'דנה לוי', role: 'Founder & CEO 👋' };
    expect(decodeGraphicVars(varsParam(values))).toEqual(values);
  });

  it('is the same text for the same values in any key order', () => {
    expect(varsParam({ name: 'A', role: 'B' })).toBe(varsParam({ role: 'B', name: 'A' }));
    expect(varsParam({ name: 'A', role: 'B' })).toBe(encodeGraphicVars({ name: 'A', role: 'B' }));
  });

  it('keeps an empty field: an empty text is not the default text', () => {
    expect(decodeGraphicVars(varsParam({ name: '' }))).toEqual({ name: '' });
  });

  it('only has characters an address can carry as they are', () => {
    expect(varsParam({ name: 'דנה לוי ?&=#/+' })).toMatch(/^[A-Za-z0-9_-]+$/);
  });
});

describe('sortedValues', () => {
  it('puts the keys in order and leaves the values alone', () => {
    expect(Object.keys(sortedValues({ role: 'r', name: 'n', a: 'x' }))).toEqual([
      'a',
      'name',
      'role',
    ]);
    expect(sortedValues({ b: '2', a: '1' })).toEqual({ a: '1', b: '2' });
  });
});

describe('graphicHostUrl', () => {
  it('is the host.html address of the version, with the size and the background', () => {
    expect(
      graphicHostUrl({ id: ID, version: 2, size: '16x9', background: 'checker', vars: '' }),
    ).toBe(`/api/graphics/${ID}/v/2/host.html?size=16x9&bg=checker`);
    expect(GRAPHICS_API_BASE).toBe('/api/graphics');
  });

  it('adds the values when there are some', () => {
    const vars = varsParam({ name: 'Dana' });
    expect(graphicHostUrl({ id: ID, version: 1, size: '9x16', background: 'frame', vars })).toBe(
      `/api/graphics/${ID}/v/1/host.html?size=9x16&bg=frame&vars=${vars}`,
    );
  });

  it.each(GRAPHIC_SIZES)('names the size %s the way the host reads it', (size) => {
    const url = graphicHostUrl({ id: ID, version: 1, size, background: 'black', vars: '' });
    expect(new URL(url, 'http://x').searchParams.get('size')).toBe(size);
    expect(new URL(url, 'http://x').searchParams.get('bg')).toBe('black');
  });

  it('is a different address for each thing that changes the picture', () => {
    const base = { id: ID, version: 1, size: '9x16', background: 'frame', vars: '' } as const;
    const urls = new Set([
      graphicHostUrl(base),
      graphicHostUrl({ ...base, version: 2 }),
      graphicHostUrl({ ...base, size: '1x1' }),
      graphicHostUrl({ ...base, background: 'black' }),
      graphicHostUrl({ ...base, vars: varsParam({ name: 'x' }) }),
    ]);
    expect(urls.size).toBe(5);
  });

  it('takes another base, without doubling the slash', () => {
    expect(
      graphicHostUrl({
        id: ID,
        version: 3,
        size: '1x1',
        background: 'frame',
        vars: '',
        apiBase: '/__dev/graphic-sample/',
      }),
    ).toBe(`/__dev/graphic-sample/${ID}/v/3/host.html?size=1x1&bg=frame`);
  });
});

describe('the loop’s length', () => {
  it('is the graphic’s length plus the 0.8 s tail', () => {
    expect(PREVIEW_TAIL_SEC).toBe(0.8);
    expect(playDurationSec(3)).toBe(3.8);
    expect(playDurationSec(2.4)).toBe(3.2);
    expect(playDurationSec(0.5)).toBe(1.3);
  });

  it('is not known without a length', () => {
    expect(playDurationSec(null)).toBeUndefined();
    expect(playDurationSec(undefined)).toBeUndefined();
    expect(playDurationSec(0)).toBeUndefined();
    expect(playDurationSec(Number.NaN)).toBeUndefined();
  });

  it('gives the graphic’s own length back from what the player reports', () => {
    expect(graphicLengthSec(3.8)).toBe(3);
    expect(graphicLengthSec(13.05)).toBe(12.25);
    expect(graphicLengthSec(0.5)).toBe(0);
    expect(graphicLengthSec(0)).toBe(0);
  });
});

describe('timeLabel', () => {
  it('reads "1.2 / 3.0 s"', () => {
    expect(timeLabel(1.2, 3)).toBe('1.2 / 3.0 s');
    expect(timeLabel(0, 2.5)).toBe('0.0 / 2.5 s');
  });

  it('stops at the graphic’s length: the tail of the loop reads the full length', () => {
    expect(timeLabel(3.4, 3)).toBe('3.0 / 3.0 s');
    expect(timeLabel(3.8, 3)).toBe('3.0 / 3.0 s');
  });

  it('is 0.0 / 0.0 s when nothing is known', () => {
    expect(timeLabel(0, 0)).toBe('0.0 / 0.0 s');
    expect(timeLabel(Number.NaN, Number.NaN)).toBe('0.0 / 0.0 s');
    expect(timeLabel(-1, 3)).toBe('0.0 / 3.0 s');
  });
});

describe('isShowingOlder', () => {
  it('is true only when the version on show is older than the one edits use', () => {
    expect(isShowingOlder(1, 2)).toBe(true);
    expect(isShowingOlder(2, 2)).toBe(false);
    expect(isShowingOlder(3, 2)).toBe(false);
    expect(isShowingOlder(null, 2)).toBe(false);
    expect(isShowingOlder(1, null)).toBe(false);
  });
});

describe('sizeRatio', () => {
  it('is the host’s width over its height', () => {
    expect(sizeRatio('9x16')).toBeCloseTo(0.5625);
    expect(sizeRatio('16x9')).toBeCloseTo(1.7778);
    expect(sizeRatio('1x1')).toBe(1);
  });
});

describe('VALUES_DEBOUNCE_MS', () => {
  it('is 300 ms', () => {
    expect(VALUES_DEBOUNCE_MS).toBe(300);
  });
});

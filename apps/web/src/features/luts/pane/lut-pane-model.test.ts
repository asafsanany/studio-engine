import { describe, expect, it } from 'vitest';
import { makeBuiltInLutSummary, makeLutDetail } from '@/data/test-utils';
import {
  afterClip,
  beforeLabel,
  clampSplit,
  DEFAULT_LUT_FRAME,
  frameCredit,
  LUT_FRAME_CHIPS,
  LUT_FRAME_STORAGE_KEY,
  LUT_PANE_TEXT,
  PREVIEW_LOADING,
  paneDescription,
  paneFacts,
  paneImageUrl,
  paneNote,
  previewLoading,
  previewLoadReducer,
  readStoredFrame,
  storeFrame,
} from './lut-pane-model';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

/** A stand-in for `localStorage` that remembers what it was given. */
function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    data,
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe('the frame chips', () => {
  it('are Person · Street · Interior, in that order', () => {
    expect(LUT_FRAME_CHIPS.map((chip) => chip.label)).toEqual(['Person', 'Street', 'Interior']);
  });

  it('give each frame its photo credit', () => {
    expect(frameCredit('person')).toBe('Photo: Benjamin Combs, Unsplash');
    expect(frameCredit('street')).toBe('Photo: Nicholas Swanson, Unsplash');
    expect(frameCredit('interior')).toBe('Photo: The Anchor, Unsplash');
  });
});

describe('the remembered frame', () => {
  it('starts on Person when nothing is stored', () => {
    expect(readStoredFrame(memoryStorage())).toBe(DEFAULT_LUT_FRAME);
    expect(DEFAULT_LUT_FRAME).toBe('person');
  });

  it('stores the chosen frame under studio.luts.frame and reads it back', () => {
    const storage = memoryStorage();
    storeFrame('interior', storage);
    expect(storage.data.get(LUT_FRAME_STORAGE_KEY)).toBe('interior');
    expect(LUT_FRAME_STORAGE_KEY).toBe('studio.luts.frame');
    expect(readStoredFrame(storage)).toBe('interior');
  });

  it('ignores a stored value that is not a frame', () => {
    expect(readStoredFrame(memoryStorage({ [LUT_FRAME_STORAGE_KEY]: 'beach' }))).toBe('person');
  });

  it('works without storage, and when storage throws', () => {
    const broken = {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    };
    expect(readStoredFrame(null)).toBe('person');
    expect(readStoredFrame(broken)).toBe('person');
    expect(() => storeFrame('street', broken)).not.toThrow();
    expect(() => storeFrame('street', null)).not.toThrow();
  });
});

describe('the divider', () => {
  it('clips the after still from the divider to the right edge', () => {
    expect(afterClip(50)).toBe('inset(0 0 0 50%)');
    expect(afterClip(0)).toBe('inset(0 0 0 0%)');
    expect(afterClip(100)).toBe('inset(0 0 0 100%)');
  });

  it('keeps the position between 0 and 100', () => {
    expect(clampSplit(-20)).toBe(0);
    expect(clampSplit(140)).toBe(100);
    expect(clampSplit(33.4)).toBe(33);
    expect(clampSplit(Number.NaN)).toBe(50);
  });
});

describe('the stills', () => {
  it('come from the preview route of the open frame, with a version', () => {
    const detail = makeLutDetail({ slug: 'golden-hour-warm', file: 'Golden Hour Warm.cube' });
    const before = paneImageUrl(detail, 'street', 'before');
    expect(before).toMatch(/^\/api\/luts\/golden-hour-warm\/preview\/street\/before\.jpg\?v=/);
    expect(paneImageUrl(detail, 'interior', 'after')).toContain('/preview/interior/after.jpg');
  });

  it('change address when the file changes, and when Try again is pressed', () => {
    const detail = makeLutDetail();
    const replaced = makeLutDetail({ bytes: 99 });
    expect(paneImageUrl(replaced, 'person', 'after')).not.toBe(
      paneImageUrl(detail, 'person', 'after'),
    );
    expect(paneImageUrl(detail, 'person', 'after', 1)).not.toBe(
      paneImageUrl(detail, 'person', 'after', 0),
    );
  });

  it("use the engine's preview key as the version when the detail has one", () => {
    const detail = makeLutDetail({ previewKey: 'a1b2c3d4' });
    expect(paneImageUrl(detail, 'person', 'after')).toBe(
      '/api/luts/golden-hour-warm/preview/person/after.jpg?v=a1b2c3d4',
    );
    expect(paneImageUrl(detail, 'person', 'after', 2)).toContain('?v=a1b2c3d4-r2');
    expect(paneImageUrl(makeLutDetail({ previewKey: 'ffff0000' }), 'person', 'after')).not.toBe(
      paneImageUrl(detail, 'person', 'after'),
    );
  });

  it('escape a slug and a file name that need it', () => {
    const detail = makeLutDetail({ file: 'Teal & Orange.cube' });
    expect(paneImageUrl(detail, 'person', 'after')).toContain('?v=Teal%20%26%20Orange.cube-');
  });
});

describe('the header and the note', () => {
  it('describes a built-in LUT with its catalog line', () => {
    expect(paneDescription(makeLutDetail({ description: 'Subtle teal shadows.' }))).toBe(
      'Subtle teal shadows.',
    );
  });

  it('describes one of Yours by its kind and size', () => {
    expect(paneDescription(makeLutDetail({ description: '' }))).toBe('Look · 33 × 33 × 33');
    const camera = makeLutDetail({
      description: '',
      kind: 'camera',
      size: 65,
      sizeLabel: '65 × 65 × 65',
    });
    expect(paneDescription(camera)).toBe('Camera · 65 × 65 × 65');
  });

  it('labels the left pill Log for a Camera LUT, Before otherwise', () => {
    expect(beforeLabel(makeLutDetail({ kind: 'camera' }))).toBe('Log');
    expect(beforeLabel(makeLutDetail({ kind: 'look' }))).toBe('Before');
    expect(beforeLabel(makeLutDetail({ kind: 'fix' }))).toBe('Before');
  });

  it('notes a Camera LUT and a Fix, and nothing for a Look', () => {
    expect(paneNote(makeLutDetail({ kind: 'camera' }))).toBe(
      'Camera LUTs expect flat log footage, so this is shown on a log sample of the frame.',
    );
    expect(paneNote(makeLutDetail({ kind: 'fix', note: null }))).toBe(
      'Made for footage with one problem, so a clean test frame can look off.',
    );
    expect(paneNote(makeLutDetail({ kind: 'look', note: null }))).toBeNull();
  });
});

describe('the facts', () => {
  it('list Kind, Size, File and Added for a LUT of Yours (no Used in while notes cannot name one)', () => {
    const facts = paneFacts(
      makeLutDetail({ addedAt: '2026-10-22T10:00:00.000Z', usedIn: null }),
      NOW,
    );
    expect(facts).toEqual([
      { label: 'Kind', value: 'Look' },
      { label: 'Size', value: '33 × 33 × 33' },
      { label: 'File', value: 'Golden Hour Warm.cube' },
      { label: 'Added', value: '2 days ago' },
    ]);
  });

  it('adds Used in once notes can name a LUT', () => {
    const labels = (usedIn: number | null, usedLabel: string) =>
      paneFacts(makeLutDetail({ usedIn, usedLabel }), NOW).map((fact) => [fact.label, fact.value]);
    expect(labels(3, '3 jobs')).toContainEqual(['Used in', '3 jobs']);
    expect(labels(0, 'Not used yet')).toContainEqual(['Used in', 'Not used yet']);
  });

  it('say a built-in LUT comes with the grade', () => {
    const detail = makeLutDetail({
      ...makeBuiltInLutSummary(),
      usedIn: 0,
      description: 'x',
      note: null,
      file: 'film_contrast.cube',
      sizeLabel: '33 × 33 × 33',
      bytes: 1,
    });
    const facts = paneFacts(detail, NOW);
    expect(facts).toContainEqual({ label: 'Added', value: LUT_PANE_TEXT.addedBuiltIn });
    expect(facts).toContainEqual({ label: 'Used in', value: 'Used by the cinematic look' });
  });

  it('show a dash for the Cinematic look, which has no file', () => {
    expect(paneFacts(makeLutDetail({ file: null }), NOW)).toContainEqual({
      label: 'File',
      value: '—',
    });
  });
});

describe('the load state of a preview', () => {
  it('waits for both stills', () => {
    let state = PREVIEW_LOADING;
    expect(previewLoading(state)).toBe(true);
    state = previewLoadReducer(state, { type: 'loaded', side: 'before' });
    expect(previewLoading(state)).toBe(true);
    state = previewLoadReducer(state, { type: 'loaded', side: 'after' });
    expect(previewLoading(state)).toBe(false);
    expect(state.failed).toBe(false);
  });

  it('fails the frame when one still fails, and stops waiting', () => {
    const state = previewLoadReducer(PREVIEW_LOADING, { type: 'failed' });
    expect(state.failed).toBe(true);
    expect(previewLoading(state)).toBe(false);
  });

  it('starts over on reset (Try again)', () => {
    const failed = previewLoadReducer(PREVIEW_LOADING, { type: 'failed' });
    expect(previewLoadReducer(failed, { type: 'reset' })).toEqual(PREVIEW_LOADING);
  });
});

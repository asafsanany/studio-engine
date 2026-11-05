import type { FontFamilyDetail, FontsListResponse } from '@studio/shared';
import { type QueryClient, QueryObserver } from '@tanstack/react-query';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  applyFontChanged,
  applyFontRequestDismissed,
  applyFontRequested,
  applyFontSummary,
  applyFontsImported,
  facesNeedReload,
  fontSummaryOf,
  reloadFonts,
  removeFont,
  removeFontSummary,
  upsertFontSummary,
} from './fonts-cache';
import { FONT_LIST_KEY, fontKey } from './fonts-query';
import {
  createTestQueryClient,
  makeFontFace,
  makeFontFamilyDetail,
  makeFontFamilySummary,
  makeFontRequest,
} from './test-utils';

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

const heebo = makeFontFamilySummary();
const outfit = makeFontFamilySummary({
  slug: 'outfit',
  name: 'Outfit',
  he: false,
  weights: [400, 700],
  weightsLabel: '2 weights',
  used: 0,
  usedLabel: 'Not used yet',
});
const rubik = makeFontFamilySummary({ slug: 'rubik', name: 'Rubik' });

const heeboBold = makeFontFace();
const heeboBoldItalic = makeFontFace({
  name: 'Heebo Bold Italic',
  italic: true,
  fileId: 'ba5eba11',
});
const outfitBold = makeFontFace({
  name: 'Outfit Bold',
  family: 'Outfit',
  fileId: 'b00b1e5',
});

function list(): FontsListResponse | undefined {
  return queryClient.getQueryData<FontsListResponse>(FONT_LIST_KEY);
}

function seed(families = [heebo, outfit]): void {
  queryClient.setQueryData<FontsListResponse>(FONT_LIST_KEY, {
    families,
    catalog: [heeboBold, outfitBold],
    requests: [makeFontRequest()],
  });
}

/**
 * What a Fonts page does: an observer on the list, which asks the server again when the list is
 * invalidated. `answer` is what the server says now; `asked()` is how many times it was asked.
 */
function openPage(answer: () => FontsListResponse): { asked: () => number; close: () => void } {
  const queryFn = vi.fn(() => Promise.resolve(answer()));
  const close = new QueryObserver(queryClient, {
    queryKey: FONT_LIST_KEY,
    queryFn,
    staleTime: Number.POSITIVE_INFINITY,
  }).subscribe(() => {});
  return { asked: () => queryFn.mock.calls.length, close };
}

const base: FontsListResponse = { families: [heebo, rubik], catalog: [], requests: [] };

describe('applyFontRequested', () => {
  it('asks for the list again and leaves what is on screen as it is until the answer comes', () => {
    seed();
    const before = list();

    applyFontRequested(queryClient);

    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(list()).toBe(before);
  });

  it('touches no pane', () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());

    applyFontRequested(queryClient);

    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(false);
  });

  it('does nothing for a list nobody loaded', () => {
    applyFontRequested(queryClient);
    expect(list()).toBeUndefined();
  });
});

describe('applyFontRequestDismissed ("Not a font", C52)', () => {
  const falcon = makeFontRequest({ id: 'a3c19e0b7d44', name: 'Falcon' });
  const gotham = makeFontRequest({ id: 'b4d20f1c8e55', name: 'Gotham Bold' });

  it('takes the request out of the list at once, keeps the rest, and asks for the list again', () => {
    queryClient.setQueryData(FONT_LIST_KEY, { ...base, requests: [falcon, gotham] });

    applyFontRequestDismissed(queryClient, 'a3c19e0b7d44');

    expect(list()).toEqual({ ...base, requests: [gotham] });
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
  });

  it('leaves a list without that request as it is, and touches no pane', () => {
    queryClient.setQueryData(FONT_LIST_KEY, { ...base, requests: [gotham] });
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());

    applyFontRequestDismissed(queryClient, 'a3c19e0b7d44');

    expect(list()?.requests).toEqual([gotham]);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(false);
  });

  it('does nothing for a list nobody loaded', () => {
    applyFontRequestDismissed(queryClient, 'a3c19e0b7d44');
    expect(list()).toBeUndefined();
  });
});

describe('upsertFontSummary', () => {
  it('puts a new family where its name puts it, A to Z without regard to case', () => {
    const karantina = makeFontFamilySummary({ slug: 'karantina', name: 'Karantina' });
    const bebas = makeFontFamilySummary({ slug: 'bebas-neue', name: 'bebas Neue' });
    const zilla = makeFontFamilySummary({ slug: 'zilla', name: 'Zilla' });
    expect(upsertFontSummary(base, karantina).families.map((f) => f.slug)).toEqual([
      'heebo',
      'karantina',
      'rubik',
    ]);
    expect(upsertFontSummary(base, bebas).families.map((f) => f.slug)).toEqual([
      'bebas-neue',
      'heebo',
      'rubik',
    ]);
    expect(upsertFontSummary(base, zilla).families.map((f) => f.slug)).toEqual([
      'heebo',
      'rubik',
      'zilla',
    ]);
  });

  it('keeps a family that is there in its place', () => {
    const changed = { ...rubik, used: 5, usedLabel: '5 jobs' };
    expect(upsertFontSummary(base, changed).families).toEqual([heebo, changed]);
  });

  it('leaves the catalog and the requests alone', () => {
    const full: FontsListResponse = {
      ...base,
      catalog: [heeboBold],
      requests: [makeFontRequest()],
    };
    const next = upsertFontSummary(full, outfit);
    expect(next.catalog).toBe(full.catalog);
    expect(next.requests).toBe(full.requests);
  });
});

describe('removeFontSummary', () => {
  it('drops the family and its faces, and no other family’s', () => {
    const full: FontsListResponse = {
      families: [heebo, outfit],
      catalog: [heeboBold, outfitBold],
      requests: [],
    };
    const next = removeFontSummary(full, 'heebo');
    expect(next.families).toEqual([outfit]);
    expect(next.catalog).toEqual([outfitBold]);
  });

  it('finds a family’s faces whatever the case of their family name', () => {
    const full: FontsListResponse = {
      families: [heebo],
      catalog: [{ ...heeboBold, family: 'HEEBO' }],
      requests: [],
    };
    expect(removeFontSummary(full, 'heebo').catalog).toEqual([]);
  });

  it('leaves a list without that slug as it is', () => {
    expect(removeFontSummary(base, 'nothing')).toBe(base);
  });
});

describe('applyFontSummary', () => {
  it('goes into the list and over a pane that is cached', () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail({ used: 14, usedIn: 14 }));
    const used = { ...heebo, used: 15, usedLabel: '15 jobs' };

    applyFontSummary(queryClient, used);

    expect(list()?.families[0]).toEqual(used);
    expect(queryClient.getQueryData(fontKey('heebo'))).toMatchObject({
      used: 15,
      usedLabel: '15 jobs',
      usedIn: 15,
      faces: [heeboBold],
    });
  });

  it('keeps a hidden "Used in" row hidden', () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail({ usedIn: null }));
    applyFontSummary(queryClient, { ...heebo, used: 3, usedLabel: '3 jobs' });
    expect(queryClient.getQueryData<FontFamilyDetail>(fontKey('heebo'))?.usedIn).toBeNull();
  });

  it('leaves a list and a pane nobody loaded alone', () => {
    applyFontSummary(queryClient, heebo);
    expect(list()).toBeUndefined();
    expect(queryClient.getQueryData(fontKey('heebo'))).toBeUndefined();
  });
});

describe('facesNeedReload and applyFontChanged', () => {
  it('say nothing needs asking when the list is not loaded', () => {
    expect(facesNeedReload(undefined, heebo)).toBe(false);
  });

  it('ask for the faces of a family the list did not have, or whose weights or added time moved', () => {
    seed();
    const cached = list();
    expect(facesNeedReload(cached, rubik)).toBe(true);
    expect(facesNeedReload(cached, { ...heebo, weights: [400, 700] })).toBe(true);
    expect(facesNeedReload(cached, { ...heebo, addedAt: '2026-10-25T10:00:00.000Z' })).toBe(true);
    expect(facesNeedReload(cached, { ...heebo, used: 99, usedLabel: '99 jobs' })).toBe(false);
  });

  it('ask when a summary shows nothing new: a face with the weights the family had (an italic)', () => {
    seed();
    const cached = list();
    expect(facesNeedReload(cached, heebo)).toBe(true);
    expect(facesNeedReload(cached, { ...heebo, he: false })).toBe(true);
    expect(facesNeedReload(cached, { ...heebo, style: 'Display' })).toBe(true);
  });

  it('do not ask for a use that moved, whatever else the event says about the clock', () => {
    seed();
    const cached = list();
    expect(facesNeedReload(cached, { ...heebo, used: 15, usedLabel: '15 jobs', isNew: true })).toBe(
      false,
    );
  });

  it('patches in place when only the use moved: nothing is asked for again', () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());

    applyFontChanged(queryClient, {
      type: 'font.changed',
      family: { ...heebo, used: 15, usedLabel: '15 jobs' },
    });

    expect(list()?.families[0]).toMatchObject({ used: 15 });
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(false);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(false);
  });

  it('adds a new family and asks for the catalog and the pane again', () => {
    seed();
    queryClient.setQueryData(fontKey('rubik'), makeFontFamilyDetail({ slug: 'rubik' }));

    applyFontChanged(queryClient, { type: 'font.changed', family: rubik });

    expect(list()?.families.map((family) => family.slug)).toEqual(['heebo', 'outfit', 'rubik']);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('rubik'))?.isInvalidated).toBe(true);
  });
});

describe('a font.changed that adds only an italic of a weight the family has', () => {
  const answered: FontsListResponse = {
    families: [heebo, outfit],
    catalog: [heeboBold, heeboBoldItalic, outfitBold],
    requests: [],
  };

  it('asks the server again, so the bar of the request it settled goes and the face comes', async () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    const page = openPage(() => answered);

    applyFontChanged(queryClient, { type: 'font.changed', family: heebo });

    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(true);
    await vi.waitFor(() => expect(list()?.requests).toEqual([]));
    expect(list()?.catalog).toEqual(answered.catalog);
    expect(page.asked()).toBe(1);
    page.close();
  });

  it('leaves the list and its open requests alone when only the use moved', async () => {
    seed();
    const page = openPage(() => answered);

    applyFontChanged(queryClient, {
      type: 'font.changed',
      family: { ...heebo, used: 15, usedLabel: '15 jobs' },
    });
    await Promise.resolve();

    expect(page.asked()).toBe(0);
    expect(list()?.requests).toEqual([makeFontRequest()]);
    expect(list()?.catalog).toEqual([heeboBold, outfitBold]);
    page.close();
  });
});

describe('applyFontsImported', () => {
  it('puts the new families in the list and asks for the catalog, the requests and the panes again', () => {
    seed();
    queryClient.setQueryData(fontKey('rubik'), makeFontFamilyDetail({ slug: 'rubik' }));

    applyFontsImported(queryClient, [rubik]);

    expect(list()?.families.map((family) => family.slug)).toEqual(['heebo', 'outfit', 'rubik']);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('rubik'))?.isInvalidated).toBe(true);
  });
});

describe('removeFont', () => {
  it('takes the family and its faces out of the list and resets its pane', () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());

    removeFont(queryClient, 'heebo');

    expect(list()?.families).toEqual([outfit]);
    expect(list()?.catalog).toEqual([outfitBold]);
    expect(queryClient.getQueryData(fontKey('heebo'))).toBeUndefined();
  });

  it('is fine for a list that is not loaded', () => {
    expect(() => removeFont(queryClient, 'heebo')).not.toThrow();
    expect(list()).toBeUndefined();
  });
});

describe('reloadFonts', () => {
  it('invalidates the list and every pane', async () => {
    seed();
    queryClient.setQueryData(fontKey('heebo'), makeFontFamilyDetail());
    await reloadFonts(queryClient);
    expect(queryClient.getQueryState(FONT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(fontKey('heebo'))?.isInvalidated).toBe(true);
  });
});

describe('fontSummaryOf', () => {
  it('is the summary fields of a pane, and nothing else', () => {
    expect(fontSummaryOf(makeFontFamilyDetail())).toEqual(heebo);
  });
});

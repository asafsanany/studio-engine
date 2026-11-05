import type { LutChangedEvent, LutDetail, LutListResponse } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { beforeEach, describe, expect, it } from 'vitest';
import {
  applyLutChanged,
  applyLutDetail,
  applyLutSummary,
  applyLutsImported,
  lutSummaryOf,
  paneNeedsReload,
  reloadLuts,
  removeLut,
  removeLutSummary,
  upsertLutSummary,
} from './luts-cache';
import { LUT_LIST_KEY, lutKey } from './luts-query';
import {
  createTestQueryClient,
  makeBuiltInLutSummary,
  makeLutDetail,
  makeLutSummary,
} from './test-utils';

let queryClient: QueryClient;
beforeEach(() => {
  queryClient = createTestQueryClient();
});

const older = makeLutSummary({
  slug: 'teal-orange-soft',
  name: 'Teal Orange Soft',
  addedAt: '2026-10-20T10:00:00.000Z',
});
const newer = makeLutSummary({
  slug: 'moody-forest',
  name: 'Moody Forest',
  addedAt: '2026-10-23T10:00:00.000Z',
});
const builtIn = makeBuiltInLutSummary();

function list(): LutListResponse | undefined {
  return queryClient.getQueryData<LutListResponse>(LUT_LIST_KEY);
}

function seed(yours = [newer, older]): void {
  queryClient.setQueryData<LutListResponse>(LUT_LIST_KEY, {
    yours,
    builtIn: [builtIn],
    builtInAvailable: true,
  });
}

describe('upsertLutSummary', () => {
  it('puts a new LUT of Yours where its import time puts it, newest first', () => {
    const base = { yours: [newer, older], builtIn: [], builtInAvailable: true };
    const fresh = makeLutSummary({ slug: 'fresh', addedAt: '2026-10-24T09:00:00.000Z' });
    const middle = makeLutSummary({ slug: 'middle', addedAt: '2026-10-21T09:00:00.000Z' });
    expect(upsertLutSummary(base, fresh).yours.map((l) => l.slug)).toEqual([
      'fresh',
      'moody-forest',
      'teal-orange-soft',
    ]);
    expect(upsertLutSummary(base, middle).yours.map((l) => l.slug)).toEqual([
      'moody-forest',
      'middle',
      'teal-orange-soft',
    ]);
  });

  it('keeps a LUT that is there in its place', () => {
    const base = { yours: [newer, older], builtIn: [], builtInAvailable: true };
    const changed = { ...older, used: 5, usedLabel: '5 jobs' };
    expect(upsertLutSummary(base, changed).yours).toEqual([newer, changed]);
  });

  it('changes a built-in row in place, and never adds one', () => {
    const base = { yours: [], builtIn: [builtIn], builtInAvailable: true };
    const used = { ...builtIn, used: 2, usedLabel: '2 jobs' };
    expect(upsertLutSummary(base, used).builtIn).toEqual([used]);
    const stranger = makeBuiltInLutSummary({ slug: 'unknown-row' });
    expect(upsertLutSummary(base, stranger).builtIn).toEqual([builtIn]);
  });

  it('leaves the input alone', () => {
    const base = { yours: [newer], builtIn: [], builtInAvailable: true };
    upsertLutSummary(base, older);
    expect(base.yours).toEqual([newer]);
  });
});

describe('removeLutSummary', () => {
  it('drops a LUT of Yours by slug and keeps the rest', () => {
    const base = { yours: [newer, older], builtIn: [builtIn], builtInAvailable: true };
    expect(removeLutSummary(base, 'moody-forest')).toEqual({ ...base, yours: [older] });
    expect(removeLutSummary(base, 'film-contrast').builtIn).toEqual([builtIn]);
  });
});

describe('applyLutSummary', () => {
  it('writes into the list and over the cached pane', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer, usedIn: 3 }));

    applyLutSummary(queryClient, { ...newer, kind: 'fix', used: 4, usedLabel: '4 jobs' });

    expect(list()?.yours[0]).toMatchObject({ slug: 'moody-forest', kind: 'fix', used: 4 });
    expect(queryClient.getQueryData<LutDetail>(lutKey('moody-forest'))).toMatchObject({
      kind: 'fix',
      used: 4,
      usedIn: 4,
      description: 'Gold-amber highlights over slightly cool shadows.',
    });
  });

  it('keeps the Used in row hidden while the pane has none', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer, usedIn: null }));
    applyLutSummary(queryClient, { ...newer, used: 9 });
    expect(queryClient.getQueryData<LutDetail>(lutKey('moody-forest'))?.usedIn).toBeNull();
  });

  it('leaves caches nobody loaded alone', () => {
    applyLutSummary(queryClient, newer);
    expect(list()).toBeUndefined();
    expect(queryClient.getQueryData(lutKey('moody-forest'))).toBeUndefined();
  });
});

describe('applyLutChanged', () => {
  const event = (lut = newer): LutChangedEvent => ({ type: 'lut.changed', lut });

  it('asks the pane again when the name changed, and not otherwise', () => {
    const cached = makeLutDetail({ ...newer });
    expect(paneNeedsReload(cached, event({ ...newer, used: 2 }))).toBe(false);
    expect(paneNeedsReload(cached, event({ ...newer, name: 'Moody Forest 2' }))).toBe(true);
    expect(paneNeedsReload(undefined, event())).toBe(false);
  });

  it('invalidates the changed LUT’s pane when the name moved', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer }));
    applyLutChanged(queryClient, event({ ...newer, name: 'Moody Forest 2' }));
    expect(queryClient.getQueryState(lutKey('moody-forest'))?.isInvalidated).toBe(true);
    expect(list()?.yours[0]?.name).toBe('Moody Forest 2');
  });

  it('only patches when the name stayed', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer }));
    applyLutChanged(queryClient, event({ ...newer, used: 1, usedLabel: '1 job' }));
    expect(queryClient.getQueryState(lutKey('moody-forest'))?.isInvalidated).toBe(false);
  });
});

describe('applyLutDetail', () => {
  it('is the pane, and its summary goes into the list', () => {
    seed();
    const copy = makeLutDetail({
      slug: 'film-contrast-2',
      name: 'Film contrast (2)',
      addedAt: '2026-10-24T10:00:00.000Z',
    });
    applyLutDetail(queryClient, copy);
    expect(queryClient.getQueryData(lutKey('film-contrast-2'))).toEqual(copy);
    expect(list()?.yours.map((l) => l.slug)).toEqual([
      'film-contrast-2',
      'moody-forest',
      'teal-orange-soft',
    ]);
    expect(list()?.yours[0]).toEqual(lutSummaryOf(copy));
  });

  it('moves a renamed LUT: the old slug leaves the list and its pane is reset', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer }));
    const renamed = makeLutDetail({ ...newer, slug: 'dark-forest', name: 'Dark Forest' });

    applyLutDetail(queryClient, renamed, 'moody-forest');

    expect(list()?.yours.map((l) => l.slug)).toEqual(['dark-forest', 'teal-orange-soft']);
    expect(queryClient.getQueryData(lutKey('moody-forest'))).toBeUndefined();
    expect(queryClient.getQueryData(lutKey('dark-forest'))).toEqual(renamed);
  });

  it('keeps everything when the slug stayed', () => {
    seed();
    const same = makeLutDetail({ ...newer, kind: 'camera' });
    applyLutDetail(queryClient, same, 'moody-forest');
    expect(list()?.yours.map((l) => l.slug)).toEqual(['moody-forest', 'teal-orange-soft']);
    expect(list()?.yours[0]?.kind).toBe('camera');
  });
});

describe('applyLutsImported', () => {
  it('adds each new row to Yours, newest first', () => {
    seed();
    const a = makeLutSummary({ slug: 'a', addedAt: '2026-10-24T10:00:00.000Z', isNew: true });
    const b = makeLutSummary({ slug: 'b', addedAt: '2026-10-24T10:00:01.000Z', isNew: true });
    applyLutsImported(queryClient, [a, b]);
    expect(list()?.yours.map((l) => l.slug)).toEqual([
      'b',
      'a',
      'moody-forest',
      'teal-orange-soft',
    ]);
  });
});

describe('removeLut', () => {
  it('takes the LUT out of Yours and resets its pane', () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer }));
    removeLut(queryClient, 'moody-forest');
    expect(list()?.yours.map((l) => l.slug)).toEqual(['teal-orange-soft']);
    expect(queryClient.getQueryData(lutKey('moody-forest'))).toBeUndefined();
  });
});

describe('reloadLuts', () => {
  it('invalidates every LUTs query', async () => {
    seed();
    queryClient.setQueryData(lutKey('moody-forest'), makeLutDetail({ ...newer }));
    await reloadLuts(queryClient);
    expect(queryClient.getQueryState(LUT_LIST_KEY)?.isInvalidated).toBe(true);
    expect(queryClient.getQueryState(lutKey('moody-forest'))?.isInvalidated).toBe(true);
  });
});

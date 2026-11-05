import type { LutListResponse } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeBuiltInLutSummary, makeLutSummary } from '@/data/test-utils';
import {
  allLuts,
  bodyStateOf,
  deleteBodyText,
  effectiveSelection,
  isLutTab,
  lutDetailText,
  lutFileNames,
  lutMenuEntries,
  matchesQuery,
  noMatchText,
  showBuiltInMissing,
  shownSlugs,
  showsNewTag,
  showYoursHead,
  showYoursHint,
  successorOf,
  tabCounts,
  visibleLuts,
  wentToTrash,
} from './lut-list';

const golden = makeLutSummary();
const soft = makeLutSummary({ slug: 'soft-pastel', name: 'Soft Pastel', size: 17 });
const sony = makeLutSummary({
  slug: 'sony-s-log3-to-rec709',
  name: 'Sony S-Log3 to Rec709',
  kind: 'camera',
  size: 65,
});
const film = makeBuiltInLutSummary();
const redSkin = makeBuiltInLutSummary({
  slug: 'red-skin-fix',
  name: 'Red skin fix',
  kind: 'fix',
});
const cinematic = makeBuiltInLutSummary({ slug: 'cinematic', name: 'Cinematic' });

const LIST: LutListResponse = {
  yours: [golden, soft, sony],
  builtIn: [cinematic, film, redSkin],
  builtInAvailable: true,
};
const EMPTY: LutListResponse = { yours: [], builtIn: [], builtInAvailable: true };

describe('tabs and counts', () => {
  it('knows the four tab words', () => {
    expect(['all', 'look', 'camera', 'fix'].every(isLutTab)).toBe(true);
    expect(isLutTab('looks')).toBe(false);
    expect(isLutTab(undefined)).toBe(false);
  });

  it('counts the whole library per tab, Yours and Built in together', () => {
    expect(tabCounts(LIST)).toEqual({ all: 6, look: 4, camera: 1, fix: 1 });
    expect(tabCounts(EMPTY)).toEqual({ all: 0, look: 0, camera: 0, fix: 0 });
  });

  it('lists Yours before Built in', () => {
    expect(allLuts(LIST).map((lut) => lut.slug)).toEqual([
      'golden-hour-warm',
      'soft-pastel',
      'sony-s-log3-to-rec709',
      'cinematic',
      'film-contrast',
      'red-skin-fix',
    ]);
  });
});

describe('search and the tab filter', () => {
  it('finds a LUT by name, slug or file name, without regard to case', () => {
    expect(matchesQuery(golden, 'golden')).toBe(true);
    expect(matchesQuery(golden, '  HOUR ')).toBe(true);
    expect(matchesQuery(golden, 'golden-hour')).toBe(true);
    expect(matchesQuery(golden, 'Hour Warm.cube')).toBe(true);
    expect(matchesQuery(golden, 'pastel')).toBe(false);
  });

  it('finds a built-in LUT by the skill’s file name, and a blank search matches everything', () => {
    expect(lutFileNames(film)).toEqual(['film_contrast.cube']);
    expect(matchesQuery(film, 'film_contrast')).toBe(true);
    expect(lutFileNames(cinematic)).toEqual([]);
    expect(matchesQuery(cinematic, '')).toBe(true);
    expect(matchesQuery(cinematic, '   ')).toBe(true);
  });

  it('keeps the two sections apart and applies the tab', () => {
    const looks = visibleLuts(LIST, 'look', '');
    expect(looks.yours.map((lut) => lut.slug)).toEqual(['golden-hour-warm', 'soft-pastel']);
    expect(looks.builtIn.map((lut) => lut.slug)).toEqual(['cinematic', 'film-contrast']);
    const camera = visibleLuts(LIST, 'camera', '');
    expect(shownSlugs(camera)).toEqual(['sony-s-log3-to-rec709']);
    const fix = visibleLuts(LIST, 'fix', '');
    expect(shownSlugs(fix)).toEqual(['red-skin-fix']);
  });

  it('applies the tab and the search together', () => {
    expect(shownSlugs(visibleLuts(LIST, 'all', 'film'))).toEqual(['film-contrast']);
    expect(shownSlugs(visibleLuts(LIST, 'camera', 'film'))).toEqual([]);
    expect(shownSlugs(visibleLuts(LIST, 'all', ''))).toHaveLength(6);
  });
});

describe('sections, hints and empty states', () => {
  it('shows the Yours hint only on All with no search and nothing imported', () => {
    const none = visibleLuts({ ...LIST, yours: [] }, 'all', '');
    expect(showYoursHint(none, 'all', '')).toBe(true);
    expect(showYoursHead(none, 'all', '')).toBe(true);
    expect(showYoursHint(none, 'look', '')).toBe(false);
    expect(showYoursHint(none, 'all', 'zzz')).toBe(false);
    expect(showYoursHead(none, 'look', '')).toBe(false);
    expect(showYoursHint(visibleLuts(LIST, 'all', ''), 'all', '')).toBe(false);
    expect(showYoursHead(visibleLuts(LIST, 'all', ''), 'all', '')).toBe(true);
  });

  it('replaces Built in with the one line while the colour grade is not installed (All, no search)', () => {
    const missing: LutListResponse = { yours: [golden], builtIn: [], builtInAvailable: false };
    expect(showBuiltInMissing(missing, 'all', '')).toBe(true);
    expect(showBuiltInMissing(missing, 'look', '')).toBe(false);
    expect(showBuiltInMissing(missing, 'all', 'gold')).toBe(false);
    expect(showBuiltInMissing(LIST, 'all', '')).toBe(false);
  });

  it('words the no-match line with the search text, or says the tab is empty', () => {
    expect(noMatchText(' zzz ')).toBe('No LUT matches “zzz”.');
    expect(noMatchText('')).toBe('Nothing in this tab yet.');
  });

  it('is loading until the first answer, unreachable if it never came, and rows afterwards', () => {
    expect(bodyStateOf({ list: undefined, failed: false })).toBe('loading');
    expect(bodyStateOf({ list: undefined, failed: true })).toBe('unreachable');
    expect(bodyStateOf({ list: LIST, failed: true })).toBe('rows');
  });
});

describe('which LUT is open', () => {
  const shown = ['a', 'b', 'c'];

  it('keeps the selected LUT while it is shown', () => {
    expect(effectiveSelection('b', shown)).toBe('b');
  });

  it('opens the first row when none is selected', () => {
    expect(effectiveSelection(null, shown)).toBe('a');
  });

  it('opens the first row when the selected one is hidden or gone', () => {
    expect(effectiveSelection('zzz', shown)).toBe('a');
  });

  it('is nothing when no row is shown', () => {
    expect(effectiveSelection('a', [])).toBeNull();
    expect(effectiveSelection(null, [])).toBeNull();
  });

  it('follows a rename while the address still holds the old slug', () => {
    expect(effectiveSelection('old', ['x', 'new'], new Map([['old', 'new']]))).toBe('new');
  });

  it('moves to the next row once a deleted one is gone, not to the first', () => {
    const successors = new Map([['b', 'c']]);
    expect(effectiveSelection('b', ['a', 'c'], new Map(), successors)).toBe('c');
    // still there (the delete was refused): nothing moves
    expect(effectiveSelection('b', shown, new Map(), successors)).toBe('b');
    // the follower is gone too: back to the first row
    expect(effectiveSelection('b', ['a'], new Map(), successors)).toBe('a');
  });

  it('names the row below a deleted one, else the one above, else none', () => {
    expect(successorOf(['a', 'b', 'c'], 'a')).toBe('b');
    expect(successorOf(['a', 'b', 'c'], 'b')).toBe('c');
    expect(successorOf(['a', 'b', 'c'], 'c')).toBe('b');
    expect(successorOf(['a'], 'a')).toBeNull();
    expect(successorOf(['a'], 'zzz')).toBeNull();
  });
});

describe('a row’s words', () => {
  it('says the kind and the grid', () => {
    expect(lutDetailText(golden)).toBe('Look · 33³');
    expect(lutDetailText(sony)).toBe('Camera · 65³');
    expect(lutDetailText(redSkin)).toBe('Fix · 33³');
  });

  it('keeps the New tag for 30 minutes from the added time, whatever the server said', () => {
    const added = '2026-10-24T12:00:00.000Z';
    const at = (minutes: number) => Date.parse(added) + minutes * 60_000;
    expect(showsNewTag({ addedAt: added }, at(1))).toBe(true);
    expect(showsNewTag({ addedAt: added }, at(29))).toBe(true);
    expect(showsNewTag({ addedAt: added }, at(30))).toBe(false);
    expect(showsNewTag({ addedAt: null }, at(1))).toBe(false);
  });
});

describe('the right-click menu', () => {
  const ids = (lut: Parameters<typeof lutMenuEntries>[0], lutsInEdits: boolean) =>
    lutMenuEntries(lut, { lutsInEdits }).map((entry) =>
      entry.type === 'separator' ? '—' : entry.label,
    );

  it('has Rename, Show in Finder, Duplicate, Copy @luts/name, a line and Delete… for Yours', () => {
    expect(ids(golden, true)).toEqual([
      'Rename',
      'Show in Finder',
      'Duplicate',
      'Copy @luts/golden-hour-warm',
      '—',
      'Delete…',
    ]);
  });

  it('has Show in Finder, Duplicate to Yours and Copy @luts/name for Built in, with no Rename or Delete', () => {
    expect(ids(film, true)).toEqual([
      'Show in Finder',
      'Duplicate to Yours',
      'Copy @luts/film-contrast',
    ]);
  });

  it('hides Copy @luts/name while notes cannot name a LUT yet', () => {
    expect(ids(golden, false)).toEqual(['Rename', 'Show in Finder', 'Duplicate', '—', 'Delete…']);
    expect(ids(film, false)).toEqual(['Show in Finder', 'Duplicate to Yours']);
  });

  it('makes Delete… the one red item', () => {
    const entries = lutMenuEntries(golden, { lutsInEdits: true });
    const red = entries.filter((entry) => entry.type === 'item' && entry.destructive);
    expect(red.map((entry) => (entry.type === 'item' ? entry.id : ''))).toEqual(['delete']);
  });

  it('disables Show in Finder for the Cinematic look, which has no file, and says why', () => {
    const entry = lutMenuEntries(cinematic, { lutsInEdits: false })[0];
    expect(entry).toMatchObject({ id: 'reveal', disabled: true });
    expect(entry).toMatchObject({ disabledReason: expect.stringContaining('no file') });
    const normal = lutMenuEntries(film, { lutsInEdits: false })[0];
    expect(normal).toMatchObject({ id: 'reveal', disabled: false });
  });
});

describe('the delete dialog’s words', () => {
  it('warns about notes only while notes can name a LUT', () => {
    expect(deleteBodyText({ lutsInEdits: true })).toBe(
      'Jobs already made keep their look. Notes that name it stop working. It goes to the Trash, so you can get it back from there.',
    );
    expect(deleteBodyText({ lutsInEdits: false })).toBe(
      'Jobs already made keep their look. It goes to the Trash, so you can get it back from there.',
    );
  });

  it('tells the Trash from the engine’s fallback place', () => {
    expect(wentToTrash('/Users/owner/.Trash')).toBe(true);
    expect(wentToTrash('/Users/owner/.Trash/LUTs')).toBe(true);
    expect(wentToTrash('/Users/owner/.studio-engine/deleted-luts')).toBe(false);
  });
});

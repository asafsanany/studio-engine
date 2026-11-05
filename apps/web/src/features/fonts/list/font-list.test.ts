import { describe, expect, it } from 'vitest';
import { makeFontFamilySummary } from '@/data/test-utils';
import {
  bodyStateOf,
  deleteAfterText,
  deleteBodyText,
  effectiveSelection,
  FONT_LIST_TEXT,
  FONT_TAB_LABELS,
  FONT_TABS,
  fontMenuEntries,
  fontToken,
  inTab,
  isFontTab,
  matchesQuery,
  noMatchText,
  offlineBannerText,
  scriptText,
  showsNewTag,
  sortedFamilies,
  tabCounts,
  visibleFamilies,
} from './font-list';
import { makeRealFamilies } from './real-families-fixture';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW - minutes * 60_000).toISOString();

const real = makeRealFamilies();
const names = (families: readonly { name: string }[]) => families.map((family) => family.name);

describe('the 40 real families', () => {
  it('counts 40 · 20 · 20 over the whole library', () => {
    expect(real).toHaveLength(40);
    expect(tabCounts(real)).toEqual({ all: 40, he: 20, en: 20 });
  });

  it('has the three tabs in the board’s words', () => {
    expect(FONT_TABS).toEqual(['all', 'he', 'en']);
    expect(FONT_TAB_LABELS).toEqual({
      all: 'All',
      he: 'Hebrew + English',
      en: 'English only',
    });
    expect(isFontTab('he')).toBe(true);
    expect(isFontTab('sideways')).toBe(false);
    expect(isFontTab(undefined)).toBe(false);
  });

  it('puts the Hebrew ones under Hebrew + English and the rest under English only', () => {
    expect(visibleFamilies(real, 'he', '', NOW)).toHaveLength(20);
    expect(visibleFamilies(real, 'en', '', NOW)).toHaveLength(20);
    expect(visibleFamilies(real, 'all', '', NOW)).toHaveLength(40);
    expect(visibleFamilies(real, 'he', '', NOW).every((family) => family.he)).toBe(true);
    expect(visibleFamilies(real, 'en', '', NOW).every((family) => !family.he)).toBe(true);
    expect(inTab(real[0] as (typeof real)[number], 'all')).toBe(true);
  });

  it('draws them A to Z without regard to case, mixing the scripts', () => {
    const shown = names(visibleFamilies(real, 'all', '', NOW));
    expect(shown[0]).toBe('Alef');
    expect(shown[1]).toBe('Amatic SC');
    expect(shown).toContain('DM Sans');
    // "DM Sans" sorts between "David Libre" and "Frank Ruhl Libre", not among the capitals first.
    expect(shown.indexOf('David Libre')).toBeLessThan(shown.indexOf('DM Sans'));
    expect(shown.indexOf('DM Sans')).toBeLessThan(shown.indexOf('Frank Ruhl Libre'));
    expect(shown).toEqual(
      [...shown].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' })),
    );
    expect(shown.at(-1)).toBe('Work Sans');
  });

  it('matches the search against the family name, without regard to case or stray spaces', () => {
    expect(names(visibleFamilies(real, 'all', 'heebo', NOW))).toEqual(['Heebo']);
    expect(names(visibleFamilies(real, 'all', '  HEEBO ', NOW))).toEqual(['Heebo']);
    expect(names(visibleFamilies(real, 'all', 'noto', NOW))).toEqual([
      'Noto Sans',
      'Noto Sans Hebrew',
    ]);
    expect(names(visibleFamilies(real, 'all', 'roboto', NOW))).toEqual([
      'Roboto',
      'Roboto Condensed',
      'Roboto Slab',
    ]);
    expect(names(visibleFamilies(real, 'all', 'rubik  spray', NOW))).toEqual(['Rubik Spray Paint']);
  });

  it('keeps the tab and the search together', () => {
    expect(names(visibleFamilies(real, 'he', 'noto', NOW))).toEqual(['Noto Sans Hebrew']);
    expect(names(visibleFamilies(real, 'en', 'noto', NOW))).toEqual(['Noto Sans']);
    expect(visibleFamilies(real, 'en', 'heebo', NOW)).toEqual([]);
  });

  it('matches by name only, not by the style, the script or the weights', () => {
    expect(visibleFamilies(real, 'all', 'serif', NOW)).toEqual([]);
    expect(visibleFamilies(real, 'all', 'hebrew', NOW).map((family) => family.name)).toEqual([
      'IBM Plex Sans Hebrew',
      'Noto Sans Hebrew',
    ]);
    expect(matchesQuery({ name: 'Heebo' }, '')).toBe(true);
    expect(matchesQuery({ name: 'Heebo' }, '   ')).toBe(true);
  });

  it('says the script of a row in the pane’s words', () => {
    expect(scriptText({ he: true })).toBe('Hebrew + English');
    expect(scriptText({ he: false })).toBe('English only');
  });
});

describe('New families', () => {
  const fresh = makeFontFamilySummary({
    slug: 'zeta',
    name: 'Zeta',
    addedAt: minutesAgo(5),
    isNew: true,
  });
  const fresher = makeFontFamilySummary({
    slug: 'yodel',
    name: 'Yodel',
    addedAt: minutesAgo(1),
    isNew: true,
  });

  it('sorts a family that is new above the A to Z rows, the newest first', () => {
    const shown = names(sortedFamilies([...real, fresh, fresher], NOW));
    expect(shown.slice(0, 3)).toEqual(['Yodel', 'Zeta', 'Alef']);
    expect(shown).toHaveLength(42);
  });

  it('keeps the new ones on top inside a tab and a search', () => {
    const family = makeFontFamilySummary({
      slug: 'hebrew-new',
      name: 'Karantina',
      he: true,
      addedAt: minutesAgo(2),
      isNew: true,
    });
    const list = [...real, family];
    expect(names(visibleFamilies(list, 'he', '', NOW)).slice(0, 2)).toEqual(['Karantina', 'Alef']);
    expect(names(visibleFamilies(list, 'en', '', NOW))).not.toContain('Karantina');
    expect(names(visibleFamilies(list, 'all', 'karan', NOW))).toEqual(['Karantina']);
  });

  it('shows the tag while the server says new and the 30 minutes are not over', () => {
    expect(showsNewTag(fresh, NOW)).toBe(true);
    expect(showsNewTag(makeFontFamilySummary({ isNew: false, addedAt: minutesAgo(5) }), NOW)).toBe(
      false,
    );
  });

  it('works the end of the 30 minutes out on the page’s own clock', () => {
    const edge = makeFontFamilySummary({ isNew: true, addedAt: minutesAgo(29) });
    expect(showsNewTag(edge, NOW)).toBe(true);
    const over = makeFontFamilySummary({ isNew: true, addedAt: minutesAgo(31) });
    expect(showsNewTag(over, NOW)).toBe(false);
    expect(showsNewTag(over, NOW - 10 * 60_000)).toBe(true);
    // Once it has ended the family goes back to its A to Z place.
    expect(names(sortedFamilies([over, ...real], NOW)).slice(0, 2)).toEqual(['Alef', 'Amatic SC']);
  });
});

describe('the open family', () => {
  const shown = [{ slug: 'alef' }, { slug: 'heebo' }];

  it('is the one the address names while it is shown', () => {
    expect(effectiveSelection('heebo', shown)).toBe('heebo');
  });

  it('is the first row when the address names none, a hidden one or one that is gone', () => {
    expect(effectiveSelection(null, shown)).toBe('alef');
    expect(effectiveSelection('poppins', shown)).toBe('alef');
  });

  it('is none when no row is shown', () => {
    expect(effectiveSelection(null, [])).toBeNull();
    expect(effectiveSelection('heebo', [])).toBeNull();
  });
});

describe('the body of the list', () => {
  it('is loading, unreachable or the rows', () => {
    expect(bodyStateOf({ families: undefined, failed: false })).toBe('loading');
    expect(bodyStateOf({ families: undefined, failed: true })).toBe('unreachable');
    expect(bodyStateOf({ families: [], failed: true })).toBe('rows');
    expect(bodyStateOf({ families: real, failed: false })).toBe('rows');
  });

  it('says what is missing when the tab and the search leave nothing', () => {
    expect(noMatchText('Gotham')).toBe('No font matches “Gotham”.');
    expect(noMatchText('  gotham ')).toBe('No font matches “gotham”.');
    expect(noMatchText('')).toBe('Nothing in this tab yet.');
  });
});

describe('the right-click menu', () => {
  it('has Show in Finder, Copy @name, a line and a red Delete… once notes can name a font', () => {
    expect(fontMenuEntries({ name: 'Heebo' }, { inNotes: true })).toEqual([
      { type: 'item', id: 'reveal', label: 'Show in Finder' },
      { type: 'item', id: 'copy', label: 'Copy @Heebo' },
      { type: 'separator', id: 'before-delete' },
      { type: 'item', id: 'delete', label: 'Delete…', destructive: true },
    ]);
  });

  it('copies the family’s name with its spaces', () => {
    expect(fontToken('Amatic SC')).toBe('@Amatic SC');
    expect(fontMenuEntries({ name: 'Amatic SC' }, { inNotes: true })[1]).toMatchObject({
      label: 'Copy @Amatic SC',
    });
  });

  it('leaves Copy @name out while notes cannot name a font yet', () => {
    expect(fontMenuEntries({ name: 'Heebo' }, { inNotes: false })).toEqual([
      { type: 'item', id: 'reveal', label: 'Show in Finder' },
      { type: 'separator', id: 'before-delete' },
      { type: 'item', id: 'delete', label: 'Delete…', destructive: true },
    ]);
  });
});

describe('the delete dialog’s first sentence', () => {
  const heebo = makeFontFamilySummary();
  const IN_NOTES = { inNotes: true };

  it('says how many jobs use the family and that all its weights go (14 jobs)', () => {
    expect(deleteBodyText(heebo, IN_NOTES)).toBe('14 jobs use it. All 9 weights go.');
  });

  it('says "1 job uses it." for one job', () => {
    expect(deleteBodyText({ used: 1, weights: heebo.weights }, IN_NOTES)).toBe(
      '1 job uses it. All 9 weights go.',
    );
  });

  it('says "Not used by any job yet." for none (0 jobs)', () => {
    expect(deleteBodyText({ used: 0, weights: heebo.weights }, IN_NOTES)).toBe(
      'Not used by any job yet. All 9 weights go.',
    );
  });

  it('counts the family’s own weights, and does not say "All 1 weight go"', () => {
    expect(deleteBodyText({ used: 3, weights: [400, 700] }, IN_NOTES)).toBe(
      '3 jobs use it. All 2 weights go.',
    );
    expect(deleteBodyText({ used: 3, weights: [400] }, IN_NOTES)).toBe(
      '3 jobs use it. Its only weight goes.',
    );
  });
});

describe('the delete dialog while notes cannot name a font yet', () => {
  const heebo = makeFontFamilySummary();
  const OFF = { inNotes: false };

  it('says only what goes: no use is counted, so no "Not used by any job yet."', () => {
    expect(deleteBodyText(heebo, OFF)).toBe('All 9 weights go.');
    expect(deleteBodyText({ used: 0, weights: heebo.weights }, OFF)).toBe('All 9 weights go.');
    expect(deleteBodyText({ used: 3, weights: [400] }, OFF)).toBe('Its only weight goes.');
  });

  it('keeps the second paragraph but not "notes that name it stop working"', () => {
    expect(deleteAfterText(true)).toBe(FONT_LIST_TEXT.deleteAfter);
    expect(deleteAfterText(true)).toContain('notes that name it stop working');
    expect(deleteAfterText(false)).toBe(
      'Videos already made keep it. A retry or a new round on those jobs would use another font. It goes to the Trash, so you can get it back from there.',
    );
    expect(deleteAfterText(false)).not.toMatch(/notes/i);
  });
});

describe('the offline bar', () => {
  it('says when the list was last right, and that importing waits', () => {
    const heard = new Date(2026, 9, 24, 10, 42).getTime();
    expect(offlineBannerText(heard)).toBe(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. Importing waits until it’s back.',
    );
  });

  it('leaves the time out when the engine never answered', () => {
    expect(offlineBannerText(null)).toBe(
      'Can’t reach the engine on your Mac. Importing waits until it’s back.',
    );
  });
});

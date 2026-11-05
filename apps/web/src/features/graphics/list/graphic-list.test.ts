import { GRAPHIC_MESSAGES, graphicBusyMessage } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGraphicSummary } from '@/data/test-utils';
import {
  bodyStateOf,
  countText,
  filterGraphics,
  GRAPHICS_TEXT,
  type GraphicMenuEntry,
  graphicDetailText,
  graphicMenuEntries,
  heardAtLabel,
  kindLabel,
  lengthText,
  makingCount,
  makingText,
  offlineBannerText,
  retryLabel,
  wentToTrash,
} from './graphic-list';

const ready = makeGraphicSummary({ id: '000000000001', name: 'Name on a white pill' });
const making = makeGraphicSummary({
  id: '000000000002',
  name: 'Hours saved counter',
  kind: 'callout',
  lengthSec: null,
  version: null,
  status: 'making',
  makingVersion: 1,
});
const failed = makeGraphicSummary({
  id: '000000000003',
  name: 'Name with the client’s logo',
  status: 'failed',
  failedVersion: 3,
});
const hebrew = makeGraphicSummary({
  id: '000000000004',
  name: 'מיתוס או אמת – פתיחה',
  kind: 'title',
  lengthSec: 2.4,
});
const off = makeGraphicSummary({ id: '000000000005', name: 'Follow card', uses: false });

describe('the list’s words', () => {
  it('are the board’s', () => {
    expect(GRAPHICS_TEXT.intro).toBe(
      'Ask for a graphic in a chat. Every edit can use what’s here.',
    );
    expect(GRAPHICS_TEXT.deleteBody).toBe(
      'Edits stop using it. Videos already made keep it. It goes to the Trash, so you can get it back from there.',
    );
    expect(GRAPHICS_TEXT.emptyTitle).toBe('No graphics yet');
    expect(GRAPHICS_TEXT.unreachable).toBe('Can’t reach the engine.');
  });
});

describe('countText and makingText', () => {
  it('say "1 graphic" and "7 graphics", and "2 being made"', () => {
    expect(countText(1)).toBe('1 graphic');
    expect(countText(7)).toBe('7 graphics');
    expect(makingText(2)).toBe('2 being made');
  });

  it('count the graphics that are being made', () => {
    expect(makingCount([ready, making, failed, hebrew])).toBe(1);
    expect(makingCount([ready, failed])).toBe(0);
    expect(makingCount([making, { ...making, id: '00000000000a' }])).toBe(2);
  });
});

describe('filterGraphics', () => {
  const all = [ready, making, failed, hebrew, off];

  it('leaves everything for a blank search', () => {
    expect(filterGraphics(all, '')).toBe(all);
    expect(filterGraphics(all, '   ')).toBe(all);
  });

  it('keeps the names that have the text in them, without regard to case', () => {
    expect(filterGraphics(all, 'PILL').map((g) => g.id)).toEqual([ready.id]);
    expect(filterGraphics(all, 'name').map((g) => g.id)).toEqual([ready.id, failed.id]);
  });

  it('finds a Hebrew name and ignores the spaces around the search', () => {
    expect(filterGraphics(all, ' אמת ').map((g) => g.id)).toEqual([hebrew.id]);
  });

  it('finds a name typed in another Unicode form of the same letters', () => {
    const cafe = makeGraphicSummary({ id: '00000000000b', name: 'Café' });
    expect(filterGraphics([cafe], 'café').map((g) => g.id)).toEqual([cafe.id]);
  });

  it('leaves nothing for a text no name has', () => {
    expect(filterGraphics(all, 'zzz')).toEqual([]);
  });
});

describe('lengthText', () => {
  it('drops a whole number’s decimals and keeps one', () => {
    expect(lengthText(3)).toBe('3 s');
    expect(lengthText(2.4)).toBe('2.4 s');
    expect(lengthText(2.5000001)).toBe('2.5 s');
    expect(lengthText(0.5)).toBe('0.5 s');
  });
});

describe('graphicDetailText', () => {
  it('says the kind and the length of a ready graphic, quietly', () => {
    expect(graphicDetailText(ready)).toEqual({ text: 'Lower third · 3 s', tone: 'quiet' });
    expect(graphicDetailText(hebrew)).toEqual({ text: 'Title · 2.4 s', tone: 'quiet' });
  });

  it('adds "off for edits" in a quieter shade when edits do not use it', () => {
    expect(graphicDetailText(off)).toEqual({
      text: 'Lower third · 3 s · off for edits',
      tone: 'off',
    });
  });

  it('says which version is being made', () => {
    expect(graphicDetailText(making)).toEqual({ text: 'Making v1…', tone: 'making' });
    expect(graphicDetailText({ ...making, makingVersion: 4 }).text).toBe('Making v4…');
  });

  it('says which version could not be finished', () => {
    expect(graphicDetailText(failed)).toEqual({ text: 'Couldn’t finish v3', tone: 'failed' });
  });

  it('names a graphic with no kind yet "Graphic" and leaves the length out', () => {
    const none = makeGraphicSummary({ kind: null, lengthSec: null });
    expect(graphicDetailText(none).text).toBe('Graphic');
  });

  it('uses the shared name of every kind', () => {
    const kinds = ['title', 'lower-third', 'callout', 'end-card', 'other'] as const;
    expect(kinds.map((kind) => kindLabel({ kind }))).toEqual([
      'Title',
      'Lower third',
      'Callout',
      'End card',
      'Graphic',
    ]);
    expect(kindLabel({ kind: null })).toBe('Graphic');
  });
});

describe('retryLabel', () => {
  it('is "Retry vN" for a failed graphic and nothing for any other', () => {
    expect(retryLabel(failed)).toBe('Retry v3');
    expect(retryLabel(ready)).toBeNull();
    expect(retryLabel(making)).toBeNull();
  });
});

const items = (graphic: Parameters<typeof graphicMenuEntries>[0]): GraphicMenuEntry[] =>
  graphicMenuEntries(graphic).filter((entry): entry is GraphicMenuEntry => entry.type === 'item');

describe('graphicMenuEntries', () => {
  it('is Open, Rename, Duplicate, Show in Finder, Turn off for edits, Delete…, in groups', () => {
    const entries = graphicMenuEntries(ready);
    expect(entries.map((entry) => (entry.type === 'item' ? entry.label : '—'))).toEqual([
      'Open',
      'Rename',
      'Duplicate',
      'Show in Finder',
      '—',
      'Turn off for edits',
      '—',
      'Delete…',
    ]);
  });

  it('turns the edits item round for a graphic edits do not use', () => {
    expect(items(off).find((entry) => entry.id === 'uses')?.label).toBe('Turn on for edits');
    expect(items(ready).find((entry) => entry.id === 'uses')?.label).toBe('Turn off for edits');
  });

  it('makes Delete… the red one, and nothing else', () => {
    expect(
      items(ready)
        .filter((entry) => entry.destructive)
        .map((entry) => entry.id),
    ).toEqual(['delete']);
  });

  it('has every item enabled for a ready or failed graphic', () => {
    for (const graphic of [ready, failed, off, hebrew]) {
      expect(items(graphic).filter((entry) => entry.disabled)).toEqual([]);
    }
  });

  it('disables Rename while a version is being made, with the engine’s words', () => {
    const rename = items({ ...making, version: 2 }).find((entry) => entry.id === 'rename');
    expect(rename?.disabled).toBe(true);
    expect(rename?.disabledReason).toBe(graphicBusyMessage(1, 'rename'));
  });

  it('disables Duplicate until v1 exists, with the engine’s words', () => {
    const duplicate = items(making).find((entry) => entry.id === 'duplicate');
    expect(duplicate?.disabled).toBe(true);
    expect(duplicate?.disabledReason).toBe(GRAPHIC_MESSAGES.nothingToDuplicate);
    expect(items({ ...making, version: 2 }).find((e) => e.id === 'duplicate')?.disabled).toBe(
      false,
    );
  });

  it('leaves Open, Show in Finder, the edits switch and Delete… open while it is being made', () => {
    const open = items(making)
      .filter((entry) => !entry.disabled)
      .map((entry) => entry.id);
    expect(open).toEqual(['open', 'reveal', 'uses', 'delete']);
  });
});

describe('wentToTrash', () => {
  it('is true for a place in the Trash and false for the engine’s own fallback place', () => {
    expect(wentToTrash('/Users/owner/.Trash/Follow card')).toBe(true);
    expect(wentToTrash('/Users/owner/.Trash')).toBe(true);
    expect(wentToTrash('/Users/owner/.studio-engine/deleted-graphics/Follow card')).toBe(false);
    expect(wentToTrash('/Volumes/Work/.Trashes/501/Follow card')).toBe(false);
  });
});

describe('the offline banner', () => {
  it('says when the list was last right, from a 24-hour clock', () => {
    const heard = new Date(2026, 9, 22, 10, 42, 30).getTime();
    expect(heardAtLabel(heard)).toBe('10:42');
    expect(heardAtLabel(new Date(2026, 9, 22, 7, 5).getTime())).toBe('07:05');
    expect(offlineBannerText(heard)).toBe(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. New graphic waits until it’s back.',
    );
  });

  it('leaves the time out when the engine never answered', () => {
    expect(offlineBannerText(null)).toBe(
      'Can’t reach the engine on your Mac. New graphic waits until it’s back.',
    );
  });
});

describe('bodyStateOf', () => {
  it('waits for the first answer, or says the engine can’t be reached when it never came', () => {
    expect(bodyStateOf({ graphics: undefined, failed: false, matching: 0 })).toBe('loading');
    expect(bodyStateOf({ graphics: undefined, failed: true, matching: 0 })).toBe('unreachable');
  });

  it('keeps a list that has arrived, whatever a later fetch does', () => {
    expect(bodyStateOf({ graphics: [ready], failed: true, matching: 1 })).toBe('rows');
  });

  it('is empty for no graphics at all, and no-match when the search leaves none', () => {
    expect(bodyStateOf({ graphics: [], failed: false, matching: 0 })).toBe('empty');
    expect(bodyStateOf({ graphics: [ready], failed: false, matching: 0 })).toBe('no-match');
    expect(bodyStateOf({ graphics: [ready, off], failed: false, matching: 2 })).toBe('rows');
  });
});

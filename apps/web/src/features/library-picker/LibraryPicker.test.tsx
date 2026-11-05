import { openPickerQuery } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LibraryPickerList, LibraryPickerNone } from './LibraryPickerPopover';
import { LibraryPreviewCard } from './LibraryPreviewCard';
import { LibraryUses } from './LibraryUses';
import { type LibraryFrame, testLibraryFrame } from './library-frame';
import { NoteTokenText, SentNoteLines } from './NoteTokenText';
import { findItem, type PickerItem, pickerView } from './picker-items';
import { libraryItems } from './test-helpers';

// The board LUReview, state by state, as markup: the picker (start "at" and "luts"), the "no match"
// panel ("none"), the chips under the box ("chip") and the sent note ("sent"). "empty" is the box
// with none of them: see ReviewComposer.test.tsx. Clicks, keys and the tooltip need a browser:
// e2e/review-picker.spec.ts.

const items = libraryItems();
const frame: LibraryFrame = testLibraryFrame(items);

function item(token: string): PickerItem {
  const [library, slug] = token.split('/') as ['luts' | 'graphics', string];
  const found = findItem(items, { library, slug });
  if (found === undefined) throw new Error(token);
  return found;
}

function view(text: string) {
  const query = openPickerQuery(text);
  if (query === null) throw new Error(text);
  return pickerView(items, query);
}

function list(text: string, highlight = 0): string {
  return renderToStaticMarkup(
    <LibraryPickerList
      view={view(text)}
      highlight={highlight}
      listId="L"
      timeLabel="0:12"
      frame={frame}
      onHover={() => {}}
      onPick={() => {}}
    />,
  );
}

/** The opening tag of the first element that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  if (at === -1) throw new Error(`no ${attribute} in the markup`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

describe('the picker for "@" (board LUReview, start "at")', () => {
  const html = list('@');

  it('is a popover 574 px wide above the box, on its right edge, with a 372 px body', () => {
    const tag = tagWith(html, 'data-slot="library-picker"');
    for (const className of [
      'absolute',
      'right-0',
      'bottom-[calc(100%+6px)]',
      'w-[574px]',
      'rounded-xl',
      'z-20',
    ]) {
      expect(tag).toContain(className);
    }
    expect(html).toContain('flex h-[372px]');
  });

  it('has a listbox of 321 px with two groups', () => {
    const box = tagWith(html, 'role="listbox"');
    expect(box).toContain('id="L"');
    expect(box).toContain('w-[321px]');
    expect(box).toContain('aria-label="Library"');
    expect(html.indexOf('>LUTs<')).toBeLessThan(html.indexOf('>Graphics<'));
  });

  it('lists 4 LUTs and 4 graphics as options that never take the focus', () => {
    expect(html.match(/role="option"/g)).toHaveLength(8);
    const row = tagWith(html, 'id="L-opt-0"');
    expect(row).toContain('role="option"');
    expect(row).toContain('tabindex="-1"');
    expect(row).toContain('title="luts/cinematic"');
    expect(row).toContain('h-[30px]');
    expect(row).toContain('cursor-pointer');
    expect(html).toContain('id="L-opt-7"');
    expect(html).not.toContain('id="L-opt-8"');
  });

  it('shows the kind icon, the name and the dim slug in each row', () => {
    const cinematic = html.slice(html.indexOf('id="L-opt-0"'), html.indexOf('id="L-opt-1"'));
    expect(cinematic).toContain('lucide-palette');
    expect(cinematic).toContain('>Cinematic</span>');
    expect(cinematic).toContain('>luts/cinematic</span>');
    expect(cinematic).toContain('text-zinc-500');
    expect(cinematic).toContain('truncate');
    expect(html).toContain('lucide-panel-bottom');
  });

  it('marks the highlighted row selected, with the quiet background, and no other', () => {
    expect(tagWith(html, 'id="L-opt-0"')).toContain('aria-selected="true"');
    expect(tagWith(html, 'id="L-opt-0"')).toContain('bg-accent/60');
    expect(tagWith(html, 'id="L-opt-1"')).toContain('aria-selected="false"');
    expect(tagWith(html, 'id="L-opt-1"')).not.toContain('bg-accent/60');
    expect(tagWith(list('@', 5), 'id="L-opt-5"')).toContain('aria-selected="true"');
  });

  it('ends with the keys line', () => {
    expect(html).toContain('↑ ↓ to move · Enter to add · Esc to close');
  });

  it('has the preview of the highlighted LUT: the frame split, Before and After, the name, the line, "Look · built in"', () => {
    const pane = html.slice(html.indexOf('data-slot="library-preview"'));
    expect(pane).toContain('role="img"');
    expect(pane).toContain('aria-label="Before and after: Cinematic on the frame at 0:12"');
    // The "before" is the same for every LUT, so one that is a plain file stands for all (the
    // Cinematic look's stills are baked from the colour grade).
    expect(pane).toContain('/api/luts/film-contrast/preview/person/before.jpg');
    expect(pane).toContain('/api/luts/cinematic/preview/person/after.jpg');
    expect(pane).toContain('[clip-path:inset(0_0_0_50%)]');
    expect(pane).toContain('>Before</span>');
    expect(pane).toContain('>After</span>');
    expect(pane).toContain('h-[248px] w-[140px]');
    expect(pane).toContain('>Cinematic</div>');
    expect(pane).toContain('Film contrast plus a light golden warmth.');
    expect(pane).toContain('Look · built in');
  });

  it('previews a graphic with its kind and length and "Placed at 0:12"', () => {
    const pane = list('@', 4).slice(list('@', 4).indexOf('data-slot="library-preview"'));
    expect(pane).toContain('Name on a white pill');
    expect(pane).toContain('Lower third · 3 s');
    expect(pane).toContain('Placed at 0:12');
    expect(pane).not.toContain('Before');
    expect(pane).not.toContain('<img');
  });

  it('says "Placed where it fits." for a graphic when the note has no time (the Brief, the note for the editor)', () => {
    const html = renderToStaticMarkup(
      <LibraryPickerList
        view={view('@')}
        highlight={4}
        listId="L"
        timeLabel={null}
        frame={frame}
        onHover={() => {}}
        onPick={() => {}}
      />,
    );
    const pane = html.slice(html.indexOf('data-slot="library-preview"'));
    expect(pane).toContain('Name on a white pill');
    expect(pane).toContain('Placed where it fits.');
    expect(pane).not.toContain('Placed at');
  });
});

describe('the picker for "Make it @luts/ci" (start "luts")', () => {
  it('shows only the LUTs that match, and the first is highlighted', () => {
    const html = list('Make it @luts/ci');
    expect(html).not.toContain('>Graphics<');
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(html).toContain('>luts/cinematic</span>');
    expect(html).toContain('>luts/cinema-dark</span>');
    expect(tagWith(html, 'id="L-opt-0"')).toContain('aria-selected="true"');
  });

  it('shows every LUT for "@luts/", in the list that scrolls', () => {
    const html = list('@luts/');
    expect(html.match(/role="option"/g)?.length).toBeGreaterThan(4);
    expect(tagWith(html, 'role="listbox"')).toContain('overflow-y-auto');
  });

  it('leaves a camera LUT out', () => {
    expect(list('@luts/')).not.toContain('my-log');
    expect(list('@luts/')).not.toContain('s-gamut3-to-cine');
  });

  it('has no preview picture when the frame has no "before" (no LUT at all to take it from)', () => {
    const html = renderToStaticMarkup(
      <LibraryPreviewCard
        item={item('luts/cinematic')}
        frame={{ beforeSrc: '', afterSrc: () => '' }}
        timeLabel="0:12"
        variant="pane"
      />,
    );
    expect(html).not.toContain('<img');
    expect(html).toContain('>Cinematic</div>');
  });

  it('takes the frame the caller gives (LU11 swaps in the paused frame)', () => {
    const html = renderToStaticMarkup(
      <LibraryPreviewCard
        item={item('luts/film-contrast')}
        frame={{ beforeSrc: '/paused.jpg', afterSrc: (slug) => `/paused/${slug}.jpg` }}
        timeLabel="0:07"
        variant="pane"
      />,
    );
    expect(html).toContain('src="/paused.jpg"');
    expect(html).toContain('src="/paused/film-contrast.jpg"');
    expect(html).toContain('on the frame at 0:07');
  });
});

describe('the "no match" panel (start "none")', () => {
  function none(text: string): string {
    const found = view(text).none;
    if (found === null) throw new Error(text);
    return renderToStaticMarkup(<LibraryPickerNone none={found} onOpenPage={() => {}} />);
  }

  it('says there is no LUT called “zzz” and offers the LUTs page, in a 300 px panel', () => {
    const html = none('Make it @luts/zzz');
    expect(tagWith(html, 'data-slot="library-picker-none"')).toContain('w-[300px]');
    expect(html).toContain('<p>No LUT called “zzz”.</p>');
    expect(html).toContain('Open LUTs to import one');
    expect(html).toContain('lucide-arrow-up-right');
    expect(html).toContain('data-variant="ghost"');
  });

  it('says there is no graphic called “zzz” and offers the Graphics page', () => {
    const html = none('@graphics/zzz');
    expect(html).toContain('No graphic called “zzz”.');
    expect(html).toContain('Open Graphics to add one');
  });

  it('names a bare query and has no button', () => {
    const html = none('@qqq');
    expect(html).toContain('Nothing in LUTs or Graphics is called “qqq”.');
    expect(html).not.toContain('<button');
  });
});

describe('the "Uses" row (start "chip")', () => {
  function uses(...tokens: string[]): string {
    return renderToStaticMarkup(
      <LibraryUses items={tokens.map(item)} frame={frame} timeLabel="0:12" onRemove={() => {}} />,
    );
  }

  it('is nothing for a note that names nothing', () => {
    expect(uses()).toBe('');
  });

  it('has one chip per item with its icon, its slug and a × that names what it removes', () => {
    const html = uses('luts/cinematic', 'graphics/follow-card');
    expect(html).toContain('>Uses</span>');
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(2);
    expect(html).toContain('data-token="luts/cinematic"');
    const x = tagWith(html, 'aria-label="Remove luts/cinematic from the note"');
    expect(x).toContain('type="button"');
    expect(x).toContain('cursor-pointer');
    expect(html).toContain('aria-label="Remove graphics/follow-card from the note"');
    expect(html).toContain('bg-[#3B82F6]/15');
    expect(html).toContain('text-[#93C5FD]');
  });

  it('says a LUT applies to the whole video, and a graphic is placed at the note’s time', () => {
    expect(uses('luts/cinematic')).toContain('A LUT applies to the whole video.');
    expect(uses('luts/cinematic')).not.toContain('A graphic is placed');
    expect(uses('graphics/follow-card')).toContain('A graphic is placed at 0:12.');
    expect(uses('graphics/follow-card')).not.toContain('applies to the whole video');
    const both = uses('luts/cinematic', 'graphics/follow-card');
    expect(both).toContain('A LUT applies to the whole video.');
    expect(both).toContain('A graphic is placed at 0:12.');
  });

  it('says a graphic is placed where it fits when the note has no time', () => {
    const html = renderToStaticMarkup(
      <LibraryUses
        items={['luts/cinematic', 'graphics/follow-card'].map(item)}
        frame={frame}
        timeLabel={null}
        onRemove={() => {}}
      />,
    );
    expect(html).toContain('A LUT applies to the whole video.');
    expect(html).toContain('A graphic is placed where it fits.');
    expect(html).not.toContain('placed at');
  });

  it('draws no card until the chip is hovered or focused', () => {
    expect(uses('luts/cinematic')).not.toContain('role="tooltip"');
  });

  it('gives the card the smaller picture (90 × 160)', () => {
    const html = renderToStaticMarkup(
      <LibraryPreviewCard
        item={item('luts/cinematic')}
        frame={frame}
        timeLabel="0:12"
        variant="tip"
      />,
    );
    expect(html).toContain('h-[160px] w-[90px]');
    expect(html).toContain('Look · built in');
  });
});

describe('a sent note (start "sent")', () => {
  it('shows each token that points at an item as a blue-tinted 13 px pill with its slug', () => {
    const html = renderToStaticMarkup(
      <p>
        <NoteTokenText text="Make it @luts/cinematic" items={items} />
      </p>,
    );
    expect(html).toContain('Make it </span>');
    const pill = tagWith(html, 'data-slot="library-token"');
    expect(pill).toContain('bg-[#3B82F6]/15');
    expect(pill).toContain('text-[13px]');
    expect(pill).toContain('dir="ltr"');
    expect(html).toContain('>luts/cinematic</span>');
    expect(html).not.toContain('@luts/cinematic');
  });

  it('is the text itself when nothing in it is a chip, and keeps a token that points at nothing as text', () => {
    expect(
      renderToStaticMarkup(
        <p>
          <NoteTokenText text="just words" items={items} />
        </p>,
      ),
    ).toBe('<p>just words</p>');
    const gone = renderToStaticMarkup(
      <p>
        <NoteTokenText text="try @luts/zzz" items={items} />
      </p>,
    );
    expect(gone).toBe('<p>try @luts/zzz</p>');
  });

  it('says "Saved. The next edit uses Cinematic on the whole video." under a note that names a LUT', () => {
    const html = renderToStaticMarkup(
      <SentNoteLines text="Make it @luts/cinematic" items={items} timeLabel="0:12" />,
    );
    expect(html).toContain('Saved. The next edit uses Cinematic on the whole video.');
    expect(html).toContain('text-zinc-500');
  });

  it('says where a graphic goes', () => {
    const html = renderToStaticMarkup(
      <SentNoteLines text="@graphics/name-on-a-white-pill" items={items} timeLabel="0:12" />,
    );
    expect(html).toContain('Saved. The next edit places Name on a white pill at 0:12.');
  });

  it('says where a graphic goes without a time: where it fits', () => {
    const html = renderToStaticMarkup(
      <SentNoteLines text="@graphics/name-on-a-white-pill" items={items} timeLabel={null} />,
    );
    expect(html).toContain('Saved. The next edit places Name on a white pill where it fits.');
  });

  it('adds nothing under a note that names nothing', () => {
    expect(
      renderToStaticMarkup(<SentNoteLines text="brighter" items={items} timeLabel="0:12" />),
    ).toBe('');
  });
});

import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import {
  type FontPickerCatalog,
  fontPickerCatalog,
  type NotePickerSources,
  notePickerView,
  openNoteQuery,
} from './font-picker';
import { LibraryPickerList, LibraryPickerNone } from './LibraryPickerPopover';
import { type LibraryFrame, testLibraryFrame } from './library-frame';
import { FONT_LIST, libraryItems } from './test-helpers';

// The board FOReview, state by state, as markup: the picker for "@" and "@he" (start "at" and
// "fonts"), the right pane for a font with and without Hebrew, and the small "none" panel. Keys,
// the mouse and the font files arriving are in a real browser: e2e/fonts-picker.spec.ts.

const catalog: FontPickerCatalog = fontPickerCatalog(FONT_LIST);
const items = libraryItems();
const frame: LibraryFrame = testLibraryFrame(items);
const both: NotePickerSources = { fonts: catalog, items, library: true };
const fontsOnly: NotePickerSources = { fonts: catalog, items: [], library: false };

function view(text: string, sources: NotePickerSources = both) {
  const query = openNoteQuery(text, sources.library);
  const found = query === null ? null : notePickerView(sources, query);
  if (found === null) throw new Error(text);
  return found;
}

function list(text: string, highlight = 0, sources: NotePickerSources = both): string {
  return renderToStaticMarkup(
    <LibraryPickerList
      view={view(text, sources)}
      highlight={highlight}
      listId="L"
      timeLabel="0:12"
      frame={frame}
      fonts={catalog}
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

/** The markup of one row, from its opening tag to the next row. */
function row(html: string, index: number): string {
  const from = html.lastIndexOf('<button', html.indexOf(`id="L-opt-${index}"`));
  const next = html.indexOf('<button', from + 1);
  return html.slice(from, next === -1 ? undefined : next);
}

describe('the picker for "@" (board FOReview, start "at")', () => {
  const html = list('@');

  it('is the same popover as LU8’s: 574 px, above the box, a 321 px listbox and the keys line', () => {
    expect(tagWith(html, 'data-slot="library-picker"')).toContain('w-[574px]');
    expect(tagWith(html, 'data-slot="library-picker"')).toContain('bottom-[calc(100%+6px)]');
    expect(tagWith(html, 'role="listbox"')).toContain('w-[321px]');
    expect(html).toContain('↑ ↓ to move · Enter to add · Esc to close');
  });

  it('has three groups, Fonts · recent first, then LUTs and Graphics', () => {
    const fonts = html.indexOf('>Fonts · recent<');
    expect(fonts).toBeGreaterThan(-1);
    expect(fonts).toBeLessThan(html.indexOf('>LUTs<'));
    expect(html.indexOf('>LUTs<')).toBeLessThan(html.indexOf('>Graphics<'));
    expect(html.match(/role="option"/g)).toHaveLength(11);
  });

  it('sets a font row in its own font at 16 px, with its script on the right', () => {
    const first = row(html, 0);
    expect(first).toContain('title="@Heebo Bold"');
    expect(first).toContain('aria-selected="true"');
    expect(first).toContain('bg-accent/60');
    expect(first).toContain('h-8');
    expect(first).toContain('lucide-case-sensitive');
    expect(first).toContain('text-base');
    // The face's own file (a hash-free stand-in id here), at its weight, then a plain sans.
    expect(first).toContain('font-family:&quot;fe-heebo-700&quot;, sans-serif');
    expect(first).toContain('font-weight:700');
    expect(first).toContain('>Heebo Bold</span>');
    expect(first).toContain('>Hebrew + English</span>');
    expect(row(html, 1)).toContain('>Assistant Bold</span>');
  });

  it('keeps LU8’s rows as they were, 32 px high here as the rows of FOReview are', () => {
    const cinematic = row(html, 5);
    expect(cinematic).toContain('title="luts/cinematic"');
    expect(cinematic).toContain('lucide-palette');
    expect(cinematic).toContain('>luts/cinematic</span>');
    expect(cinematic).toContain('h-8');
    expect(cinematic).not.toContain('font-family');
  });

  it('shows the card of the highlighted font: the frame, the caption, the name and the facts', () => {
    const pane = html.slice(html.indexOf('data-slot="library-preview"'));
    const frameTag = tagWith(pane, 'data-slot="font-card-frame"');
    expect(frameTag).toContain('role="img"');
    expect(frameTag).toContain('h-[248px] w-[140px]');
    expect(frameTag).toContain('aria-label="The caption on a test frame in Heebo Bold"');
    expect(pane).toContain('src="/api/fonts/frame/person.jpg"');
    expect(pane).toContain('ככה הכול התחיל');
    expect(pane).toContain('That’s how it all started');
    expect(pane).toContain('text-[17px]');
    expect(pane).toContain('text-[9px]');
    expect(pane).toContain('font-family:&quot;fe-heebo-700&quot;, sans-serif');
    expect(tagWith(pane, 'data-slot="font-card-name"')).toContain('text-[18px]');
    expect(pane).toContain('>Heebo Bold</div>');
    expect(pane).toContain('Sans · Hebrew + English');
    expect(pane).toContain('9 weights · used in 14 jobs');
    expect(pane).not.toContain('No Hebrew letters');
  });

  it('shows a LUT’s card and a graphic’s card as LU8 does when one is highlighted', () => {
    const lut = list('@', 5).slice(list('@', 5).indexOf('data-slot="library-preview"'));
    expect(lut).toContain('Before and after: Cinematic on the frame at 0:12');
    expect(lut).not.toContain('font-card-frame');
    const graphic = list('@', 8).slice(list('@', 8).indexOf('data-slot="library-preview"'));
    expect(graphic).toContain('Name on a white pill');
    expect(graphic).toContain('Placed at 0:12');
  });
});

describe('the picker for "Make the captions @he" (start "fonts")', () => {
  const html = list('Make the captions @he', 0, fontsOnly);

  it('is one group, Fonts, with a row for each of three families', () => {
    expect(html).toContain('>Fonts<');
    expect(html).not.toContain('recent');
    expect(html).not.toContain('>LUTs<');
    expect(html.match(/role="option"/g)).toHaveLength(3);
  });

  it('names each family in its Regular and counts its weights on the right', () => {
    expect(row(html, 0)).toContain('>Heebo</span>');
    expect(row(html, 0)).toContain('>9 weights</span>');
    expect(row(html, 0)).toContain('font-weight:400');
    expect(row(html, 1)).toContain('>Noto Sans Hebrew</span>');
    expect(row(html, 2)).toContain('>IBM Plex Sans Hebrew</span>');
    expect(row(html, 2)).toContain('>7 weights</span>');
  });

  it('marks only the highlighted row selected', () => {
    expect(list('@he', 1, fontsOnly)).toContain('id="L-opt-1" aria-selected="true"');
    expect(tagWith(list('@he', 1, fontsOnly), 'id="L-opt-0"')).toContain('aria-selected="false"');
  });
});

describe('the picker for "@heebo b" (Bold and Black)', () => {
  it('lists the two faces, each in its own weight, with the script on the right', () => {
    const html = list('@heebo b', 0, fontsOnly);
    expect(html.match(/role="option"/g)).toHaveLength(2);
    expect(row(html, 0)).toContain('>Heebo Bold</span>');
    expect(row(html, 0)).toContain('font-weight:700');
    expect(row(html, 1)).toContain('>Heebo Black</span>');
    expect(row(html, 1)).toContain('font-weight:900');
    expect(row(html, 1)).toContain('>Hebrew + English</span>');
  });
});

describe('the card of a font with no Hebrew (Poppins)', () => {
  const html = list('@poppins bold', 0, fontsOnly);
  const pane = html.slice(html.indexOf('data-slot="library-preview"'));

  it('says Hebrew words stay in the video’s own font, and sets the Hebrew line in Heebo’s file', () => {
    expect(pane).toContain('No Hebrew letters. Hebrew words stay in the video’s own font.');
    expect(tagWith(pane, 'data-slot="font-card-no-hebrew"')).toContain('text-amber-400');
    const caption = pane.slice(pane.indexOf('lang="he"'));
    // The nearest weight of the library's own Heebo (Bold here), then the Heebo the Mac may have.
    expect(caption.slice(0, 240)).toContain('&quot;fe-heebo-700&quot;, &quot;Heebo&quot;');
  });

  it('says what the font is', () => {
    expect(pane).toContain('Sans · English only');
    expect(pane).toContain('9 weights · used in 2 jobs');
    expect(pane).toContain('>Poppins Bold</div>');
  });
});

describe('the small panel for a name nothing has', () => {
  function none(text: string, sources: NotePickerSources = both): string {
    const found = view(text, sources).none;
    if (found === null) throw new Error(text);
    return renderToStaticMarkup(<LibraryPickerNone none={found} onOpenPage={() => {}} withFonts />);
  }

  it('says nothing in Fonts, LUTs or Graphics is called it, and offers Fonts', () => {
    const html = none('Make the captions @Gotham');
    // 320 px, as board FOReview draws it (LUReview's is 300).
    expect(tagWith(html, 'data-slot="library-picker-none"')).toContain('w-[320px]');
    expect(html).toContain('<p>Nothing in Fonts, LUTs or Graphics is called “Gotham”.</p>');
    expect(html).toContain('Open Fonts to import one');
    expect(html).toContain('lucide-arrow-up-right');
  });

  it('names only Fonts when LUTs and graphics are off', () => {
    expect(none('@Gotham', fontsOnly)).toContain('<p>Nothing in Fonts is called “Gotham”.</p>');
  });
});

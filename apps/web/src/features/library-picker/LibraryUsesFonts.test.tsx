import { QueryClientProvider } from '@tanstack/react-query';
import type { ComponentProps, ReactElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { FontPreviewCard } from './FontPreviewCard';
import {
  type FontPickerCatalog,
  type FontPickerItem,
  fontPickerCatalog,
  heeboFaceFor,
  type NotePickerSources,
  notePickerView,
  openNoteQuery,
} from './font-picker';
import { LibraryPickerNone } from './LibraryPickerPopover';
import { LibraryUses } from './LibraryUses';
import { type LibraryFrame, testLibraryFrame } from './library-frame';
import { NoteTokenText, SentNoteLines } from './NoteTokenText';
import { readNote } from './note-uses';
import { FONT_LIST, libraryClient, libraryItems } from './test-helpers';
import { type LibraryPicker, useLibraryPicker } from './use-library-picker';

// The board FOReview, state by state, as markup: the chips under the box ("chip", "two", "hebrew"),
// the card above a chip, the helper lines, the small panel ("none") and the posted note ("sent").
// The × is proved through the hook that wires it. Hovering a chip, real files arriving and the
// whole box are in a real browser: e2e/fonts-picker.spec.ts.

const fonts: FontPickerCatalog = fontPickerCatalog(FONT_LIST);
const items = libraryItems();
const frame: LibraryFrame = testLibraryFrame(items);

/** The entries a text names, as the "Uses" row is given them. */
function named(text: string, withItems = items) {
  return readNote(text, { fonts, items: withItems }).uses.map((use) => use.entry);
}

function uses(text: string, timeLabel: string | null = '0:12'): string {
  return renderToStaticMarkup(
    <LibraryUses
      items={named(text)}
      frame={frame}
      timeLabel={timeLabel}
      onRemove={() => {}}
      fonts={fonts}
    />,
  );
}

/** The opening tag of the first element that has `attribute`. */
function tagWith(html: string, attribute: string): string {
  const at = html.indexOf(attribute);
  if (at === -1) throw new Error(`no ${attribute} in the markup`);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

/** The font row for a face. */
function fontItem(text: string): FontPickerItem {
  const entry = named(text)[0];
  if (entry?.type !== 'font') throw new Error(`${text} names no font`);
  return entry;
}

describe('the "Uses" row with fonts (board FOReview, start "chip")', () => {
  it('is nothing for a note that names nothing, or a font the library does not have', () => {
    expect(uses('just words')).toBe('');
    expect(uses('Make the captions @Gotham')).toBe('');
  });

  it('has a chip for one font: its icon, @Heebo Bold and a × that names what it removes', () => {
    const html = uses('Make the captions @Heebo Bold ');
    expect(html).toContain('>Uses</span>');
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(1);
    const chip = tagWith(html, 'data-slot="library-chip"');
    expect(chip).toContain('data-token="@Heebo Bold"');
    expect(chip).toContain('dir="ltr"');
    expect(html).toContain('lucide-case-sensitive');
    expect(html).toContain('@Heebo Bold<button');
    const x = tagWith(html, 'aria-label="Remove @Heebo Bold from the note"');
    expect(x).toContain('type="button"');
    expect(x).toContain('cursor-pointer');
    expect(html).toContain('bg-[#3B82F6]/15');
    expect(html).toContain('text-[#93C5FD]');
    expect(html).toContain('h-6');
  });

  it('has two chips for two fonts, in the order written', () => {
    const html = uses('Titles in @Rubik Black and captions in @Heebo Medium ');
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(2);
    expect(html.indexOf('@Rubik Black<button')).toBeLessThan(html.indexOf('@Heebo Medium<button'));
    expect(html).toContain('aria-label="Remove @Rubik Black from the note"');
    expect(html).toContain('aria-label="Remove @Heebo Medium from the note"');
  });

  it('has one chip for a font named twice, and one for each of Regular and Bold', () => {
    expect(
      uses('captions @Heebo Bold, titles @Heebo Bold').match(/data-slot="library-chip"/g),
    ).toHaveLength(1);
    expect(uses('@Heebo and @Heebo Bold').match(/data-slot="library-chip"/g)).toHaveLength(2);
  });

  it('has a chip for a font in a Hebrew note, read left to right (start "hebrew")', () => {
    const html = uses('תשנה את הכתוביות ל-@Heebo Bold ');
    expect(html).toContain('@Heebo Bold<button');
    expect(tagWith(html, 'data-slot="library-chip"')).toContain('dir="ltr"');
  });

  it('writes a LUT and a graphic with their @ beside a font, as the board does', () => {
    const html = uses(
      'Captions in @Heebo Bold, grade @luts/cinematic, place @graphics/follow-card',
    );
    expect(html.match(/data-slot="library-chip"/g)).toHaveLength(3);
    expect(html).toContain('@luts/cinematic<button');
    expect(html).toContain('@graphics/follow-card<button');
    expect(html).toContain('aria-label="Remove @luts/cinematic from the note"');
    expect(html).toContain('lucide-palette');
    expect(html).toContain('lucide-flag');
  });

  it('draws no card until the chip is hovered or focused', () => {
    expect(uses('Make the captions @Heebo Bold ')).not.toContain('role="tooltip"');
  });
});

describe('the lines under the chips', () => {
  const FONT_LINE =
    'A font is used for the text the note names, like the captions or the titles. If it names none, for all the text the edit adds.';

  it('says what a font is for, once, however many fonts there are', () => {
    expect(uses('Make the captions @Heebo Bold ')).toContain(`>${FONT_LINE}</p>`);
    const two = uses('Titles in @Rubik Black and captions in @Heebo Medium ');
    expect(two.split(FONT_LINE)).toHaveLength(2);
  });

  it('is dim and small, as the LUT and graphic lines are', () => {
    const tag = tagWith(uses('@Heebo Bold'), FONT_LINE);
    expect(tag).toContain('text-xs');
    expect(tag).toContain('text-zinc-500');
  });

  it('has no font line when no font is named, and keeps the LUT and graphic lines', () => {
    const lut = uses('@luts/cinematic');
    expect(lut).not.toContain('A font is used');
    expect(lut).toContain('A LUT applies to the whole video.');
    expect(uses('@graphics/follow-card')).toContain('A graphic is placed at 0:12.');
    expect(uses('@graphics/follow-card', null)).toContain('A graphic is placed where it fits.');
  });

  it('has the font line, then the LUT line, then the graphic line', () => {
    const html = uses('@Heebo Bold @luts/cinematic @graphics/follow-card');
    expect(html.indexOf(FONT_LINE)).toBeLessThan(html.indexOf('A LUT applies to the whole video.'));
    expect(html.indexOf('A LUT applies to the whole video.')).toBeLessThan(
      html.indexOf('A graphic is placed at 0:12.'),
    );
  });
});

describe('the "Uses" row with the fonts switch off (it is LU8’s)', () => {
  function lutRow(withFonts: FontPickerCatalog | undefined): string {
    return renderToStaticMarkup(
      <LibraryUses
        items={named('@luts/cinematic').filter((entry) => entry.type !== 'font')}
        frame={frame}
        timeLabel="0:12"
        onRemove={() => {}}
        fonts={withFonts}
      />,
    );
  }

  it('writes the LUT as its bare slug, with no direction, as it always did', () => {
    const html = lutRow(undefined);
    expect(html).toContain('luts/cinematic<button');
    expect(html).not.toContain('@luts/cinematic');
    expect(html).toContain('aria-label="Remove luts/cinematic from the note"');
    expect(tagWith(html, 'data-slot="library-chip"')).not.toContain('dir=');
    expect(html).not.toContain('A font is used');
  });

  it('is different only by the @ and the direction once fonts are in the notes', () => {
    expect(lutRow(fonts)).toBe(
      lutRow(undefined)
        .replace('luts/cinematic<button', '@luts/cinematic<button')
        .replace('Remove luts/cinematic', 'Remove @luts/cinematic')
        .replace('data-token="luts/cinematic"', 'data-token="luts/cinematic" dir="ltr"'),
    );
  });
});

describe('the card above a font’s chip (board FOReview, the chip’s tooltip)', () => {
  function tip(text: string): string {
    const item = fontItem(text);
    const heebo = item.family.he ? null : heeboFaceFor(fonts, item.face.weight);
    return renderToStaticMarkup(<FontPreviewCard item={item} heebo={heebo} variant="tip" />);
  }

  it('is the name in its own font at 22 px, the Hebrew sample at 18 px, and two lines of facts', () => {
    const html = tip('@Heebo Bold');
    const name = tagWith(html, 'data-slot="font-card-name"');
    expect(name).toContain('text-[22px]');
    expect(name).toContain('font-weight:700');
    expect(name).toContain('&quot;fe-heebo-700&quot;');
    expect(html).toContain('>Heebo Bold</div>');
    const hebrew = tagWith(html, 'lang="he"');
    expect(hebrew).toContain('dir="rtl"');
    expect(hebrew).toContain('text-[18px]');
    expect(hebrew).toContain('text-left');
    expect(hebrew).toContain('font-weight:700');
    expect(hebrew).toContain('&quot;fe-heebo-700&quot;');
    expect(html).toContain('>ככה הכול התחיל</div>');
    expect(html).toContain('>Sans · Hebrew + English</div>');
    expect(html).toContain('>9 weights · used in 14 jobs</div>');
  });

  it('is a tip card: no picture, no 140 px frame', () => {
    const html = tip('@Heebo Bold');
    expect(tagWith(html, 'data-slot="library-preview"')).toContain('data-variant="tip"');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('font-card-frame');
  });

  it('sets the name in the face it is: a Light is light', () => {
    expect(tagWith(tip('@Heebo Light'), 'data-slot="font-card-name"')).toContain('font-weight:300');
  });

  it('says a font that is not used yet is "not used yet"', () => {
    expect(tip('@Alef')).toContain('2 weights · not used yet');
  });

  it('says the Hebrew words of a font with no Hebrew keep the video’s font, in amber', () => {
    const html = tip('@Poppins Bold');
    expect(html).toContain('>Sans · English only</div>');
    expect(tagWith(html, 'data-slot="font-card-no-hebrew"')).toContain('text-amber-400');
    expect(html).toContain('No Hebrew letters. Hebrew words stay in the video’s own font.');
    // The sample is set in Heebo (its nearest weight), not in a file with no Hebrew letters.
    const hebrew = html.slice(html.indexOf('lang="he"'));
    expect(hebrew.slice(0, 260)).toContain('&quot;fe-heebo-700&quot;');
    expect(hebrew.slice(0, 260)).not.toContain('fe-poppins');
  });

  it('has no such line for a font that has Hebrew', () => {
    expect(tip('@Heebo Bold')).not.toContain('No Hebrew letters');
  });
});

describe('the small panel for a name nothing has (start "none")', () => {
  const both: NotePickerSources = { fonts, items, library: true };
  function none(text: string, sources: NotePickerSources = both): string {
    const query = openNoteQuery(text, sources.library);
    const found = query === null ? null : notePickerView(sources, query)?.none;
    if (found === null || found === undefined) throw new Error(text);
    return renderToStaticMarkup(<LibraryPickerNone none={found} onOpenPage={() => {}} withFonts />);
  }

  it('says nothing in Fonts, LUTs or Graphics is called “Gotham”, with the way to Fonts', () => {
    const html = none('Make the captions @Gotham');
    expect(tagWith(html, 'data-slot="library-picker-none"')).toContain('w-[320px]');
    expect(html).toContain('<p>Nothing in Fonts, LUTs or Graphics is called “Gotham”.</p>');
    expect(html).toContain('Open Fonts to import one');
    expect(html).toContain('lucide-arrow-up-right');
  });

  it('keeps the words for a LUT or a graphic query', () => {
    const lut = none('@luts/zzz');
    expect(lut).toContain('<p>No LUT called “zzz”.</p>');
    expect(lut).toContain('Open LUTs to import one');
    const graphic = none('@graphics/zzz');
    expect(graphic).toContain('<p>No graphic called “zzz”.</p>');
    expect(graphic).toContain('Open Graphics to add one');
  });

  it('names only Fonts when LUTs and graphics are off', () => {
    expect(none('@Gotham', { fonts, items: [], library: false })).toContain(
      '<p>Nothing in Fonts is called “Gotham”.</p>',
    );
  });
});

describe('a posted note with fonts (start "sent")', () => {
  const text = 'Titles in @Rubik Black and captions in @Heebo Medium';
  const pills = (note: string) =>
    renderToStaticMarkup(
      <p dir="auto">
        <NoteTokenText text={note} items={items} fonts={fonts} />
      </p>,
    );
  const savedLines = (note: string, timeLabel: string | null = '0:12') =>
    renderToStaticMarkup(
      <SentNoteLines text={note} items={items} timeLabel={timeLabel} fonts={fonts} />,
    );

  it('shows each font token as a blue pill, 13 px, left to right, with the text between', () => {
    const html = pills(text);
    expect(html.match(/data-slot="library-token"/g)).toHaveLength(2);
    const pill = tagWith(html, 'data-slot="library-token"');
    expect(pill).toContain('bg-[#3B82F6]/15');
    expect(pill).toContain('text-[13px]');
    expect(pill).toContain('dir="ltr"');
    expect(html).toContain('>@Rubik Black</span>');
    expect(html).toContain('>@Heebo Medium</span>');
    expect(html).toContain('<span>Titles in </span>');
    expect(html).toContain('<span> and captions in </span>');
    expect(html.startsWith('<p dir="auto">')).toBe(true);
  });

  it('says what the next edit does with each font, for the text it names', () => {
    const html = savedLines(text);
    expect(html).toContain('Saved. The next edit uses Rubik Black for the titles.');
    expect(html).toContain('It also uses Heebo Medium for the captions.');
    expect(html.indexOf('Saved.')).toBeLessThan(html.indexOf('It also'));
    expect(html).toContain('text-zinc-500');
    expect(html).toContain('data-slot="library-note-lines"');
  });

  it('says "all the text it adds" for a font with no text named', () => {
    expect(savedLines('Use @Heebo Bold please')).toContain(
      'Saved. The next edit uses Heebo Bold for all the text it adds.',
    );
  });

  it('shows a font in a Hebrew note as a pill that stays left to right, in the note’s own direction', () => {
    const html = pills('תשנה את הכתוביות ל-@Heebo Bold');
    expect(html).toContain('<span>תשנה את הכתוביות ל-</span>');
    expect(tagWith(html, 'data-slot="library-token"')).toContain('dir="ltr"');
    expect(html).toContain('>@Heebo Bold</span>');
    expect(html).toContain('<p dir="auto">');
    expect(savedLines('תשנה את הכתוביות ל-@Heebo Bold')).toContain(
      'Saved. The next edit uses Heebo Bold for the captions.',
    );
  });

  it('shows a LUT and a graphic beside a font, written with their @ and with their old lines', () => {
    const note = 'Captions in @Heebo Bold, grade @luts/cinematic, place @graphics/follow-card';
    const html = pills(note);
    expect(html).toContain('>@luts/cinematic</span>');
    expect(html).toContain('>@graphics/follow-card</span>');
    const lines = savedLines(note);
    expect(lines).toContain('It also uses Cinematic on the whole video.');
    expect(lines).toContain('It also places Follow card at 0:12.');
  });

  it('is the text itself, with no line, for a note with no token', () => {
    expect(pills('brighter please')).toBe('<p dir="auto">brighter please</p>');
    expect(savedLines('brighter please')).toBe('');
  });

  it('keeps a name the library does not have as text, and says what the edit will do about it', () => {
    expect(pills('Make the captions @Gotham Bold')).toBe(
      '<p dir="auto">Make the captions @Gotham Bold</p>',
    );
    // One dim line, drawn like the others (12 px, grey).
    expect(savedLines('Make the captions @Gotham Bold')).toBe(
      '<div data-slot="library-note-lines" class="flex flex-col gap-0.5"><p class="pr-1 text-xs text-pretty text-zinc-500">Gotham Bold isn’t in your library, so the edit will use the closest font it has.</p></div>',
    );
  });

  it('puts that line under the usual ones, one for each name', () => {
    const html = savedLines('Titles in @Avenir Next and @Gotham Bold, captions in @Heebo Bold');
    const lines = [...html.matchAll(/<p [^>]*>([^<]*)<\/p>/g)].map((match) => match[1]);
    expect(lines).toEqual([
      'Saved. The next edit uses Heebo Bold for the captions.',
      'Avenir Next isn’t in your library, so the edit will use the closest font it has.',
      'Gotham Bold isn’t in your library, so the edit will use the closest font it has.',
    ]);
  });

  it('says nothing about a name while no font list is in (no catalog faces)', () => {
    expect(
      renderToStaticMarkup(
        <SentNoteLines
          text="Make the captions @Gotham Bold"
          items={items}
          timeLabel="0:12"
          fonts={fontPickerCatalog(undefined)}
        />,
      ),
    ).toBe('');
  });

  it('shows a font token as plain text, with no line, while fonts are off (no catalog given)', () => {
    const off = renderToStaticMarkup(
      <p>
        <NoteTokenText text="Captions in @Heebo Bold" items={items} />
      </p>,
    );
    expect(off).toBe('<p>Captions in @Heebo Bold</p>');
    expect(
      renderToStaticMarkup(
        <SentNoteLines text="Captions in @Heebo Bold" items={items} timeLabel="0:12" />,
      ),
    ).toBe('');
  });

  it('shows the same LUT note as before while fonts are off', () => {
    expect(
      renderToStaticMarkup(
        <p>
          <NoteTokenText text="Make it @luts/cinematic" items={items} />
        </p>,
      ),
    ).toContain('>luts/cinematic</span>');
  });
});

describe('the × of a chip, through the box’s picker (useLibraryPicker)', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  /** The picker a box gets for `text`: what the hook answers on a render, with its callbacks. */
  function pickerFor(
    text: string,
    options: { fontsInNotes?: boolean; box?: HTMLTextAreaElement | null } = {},
  ) {
    const onTextChange = vi.fn();
    let picker: LibraryPicker | undefined;
    function Probe() {
      picker = useLibraryPicker({
        text,
        onTextChange,
        textareaRef: { current: options.box ?? null },
        timeLabel: '0:12',
      });
      return null;
    }
    renderToStaticMarkup(
      <QueryClientProvider client={libraryClient({ fontsInNotes: options.fontsInNotes ?? true })}>
        <Probe />
      </QueryClientProvider>,
    );
    if (picker === undefined) throw new Error('the probe did not render');
    return { picker, onTextChange };
  }

  type UsesProps = ComponentProps<typeof LibraryUses>;
  const usesProps = (picker: LibraryPicker): UsesProps => {
    if (picker.uses === null) throw new Error('no Uses row');
    return (picker.uses as ReactElement<UsesProps>).props;
  };

  it('gives the row the fonts the text names, once each', () => {
    const { picker } = pickerFor('Titles in @Rubik Black and captions in @Heebo Medium ');
    expect(usesProps(picker).items.map((entry) => entry.name)).toEqual([
      'Rubik Black',
      'Heebo Medium',
    ]);
    expect(usesProps(picker).fonts).toBeDefined();
  });

  it('gives no row for a text that names nothing', () => {
    expect(pickerFor('just words').picker.uses).toBeNull();
    expect(pickerFor('Make the captions @Gotham').picker.uses).toBeNull();
  });

  it('the × takes the token and one space out of the text', () => {
    const { picker, onTextChange } = pickerFor('Make the captions @Heebo Bold please');
    const props = usesProps(picker);
    const chip = props.items[0];
    if (chip === undefined) throw new Error('no chip');
    props.onRemove(chip);
    expect(onTextChange).toHaveBeenCalledTimes(1);
    expect(onTextChange).toHaveBeenCalledWith('Make the captions please');
  });

  it('the × of one font leaves the other, and takes a font after a hyphen', () => {
    const { picker, onTextChange } = pickerFor('ל-@Heebo Bold and @Rubik Black ');
    const props = usesProps(picker);
    const heebo = props.items.find((entry) => entry.name === 'Heebo Bold');
    if (heebo === undefined) throw new Error('no chip');
    props.onRemove(heebo);
    expect(onTextChange).toHaveBeenCalledWith('ל-and @Rubik Black ');
  });

  it('the × of the only token empties the box', () => {
    const { picker, onTextChange } = pickerFor('@Heebo Bold ');
    const props = usesProps(picker);
    const chip = props.items[0];
    if (chip === undefined) throw new Error('no chip');
    props.onRemove(chip);
    expect(onTextChange).toHaveBeenCalledWith('');
  });

  it('the × gives the focus back to the box, caret at the end', () => {
    vi.useFakeTimers();
    const box = {
      focus: vi.fn(),
      setSelectionRange: vi.fn(),
      value: 'Make the captions ',
    } as unknown as HTMLTextAreaElement;
    const { picker } = pickerFor('Make the captions @Heebo Bold ', { box });
    const props = usesProps(picker);
    const chip = props.items[0];
    if (chip === undefined) throw new Error('no chip');
    props.onRemove(chip);
    vi.advanceTimersByTime(1);
    expect(box.focus).toHaveBeenCalledTimes(1);
    expect(box.setSelectionRange).toHaveBeenCalledWith(18, 18);
  });

  it('the × of a LUT chip takes it out too, beside a font', () => {
    const { picker, onTextChange } = pickerFor(
      'Captions in @Heebo Bold, grade @luts/cinematic now',
    );
    const props = usesProps(picker);
    const lut = props.items.find((entry) => entry.type === 'lut');
    if (lut === undefined) throw new Error('no chip');
    props.onRemove(lut);
    expect(onTextChange).toHaveBeenCalledWith('Captions in @Heebo Bold, grade now');
  });

  it('with the fonts switch off a font token is no chip, and a LUT’s × is LU8’s', () => {
    const off = pickerFor('Make @Heebo Bold and @luts/cinematic now', { fontsInNotes: false });
    const props = usesProps(off.picker);
    expect(props.items.map((entry) => entry.name)).toEqual(['Cinematic']);
    expect(props.fonts).toBeUndefined();
    const chip = props.items[0];
    if (chip === undefined) throw new Error('no chip');
    props.onRemove(chip);
    expect(off.onTextChange).toHaveBeenCalledWith('Make @Heebo Bold and now');
  });
});

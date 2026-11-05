import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { fontPickerCatalog } from '../library-picker/font-picker';
import { FONT_LIST, libraryItems } from '../library-picker/test-helpers';
import { type NoteFixLine, noteFixLine } from './fix-lines';
import { makeOpenFix, makeQuickFix, routedNote } from './fix-test-helpers';
import { NoteCard } from './NoteCard';
import { NOTES_TEXT } from './review-text';
import { renderReview, tagWith } from './test-helpers';

const hebrew = 'הכותרת יורדת מהר מדי. "להשאיר" אותה עוד שנייה.';

function card(
  noteOverrides: Parameters<typeof makeReviewNote>[0] = {},
  props: Partial<React.ComponentProps<typeof NoteCard>> = {},
): string {
  return renderReview(
    <NoteCard
      note={makeReviewNote({ text: hebrew, ...noteOverrides })}
      jobId="a1b2c3d4e5f6"
      client="מאפיית הצפון"
      seriesName={null}
      hovered={false}
      active={false}
      onHover={() => {}}
      onGo={() => {}}
      onDelete={() => {}}
      cardRef={() => {}}
      onPlayVoice={() => {}}
      {...props}
    />,
  );
}

describe('<NoteCard> of a text note', () => {
  it('is an article with the note’s id, kind and state', () => {
    const tag = tagWith(card(), 'data-slot="review-note"');
    expect(tag).toContain('<article');
    expect(tag).toContain('data-note-id="n1"');
    expect(tag).toContain('data-kind="text"');
    expect(tag).toContain('data-state="idle"');
  });

  it('has a time chip that goes there, with the blue dot', () => {
    const html = card();
    const chip = tagWith(html, 'aria-label="Go to 0:02"');
    expect(chip).toContain('type="button"');
    expect(chip).toContain('h-[22px]');
    expect(chip).toContain('bg-secondary');
    expect(html).toContain('bg-[#3B82F6]"></span>0:02</button>');
  });

  it('has no "Voice note" tag', () => {
    expect(card()).not.toContain('Voice note');
  });

  it('shows the text word for word, in its own direction', () => {
    const html = card();
    const tag = tagWith(html, 'dir="auto"');
    expect(tag).toContain('[unicode-bidi:plaintext]');
    expect(tag).toContain('whitespace-pre-wrap');
    // The quotes are escaped as HTML entities, which read back as the same text.
    expect(html).toContain('הכותרת יורדת מהר מדי. &quot;להשאיר&quot; אותה עוד שנייה.</p>');
  });

  it('has the "Add to style" toggle, off, and a delete button', () => {
    const html = card();
    const toggle = tagWith(html, 'aria-pressed="false"');
    expect(toggle).toContain('type="button"');
    expect(toggle).toContain('data-size="xs"');
    expect(html).toContain('Add to style</button>');
    expect(html).not.toContain('In style');
    expect(html).not.toContain('When you send');
    const del = tagWith(html, 'aria-label="Delete note"');
    expect(del).toContain('size-7');
    expect(del).toContain('type="button"');
    expect(html).toContain('lucide-trash-2');
    expect(html).toContain('lucide-palette');
  });

  it('has the toggle and the delete button at the board’s 6 px radius, not shadcn’s 8', () => {
    const html = card();
    expect(tagWith(html, 'aria-pressed="false"')).toContain('rounded-sm');
    expect(tagWith(html, 'aria-label="Delete note"')).toContain('rounded-sm');
  });

  it('has no title attributes (the explanations are tooltips)', () => {
    expect(card()).not.toContain('title=');
    expect(card({ addToStyle: true })).not.toContain('title=');
  });
});

describe('<NoteCard> with "Add to style" on', () => {
  it('shows a filled "In style" toggle and the line naming the client', () => {
    const html = card({ addToStyle: true });
    const toggle = tagWith(html, 'aria-pressed="true"');
    expect(toggle).toContain('bg-foreground');
    expect(toggle).toContain('text-background');
    expect(toggle).toContain('dark:bg-foreground');
    expect(html).toContain('In style</button>');
    expect(html).not.toContain('>Add to style<');
    expect(html).toContain('When you send, this also goes into the style of');
    expect(html).toContain('<bdi class="text-foreground">מאפיית הצפון</bdi>');
  });
});

describe('<NoteCard> of a voice note', () => {
  const voice = {
    kind: 'voice',
    text: 'כאן הכתוביות מכסות את הידיים.',
    audioFile: 'edit/review/voice/n1.webm',
    audioSec: 9,
    transcriptStatus: 'done',
  } as const;

  it('has the "Voice note" tag, and its player and transcript instead of the text', () => {
    const html = card(voice);
    expect(tagWith(html, 'data-slot="review-note"')).toContain('data-kind="voice"');
    expect(html).toContain('Voice note</span>');
    expect(html).toContain('lucide-mic');
    expect(html).toContain('data-slot="voice-note"');
    expect(html).toContain('aria-label="Play voice note"');
    expect(html).toContain('<audio src="/api/jobs/a1b2c3d4e5f6/notes/n1/audio"');
    // The transcript is the one paragraph, and it is not the text note's (no whitespace-pre-wrap).
    expect(html.match(/<p /g)).toHaveLength(1);
    expect(tagWith(html, 'dir="auto"')).not.toContain('whitespace-pre-wrap');
    expect(html).toContain('כאן הכתוביות מכסות את הידיים.</p>');
  });

  it('shows "Transcribing…" while the transcript is on its way, and says when it failed', () => {
    expect(card({ ...voice, text: null, transcriptStatus: 'pending' })).toContain(
      'Transcribing…</p>',
    );
    const failed = card({ ...voice, text: null, transcriptStatus: 'failed' });
    expect(failed).toContain('Couldn&#x27;t transcribe. The editor will listen to it.</p>');
  });

  it('shows the length of the recording', () => {
    expect(card(voice)).toContain('>0:09</span>');
  });

  it('keeps the time chip, the toggle and the delete button', () => {
    const html = card(voice);
    expect(html).toContain('aria-label="Go to 0:02"');
    expect(html).toContain('Add to style</button>');
    expect(html).toContain('aria-label="Delete note"');
  });
});

describe('<NoteCard> states', () => {
  it('is idle: a quiet border and background', () => {
    const tag = tagWith(card(), 'data-slot="review-note"');
    expect(tag).toContain('data-state="idle"');
    expect(tag).toContain('border-border');
    expect(tag).toContain('bg-white/[0.02]');
  });

  it('is hovered: tinted blue', () => {
    const tag = tagWith(card({}, { hovered: true }), 'data-slot="review-note"');
    expect(tag).toContain('data-state="hovered"');
    expect(tag).toContain('border-[#3B82F6]/50');
    expect(tag).toContain('bg-[#3B82F6]/[0.08]');
  });

  it('is active: a white border and background, which win over hover', () => {
    const tag = tagWith(card({}, { hovered: true, active: true }), 'data-slot="review-note"');
    expect(tag).toContain('data-state="active"');
    expect(tag).toContain('border-white/35');
    expect(tag).toContain('bg-white/[0.06]');
    expect(tag).not.toContain('border-[#3B82F6]/50');
  });

  it('changes colour with an ease-in-out transition, as the board says', () => {
    const tag = tagWith(card(), 'data-slot="review-note"');
    expect(tag).toContain('transition-colors');
    expect(tag).toContain('duration-150');
    expect(tag).toContain('ease-in-out');
  });

  it('has the board’s padding, radius and gap', () => {
    const tag = tagWith(card(), 'data-slot="review-note"');
    for (const className of ['rounded-md', 'gap-1.5', 'pt-2', 'pr-2', 'pb-2.5', 'pl-3']) {
      expect(tag).toContain(className);
    }
  });
});

describe('<NoteCard> on an episode of a series', () => {
  const SERIES = 'מיתוס או אמת';
  const episode = (
    noteOverrides: Parameters<typeof makeReviewNote>[0] = {},
    props: Partial<React.ComponentProps<typeof NoteCard>> = {},
  ) => card(noteOverrides, { seriesName: SERIES, ...props });

  it('has two toggles, Series then Style, in front of Delete, both off', () => {
    const html = episode();
    expect(html).toContain('Series</button>');
    expect(html).toContain('Style</button>');
    expect(html).not.toContain('Add to style</button>');
    expect(html).not.toContain('In series');
    expect(html).not.toContain('In style');
    expect(html.match(/aria-pressed="false"/g)).toHaveLength(2);
    expect(html).not.toContain('aria-pressed="true"');
    expect(html.indexOf('Series</button>')).toBeLessThan(html.indexOf('Style</button>'));
    expect(html.indexOf('Style</button>')).toBeLessThan(html.indexOf('aria-label="Delete note"'));
  });

  it('gives the toggles the Layers2 and the palette icons, and the same look as before', () => {
    const html = episode();
    expect(html).toContain('lucide-layers-2');
    expect(html).toContain('lucide-palette');
    const toggle = tagWith(html, 'aria-pressed="false"');
    expect(toggle).toContain('data-size="xs"');
    expect(toggle).toContain('rounded-sm');
    expect(toggle).toContain('text-muted-foreground');
    expect(html).not.toContain('title=');
  });

  it('fills "In series" and says what Send does, naming the series', () => {
    const html = episode({ addToSeries: true });
    const toggle = tagWith(html, 'aria-pressed="true"');
    expect(toggle).toContain('bg-foreground');
    expect(toggle).toContain('text-background');
    expect(html).toContain('In series</button>');
    expect(html).toContain('Style</button>');
    expect(html).toContain('When you send, this also goes into every later episode of');
    expect(html).toContain('<bdi class="text-foreground">מיתוס או אמת</bdi>');
    expect(html).not.toContain('goes into the style of');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
  });

  it('fills "In style" on its own, with the line naming the client', () => {
    const html = episode({ addToStyle: true });
    expect(html).toContain('Series</button>');
    expect(html).toContain('In style</button>');
    expect(html).toContain('When you send, this also goes into the style of');
    expect(html).toContain('<bdi class="text-foreground">מאפיית הצפון</bdi>');
    expect(html).not.toContain('every later episode');
  });

  it('shows both lines, the series first, when both are on', () => {
    const html = episode({ addToSeries: true, addToStyle: true });
    expect(html).toContain('In series</button>');
    expect(html).toContain('In style</button>');
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(2);
    expect(html.indexOf('every later episode')).toBeLessThan(html.indexOf('the style of'));
  });

  it('keeps the whole header on one line: a 6 px gap and a voice note’s tag as its icon', () => {
    const text = episode();
    expect(tagWith(text, 'class="flex items-center gap-1.5"')).toContain('gap-1.5');
    const voice = episode({
      kind: 'voice',
      text: 'כאן הכתוביות מכסות את הידיים.',
      audioFile: 'edit/review/voice/n1.webm',
      audioSec: 9,
      transcriptStatus: 'done',
      addToSeries: true,
      addToStyle: true,
    });
    // The words stay for screen readers; the mic is what is drawn.
    expect(voice).toContain('lucide-mic');
    expect(voice).toContain('<span class="sr-only">Voice note</span>');
    expect(voice).not.toContain('gap-1 text-xs text-muted-foreground"><svg');
    expect(voice).toContain('In series</button>');
    expect(voice).toContain('In style</button>');
  });

  it('is exactly the card it was on any other job: no Series toggle, the long "Add to style"', () => {
    const html = card({ addToSeries: true });
    expect(html).not.toContain('lucide-layers-2');
    expect(html).not.toContain('Series');
    expect(html).not.toContain('every later episode');
    expect(html).toContain('Add to style</button>');
    expect(html.match(/aria-pressed=/g)).toHaveLength(1);
    expect(tagWith(html, 'class="flex items-center gap-2"')).toContain('gap-2');
    // The voice note keeps its words, too.
    const voice = card({ kind: 'voice', text: 'x', audioSec: 9, transcriptStatus: 'done' });
    expect(voice).toContain('Voice note</span>');
    expect(voice).not.toContain('sr-only');
  });

  it('says the toggles’ words as the board does', () => {
    expect(NOTES_TEXT).toMatchObject({
      series: 'Series',
      inSeries: 'In series',
      addToSeriesTip: 'Add to series: also change every later episode',
      inSeriesTip: 'Keep this to this episode only',
      episodeStyle: 'Style',
      episodeStyleTip: 'Add to style: also save this for every future job of this client',
      inStyleTip: 'Remove from the client style',
      seriesLine: 'When you send, this also goes into every later episode of',
    });
  });
});

describe('<NoteCard> on the phone (board MReviewNotes)', () => {
  const phone = { variant: 'phone' } as const;

  it('has a 32 px time chip that still goes there', () => {
    const chip = tagWith(card({}, phone), 'aria-label="Go to 0:02"');
    expect(chip).toContain('h-8');
    expect(chip).not.toContain('h-[22px]');
  });

  it('has a 32 px Add to style toggle and a 36 px delete button', () => {
    const html = card({}, phone);
    expect(tagWith(html, 'aria-pressed="false"')).toContain('h-8');
    expect(tagWith(html, 'aria-label="Delete note"')).toContain('size-9');
  });

  it('keeps the Voice note words on a voice note, also on an episode of a series', () => {
    expect(card({ kind: 'voice' }, phone)).toContain('Voice note');
    expect(card({ kind: 'voice' }, { ...phone, seriesName: 'Tours' })).toContain('Voice note');
  });

  it('draws the text at 15 px, and a voice note’s play button at 36 px', () => {
    expect(tagWith(card({}, phone), 'dir="auto"')).toContain('text-[15px]');
    const voice = card({ kind: 'voice', audioSec: 9, transcriptStatus: 'done' }, phone);
    expect(tagWith(voice, 'aria-label="Play voice note"')).toContain('size-9');
  });

  it('sets the line under a note (where it goes) 2 px down, with the page’s 1.43 line', () => {
    const styleLine = (html: string) => tagWith(html, 'border-t border-white/[0.08]');
    expect(styleLine(card({ addToStyle: true }, phone))).toContain('mt-0.5');
    expect(styleLine(card({ addToStyle: true }, phone))).toContain('leading-[1.43]');
    expect(styleLine(card({ addToStyle: true }))).not.toContain('mt-0.5');
  });

  it('is the Mac’s card when no variant is given', () => {
    const html = card();
    expect(tagWith(html, 'aria-label="Go to 0:02"')).toContain('h-[22px]');
    expect(html).not.toContain('size-9');
  });
});

describe('<NoteCard> of a note that names a LUT or a graphic (lutsInEdits)', () => {
  const library = { libraryItems: libraryItems() };

  it('shows the token as a pill and says what the next edit does', () => {
    const html = card({ text: 'Make it @luts/cinematic', atSec: 12.4 }, library);
    expect(html).toContain('data-slot="library-token"');
    expect(html).toContain('>luts/cinematic</span>');
    expect(html).not.toContain('@luts/cinematic');
    expect(html).toContain('Saved. The next edit uses Cinematic on the whole video.');
  });

  it('puts the note’s time in the line for a graphic', () => {
    const html = card({ text: '@graphics/name-on-a-white-pill', atSec: 12.4 }, library);
    expect(html).toContain('Saved. The next edit places Name on a white pill at 0:12.');
  });

  it('shows a note with no token word for word, with no line', () => {
    const html = card({}, library);
    expect(html).toContain('הכותרת יורדת מהר מדי. &quot;להשאיר&quot; אותה עוד שנייה.</p>');
    expect(html).not.toContain('library-');
  });

  it('keeps a token that points at nothing as text, with no line', () => {
    const html = card({ text: 'try @luts/zzz' }, library);
    expect(html).toContain('try @luts/zzz</p>');
    expect(html).not.toContain('library-');
  });

  it('is the card it was while the switch is off (no items given)', () => {
    expect(card({ text: 'Make it @luts/cinematic' })).toContain('Make it @luts/cinematic</p>');
    expect(card({ text: 'Make it @luts/cinematic' })).not.toContain('library-');
  });

  it('adds nothing under a voice note', () => {
    const html = card(
      { kind: 'voice', text: '@luts/cinematic', transcriptStatus: 'done', audioSec: 3 },
      library,
    );
    expect(html).not.toContain('library-');
  });
});

describe('<NoteCard> of a note that names a font (fontsInNotes)', () => {
  const fonts = { fontCatalog: fontPickerCatalog(FONT_LIST), libraryItems: libraryItems() };

  it('shows each font token as a pill and says which text the next edit sets in it', () => {
    const html = card(
      { text: 'Titles in @Rubik Black and captions in @Heebo Medium', atSec: 12.4 },
      fonts,
    );
    expect(html.match(/data-slot="library-token"/g)).toHaveLength(2);
    expect(html).toContain('>@Rubik Black</span>');
    expect(html).toContain('>@Heebo Medium</span>');
    expect(html).toContain('Saved. The next edit uses Rubik Black for the titles.');
    expect(html).toContain('It also uses Heebo Medium for the captions.');
  });

  it('says "all the text it adds" when the note names no text', () => {
    expect(card({ text: 'Use @Heebo Bold' }, fonts)).toContain(
      'Saved. The next edit uses Heebo Bold for all the text it adds.',
    );
  });

  it('keeps the note in its own direction, with the pill left to right (a Hebrew note)', () => {
    const html = card({ text: 'תשנה את הכתוביות ל-@Heebo Bold', atSec: 12.4 }, fonts);
    expect(tagWith(html, 'dir="auto"')).toContain('[unicode-bidi:plaintext]');
    expect(tagWith(html, 'data-slot="library-token"')).toContain('dir="ltr"');
    expect(html).toContain('<span>תשנה את הכתוביות ל-</span>');
    expect(html).toContain('Saved. The next edit uses Heebo Bold for the captions.');
  });

  it('shows a font next to a LUT and a graphic, each with its line', () => {
    const html = card(
      {
        text: 'Captions in @Heebo Bold, grade @luts/cinematic, place @graphics/follow-card',
        atSec: 12.4,
      },
      fonts,
    );
    expect(html).toContain('Saved. The next edit uses Heebo Bold for the captions.');
    expect(html).toContain('It also uses Cinematic on the whole video.');
    expect(html).toContain('It also places Follow card at 0:12.');
  });

  it('names fonts alone when LUTs and graphics are off (no items): their tokens stay text', () => {
    const html = card(
      { text: 'Captions in @Heebo Bold, grade @luts/cinematic' },
      { fontCatalog: fonts.fontCatalog },
    );
    expect(html).toContain('>@Heebo Bold</span>');
    expect(html).toContain('<span>, grade @luts/cinematic</span></p>');
    expect(html).toContain('Saved. The next edit uses Heebo Bold for the captions.');
    expect(html).not.toContain('Cinematic');
  });

  it('shows a note with no token word for word, with no line', () => {
    const html = card({}, fonts);
    expect(html).toContain('הכותרת יורדת מהר מדי. &quot;להשאיר&quot; אותה עוד שנייה.</p>');
    expect(html).not.toContain('library-');
  });

  it('keeps a font the library does not have as text, and says the edit will use the closest one', () => {
    const html = card({ text: 'Make the captions @Gotham Bold' }, fonts);
    expect(html).toContain('Make the captions @Gotham Bold</p>');
    expect(html).not.toContain('data-slot="library-token"');
    expect(html).toContain(
      'Gotham Bold isn’t in your library, so the edit will use the closest font it has.',
    );
    // Not "Saved.": the note names nothing it has, so there is no usual line to lead with.
    expect(html).not.toContain('Saved.');
  });

  it('puts that line after the usual one, in the same dim lines under the note', () => {
    const html = card(
      { text: 'Make the title @Outfit Bold and the lower third in @Gotham Bold', atSec: 12.4 },
      fonts,
    );
    expect(html).toContain('Saved. The next edit uses Outfit Bold for the titles.');
    expect(html.indexOf('Saved. The next edit')).toBeLessThan(html.indexOf('Gotham Bold isn’t'));
    const lines = tagWith(html, 'data-slot="library-note-lines"');
    expect(lines).toContain('flex-col');
    expect(html.match(/text-xs text-pretty text-zinc-500/g)).toHaveLength(2);
  });

  it('says nothing for a name the library resolves: @Heebo Bold Italic is Heebo Bold', () => {
    const html = card({ text: 'Captions in @Heebo Bold Italic' }, fonts);
    expect(html).toContain('Saved. The next edit uses Heebo Bold for the captions.');
    expect(html).not.toContain('isn’t in your library');
  });

  it('does not take a LUT or a graphic that points at nothing for a font', () => {
    const html = card({ text: 'try @luts/zzz and @graphics/none' }, fonts);
    expect(html).not.toContain('isn’t in your library');
    expect(html).not.toContain('library-');
  });

  it('says nothing about a font while the font list is not in yet', () => {
    const html = card(
      { text: 'Make the captions @Gotham Bold' },
      { fontCatalog: fontPickerCatalog(undefined), libraryItems: libraryItems() },
    );
    expect(html).not.toContain('isn’t in your library');
    expect(html).not.toContain('library-');
  });

  it('says nothing under a note that names no font, and nothing at all while the switch is off', () => {
    expect(
      card({ text: 'Make the captions @Gotham Bold' }, { libraryItems: libraryItems() }),
    ).not.toContain('isn’t in your library');
    expect(card({ text: 'Make the captions @Gotham Bold' })).not.toContain('isn’t in your library');
  });

  it('is the card it was while the switch is off (no catalog given): the token is text', () => {
    const html = card({ text: 'Captions in @Heebo Bold' }, { libraryItems: libraryItems() });
    expect(html).toContain('Captions in @Heebo Bold</p>');
    expect(html).not.toContain('library-');
    expect(card({ text: 'Captions in @Heebo Bold' })).toContain('Captions in @Heebo Bold</p>');
  });

  it('adds nothing under a voice note', () => {
    const html = card(
      { kind: 'voice', text: '@Heebo Bold', transcriptStatus: 'done', audioSec: 3 },
      fonts,
    );
    expect(html).not.toContain('library-');
  });
});

describe('<NoteCard> with Quick fixes on (the line under the note)', () => {
  const CONTEXT = { auto: true, loaded: true, newestFixedId: 'f1', busy: false };
  const lineFor = (...args: Parameters<typeof noteFixLine>): NoteFixLine => {
    const line = noteFixLine(...args);
    if (line === null) throw new Error('no line');
    return line;
  };
  const running = lineFor(routedNote('quick'), makeOpenFix('running'), CONTEXT);
  const fixed = lineFor(routedNote('quick'), makeQuickFix(), CONTEXT);
  const olderFixed = lineFor(routedNote('quick'), makeQuickFix(), {
    ...CONTEXT,
    newestFixedId: 'f9',
  });
  const sends = lineFor(routedNote('revise'), null, CONTEXT);

  it('is the card it was while Quick fixes are off (no line given): nothing of fixes in it', () => {
    const html = card();
    expect(html).not.toContain('data-slot="note-fix"');
    expect(html).not.toContain('role="status"');
    expect(html).not.toContain('data-slot="reveal"');
    expect(tagWith(html, 'aria-label="Delete note"')).not.toContain('disabled=""');
  });

  it('adds nothing for a note with no line (a manual level, a note Auto never read)', () => {
    const html = card({}, { fixLine: null });
    expect(html).not.toContain('data-slot="note-fix"');
    expect(html).not.toContain('data-slot="reveal"');
    expect(html).toContain('aria-label="Delete note"');
  });

  it('shows the line under the note’s words, after its font lines, before the style line', () => {
    const html = card(
      { text: 'Captions in @Heebo Bold', addToStyle: true },
      {
        fixLine: sends,
        fontCatalog: fontPickerCatalog(FONT_LIST),
        libraryItems: libraryItems(),
      },
    );
    const words = html.indexOf('Captions in');
    const fontLine = html.indexOf('Saved. The next edit uses Heebo Bold');
    const fixLine = html.indexOf('Goes with Send · it changes the cut');
    const styleLine = html.indexOf('When you send, this also goes into the style of');
    expect(words).toBeGreaterThan(-1);
    expect(fontLine).toBeGreaterThan(words);
    expect(fixLine).toBeGreaterThan(fontLine);
    expect(styleLine).toBeGreaterThan(fixLine);
  });

  it('keeps the note’s own words in their own direction', () => {
    const html = card({}, { fixLine: fixed });
    expect(tagWith(html, 'dir="auto"')).toContain('[unicode-bidi:plaintext]');
  });

  it('takes 300 ms to change the border of a card with a line (the board), 150 ms without one', () => {
    for (const line of [running, fixed, sends]) {
      const tag = tagWith(card({}, { fixLine: line }), 'data-slot="review-note"');
      expect(tag).toContain('duration-300');
      expect(tag).not.toContain('duration-150');
      expect(tag).toContain('ease-in-out');
    }
    for (const given of [{ fixLine: null }, {}]) {
      const tag = tagWith(card({}, given), 'data-slot="review-note"');
      expect(tag).toContain('duration-150');
      expect(tag).not.toContain('duration-300');
    }
  });

  it('gives a card whose fix runs the blue border, a disabled delete button and the bar', () => {
    const html = card({}, { fixLine: running });
    expect(tagWith(html, 'data-slot="review-note"')).toContain('border-[#3B82F6]/45');
    expect(tagWith(html, 'aria-label="Delete note"')).toContain('disabled=""');
    expect(html).toContain('data-slot="note-fix-bar"');
  });

  it('keeps the plain border for the other lines, and a hovered or active card its own', () => {
    for (const line of [fixed, sends]) {
      expect(tagWith(card({}, { fixLine: line }), 'data-slot="review-note"')).not.toContain(
        '#3B82F6]/45',
      );
    }
    const hovered = tagWith(
      card({}, { fixLine: running, hovered: true }),
      'data-slot="review-note"',
    );
    expect(hovered).toContain('border-[#3B82F6]/50');
    expect(hovered).not.toContain('#3B82F6]/45');
    expect(
      tagWith(card({}, { fixLine: running, active: true }), 'data-slot="review-note"'),
    ).toContain('border-white/35');
  });

  it('hides the delete button of a fixed note that is not the newest fix, and has no Undo on it', () => {
    const html = card({}, { fixLine: olderFixed });
    expect(html).not.toContain('aria-label="Delete note"');
    expect(html).not.toContain('lucide-trash-2');
    expect(html).not.toContain('Undo');
    expect(html).toContain('Fixed in 48 s.');
  });

  it('keeps the delete button on the newest fixed note, with Undo beside the line', () => {
    const html = card({}, { fixLine: fixed });
    expect(tagWith(html, 'aria-label="Delete note"')).not.toContain('disabled=""');
    expect(html).toContain('Undo</button>');
  });

  it('keeps the delete button on a note that waits for Send', () => {
    const html = card({}, { fixLine: sends });
    expect(tagWith(html, 'aria-label="Delete note"')).not.toContain('disabled=""');
  });

  it('keeps a Hebrew note and its Hebrew reply apart from the English words, on the Mac’s card and the phone’s', () => {
    const said = 'הכיתוב בשנייה 25.6 הוא עכשיו "יש סיפור משלו".';
    const line = lineFor(routedNote('quick'), makeQuickFix({ said }), CONTEXT);
    for (const variant of ['mac', 'phone'] as const) {
      const html = card({}, { fixLine: line, variant });
      // The note's words and the reply each have their own dir="auto" element.
      expect(html.match(/dir="auto"/g)).toHaveLength(2);
      const reply = tagWith(html, 'data-slot="note-fix-said"');
      expect(reply).toContain('dir="auto"');
      expect(reply).toContain('[unicode-bidi:plaintext]');
      // "Fixed in 48 s." stays an English line of its own; the reply starts after it.
      const status = html.slice(html.indexOf('role="status"'));
      expect(status).toContain('>Fixed in 48 s.<span dir="auto" data-slot="note-fix-said"');
    }
  });

  it('is the phone’s card on the phone, with a 32 px Undo and no tooltip', () => {
    const html = card({}, { fixLine: fixed, variant: 'phone' });
    const end = html.indexOf('Undo</button>');
    expect(end).toBeGreaterThan(-1);
    const start = html.lastIndexOf('<button', end);
    expect(html.slice(start, html.indexOf('>', start))).toContain('h-8');
  });
});

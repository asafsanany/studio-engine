import { describe, expect, it } from 'vitest';
import {
  FIXED_NOTES_HEADING,
  type FixedNoteForFile,
  formatNoteTime,
  type ReviewNoteForFile,
  renderRoundFile,
  renderSeriesNotesFile,
  renderStyleNotesFile,
  STYLE_NOTES_FILE_NAME_MAX_BYTES,
  styleNotesFileName,
} from './notes-files.ts';
import { bakeryRound, bakerySeries, bakeryStyle, makeNote } from './test-fixtures.ts';

/** UTF-8 bytes of a string, counted on its own (the package has no TextEncoder). */
const utf8Bytes = (s: string): number => encodeURIComponent(s).replace(/%[0-9A-F]{2}/g, '_').length;

/** The round file of a job called Job, from a client called Client, with these notes. */
function round(notes: readonly ReviewNoteForFile[], n = 1): string {
  return renderRoundFile({ job: 'Job', client: 'Client', round: n, notes });
}

/** The round file of a job with no notes at all. */
const NO_NOTES =
  "# Review notes, round 1: Job (Client)\n\nThe owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.\n";

/** The §7 header, written out here so a change in the code's text fails a test. */
const STYLE_HEADER = `# Review notes from Job (round 4)

The owner wrote these while reviewing this job and asked for them to become part of this client's style. Turn each into a general rule for the client's future videos, in plain English (for example "the title goes too fast" becomes "Titles stay on screen about a second longer"). Keep any on-screen text word for word. Ignore the times; they only place the note in this job.
`;

/** The series-notes header, written out here so a change in the code's text fails a test. */
const SERIES_HEADER = `# Review notes from Job (round 4)

The owner wrote these while reviewing this episode and asked for them to become part of the series “Weekly”. Turn each into a rule for the series' next episodes, in plain English (for example "the title goes too fast" becomes "Titles stay on screen about a second longer"). Keep any on-screen text word for word. Ignore the times; they only place the note in this episode. A rule is for this series only, not for the client's other videos.
`;

/** Freezes the notes and every note in them, so a sort or a write in place throws in strict mode. */
function frozen(notes: readonly ReviewNoteForFile[]): readonly ReviewNoteForFile[] {
  return Object.freeze(notes.map((note) => Object.freeze({ ...note })));
}

/** The edge-case notes of the second round-file golden, in input order. */
const springNotes: ReviewNoteForFile[] = [
  makeNote({
    atSec: 65.25,
    kind: 'voice',
    text: null,
    audioFile: 'edit/review/voice/b7.m4a',
    transcriptStatus: 'failed',
  }),
  makeNote({
    atSec: 3,
    text: 'Two things here:\r\n- the title is late\r\n\r\n\r\n- the music is too loud  ',
  }),
  makeNote({
    atSec: 30.04,
    kind: 'voice',
    text: null,
    audioFile: 'edit/review/voice/c9.webm',
    transcriptStatus: 'pending',
  }),
  makeNote({
    atSec: 3,
    kind: 'voice',
    text: '  Cut the second clap. ',
    audioFile: 'edit/review/voice/a1.webm',
    transcriptStatus: 'done',
  }),
];

describe('formatNoteTime', () => {
  it.each([
    [0, '0:00.0'],
    [2.4, '0:02.4'],
    [2.43, '0:02.4'],
    [7.8, '0:07.8'],
    [15.62, '0:15.6'],
    [9.96, '0:10.0'],
    [59.94, '0:59.9'],
    [59.96, '1:00.0'],
    [65.25, '1:05.3'],
    [600, '10:00.0'],
    [3599.94, '59:59.9'],
  ])('%d s is %s', (sec, expected) => {
    expect(formatNoteTime(sec)).toBe(expected);
  });

  it.each([
    [0.05, '0:00.1'],
    [0.25, '0:00.3'],
    [1.45, '0:01.5'],
    [2.45, '0:02.5'],
    [0.04, '0:00.0'],
  ])(
    'rounds a half up even when floating point lands just under it: %d s is %s',
    (sec, expected) => {
      expect(formatNoteTime(sec)).toBe(expected);
    },
  );

  it.each([
    [3599.96, '60:00.0'],
    [3600, '60:00.0'],
    [3725.5, '62:05.5'],
  ])('keeps counting minutes past 59:59.9, with no hours: %d s is %s', (sec, expected) => {
    expect(formatNoteTime(sec)).toBe(expected);
  });

  it.each([
    ['-1', -1],
    ['-0', -0],
    ['NaN', Number.NaN],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['-Infinity', Number.NEGATIVE_INFINITY],
  ])('gives 0:00.0 for %s', (_name, sec) => {
    expect(formatNoteTime(sec)).toBe('0:00.0');
  });
});

describe('renderRoundFile: golden', () => {
  it('reproduces the bakery round file byte for byte, with the notes sorted', () => {
    expect(renderRoundFile(bakeryRound)).toBe(bakeryRound.markdown);
  });

  it('reproduces the edge-case round file byte for byte', () => {
    const expected = [
      '# Review notes, round 2: Spring promo (Arc Fitness)',
      '',
      "The owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.",
      '',
      '- 0:03.0 — Two things here:',
      '  - the title is late',
      '',
      '  - the music is too loud',
      '- 0:03.0 — voice note (edit/review/voice/a1.webm): "Cut the second clap."',
      '- 0:30.0 — voice note (edit/review/voice/c9.webm): not transcribed',
      '- 1:05.3 — voice note (edit/review/voice/b7.m4a): not transcribed',
      '',
    ].join('\n');
    const input = { job: 'Spring promo', client: 'Arc Fitness', round: 2, notes: springNotes };
    expect(renderRoundFile(input)).toBe(expected);
  });

  it('is pure: frozen input, input unchanged, same text twice', () => {
    const notes = frozen(bakeryRound.notes);
    const before = JSON.parse(JSON.stringify(notes));
    const input = { job: bakeryRound.job, client: bakeryRound.client, round: 1, notes };
    const a = renderRoundFile(input);
    const b = renderRoundFile(input);
    expect(a).toBe(b);
    expect(notes).toEqual(before);
  });

  it.each([
    ['bakery', () => renderRoundFile(bakeryRound)],
    [
      'edge-case',
      () =>
        renderRoundFile({
          job: 'Spring promo',
          client: 'Arc Fitness',
          round: 2,
          notes: springNotes,
        }),
    ],
  ])('the %s output is plain, clean Markdown', (_name, render) => {
    const out = render();
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
    expect(out).not.toContain('\r');
    expect(out).not.toMatch(/[ \t]$/m);
    expect(out).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
  });
});

describe('renderRoundFile: rules', () => {
  it('uses the round and the names as given in the header', () => {
    expect(round([], 3).startsWith('# Review notes, round 3: Job (Client)\n\n')).toBe(true);
  });

  it('is the header and the intro, and nothing else, when there are no notes', () => {
    expect(round([])).toBe(NO_NOTES);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only white space', '  \n\t '],
  ])('gives a text note with %s no line', (_name, text) => {
    expect(round([makeNote({ text })])).toBe(NO_NOTES);
  });

  it('trims a text note and ignores its audioFile and transcriptStatus', () => {
    const note = makeNote({ text: '  Hi.\n', audioFile: 'x.webm', transcriptStatus: 'failed' });
    expect(round([note])).toBe(`${NO_NOTES.trimEnd()}\n\n- 0:00.0 — Hi.\n`);
  });

  it('puts the notes in a block after one blank line, one note per line', () => {
    const out = round([makeNote({ text: 'One.' }), makeNote({ atSec: 5, text: 'Two.' })]);
    expect(out).toBe(`${NO_NOTES}\n- 0:00.0 — One.\n- 0:05.0 — Two.\n`);
  });

  it.each([
    ['pending', 'pending', 'Hi.'],
    ['failed', 'failed', 'Hi.'],
    ['null', null, 'Hi.'],
    ['undefined', undefined, 'Hi.'],
    ['done with a null text', 'done', null],
    ['done with an empty text', 'done', ''],
    ['done with a blank text', 'done', '   '],
  ] as const)(
    'writes a voice note whose status is %s as not transcribed',
    (_name, transcriptStatus, text) => {
      const note = makeNote({
        kind: 'voice',
        text,
        audioFile: 'edit/review/voice/v.webm',
        transcriptStatus,
      });
      expect(round([note])).toBe(
        `${NO_NOTES}\n- 0:00.0 — voice note (edit/review/voice/v.webm): not transcribed\n`,
      );
    },
  );

  it('quotes a transcript with straight double quotes, trimmed, and leaves quotes inside it alone', () => {
    const note = makeNote({
      kind: 'voice',
      text: ' She said "stop" there. ',
      audioFile: 'edit/review/voice/v.webm',
      transcriptStatus: 'done',
    });
    expect(round([note])).toContain(
      '- 0:00.0 — voice note (edit/review/voice/v.webm): "She said "stop" there."\n',
    );
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
  ])('leaves the file part out of a voice note whose audioFile is %s', (_name, audioFile) => {
    const untranscribed = makeNote({
      kind: 'voice',
      text: null,
      audioFile,
      transcriptStatus: 'failed',
    });
    const transcribed = makeNote({
      kind: 'voice',
      text: 'Hi.',
      audioFile,
      transcriptStatus: 'done',
    });
    expect(round([untranscribed])).toContain('- 0:00.0 — voice note: not transcribed\n');
    expect(round([transcribed])).toContain('- 0:00.0 — voice note: "Hi."\n');
  });

  describe('time order', () => {
    it('puts the notes in ascending order of atSec', () => {
      const out = round([
        makeNote({ atSec: 30, text: 'c' }),
        makeNote({ atSec: 5, text: 'a' }),
        makeNote({ atSec: 12.5, text: 'b' }),
      ]);
      expect(out.endsWith('- 0:05.0 — a\n- 0:12.5 — b\n- 0:30.0 — c\n')).toBe(true);
    });

    it('keeps notes with the same time in input order', () => {
      const out = round([
        makeNote({ atSec: 4, text: 'first' }),
        makeNote({ atSec: 1, text: 'early' }),
        makeNote({ atSec: 4, text: 'second' }),
        makeNote({ atSec: 4, text: 'third' }),
      ]);
      expect(
        out.endsWith('- 0:01.0 — early\n- 0:04.0 — first\n- 0:04.0 — second\n- 0:04.0 — third\n'),
      ).toBe(true);
    });

    it('puts a note with a NaN or a negative atSec first, as 0:00.0', () => {
      const out = round([
        makeNote({ atSec: 2, text: 'two' }),
        makeNote({ atSec: Number.NaN, text: 'nan' }),
        makeNote({ atSec: -4, text: 'negative' }),
      ]);
      expect(out.endsWith('- 0:00.0 — nan\n- 0:00.0 — negative\n- 0:02.0 — two\n')).toBe(true);
    });
  });

  describe('multi-line notes', () => {
    it('treats a lone \\r as a line break', () => {
      expect(round([makeNote({ text: 'a\rb' })]).endsWith('- 0:00.0 — a\n  b\n')).toBe(true);
    });

    it('indents a continuation line by two spaces and keeps its own leading spaces', () => {
      expect(round([makeNote({ text: 'a\n  b' })]).endsWith('- 0:00.0 — a\n    b\n')).toBe(true);
    });

    it('removes trailing white space from every line', () => {
      expect(
        round([makeNote({ text: 'a \t\nb   \nc' })]).endsWith('- 0:00.0 — a\n  b\n  c\n'),
      ).toBe(true);
    });

    it('turns a run of blank lines into one empty line, with no indent', () => {
      expect(round([makeNote({ text: 'a\n\n\n\nb' })]).endsWith('- 0:00.0 — a\n\n  b\n')).toBe(
        true,
      );
    });

    it('treats a line with only spaces as a blank line', () => {
      expect(round([makeNote({ text: 'a\n   \n  \nb' })]).endsWith('- 0:00.0 — a\n\n  b\n')).toBe(
        true,
      );
    });

    it('indents a voice transcript that spans lines the same way, inside its quotes', () => {
      const note = makeNote({
        kind: 'voice',
        text: 'first\nsecond',
        audioFile: 'edit/review/voice/v.webm',
        transcriptStatus: 'done',
      });
      expect(
        round([note]).endsWith(
          '- 0:00.0 — voice note (edit/review/voice/v.webm): "first\n  second"\n',
        ),
      ).toBe(true);
    });
  });

  describe('the text is kept as given', () => {
    it('does not normalize an NFD string', () => {
      const nfd = 'Café';
      const out = round([makeNote({ text: nfd })]);
      expect(out.endsWith(`— ${nfd}\n`)).toBe(true);
      expect(out.endsWith('— Café\n')).toBe(false);
    });

    it('does not change straight or curly quotes', () => {
      const text = 'It\'s "x", “y” and ‘z’ and ’w’.';
      expect(round([makeNote({ text })]).endsWith(`— ${text}\n`)).toBe(true);
    });

    it('does not add bidi marks to Hebrew', () => {
      expect(renderRoundFile(bakeryRound)).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
    });
  });
});

describe('renderStyleNotesFile', () => {
  const style = (notes: readonly ReviewNoteForFile[], n = 4): string | null =>
    renderStyleNotesFile({ job: 'Job', round: n, notes });

  it('reproduces the bakery style-notes file byte for byte', () => {
    expect(renderStyleNotesFile(bakeryStyle)).toBe(bakeryStyle.markdown);
  });

  it('starts with the header from the architecture page, word for word', () => {
    expect(style([makeNote({ text: 'Hi.' })])).toBe(`${STYLE_HEADER}\n- 0:00.0 — Hi.\n`);
  });

  it('uses the job name as given, not the file-name form', () => {
    const out = renderStyleNotesFile({ job: 'Promo 2/3: final', round: 2, notes: [makeNote()] });
    expect(out?.startsWith('# Review notes from Promo 2/3: final (round 2)\n\n')).toBe(true);
  });

  it('writes a voice transcript bare: no label, no audio path and no quotes', () => {
    const out = style([
      makeNote({
        kind: 'voice',
        text: ' Raise the captions. ',
        audioFile: 'edit/review/voice/v.webm',
        transcriptStatus: 'done',
      }),
    ]);
    expect(out).toBe(`${STYLE_HEADER}\n- 0:00.0 — Raise the captions.\n`);
    expect(out).not.toContain('voice note');
    expect(out).not.toContain('edit/review');
    expect(out).not.toContain('"Raise');
  });

  it.each([
    ['no notes', []],
    [
      'only notes without anything to turn into a rule',
      [
        makeNote({ kind: 'voice', text: null, audioFile: 'a.webm', transcriptStatus: 'failed' }),
        makeNote({ kind: 'voice', text: 'Hi.', audioFile: 'b.webm', transcriptStatus: 'pending' }),
        makeNote({ text: '  ' }),
      ],
    ],
  ])('returns null for %s', (_name, notes) => {
    expect(style(notes)).toBeNull();
  });

  it('gives a voice note without a transcript no line, and a text note without text none either', () => {
    const out = style([
      makeNote({
        atSec: 1,
        kind: 'voice',
        text: 'Cut it.',
        audioFile: 'a.webm',
        transcriptStatus: 'failed',
      }),
      makeNote({ atSec: 2, text: null }),
      makeNote({ atSec: 3, text: 'Keep it.' }),
    ]);
    expect(out).toBe(`${STYLE_HEADER}\n- 0:03.0 — Keep it.\n`);
  });

  it('sorts by time and indents multi-line notes as the round file does', () => {
    const out = style([
      makeNote({ atSec: 9, text: 'b\r\n\r\n\r\n c  ' }),
      makeNote({ atSec: 2, text: 'a' }),
    ]);
    expect(out).toBe(`${STYLE_HEADER}\n- 0:02.0 — a\n- 0:09.0 — b\n\n   c\n`);
  });

  it('is pure: frozen input, input unchanged, same text twice', () => {
    const notes = frozen(bakeryStyle.notes);
    const before = JSON.parse(JSON.stringify(notes));
    const input = { job: bakeryStyle.job, round: 1, notes };
    const a = renderStyleNotesFile(input);
    const b = renderStyleNotesFile(input);
    expect(a).toBe(b);
    expect(a).toBe(bakeryStyle.markdown);
    expect(notes).toEqual(before);
  });

  it('gives clean Markdown: one final newline, no blank-line runs, no trailing white space, no bidi marks', () => {
    const out = renderStyleNotesFile(bakeryStyle) ?? '';
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
    expect(out).not.toContain('\r');
    expect(out).not.toMatch(/[ \t]$/m);
    expect(out).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
  });
});

describe('renderSeriesNotesFile', () => {
  const series = (notes: readonly ReviewNoteForFile[], n = 4, name = 'Weekly'): string | null =>
    renderSeriesNotesFile({ series: name, job: 'Job', round: n, notes });

  it('reproduces the bakery series-notes file byte for byte', () => {
    expect(renderSeriesNotesFile(bakerySeries)).toBe(bakerySeries.markdown);
  });

  it('names the series and the episode, and never the client’s style', () => {
    const out = series([makeNote({ text: 'Hi.' })]);
    expect(out).toBe(`${SERIES_HEADER}\n- 0:00.0 — Hi.\n`);
    expect(out).toContain('part of the series “Weekly”');
    expect(out).toContain('this series only');
    expect(out).not.toContain("this client's style");
    expect(out).not.toContain("the client's future videos");
  });

  it('uses the series name and the job name as given', () => {
    const out = renderSeriesNotesFile({
      series: 'Q&A: “live”',
      job: 'Promo 2/3: final',
      round: 2,
      notes: [makeNote()],
    });
    expect(out?.startsWith('# Review notes from Promo 2/3: final (round 2)\n\n')).toBe(true);
    expect(out).toContain('part of the series “Q&A: “live””. ');
  });

  it('keeps the lines of the style-notes file: same notes, same lines, only the intro differs', () => {
    const lines = (text: string | null): string => (text ?? '').split('\n\n').slice(2).join('\n\n');
    expect(lines(renderSeriesNotesFile(bakerySeries))).toBe(
      lines(renderStyleNotesFile(bakeryStyle)),
    );
    expect(renderSeriesNotesFile(bakerySeries)).not.toBe(renderStyleNotesFile(bakeryStyle));
  });

  it('does not say when it is read: no round, send or approval is named in the intro', () => {
    const intro = (series([makeNote()]) ?? '').split('\n\n')[1] ?? '';
    expect(intro).not.toMatch(/\b(send|sent|approv|round)/i);
  });

  it('writes a voice transcript bare and gives notes without a transcript or text no line', () => {
    const out = series([
      makeNote({
        atSec: 1,
        kind: 'voice',
        text: ' Raise the captions. ',
        audioFile: 'edit/review/voice/v.webm',
        transcriptStatus: 'done',
      }),
      makeNote({ atSec: 2, kind: 'voice', text: 'Cut it.', transcriptStatus: 'failed' }),
      makeNote({ atSec: 3, text: null }),
    ]);
    expect(out).toBe(`${SERIES_HEADER}\n- 0:01.0 — Raise the captions.\n`);
  });

  it.each([
    ['no notes', []],
    [
      'only notes without anything to turn into a rule',
      [
        makeNote({ kind: 'voice', text: null, audioFile: 'a.webm', transcriptStatus: 'failed' }),
        makeNote({ text: '  ' }),
      ],
    ],
  ])('returns null for %s', (_name, notes) => {
    expect(series(notes)).toBeNull();
  });

  it('is pure: frozen input, input unchanged, same text twice', () => {
    const notes = frozen(bakerySeries.notes);
    const before = JSON.parse(JSON.stringify(notes));
    const input = { series: bakerySeries.series, job: bakerySeries.job, round: 1, notes };
    expect(renderSeriesNotesFile(input)).toBe(renderSeriesNotesFile(input));
    expect(renderSeriesNotesFile(input)).toBe(bakerySeries.markdown);
    expect(notes).toEqual(before);
  });

  it('gives clean Markdown: one final newline, no blank-line runs, no trailing white space, no bidi marks', () => {
    const out = renderSeriesNotesFile(bakerySeries) ?? '';
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
    expect(out).not.toContain('\r');
    expect(out).not.toMatch(/[ \t]$/m);
    expect(out).not.toMatch(/[‎‏‪-‮⁦-⁩]/);
  });
});

describe('styleNotesFileName', () => {
  it('writes the job name as given, Hebrew included', () => {
    expect(styleNotesFileName(bakeryRound.job, 1)).toBe(
      `Review notes – ${bakeryRound.job} – round 1.md`,
    );
  });

  it('puts an en dash with a space on each side around the job', () => {
    const name = styleNotesFileName('Job', 2);
    expect(name).toBe('Review notes – Job – round 2.md');
    expect(name).not.toContain('—');
    expect(name).not.toContain(' - ');
  });

  it('replaces /, : and a null character with a hyphen', () => {
    expect(styleNotesFileName('Promo 2/3: final', 2)).toBe(
      'Review notes – Promo 2-3- final – round 2.md',
    );
    expect(styleNotesFileName('a\0b', 1)).toBe('Review notes – a-b – round 1.md');
  });

  it('gives a composed and a decomposed name the same, composed, name', () => {
    const composed = styleNotesFileName('Café promo', 1);
    const decomposed = styleNotesFileName('Café promo', 1);
    expect(decomposed).toBe(composed);
    expect(composed).toContain('Café');
  });

  it('keeps emoji', () => {
    expect(styleNotesFileName('Launch 🚀', 1)).toBe('Review notes – Launch 🚀 – round 1.md');
  });

  it('writes a two-digit round in full', () => {
    expect(styleNotesFileName('Job', 12)).toBe('Review notes – Job – round 12.md');
  });

  describe('length', () => {
    it('allows 240 bytes', () => {
      expect(STYLE_NOTES_FILE_NAME_MAX_BYTES).toBe(240);
    });

    it('never changes a name that fits', () => {
      const name = styleNotesFileName('x'.repeat(208), 1);
      expect(name).toBe(`Review notes – ${'x'.repeat(208)} – round 1.md`);
      expect(utf8Bytes(name)).toBe(240);
    });

    it('cuts one byte over and ends the job part with …', () => {
      const name = styleNotesFileName('x'.repeat(209), 1);
      expect(name).toBe(`Review notes – ${'x'.repeat(205)}… – round 1.md`);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });

    it('counts two-byte letters as two bytes', () => {
      const name = styleNotesFileName('א'.repeat(150), 1);
      expect(name).toBe(`Review notes – ${'א'.repeat(102)}… – round 1.md`);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });

    it('never cuts a grapheme in half', () => {
      const name = styleNotesFileName('👍🏽'.repeat(60), 1);
      expect(name).toBe(`Review notes – ${'👍🏽'.repeat(25)}… – round 1.md`);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });

    it('drops the space before the …', () => {
      const name = styleNotesFileName(`${'a'.repeat(204)} ${'b'.repeat(10)}`, 1);
      expect(name).toBe(`Review notes – ${'a'.repeat(204)}… – round 1.md`);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });

    it('counts the replacement of / and : before it measures', () => {
      const name = styleNotesFileName(`${'x'.repeat(100)}/${'y'.repeat(200)}`, 1);
      expect(name).toBe(`Review notes – ${'x'.repeat(100)}-${'y'.repeat(104)}… – round 1.md`);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });

    it('leaves room for a two-digit round', () => {
      const name = styleNotesFileName('x'.repeat(300), 12);
      expect(name.endsWith('… – round 12.md')).toBe(true);
      expect(utf8Bytes(name)).toBeLessThanOrEqual(240);
    });
  });
});

// QF4 (CVP-376): a note fixed in Review goes along in the round file as already changed.
describe('renderRoundFile: notes already fixed in Review', () => {
  const fixedNote = (overrides: Partial<FixedNoteForFile>): FixedNoteForFile => ({
    ...makeNote(),
    ...overrides,
  });
  const fixedIntro =
    "The owner's other notes below were already done in the live preview (edit/preview/) while they were reviewing. Keep each of them exactly as it is: do not undo, redo or move them. They are listed so you know what the preview holds.";
  const waiting = [
    makeNote({ atSec: 12, text: 'swap this shot for the drone shot' }),
    makeNote({ atSec: 3, text: 'the music is too loud' }),
  ];
  const fixed: FixedNoteForFile[] = [
    fixedNote({
      atSec: 20.25,
      text: 'make the title yellow',
      said: 'The title is yellow now.',
    }),
    fixedNote({
      atSec: 7,
      kind: 'voice',
      text: 'change the caption font to Heebo Bold',
      audioFile: 'edit/review/voice/n2.webm',
      transcriptStatus: 'done',
      said: 'The captions are Heebo Bold now.\nThe title kept its font.',
    }),
  ];

  it('lists them under their heading after the waiting notes, each with its time, words and what the fix said', () => {
    const out = renderRoundFile({ job: 'Job', client: 'Client', round: 2, notes: waiting, fixed });
    expect(out).toBe(
      [
        '# Review notes, round 2: Job (Client)',
        '',
        "The owner watched the preview (edit/preview/) and wrote these notes. Each time is a moment on the preview's timeline.",
        '',
        '- 0:03.0 — the music is too loud',
        '- 0:12.0 — swap this shot for the drone shot',
        '',
        '## Already changed in Review (keep these)',
        '',
        fixedIntro,
        '',
        '- 0:07.0 — voice note (edit/review/voice/n2.webm): "change the caption font to Heebo Bold"',
        '  Changed: The captions are Heebo Bold now.',
        '  The title kept its font.',
        '- 0:20.3 — make the title yellow',
        '  Changed: The title is yellow now.',
        '',
      ].join('\n'),
    );
    expect(FIXED_NOTES_HEADING).toBe('Already changed in Review (keep these)');
  });

  it('is the file it always was when no note is fixed, whether the list is left out or empty', () => {
    const plain = renderRoundFile({ job: 'Job', client: 'Client', round: 1, notes: waiting });
    expect(
      renderRoundFile({ job: 'Job', client: 'Client', round: 1, notes: waiting, fixed: [] }),
    ).toBe(plain);
    expect(plain).not.toContain('Already changed');
    expect(plain).toBe(round(waiting));
  });

  it('keeps a fixed note whose fix said nothing, with its words only', () => {
    const out = renderRoundFile({
      job: 'Job',
      client: 'Client',
      round: 1,
      notes: waiting,
      fixed: [
        fixedNote({ atSec: 5, text: 'bigger logo', said: '  ' }),
        fixedNote({ atSec: 6, text: 'x' }),
      ],
    });
    expect(out.endsWith(`${fixedIntro}\n\n- 0:05.0 — bigger logo\n- 0:06.0 — x\n`)).toBe(true);
    expect(out).not.toContain('Changed:');
  });

  it('gives a fixed note without words no line, and leaves the heading out when none has a line', () => {
    const out = renderRoundFile({
      job: 'Job',
      client: 'Client',
      round: 1,
      notes: waiting,
      fixed: [fixedNote({ atSec: 5, text: null, said: 'Done.' })],
    });
    expect(out).not.toContain('Already changed');
  });

  it('is plain, clean Markdown and does not change its input', () => {
    const input = {
      job: 'Job',
      client: 'Client',
      round: 2,
      notes: Object.freeze(waiting.map((note) => Object.freeze({ ...note }))),
      fixed: Object.freeze(fixed.map((note) => Object.freeze({ ...note }))),
    };
    const out = renderRoundFile(input);
    expect(renderRoundFile(input)).toBe(out);
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
    expect(out).not.toMatch(/[ \t]$/m);
  });
});

describe('renderRoundFile with two formats', () => {
  const formats = [
    { id: '9x16', label: '9:16' },
    { id: '1x1', label: '1:1' },
  ];
  const notes: ReviewNoteForFile[] = [
    makeNote({ atSec: 7, text: 'Stress the BUT more.' }),
    makeNote({ atSec: 32, text: 'End card: logo bigger.', format: '1x1' }),
  ];
  const withFormats = (input: readonly ReviewNoteForFile[]): string =>
    renderRoundFile({ job: 'Job', client: 'Client', round: 1, notes: input, formats });

  it('prints the format each note was written on after its time', () => {
    const text = withFormats(notes);
    expect(text).toContain('- 0:07.0 (on 9:16) — Stress the BUT more.');
    expect(text).toContain('- 0:32.0 (on 1:1) — End card: logo bigger.');
  });

  it('explains the stamp once, under the intro', () => {
    const text = withFormats(notes);
    expect(text).toContain("which format's preview they were watching");
    expect(text.indexOf('which format')).toBeGreaterThan(text.indexOf('Each time is a moment'));
  });

  it('stamps the notes fixed in Review too', () => {
    const text = renderRoundFile({
      job: 'Job',
      client: 'Client',
      round: 1,
      notes: [],
      fixed: [
        { ...makeNote({ atSec: 3, text: 'Bigger captions.', format: '1x1' }), said: 'Done.' },
      ],
      formats,
    });
    expect(text).toContain('- 0:03.0 (on 1:1) — Bigger captions.');
  });

  it('leaves a format the job no longer has unstamped', () => {
    expect(withFormats([makeNote({ atSec: 1, text: 'Old.', format: '4x5' })])).toContain(
      '- 0:01.0 — Old.',
    );
  });

  it('is the file it was before formats with one format, none, or no list', () => {
    const plain = round(notes);
    expect(renderRoundFile({ job: 'Job', client: 'Client', round: 1, notes, formats: [] })).toBe(
      plain,
    );
    expect(
      renderRoundFile({
        job: 'Job',
        client: 'Client',
        round: 1,
        notes,
        formats: formats.slice(0, 1),
      }),
    ).toBe(plain);
    expect(plain).not.toContain('(on ');
  });

  it('leaves the style and series notes files alone', () => {
    const style = renderStyleNotesFile({ job: 'Job', round: 1, notes });
    expect(style).not.toContain('(on ');
  });
});

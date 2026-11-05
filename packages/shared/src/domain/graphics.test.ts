import { describe, expect, expectTypeOf, it } from 'vitest';
import { EFFORT_LEVELS } from './effort.ts';
import {
  cleanGraphicName,
  decodeGraphicVars,
  deleteGraphicResponseSchema,
  encodeGraphicVars,
  freeGraphicName,
  GRAPHIC_BACKGROUND_LABELS,
  GRAPHIC_BACKGROUNDS,
  GRAPHIC_KIND_LABELS,
  GRAPHIC_KINDS,
  GRAPHIC_LIMITS,
  GRAPHIC_MESSAGES,
  GRAPHIC_SIZE_LABELS,
  GRAPHIC_SIZE_PIXELS,
  GRAPHIC_SIZES,
  GRAPHIC_STEP_LABELS,
  type GraphicAbout,
  type GraphicDetail,
  type GraphicStatusRow,
  graphicAboutSchema,
  graphicBusyMessage,
  graphicCopiedText,
  graphicCopyName,
  graphicDetailSchema,
  graphicListResponseSchema,
  graphicMessageFieldsSchema,
  graphicMessageSchema,
  graphicNameKey,
  graphicRestoredText,
  graphicStatusOf,
  graphicStepLabels,
  graphicStoppedByEngineMessage,
  graphicSummarySchema,
  graphicVariableSchema,
  graphicVoiceResponseSchema,
  NEW_GRAPHIC_NAME,
  revealGraphicResponseSchema,
  updateGraphicRequestSchema,
} from './graphics.ts';
import {
  makeGraphicDetail,
  makeGraphicMessage,
  makeGraphicSummary,
  makeYourGraphicMessage,
} from './test-fixtures.ts';

describe('kinds, sizes and backgrounds', () => {
  it('has the five kinds, each with its words', () => {
    expect(GRAPHIC_KINDS).toEqual(['title', 'lower-third', 'callout', 'end-card', 'other']);
    expect(GRAPHIC_KINDS.map((kind) => GRAPHIC_KIND_LABELS[kind])).toEqual([
      'Title',
      'Lower third',
      'Callout',
      'End card',
      'Graphic',
    ]);
  });

  it('has the three sizes in pixels and as the toggle says them', () => {
    expect(GRAPHIC_SIZES).toEqual(['9x16', '16x9', '1x1']);
    expect(GRAPHIC_SIZE_PIXELS).toEqual({
      '9x16': { width: 1080, height: 1920 },
      '16x9': { width: 1920, height: 1080 },
      '1x1': { width: 1080, height: 1080 },
    });
    expect(GRAPHIC_SIZES.map((size) => GRAPHIC_SIZE_LABELS[size])).toEqual(['9:16', '16:9', '1:1']);
  });

  it('has the three backgrounds of "Behind it"', () => {
    expect(GRAPHIC_BACKGROUNDS).toEqual(['frame', 'checker', 'black']);
    expect(GRAPHIC_BACKGROUNDS.map((bg) => GRAPHIC_BACKGROUND_LABELS[bg])).toEqual([
      'Sample frame',
      'See-through',
      'Black',
    ]);
  });
});

describe('steps and limits', () => {
  it('words the steps of a first version and of a change', () => {
    expect(GRAPHIC_STEP_LABELS.first).toEqual([
      'Reading your request',
      'Building the graphic',
      'Checking it at 9:16, 16:9 and 1:1',
    ]);
    expect(GRAPHIC_STEP_LABELS.change).toEqual([
      'Reading your note',
      'Changing the graphic',
      'Checking it at 9:16, 16:9 and 1:1',
    ]);
    expect(graphicStepLabels(1)).toBe(GRAPHIC_STEP_LABELS.first);
    expect(graphicStepLabels(2)).toBe(GRAPHIC_STEP_LABELS.change);
    expect(graphicStepLabels(9)).toBe(GRAPHIC_STEP_LABELS.change);
  });

  it('keeps the limits of the plan', () => {
    expect(GRAPHIC_LIMITS).toEqual({
      nameMax: 60,
      textMax: 4000,
      refsMaxFiles: 5,
      refsMaxBytes: 500 * 1024 * 1024,
      variablesMax: 8,
      whenMax: 200,
      replyMax: 600,
      lengthMinSec: 0.5,
      lengthMaxSec: 30,
      runsAtOnce: 2,
      runTimeoutMs: 20 * 60 * 1000,
    });
  });
});

describe('graphicVariableSchema', () => {
  it('takes an id of lower-case letters, digits and _, starting with a letter', () => {
    for (const id of ['name', 'role_2', 'a']) {
      expect(graphicVariableSchema.safeParse({ id, label: 'Name', default: 'x' }).success, id).toBe(
        true,
      );
    }
    for (const id of ['', 'Name', '2nd', '_name', 'first-name', 'שם']) {
      expect(graphicVariableSchema.safeParse({ id, label: 'Name', default: 'x' }).success, id).toBe(
        false,
      );
    }
  });

  it('needs a label', () => {
    expect(graphicVariableSchema.safeParse({ id: 'name', label: ' ', default: '' }).success).toBe(
      false,
    );
  });
});

describe('graphicAboutSchema (about.json)', () => {
  const about: GraphicAbout = {
    name: 'Name on a white pill',
    kind: 'lower-third',
    lengthSec: 3,
    variables: [{ id: 'name', label: 'Name', default: 'דנה לוי' }],
    when: 'The first time a person is named on camera.',
    reply: 'Made v1. A white pill with the name in Heebo Bold.',
  };

  it('parses the answer of a first version, and of a later one without a name', () => {
    expect(graphicAboutSchema.parse(about)).toEqual(about);
    const { name: _name, ...later } = about;
    expect(graphicAboutSchema.parse(later)).toEqual(later);
  });

  it('trims the words', () => {
    expect(graphicAboutSchema.parse({ ...about, when: '  Openers.  ' }).when).toBe('Openers.');
  });

  it.each([
    ['a name over 60 characters', { name: 'x'.repeat(61) }],
    ['an unknown kind', { kind: 'banner' }],
    ['a length under 0.5 s', { lengthSec: 0.4 }],
    ['a length over 30 s', { lengthSec: 30.5 }],
    [
      'more than 8 text fields',
      {
        variables: Array.from({ length: 9 }, (_, i) => ({ id: `v${i}`, label: 'V', default: '' })),
      },
    ],
    [
      'a text field id twice',
      {
        variables: [
          { id: 'name', label: 'Name', default: '' },
          { id: 'name', label: 'Other', default: '' },
        ],
      },
    ],
    ['a When over 200 characters', { when: 'x'.repeat(201) }],
    ['no When', { when: '' }],
    ['a reply over 600 characters', { reply: 'x'.repeat(601) }],
    ['no reply', { reply: ' ' }],
  ])('refuses %s', (_label, change) => {
    expect(graphicAboutSchema.safeParse({ ...about, ...change }).success).toBe(false);
  });
});

describe('the wire shapes', () => {
  it('parses a summary, a message and a detail', () => {
    expect(graphicSummarySchema.parse(makeGraphicSummary())).toEqual(makeGraphicSummary());
    expect(graphicMessageSchema.parse(makeYourGraphicMessage())).toEqual(makeYourGraphicMessage());
    expect(graphicDetailSchema.parse(makeGraphicDetail())).toEqual(makeGraphicDetail());
    expect(graphicListResponseSchema.parse([makeGraphicSummary()])).toHaveLength(1);
  });

  it('parses a new graphic being made: no kind, no length, no version yet', () => {
    const making = makeGraphicSummary({
      name: 'New graphic',
      kind: null,
      lengthSec: null,
      version: null,
      status: 'making',
      makingVersion: 1,
    });
    expect(graphicSummarySchema.parse(making)).toEqual(making);
  });

  it('refuses an id that is not 12 hex characters', () => {
    for (const id of ['', 'abc', 'ABCDEF123456', '3f9a1c2b7d4e0']) {
      expect(graphicSummarySchema.safeParse(makeGraphicSummary({ id })).success, id).toBe(false);
    }
  });

  it('refuses a step outside 0–2 and a version under 1', () => {
    expect(
      graphicMessageSchema.safeParse({ ...makeGraphicMessage({ status: 'making' }), step: 3 })
        .success,
    ).toBe(false);
    expect(graphicMessageSchema.safeParse(makeGraphicMessage({ version: 0 })).success).toBe(false);
  });

  it('carries "Used in" as null while edits do not use the library', () => {
    expect(graphicDetailSchema.parse(makeGraphicDetail({ usedIn: null })).usedIn).toBeNull();
    expect(graphicDetailSchema.parse(makeGraphicDetail({ usedIn: 4 })).usedIn).toBe(4);
  });

  it('infers a detail as the summary and its page fields', () => {
    expectTypeOf<GraphicDetail>().toMatchTypeOf<ReturnType<typeof makeGraphicSummary>>();
  });
});

describe('updateGraphicRequestSchema', () => {
  it('takes any one of name, when and uses', () => {
    for (const body of [{ name: 'X' }, { when: 'Openers.' }, { uses: false }]) {
      expect(updateGraphicRequestSchema.safeParse(body).success).toBe(true);
    }
  });

  it('refuses an empty body, a When over 200 characters and a uses that is not a boolean', () => {
    expect(updateGraphicRequestSchema.safeParse({}).success).toBe(false);
    expect(updateGraphicRequestSchema.safeParse({ when: 'x'.repeat(201) }).success).toBe(false);
    expect(updateGraphicRequestSchema.safeParse({ uses: 'yes' }).success).toBe(false);
  });
});

describe('graphicMessageFieldsSchema (the multipart text fields)', () => {
  it('takes text of 0 to 4000 characters once trimmed, and an optional effort', () => {
    expect(graphicMessageFieldsSchema.parse({ text: '  A lower third. ' })).toEqual({
      text: 'A lower third.',
    });
    for (const effort of EFFORT_LEVELS) {
      expect(graphicMessageFieldsSchema.parse({ text: 'x', effort }).effort).toBe(effort);
    }
    expect(graphicMessageFieldsSchema.safeParse({ text: 'x'.repeat(4000) }).success).toBe(true);
  });

  it('takes empty text: a message may be only attachments (the route asks for text or a file)', () => {
    expect(graphicMessageFieldsSchema.parse({ text: '   ' })).toEqual({ text: '' });
    expect(graphicMessageFieldsSchema.parse({ text: '' })).toEqual({ text: '' });
  });

  it('refuses too much text and an effort that does not exist', () => {
    expect(graphicMessageFieldsSchema.safeParse({ text: 'x'.repeat(4001) }).success).toBe(false);
    expect(graphicMessageFieldsSchema.safeParse({ text: 'x', effort: 'max' }).success).toBe(false);
  });
});

describe('the small answers', () => {
  it('parses the voice, reveal and delete answers', () => {
    expect(graphicVoiceResponseSchema.parse({ text: 'Slower.' })).toEqual({ text: 'Slower.' });
    expect(graphicVoiceResponseSchema.safeParse({ text: '' }).success).toBe(false);
    expect(revealGraphicResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    const deleted = { ok: true, where: '/Users/owner/.Trash/Name on a white pill' };
    expect(deleteGraphicResponseSchema.parse(deleted)).toEqual(deleted);
  });
});

describe('GRAPHIC_MESSAGES and the sentences', () => {
  it('words every refusal as one plain sentence', () => {
    expect(GRAPHIC_MESSAGES.off).toBe('Graphics are off.');
    for (const [key, message] of Object.entries(GRAPHIC_MESSAGES)) {
      expect(message, key).toMatch(/^[A-Z].*\.$/);
    }
  });

  it('asks to wait for the version being made', () => {
    expect(graphicBusyMessage(3, 'rename')).toBe('Wait until v3 is made, then rename it.');
    expect(graphicBusyMessage(1, 'send')).toBe(
      'Wait until v1 is made, then send your next message.',
    );
  });

  it('words a run the engine left, a version used again and a copy', () => {
    expect(graphicStoppedByEngineMessage(2)).toBe(
      'The engine stopped while it was making v2. Retry to make it again.',
    );
    expect(graphicRestoredText(1, 3)).toBe('v1 is back, as v3.');
    expect(graphicCopiedText('Name on a white pill', 2)).toBe(
      'Copied from Name on a white pill v2.',
    );
    expect(graphicCopyName('Name on a white pill')).toBe('Name on a white pill copy');
  });
});

describe('graphicStatusOf', () => {
  const you: GraphicStatusRow = { role: 'you', status: null, version: null };
  const claude = (status: GraphicStatusRow['status'], version: number): GraphicStatusRow => ({
    role: 'claude',
    status,
    version,
  });

  it('is empty with no version and nothing being made', () => {
    expect(graphicStatusOf(null, [])).toEqual({
      status: 'empty',
      makingVersion: null,
      failedVersion: null,
    });
    // A first run that was stopped leaves nothing.
    expect(graphicStatusOf(null, [you, claude('stopped', 1)]).status).toBe('empty');
  });

  it('is making while a run is making, whatever else', () => {
    expect(graphicStatusOf(null, [you, claude('making', 1)])).toEqual({
      status: 'making',
      makingVersion: 1,
      failedVersion: null,
    });
    expect(
      graphicStatusOf(2, [you, claude('done', 1), you, claude('failed', 2), claude('making', 2)]),
    ).toEqual({ status: 'making', makingVersion: 2, failedVersion: null });
  });

  it('is failed when the newest run failed, with the version it tried', () => {
    expect(graphicStatusOf(2, [you, claude('done', 2), you, claude('failed', 3)])).toEqual({
      status: 'failed',
      makingVersion: null,
      failedVersion: 3,
    });
    expect(graphicStatusOf(null, [you, claude('failed', 1)]).status).toBe('failed');
  });

  it('is ready once it has a version, when the newest run did not fail', () => {
    expect(graphicStatusOf(1, [you, claude('done', 1)]).status).toBe('ready');
    // A failure that a later run made good is over.
    expect(graphicStatusOf(2, [you, claude('failed', 2), claude('done', 2)]).status).toBe('ready');
    // A stopped change keeps the version edits use.
    expect(graphicStatusOf(1, [you, claude('done', 1), you, claude('stopped', 2)]).status).toBe(
      'ready',
    );
  });

  it('reads only Claude rows', () => {
    expect(graphicStatusOf(1, [claude('failed', 2), you]).status).toBe('failed');
  });
});

describe('cleanGraphicName', () => {
  it('trims, and turns / and : into a dash', () => {
    expect(cleanGraphicName('  Name / role: v2  ')).toBe('Name – role– v2');
  });

  it('keeps at most 60 characters, counting a Hebrew letter or an emoji once', () => {
    expect(cleanGraphicName('x'.repeat(70))).toBe('x'.repeat(60));
    expect(Array.from(cleanGraphicName('ש'.repeat(70)))).toHaveLength(60);
    expect(Array.from(cleanGraphicName('🎬'.repeat(61)))).toHaveLength(60);
  });

  it('drops control characters and leading dots, and is NFC', () => {
    expect(cleanGraphicName('a\u0000b\nc')).toBe('a b c');
    expect(cleanGraphicName('..hidden')).toBe('hidden');
    expect(cleanGraphicName('Café')).toBe('Café');
  });

  it('is empty when nothing is left', () => {
    expect(cleanGraphicName('   ')).toBe('');
    expect(cleanGraphicName('...')).toBe('');
  });
});

describe('freeGraphicName', () => {
  it('keeps a free name', () => {
    expect(freeGraphicName('Lower third', ['Title'])).toBe('Lower third');
  });

  it('numbers a taken one from (2), comparing without regard to case', () => {
    expect(freeGraphicName(NEW_GRAPHIC_NAME, ['new graphic'])).toBe('New graphic (2)');
    expect(freeGraphicName('New graphic', ['New graphic', 'NEW GRAPHIC (2)'])).toBe(
      'New graphic (3)',
    );
  });

  it('cuts a long name so the numbered one still fits 60 characters', () => {
    const long = 'x'.repeat(60);
    const free = freeGraphicName(long, [long]);
    expect(free).toBe(`${'x'.repeat(56)} (2)`);
    expect(free).toHaveLength(60);
  });

  it('compares names in NFC', () => {
    expect(graphicNameKey('Café')).toBe(graphicNameKey('CAFÉ'));
    expect(freeGraphicName('Café', ['Café'])).toBe('Café (2)');
  });
});

describe('encodeGraphicVars / decodeGraphicVars', () => {
  it('round-trips Hebrew, English and emoji', () => {
    const values = { name: 'דנה לוי', role: 'Founder & CEO', badge: '🎬 100%' };
    const encoded = encodeGraphicVars(values);
    expect(encoded).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(decodeGraphicVars(encoded)).toEqual(values);
  });

  it('is base64url of the JSON in UTF-8, without padding', () => {
    // btoa('{"a":"b"}') is eyJhIjoiYiJ9; "é" is C3 A9 in UTF-8.
    expect(encodeGraphicVars({ a: 'b' })).toBe('eyJhIjoiYiJ9');
    expect(encodeGraphicVars({ a: 'é' })).toBe('eyJhIjoiw6kifQ');
    expect(encodeGraphicVars({})).toBe('e30');
  });

  it('reads padded text too', () => {
    expect(decodeGraphicVars('e30=')).toEqual({});
  });

  it('is null for text that is not base64url of an object of strings', () => {
    for (const text of ['!!', 'e', encodeGraphicVars({ a: 'b' }).replace('e', '+')]) {
      expect(decodeGraphicVars(text), text).toBeNull();
    }
    // JSON, but not an object of strings.
    expect(decodeGraphicVars('WzFd')).toBeNull(); // [1]
    expect(decodeGraphicVars('eyJhIjoxfQ')).toBeNull(); // {"a":1}
    // Not UTF-8.
    expect(decodeGraphicVars('_w')).toBeNull();
  });
});

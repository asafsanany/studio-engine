import { describe, expect, expectTypeOf, it } from 'vitest';
import { z } from 'zod';
import * as shared from '../index.ts';
import {
  BRIEF_CANVASES,
  BRIEF_CAPTIONS,
  BRIEF_FILE_ROLES,
  BRIEF_GENERATED_KEYS,
  BRIEF_PRODUCTIONS,
  type Brief,
  type BriefDraft,
  briefDraftSchema,
  briefPromptSchema,
  briefSchema,
  firstBriefIssue,
} from './schema.ts';
import { bakery, makeDraft } from './test-fixtures.ts';

/** Passed as a value to `bakeryWith` to delete the key instead of setting it. */
const REMOVE = Symbol('remove');

/**
 * A deep copy of the bakery draft as plain JSON with changes applied, so a test can break one thing
 * in it. Each change is a path such as "files[3].role" and the value to put there (or `REMOVE`).
 */
function bakeryWith(...changes: [path: string, value: unknown][]): Record<string, unknown> {
  const root = JSON.parse(JSON.stringify(bakery.rawDraft)) as Record<string, unknown>;
  for (const [path, value] of changes) {
    const steps = path.match(/[^.[\]]+/g) ?? [];
    const last = steps.pop();
    if (last === undefined) continue;
    let node = root;
    for (const step of steps) node = node[step] as Record<string, unknown>;
    if (value === REMOVE) Reflect.deleteProperty(node, last);
    else node[last] = value;
  }
  return root;
}

/** The first issue text for input that must not parse. */
function issueFor(input: unknown, schema: z.ZodType = briefDraftSchema): string {
  const result = schema.safeParse(input);
  if (result.success) throw new Error('expected the input to be rejected');
  return firstBriefIssue(result.error);
}

describe('briefDraftSchema', () => {
  it('accepts the bakery draft and keeps every value', () => {
    expect(briefDraftSchema.parse(bakery.rawDraft)).toEqual(bakery.rawDraft);
  });

  it('accepts a draft where every optional-looking field is null or empty', () => {
    expect(briefDraftSchema.safeParse(makeDraft()).success).toBe(true);
  });

  it('has exactly the fields of the page, in the page order', () => {
    expect(Object.keys(briefDraftSchema.shape)).toEqual([
      'summary',
      'goal',
      'audience',
      'platform',
      'canvas',
      'length',
      'language',
      'captions',
      'tone',
      'pacing',
      'hook',
      'mustInclude',
      'mustAvoid',
      'onScreenText',
      'look',
      'music',
      'production',
      'voiceover',
      'formats',
      'budgetUsd',
      'references',
      'files',
      'assumptions',
      'assumed',
    ]);
  });

  it('exposes the enums of the page', () => {
    expect(BRIEF_CANVASES).toEqual(['1080x1920', '1920x1080', '1080x1080', '1080x1350']);
    expect(BRIEF_CAPTIONS).toEqual(['on', 'off']);
    expect(BRIEF_FILE_ROLES).toEqual([
      'footage',
      'instructions',
      'music',
      'logo',
      'reference',
      'ignore',
    ]);
  });

  it('accepts every canvas, captions value and file role', () => {
    for (const canvas of BRIEF_CANVASES) {
      expect(briefDraftSchema.safeParse(makeDraft({ canvas })).success).toBe(true);
    }
    for (const captions of BRIEF_CAPTIONS) {
      expect(briefDraftSchema.safeParse(makeDraft({ captions })).success).toBe(true);
    }
    for (const role of BRIEF_FILE_ROLES) {
      expect(
        briefDraftSchema.safeParse(makeDraft({ files: [{ path: 'x', role, note: null }] })).success,
      ).toBe(true);
    }
  });

  it('infers the types the renderer and the engine use', () => {
    expectTypeOf<BriefDraft['canvas']>().toEqualTypeOf<
      '1080x1920' | '1920x1080' | '1080x1080' | '1080x1350' | null
    >();
    expectTypeOf<BriefDraft['captions']>().toEqualTypeOf<'on' | 'off' | null>();
    expectTypeOf<BriefDraft['assumed']>().toEqualTypeOf<string[]>();
    expectTypeOf<Brief['schema']>().toEqualTypeOf<1>();
    expectTypeOf<Brief['fingerprint']>().toEqualTypeOf<string>();
  });

  describe('unknown keys', () => {
    it('are stripped, at the top and inside every object', () => {
      const input = bakeryWith(
        ['extra', 'x'],
        ['hook.extra', 'x'],
        ['length.extra', 'x'],
        ['onScreenText.extra', 'x'],
        ['onScreenText.lowerThirds[0].extra', 'x'],
        ['look.extra', 'x'],
        ['music.extra', 'x'],
        ['mustInclude[0].extra', 'x'],
        ['mustAvoid[0].extra', 'x'],
        ['files[0].extra', 'x'],
      );
      expect(briefDraftSchema.parse(input)).toEqual(bakery.rawDraft);
    });

    it('does not let schema or fingerprint through the draft', () => {
      const parsed = briefDraftSchema.parse({ ...bakeryWith(), schema: 1, fingerprint: 'sha1:x' });
      expect(Object.keys(parsed)).not.toContain('schema');
      expect(Object.keys(parsed)).not.toContain('fingerprint');
    });
  });

  describe('every key is required', () => {
    // The four keys of Generated videos have defaults: see the describe below.
    it.each(
      Object.keys(bakery.rawDraft).filter(
        (key) => !(BRIEF_GENERATED_KEYS as readonly string[]).includes(key),
      ),
    )('rejects a draft without %s', (key) => {
      expect(issueFor(bakeryWith([key, REMOVE]))).toBe(`${key}: missing`);
    });

    it.each([
      'hook.what',
      'hook.file',
      'hook.at',
      'length.targetSec',
      'length.maxSec',
      'mustInclude[0].what',
      'mustInclude[0].file',
      'mustInclude[0].at',
      'mustInclude[0].quote',
      'mustAvoid[1].what',
      'mustAvoid[1].file',
      'onScreenText.title',
      'onScreenText.lowerThirds',
      'onScreenText.cta',
      'onScreenText.endCard',
      'onScreenText.lowerThirds[0].name',
      'onScreenText.lowerThirds[0].role',
      'look.logo',
      'look.colors',
      'look.fonts',
      'music.file',
      'music.note',
      'files[0].path',
      'files[0].role',
      'files[0].note',
    ])('rejects a draft without %s, naming it', (path) => {
      expect(issueFor(bakeryWith([path, REMOVE]))).toBe(`${path}: missing`);
    });

    it('rejects a list entry without its keys (references)', () => {
      const input = bakeryWith(['references', [{ file: 'ref.mp4' }]]);
      expect(issueFor(input)).toBe('references[0].takeaway: missing');
    });

    it('rejects a null where a list is required', () => {
      expect(issueFor(bakeryWith(['platform', null]))).toBe(
        'platform: expected array, received null',
      );
    });

    it('rejects a null where an object is required', () => {
      expect(issueFor(bakeryWith(['look', null]))).toBe('look: expected object, received null');
    });
  });

  describe('invalid drafts', () => {
    it('rejects a canvas that is not one of the four', () => {
      expect(issueFor(bakeryWith(['canvas', '1280x720']))).toBe(
        'canvas: Invalid option: expected one of "1080x1920"|"1920x1080"|"1080x1080"|"1080x1350"',
      );
    });

    it('rejects a missing summary', () => {
      expect(issueFor(bakeryWith(['summary', REMOVE]))).toBe('summary: missing');
    });

    it('rejects an empty summary', () => {
      expect(issueFor(bakeryWith(['summary', '']))).toBe(
        'summary: Too small: expected string to have >=1 characters',
      );
    });

    it('rejects a file role that does not exist', () => {
      expect(issueFor(bakeryWith(['files[3].role', 'b-roll']))).toBe(
        'files[3].role: Invalid option: expected one of "footage"|"instructions"|"music"|"logo"|"reference"|"ignore"',
      );
    });

    it.each(['#fff', 'red', '7A3E1D', '#GGGGGG', '#7A3E1D0', '#7a3e1d ', ''])(
      'rejects the colour %j',
      (color) => {
        expect(issueFor(bakeryWith(['look.colors', ['#7A3E1D', color]]))).toBe(
          `look.colors[1]: expected a colour like #7A3E1D, got ${JSON.stringify(color)}`,
        );
      },
    );

    it.each(['#7A3E1D', '#7a3e1d', '#000000', '#FfFfFf'])('accepts the colour %s', (color) => {
      expect(briefDraftSchema.safeParse(bakeryWith(['look.colors', [color]])).success).toBe(true);
    });

    it.each(['HE', 'heb', 'h', 'he-IL', '', 'עב'])('rejects the language %j', (language) => {
      expect(issueFor(bakeryWith(['language', language]))).toBe(
        `language: expected a two-letter lower-case language code like "he", got ${JSON.stringify(language)}`,
      );
    });

    it('accepts any two-letter code, even one the renderer has no name for', () => {
      expect(briefDraftSchema.safeParse(makeDraft({ language: 'sv' })).success).toBe(true);
    });

    it('rejects captions other than on or off', () => {
      expect(issueFor(bakeryWith(['captions', 'maybe']))).toBe(
        'captions: Invalid option: expected one of "on"|"off"',
      );
    });

    it.each([0, -5])('rejects a length of %d seconds', (seconds) => {
      expect(issueFor(bakeryWith(['length.maxSec', seconds]))).toBe(
        'length.maxSec: Too small: expected number to be >0',
      );
    });

    it('rejects a length that is not a number', () => {
      expect(issueFor(bakeryWith(['length.targetSec', '30']))).toBe(
        'length.targetSec: expected number, received string',
      );
    });

    it('rejects something that is not an object at all', () => {
      expect(issueFor('nope')).toBe('expected object, received string');
      expect(issueFor(null)).toBe('expected object, received null');
      expect(issueFor([])).toBe('expected object, received array');
    });

    it('reports the first problem when there are several', () => {
      const input = bakeryWith(['canvas', 'huge'], ['summary', REMOVE]);
      expect(issueFor(input)).toBe('summary: missing');
    });
  });
});

describe('briefDraftSchema: the song in music (Songs)', () => {
  /** The bakery draft with its music replaced by `music`. */
  const withMusic = (music: unknown) => bakeryWith(['music', music]);
  const song = {
    title: 'נתתי לך בית',
    artist: 'Ofek Adanek',
    version: 'sped up',
    link: null,
    fromFile: 'IMG_4412.PNG',
  };

  it('reads a brief.json from before Songs, with music { file, note } alone, as no song', () => {
    const before = withMusic({ file: 'music-weekend.mp3', note: 'the client’s pick' });
    expect(before.music).not.toHaveProperty('song');
    const parsed = briefDraftSchema.parse(before);
    expect(parsed.music).toEqual({
      file: 'music-weekend.mp3',
      note: 'the client’s pick',
      wanted: false,
      song: null,
      original: null,
      wantsTrending: false,
    });
    // Every other key is exactly as it was.
    expect({ ...parsed, music: null }).toEqual({ ...bakery.draft, music: null });
    expect(briefSchema.safeParse({ schema: 1, fingerprint: 'sha1:9f2c', ...before }).success).toBe(
      true,
    );
  });

  it('keeps a null music, and reads a music with no file', () => {
    expect(briefDraftSchema.parse(withMusic(null)).music).toBeNull();
    const parsed = briefDraftSchema.parse(withMusic({ file: null, note: null, song }));
    expect(parsed.music).toEqual({
      file: null,
      note: null,
      wanted: false,
      song,
      original: null,
      wantsTrending: false,
    });
  });

  it('reads a song, an original audio label and a wish for a trending song', () => {
    const music = {
      file: null,
      note: null,
      wanted: false,
      song,
      original: null,
      wantsTrending: false,
    };
    expect(briefDraftSchema.parse(withMusic(music)).music).toEqual(music);
    const original = {
      file: null,
      note: null,
      wanted: false,
      song: null,
      original: { by: '@reels.creator' },
      wantsTrending: false,
    };
    expect(briefDraftSchema.parse(withMusic(original)).music).toEqual(original);
    const trending = {
      file: null,
      note: null,
      wanted: false,
      song: null,
      original: null,
      wantsTrending: true,
    };
    expect(briefDraftSchema.parse(withMusic(trending)).music).toEqual(trending);
  });

  it('reads a song that is only a link', () => {
    const linkOnly = {
      title: null,
      artist: null,
      version: null,
      link: 'https://www.instagram.com/reel/DQx7mK2kF9a/',
      fromFile: null,
    };
    const music = {
      file: null,
      note: null,
      wanted: false,
      song: linkOnly,
      original: null,
      wantsTrending: false,
    };
    expect(briefDraftSchema.parse(withMusic(music)).music).toEqual(music);
  });

  it.each(['title', 'artist', 'version', 'link', 'fromFile'])(
    'needs song.%s, null if there is none',
    (key) => {
      const rest: Record<string, unknown> = { ...song };
      Reflect.deleteProperty(rest, key);
      expect(issueFor(withMusic({ file: null, note: null, song: rest }))).toMatch(
        new RegExp(`^music\\.song\\.${key}: `),
      );
    },
  );

  it('needs original.by', () => {
    expect(issueFor(withMusic({ file: null, note: null, original: {} }))).toBe(
      'music.original.by: missing',
    );
  });

  it('accepts the four kinds of a song and nothing else', () => {
    for (const version of ['original', 'sped up', 'slowed', 'remix', null]) {
      const music = { file: null, note: null, song: { ...song, version } };
      expect(briefDraftSchema.safeParse(withMusic(music)).success, String(version)).toBe(true);
    }
    expect(
      issueFor(withMusic({ file: null, note: null, song: { ...song, version: 'live' } })),
    ).toBe(
      'music.song.version: Invalid option: expected one of "original"|"sped up"|"slowed"|"remix"',
    );
  });

  it('refuses a wantsTrending that is not true or false', () => {
    expect(issueFor(withMusic({ file: null, note: null, wantsTrending: 'yes' }))).toBe(
      'music.wantsTrending: expected boolean, received string',
    );
  });

  it('still needs file and note, the keys it always had', () => {
    expect(issueFor(withMusic({ note: null }))).toBe('music.file: missing');
    expect(issueFor(withMusic({ file: null }))).toBe('music.note: missing');
  });

  it('asks the Brief run for the song keys, in plain words', () => {
    const schema = JSON.parse(briefPromptSchema({ songs: true })) as {
      properties: {
        music: {
          anyOf: { properties?: Record<string, { description?: string }>; required?: string[] }[];
        };
      };
    };
    const music = schema.properties.music.anyOf.find((option) => option.properties);
    expect(music?.required).toEqual([
      'file',
      'note',
      'wanted',
      'song',
      'original',
      'wantsTrending',
    ]);
    for (const key of ['song', 'original', 'wantsTrending']) {
      expect(music?.properties?.[key]?.description, key).toMatch(/^[A-Z]/);
    }
    expect(music?.properties?.song?.description).toContain('Never guess');
  });

  it('is the same list of fields as before: the song sits inside music', () => {
    expect(Object.keys(briefDraftSchema.shape)).toContain('music');
    expect(Object.keys(briefDraftSchema.shape)).not.toContain('song');
  });
});

describe('the keys of Generated videos', () => {
  const PINEWOOD_LINES = {
    lines: [
      { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
      { id: 'L2', text: 'BUT it gets worse.', direction: 'a clear stop after BUT, weighty' },
    ],
  };
  const generated = (changes: Record<string, unknown>) => ({ ...bakery.rawDraft, ...changes });

  it('are production, voiceover, formats and budgetUsd', () => {
    expect([...BRIEF_GENERATED_KEYS]).toEqual(['production', 'voiceover', 'formats', 'budgetUsd']);
    expect([...BRIEF_PRODUCTIONS]).toEqual(['footage', 'generate']);
  });

  it('default to null, so a brief.json from before them still parses', () => {
    const old = bakeryWith(...BRIEF_GENERATED_KEYS.map((key): [string, unknown] => [key, REMOVE]));
    expect(Object.keys(old)).not.toContain('production');
    expect(briefDraftSchema.parse(old)).toEqual({
      ...bakery.rawDraft,
      production: null,
      voiceover: null,
      formats: null,
      budgetUsd: null,
    });
    expect(bakery.draft.production).toBeNull();
    expect(bakery.draft.voiceover).toBeNull();
    expect(bakery.draft.formats).toBeNull();
    expect(bakery.draft.budgetUsd).toBeNull();
  });

  it('accepts the brief of a generated video with two formats and a budget', () => {
    const input = generated({
      production: 'generate',
      voiceover: PINEWOOD_LINES,
      formats: ['1080x1920', '1080x1080'],
      budgetUsd: 5,
    });
    expect(briefDraftSchema.parse(input)).toEqual(input);
  });

  it('accepts footage as a production too', () => {
    expect(briefDraftSchema.parse(generated({ production: 'footage' })).production).toBe('footage');
  });

  it('refuses a production that is neither footage nor generate', () => {
    expect(issueFor(generated({ production: 'ai' }))).toBe(
      'production: Invalid option: expected one of "footage"|"generate"',
    );
  });

  it('refuses a voiceover with no lines, a line without text, or an id that is not L1, L2 …', () => {
    expect(briefDraftSchema.safeParse(generated({ voiceover: { lines: [] } })).success).toBe(false);
    expect(
      briefDraftSchema.safeParse(
        generated({ voiceover: { lines: [{ id: 'L1', text: '', direction: null }] } }),
      ).success,
    ).toBe(false);
    expect(
      issueFor(generated({ voiceover: { lines: [{ id: 'line1', text: 'x', direction: null }] } })),
    ).toBe('voiceover.lines[0].id: must be L1, L2 …');
    expect(issueFor(generated({ voiceover: { lines: [{ id: 'L1', text: 'x' }] } }))).toBe(
      'voiceover.lines[0].direction: missing',
    );
  });

  it('refuses formats that are not canvases, and takes one or more', () => {
    expect(issueFor(generated({ formats: ['square'] }))).toMatch(/^formats\[0\]: /);
    expect(briefDraftSchema.safeParse(generated({ formats: [] })).success).toBe(false);
    expect(briefDraftSchema.safeParse(generated({ formats: ['1080x1080'] })).success).toBe(true);
  });

  it('refuses a budget of nothing or less, and a budget that is not a number', () => {
    expect(briefDraftSchema.safeParse(generated({ budgetUsd: 0 })).success).toBe(false);
    expect(briefDraftSchema.safeParse(generated({ budgetUsd: -2 })).success).toBe(false);
    expect(briefDraftSchema.safeParse(generated({ budgetUsd: '$5' })).success).toBe(false);
    expect(briefDraftSchema.parse(generated({ budgetUsd: 4.5 })).budgetUsd).toBe(4.5);
  });

  it('infers the types the renderer and the engine use', () => {
    expectTypeOf<BriefDraft['production']>().toEqualTypeOf<'footage' | 'generate' | null>();
    expectTypeOf<BriefDraft['budgetUsd']>().toEqualTypeOf<number | null>();
    expectTypeOf<
      NonNullable<BriefDraft['voiceover']>['lines'][number]['direction']
    >().toEqualTypeOf<string | null>();
  });

  describe('in the Brief prompt', () => {
    type Node = {
      properties?: Record<string, Node>;
      required?: string[];
      description?: string;
      default?: unknown;
    };
    const on = JSON.parse(briefPromptSchema({ generate: true })) as Node;

    it('are asked for only with generate on, after music and before references', () => {
      const keys = Object.keys(briefDraftSchema.shape);
      expect(on.required).toEqual(keys);
      expect(keys.slice(keys.indexOf('music'), keys.indexOf('references') + 1)).toEqual([
        'music',
        'production',
        'voiceover',
        'formats',
        'budgetUsd',
        'references',
      ]);
      expect(briefPromptSchema({ generate: false })).toBe(briefPromptSchema());
    });

    it('are described in plain words', () => {
      for (const key of BRIEF_GENERATED_KEYS) {
        expect(on.properties?.[key]?.description, key).toMatch(/^[A-Z"]/);
        expect(on.properties?.[key]?.default, key).toBeNull();
      }
      expect(on.properties?.voiceover?.description).toContain('word for word');
      expect(on.properties?.formats?.description).toContain('explicitly ask for more than one');
      expect(on.properties?.budgetUsd?.description).toContain('budget $5');
    });

    it('go together with the Songs keys when both are on', () => {
      const both = JSON.parse(briefPromptSchema({ songs: true, generate: true })) as Node;
      expect(both).toEqual(JSON.parse(JSON.stringify(z.toJSONSchema(briefDraftSchema))));
    });

    it('keep the Songs-off music with generate on', () => {
      expect(briefPromptSchema({ generate: true })).toContain(
        '"required": [\n            "file",\n            "note"\n          ]',
      );
    });
  });
});

describe('briefSchema', () => {
  const full = { schema: 1, fingerprint: 'sha1:9f2c', ...bakeryWith() };

  it('accepts the draft plus schema 1 and a fingerprint', () => {
    expect(briefSchema.parse(full)).toEqual(full);
  });

  it('lists schema and fingerprint first, then every draft field', () => {
    expect(Object.keys(briefSchema.shape)).toEqual([
      'schema',
      'fingerprint',
      ...Object.keys(briefDraftSchema.shape),
    ]);
  });

  it('rejects another schema version', () => {
    expect(issueFor({ ...full, schema: 2 }, briefSchema)).toBe('schema: expected 1');
  });

  it('rejects a missing schema or fingerprint', () => {
    const { schema: _schema, ...withoutSchema } = full;
    const { fingerprint: _fingerprint, ...withoutFingerprint } = full;
    expect(issueFor(withoutSchema, briefSchema)).toBe('schema: missing');
    expect(issueFor(withoutFingerprint, briefSchema)).toBe('fingerprint: missing');
  });

  it('still checks the draft fields', () => {
    expect(issueFor({ ...full, canvas: 'huge' }, briefSchema)).toMatch(/^canvas: /);
  });

  it('strips unknown keys', () => {
    expect(briefSchema.parse({ ...full, extra: 1 })).toEqual(full);
  });
});

describe('briefPromptSchema', () => {
  type JsonSchemaNode = {
    type?: string | string[];
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    additionalProperties?: boolean;
    items?: JsonSchemaNode;
    anyOf?: JsonSchemaNode[];
    [key: string]: unknown;
  };

  const text = briefPromptSchema();
  const schema = JSON.parse(text) as JsonSchemaNode;

  /** Every node of the schema that describes an object with properties. */
  function objectNodes(node: JsonSchemaNode, path = '$'): [string, JsonSchemaNode][] {
    const found: [string, JsonSchemaNode][] = [];
    if (node.properties) {
      found.push([path, node]);
      for (const [key, child] of Object.entries(node.properties)) {
        found.push(...objectNodes(child, `${path}.${key}`));
      }
    }
    if (node.items) found.push(...objectNodes(node.items, `${path}[]`));
    for (const option of node.anyOf ?? []) found.push(...objectNodes(option, path));
    return found;
  }

  it('is pretty JSON of z.toJSONSchema of the draft, as it was before Songs', () => {
    expect(text).toContain('\n  "properties": {\n');
    // Songs off: the music is a file and a note, and nothing in the prompt mentions a song.
    expect(text).not.toMatch(/song|original|wantsTrending/i);
    expect(schema.properties?.music?.anyOf?.[0]?.required).toEqual(['file', 'note']);
    expect(schema.properties?.music?.anyOf?.[0]?.properties?.file?.type).toBe('string');
    expect(briefPromptSchema({})).toBe(text);
    expect(briefPromptSchema({ songs: false })).toBe(text);
  });

  // Without the Generate switch the four keys of Generated videos are not asked for.
  const withoutGenerated = Object.keys(briefDraftSchema.shape).filter(
    (key) => !(BRIEF_GENERATED_KEYS as readonly string[]).includes(key),
  );

  it('lists every field of the draft as required, and nothing else', () => {
    expect(schema.required).toEqual(withoutGenerated);
    expect(Object.keys(schema.properties ?? {})).toEqual(withoutGenerated);
    expect(text).not.toMatch(/production|voiceover|budgetUsd|formats/);
  });

  it('lists every field of every nested object as required, and allows no other keys', () => {
    const nodes = objectNodes(schema);
    // The draft itself plus hook, length, mustInclude[], mustAvoid[], onScreenText,
    // onScreenText.lowerThirds[], look, music, references[] and files[].
    expect(nodes.map(([path]) => path).sort()).toEqual(
      [
        '$',
        '$.hook',
        '$.length',
        '$.mustInclude[]',
        '$.mustAvoid[]',
        '$.onScreenText',
        '$.onScreenText.lowerThirds[]',
        '$.look',
        '$.music',
        '$.references[]',
        '$.files[]',
      ].sort(),
    );
    for (const [path, node] of nodes) {
      expect(node.required, path).toEqual(Object.keys(node.properties ?? {}));
      expect(node.additionalProperties, path).toBe(false);
    }
  });

  it('does not ask the run for the engine-owned fields', () => {
    expect(text).not.toContain('"fingerprint"');
    expect(schema.properties).not.toHaveProperty('schema');
  });

  it('spells out the enums and the colour pattern the validator checks', () => {
    const properties = schema.properties ?? {};
    expect(JSON.stringify(properties.canvas)).toContain('"1080x1350"');
    expect(JSON.stringify(properties.captions)).toContain('"off"');
    expect(JSON.stringify(properties.files)).toContain('"instructions"');
    expect(text).toContain('^#[0-9A-Fa-f]{6}$');
    expect(text).toContain('^[a-z]{2}$');
  });

  it('is the same every time', () => {
    expect(briefPromptSchema()).toBe(text);
  });
});

describe('briefPromptSchema with Songs on', () => {
  type JsonSchemaNode = {
    properties?: Record<string, JsonSchemaNode>;
    required?: string[];
    anyOf?: JsonSchemaNode[];
    description?: string;
    default?: unknown;
    type?: string | string[];
  };
  const text = briefPromptSchema({ songs: true });
  const schema = JSON.parse(text) as JsonSchemaNode;
  const music = schema.properties?.music?.anyOf?.find((option) => option.properties);

  const withoutGenerated = Object.keys(briefDraftSchema.shape).filter(
    (key) => !(BRIEF_GENERATED_KEYS as readonly string[]).includes(key),
  );

  it('is pretty JSON of z.toJSONSchema(briefDraftSchema) without the Generated videos keys', () => {
    const omitted = { production: true, voiceover: true, formats: true, budgetUsd: true } as const;
    expect(Object.keys(omitted)).toEqual([...BRIEF_GENERATED_KEYS]);
    expect(text).toBe(JSON.stringify(z.toJSONSchema(briefDraftSchema.omit(omitted)), null, 2));
  });

  it('keeps the draft’s fields, in their order, all required', () => {
    expect(schema.required).toEqual(withoutGenerated);
    expect(Object.keys(schema.properties ?? {})).toEqual(withoutGenerated);
  });

  it('asks for the file (or null), the note, wanted and the three keys Songs added', () => {
    expect(music?.required).toEqual([
      'file',
      'note',
      'wanted',
      'song',
      'original',
      'wantsTrending',
    ]);
    expect(music?.properties?.file?.type).toEqual(['string', 'null']);
  });

  it('describes the song in plain words and lists all five of its keys as required', () => {
    const song = music?.properties?.song?.anyOf?.find((option) => option.properties);
    expect(song?.required).toEqual(['title', 'artist', 'version', 'link', 'fromFile']);
    expect(music?.properties?.song?.description).toContain('Never guess');
    expect(music?.properties?.original?.description).toContain('Original audio');
    expect(music?.properties?.wantsTrending?.description).toContain('trending');
    expect(JSON.stringify(song?.properties?.version)).toContain('"sped up"');
    const original = music?.properties?.original?.anyOf?.find((option) => option.properties);
    expect(original?.required).toEqual(['by']);
  });

  it('writes the defaults the engine fills in for an old brief', () => {
    expect(music?.properties?.song?.default).toBeNull();
    expect(music?.properties?.original?.default).toBeNull();
    expect(music?.properties?.wantsTrending?.default).toBe(false);
  });

  it('is the same every time, and not the schema Songs off gives', () => {
    expect(briefPromptSchema({ songs: true })).toBe(text);
    expect(text).not.toBe(briefPromptSchema());
  });
});

describe('firstBriefIssue', () => {
  it('writes a path as dots and indexes', () => {
    const input = bakeryWith(['onScreenText.lowerThirds[0].name', 5]);
    expect(issueFor(input)).toBe(
      'onScreenText.lowerThirds[0].name: expected string, received number',
    );
  });

  it('says what to do about a missing key, not that zod saw undefined', () => {
    expect(issueFor(bakeryWith(['goal', REMOVE]))).toBe('goal: missing');
  });

  it('has a fallback for an error without issues', () => {
    expect(firstBriefIssue(new z.ZodError([]))).toBe('unknown problem');
  });
});

describe('package root', () => {
  it('exports the brief contract', () => {
    expect(Object.keys(shared)).toEqual(
      expect.arrayContaining([
        'BRIEF_CANVASES',
        'BRIEF_CAPTIONS',
        'BRIEF_FILE_ROLES',
        'NO_INSTRUCTIONS_SUMMARY',
        'briefDraftSchema',
        'briefPromptSchema',
        'briefSchema',
        'firstBriefIssue',
        'noInstructionsBrief',
        'renderBriefMd',
      ]),
    );
  });
});

describe('music.wanted (music only when asked, U21)', () => {
  const withMusic = (music: unknown) => bakeryWith(['music', music]);

  it('reads a brief.json from before it as not asked', () => {
    const before = withMusic({ file: null, note: 'intense', song: null, original: null });
    expect(before.music).not.toHaveProperty('wanted');
    expect(briefDraftSchema.parse(before).music).toMatchObject({ wanted: false, note: 'intense' });
    // The first brief.json Songs wrote (no song keys either) still parses.
    const oldest = withMusic({ file: 'music-weekend.mp3', note: null });
    expect(briefDraftSchema.parse(oldest).music).toMatchObject({
      file: 'music-weekend.mp3',
      wanted: false,
    });
    expect(briefSchema.safeParse({ schema: 1, fingerprint: 'sha1:9f2c', ...oldest }).success).toBe(
      true,
    );
  });

  it('reads a wanted that is true, keeps a null music, and refuses anything else', () => {
    const asked = briefDraftSchema.parse(
      withMusic({ file: null, note: 'with drops', wanted: true }),
    );
    expect(asked.music).toMatchObject({ file: null, note: 'with drops', wanted: true });
    expect(briefDraftSchema.parse(withMusic(null)).music).toBeNull();
    expect(issueFor(withMusic({ file: null, note: null, wanted: 'yes' }))).toBe(
      'music.wanted: expected boolean, received string',
    );
  });

  describe('the prompt schema', () => {
    type Node = {
      properties?: Record<string, Node>;
      required?: string[];
      anyOf?: Node[];
      description?: string;
      default?: unknown;
      type?: string | string[];
    };
    const musicOf = (options: Parameters<typeof briefPromptSchema>[0]): Node | undefined =>
      (JSON.parse(briefPromptSchema(options)) as Node).properties?.music?.anyOf?.find(
        (option) => option.properties,
      );

    it('is exactly what it was without the music switch: a file and a note, no wanted', () => {
      expect(musicOf({})?.required).toEqual(['file', 'note']);
      expect(briefPromptSchema({ music: false })).toBe(briefPromptSchema());
      expect(briefPromptSchema({ music: false, songs: false })).toBe(briefPromptSchema());
      expect(briefPromptSchema()).not.toContain('wanted');
    });

    it('asks for wanted while the music is on, with a file that may be null, and no song keys', () => {
      const music = musicOf({ music: true });
      expect(music?.required).toEqual(['file', 'note', 'wanted']);
      expect(music?.properties?.file?.type).toEqual(['string', 'null']);
      expect(music?.properties?.wanted?.type).toBe('boolean');
      expect(music?.properties?.wanted?.description).toMatch(/^True only when the instructions/);
      expect(music?.properties?.wanted?.default).toBe(false);
      expect(Object.keys(music?.properties ?? {})).toEqual(['file', 'note', 'wanted']);
    });

    it('the Songs schema has it too, whichever way it is asked for', () => {
      expect(musicOf({ songs: true })?.required).toContain('wanted');
      expect(briefPromptSchema({ music: true, songs: true })).toBe(
        briefPromptSchema({ songs: true }),
      );
    });
  });
});

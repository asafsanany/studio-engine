import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  CLIENT_NAME_MAX_LENGTH,
  CLIENT_STYLE_STATES,
  type ClientRow,
  type ClientStyle,
  type ClientStyleResponse,
  type ClientStyleState,
  clientListResponseSchema,
  clientNameProblem,
  clientRowSchema,
  clientStyleResponseSchema,
  clientStyleSchema,
  clientStyleStateSchema,
  createClientRequestSchema,
  createClientResponseSchema,
  noClientStyle,
  normalizeClientName,
  revealClientResponseSchema,
  type StylePassSummary,
  stylePassSummarySchema,
} from './client.ts';
import { makeClientStyle } from './test-fixtures.ts';

describe('ClientStyleState', () => {
  it('lists the four states in lifecycle order', () => {
    expect(CLIENT_STYLE_STATES).toEqual(['none', 'analysing', 'ready', 'failed']);
  });

  it.each(CLIENT_STYLE_STATES)('accepts %s', (state) => {
    expect(clientStyleStateSchema.parse(state)).toBe(state);
  });

  it.each(['', 'Ready', 'learning', null, 1])('rejects %j', (value) => {
    expect(clientStyleStateSchema.safeParse(value).success).toBe(false);
  });
});

describe('ClientStyle', () => {
  it.each(CLIENT_STYLE_STATES)('parses a %s style unchanged', (state) => {
    const style = makeClientStyle({ state });
    expect(clientStyleSchema.parse(style)).toEqual(style);
  });

  it('parses a failed style with its error, and a style made from files (no source job)', () => {
    const style = makeClientStyle({
      state: 'failed',
      error: 'Style stopped: the file is missing',
      sourceJobId: null,
    });
    expect(clientStyleSchema.parse(style)).toEqual(style);
  });

  it('survives a JSON round trip', () => {
    const style = makeClientStyle();
    expect(clientStyleSchema.parse(JSON.parse(JSON.stringify(style)))).toEqual(style);
  });

  it('keeps a Hebrew client name exactly', () => {
    const style = makeClientStyle({ clientId: '4d337086919d', client: 'מאפיית הצפון' });
    expect(clientStyleSchema.parse(style).client).toBe('מאפיית הצפון');
  });

  it('requires every field, including the nullable ones', () => {
    const style = makeClientStyle();
    for (const key of Object.keys(style)) {
      const { [key as keyof ClientStyle]: _omitted, ...rest } = style;
      expect(clientStyleSchema.safeParse(rest).success, `missing ${key}`).toBe(false);
    }
  });

  it.each([
    ['empty clientId', { clientId: '' }],
    ['empty client', { client: '' }],
    ['unknown state', { state: 'learning' }],
    ['negative version', { version: -1 }],
    ['fractional version', { version: 1.5 }],
    ['non-ISO updatedAt', { updatedAt: '2026-10-20' }],
    ['numeric updatedAt', { updatedAt: 1_792_503_660_000 }],
    ['empty error (use null)', { error: '' }],
    ['empty sourceJobId (use null)', { sourceJobId: '' }],
    ['undefined instead of null', { error: undefined }],
  ])('rejects %s', (_label, override) => {
    expect(clientStyleSchema.safeParse({ ...makeClientStyle(), ...override }).success).toBe(false);
  });

  it('infers nullable fields as T | null (never optional)', () => {
    expectTypeOf<ClientStyle['state']>().toEqualTypeOf<ClientStyleState>();
    expectTypeOf<ClientStyle['version']>().toEqualTypeOf<number>();
    expectTypeOf<ClientStyle['updatedAt']>().toEqualTypeOf<string | null>();
    expectTypeOf<ClientStyle['error']>().toEqualTypeOf<string | null>();
    expectTypeOf<ClientStyle['sourceJobId']>().toEqualTypeOf<string | null>();
  });
});

describe('noClientStyle', () => {
  it('is a valid style in state none with nothing else set', () => {
    const style = noClientStyle('1c9823704bf5', 'Northwind Bakery');
    expect(clientStyleSchema.parse(style)).toEqual(style);
    expect(style).toEqual({
      clientId: '1c9823704bf5',
      client: 'Northwind Bakery',
      state: 'none',
      version: 0,
      updatedAt: null,
      error: null,
      sourceJobId: null,
      pass: null,
    });
  });
});

describe('the pass of an analysing style', () => {
  const reading: StylePassSummary = {
    kind: 'read',
    mode: 'add',
    fileCount: 3,
    jobId: null,
    job: null,
  };
  const learning: StylePassSummary = {
    kind: 'learn',
    mode: 'create',
    fileCount: 0,
    jobId: 'a1b2c3d4e5f6',
    job: 'סרטון גיוס',
  };

  it.each([
    ['a Read pass', reading],
    ['a Learn pass', learning],
    ['a Learn pass that merges', { ...learning, mode: 'merge' } satisfies StylePassSummary],
  ])('parses %s on an analysing style', (_label, pass) => {
    const style = makeClientStyle({ state: 'analysing', pass });
    expect(clientStyleSchema.parse(style)).toEqual(style);
  });

  it('is null while nothing runs, and may be left out by a sender that predates it', () => {
    expect(clientStyleSchema.parse(makeClientStyle({ pass: null })).pass).toBeNull();
    expect(clientStyleSchema.parse(makeClientStyle()).pass).toBeUndefined();
  });

  it.each([
    ['unknown kind', { kind: 'review' }],
    ['unknown mode', { mode: 'paint' }],
    ['negative file count', { fileCount: -1 }],
    ['empty job name (use null)', { job: '' }],
  ])('rejects %s', (_label, override) => {
    expect(stylePassSummarySchema.safeParse({ ...learning, ...override }).success).toBe(false);
  });
});

describe('GET /api/clients/:clientId/style', () => {
  it('parses the style with its markdown, or with null when style.md is not there', () => {
    const withMarkdown = { ...makeClientStyle(), markdown: '# Style: Northwind Bakery\n' };
    expect(clientStyleResponseSchema.parse(withMarkdown)).toEqual(withMarkdown);

    const without = { ...noClientStyle('1c9823704bf5', 'Northwind Bakery'), markdown: null };
    expect(clientStyleResponseSchema.parse(without)).toEqual(without);
  });

  it('keeps the markdown byte for byte, empty text included', () => {
    const markdown = '# Style: מאפיית הצפון\r\n\r\n- Don’t: …  \n';
    expect(clientStyleResponseSchema.parse({ ...makeClientStyle(), markdown }).markdown).toBe(
      markdown,
    );
    expect(clientStyleResponseSchema.parse({ ...makeClientStyle(), markdown: '' }).markdown).toBe(
      '',
    );
  });

  it('requires the markdown key', () => {
    expect(clientStyleResponseSchema.safeParse(makeClientStyle()).success).toBe(false);
  });

  it('infers the style plus markdown', () => {
    expectTypeOf<ClientStyleResponse['markdown']>().toEqualTypeOf<string | null>();
    expectTypeOf<ClientStyleResponse>().toExtend<ClientStyle>();
  });
});

describe('POST /api/clients/:clientId/reveal', () => {
  it('parses { ok: true } only', () => {
    expect(revealClientResponseSchema.parse({ ok: true })).toEqual({ ok: true });
    expect(revealClientResponseSchema.safeParse({ ok: false }).success).toBe(false);
    expect(revealClientResponseSchema.safeParse({ error: 'nope' }).success).toBe(false);
  });
});

describe('ClientRow', () => {
  const row: ClientRow = {
    clientId: '1c9823704bf5',
    client: 'Northwind Bakery',
    jobs: 3,
    lastJobAt: '2026-10-18T09:30:00.000Z',
    style: { state: 'ready', updatedAt: '2026-10-17T08:00:00.000Z' },
  };

  it('parses a client with jobs and a style, and survives a JSON round trip', () => {
    expect(clientRowSchema.parse(row)).toEqual(row);
    expect(clientRowSchema.parse(JSON.parse(JSON.stringify(row)))).toEqual(row);
  });

  it('parses a client without jobs or a style: lastJobAt and updatedAt are null', () => {
    const empty: ClientRow = {
      clientId: '1c9823704bf5',
      client: 'מאפיית הצפון',
      jobs: 0,
      lastJobAt: null,
      style: { state: 'none', updatedAt: null },
    };
    expect(clientRowSchema.parse(empty)).toEqual(empty);
  });

  it('may carry the client’s Instagram: a summary, null for no account, or nothing at all (IG6)', () => {
    const summary = {
      handle: 'falcon.fpv',
      followers: 12_480,
      weekChange: 312,
      oursVsTheirs: 3.6,
      photoAt: '2026-10-26T06:01:00.000Z',
    };
    expect(clientRowSchema.parse({ ...row, instagram: summary })).toEqual({
      ...row,
      instagram: summary,
    });
    expect(clientRowSchema.parse({ ...row, instagram: null }).instagram).toBeNull();
    expect('instagram' in clientRowSchema.parse(row)).toBe(false);
    expect(clientRowSchema.safeParse({ ...row, instagram: { handle: 'x' } }).success).toBe(false);
    expect(clientListResponseSchema.parse([{ ...row, instagram: summary }, row])).toHaveLength(2);
  });

  it('requires every field', () => {
    for (const key of Object.keys(row)) {
      const { [key as keyof ClientRow]: _omitted, ...rest } = row;
      expect(clientRowSchema.safeParse(rest).success, `missing ${key}`).toBe(false);
    }
  });

  it.each([
    ['a negative job count', { jobs: -1 }],
    ['a fractional job count', { jobs: 1.5 }],
    ['an empty name', { client: '' }],
    ['a date that is not ISO', { lastJobAt: 'yesterday' }],
    ['an unknown style state', { style: { state: 'learning', updatedAt: null } }],
  ])('rejects %s', (_label, change) => {
    expect(clientRowSchema.safeParse({ ...row, ...change }).success).toBe(false);
  });

  it('parses the list and the create answer', () => {
    expect(clientListResponseSchema.parse([row, row])).toEqual([row, row]);
    expect(clientListResponseSchema.parse([])).toEqual([]);
    expect(createClientResponseSchema.parse(row)).toEqual(row);
  });
});

describe('POST /api/clients body', () => {
  it('needs a string name, whatever is in it', () => {
    expect(createClientRequestSchema.parse({ name: 'Acme' })).toEqual({ name: 'Acme' });
    expect(createClientRequestSchema.parse({ name: '' })).toEqual({ name: '' });
    expect(createClientRequestSchema.safeParse({}).success).toBe(false);
    expect(createClientRequestSchema.safeParse({ name: 3 }).success).toBe(false);
  });
});

describe('client names', () => {
  it('trims and writes the name in NFC', () => {
    const nfd = 'Café'.normalize('NFD');
    expect(normalizeClientName(`  ${nfd}\n`)).toBe('Café'.normalize('NFC'));
    expect(normalizeClientName('  Kova Coffee ')).toBe('Kova Coffee');
  });

  it.each([
    'Acme',
    'Kova Coffee',
    'Café Müller',
    'מאפיית הצפון',
    '🍞 Bakery',
    'Acme.',
    'a-b_c',
    '  padded  ',
    'x'.repeat(CLIENT_NAME_MAX_LENGTH),
    '🍞'.repeat(CLIENT_NAME_MAX_LENGTH),
  ])('accepts %j', (name) => {
    expect(clientNameProblem(name)).toBeNull();
  });

  it.each([
    ['', 'Give the client a name.'],
    ['   \n\t', 'Give the client a name.'],
    ['x'.repeat(CLIENT_NAME_MAX_LENGTH + 1), 'at most 80 characters'],
    ['🍞'.repeat(CLIENT_NAME_MAX_LENGTH + 1), 'at most 80 characters'],
    ['Acme/Spring', 'contain / or :'],
    ['Acme: Spring', 'contain / or :'],
    ['a\u0000b', 'control characters'],
    ['a\nb', 'control characters'],
    ['Amit Studio\u200B', 'hidden characters'],
    ['Amit\u200BStudio', 'hidden characters'],
    ['Amit\u200CStudio', 'hidden characters'],
    ['Amit\u200DStudio', 'hidden characters'],
    ['Amit\u200EStudio', 'hidden characters'],
    ['Amit\u200FStudio', 'hidden characters'],
    ['Amit\u2060Studio', 'hidden characters'],
    ['Amit\uFEFFStudio', 'hidden characters'],
    ['Amit\u00ADStudio', 'hidden characters'],
    ['Amit\u202EStudio', 'hidden characters'],
    ['Amit\u0085Studio', 'hidden characters'],
    ['Amit\u2028Studio', 'hidden characters'],
    ['Amit\u2029Studio', 'hidden characters'],
    ['Amit\u00A0Studio', 'hidden characters'],
    ['Amit\u2003Studio', 'hidden characters'],
    ['Amit\u3000Studio', 'hidden characters'],
    ['Amit  Studio', 'two spaces in a row'],
    ['Amit   Studio', 'two spaces in a row'],
    ['.hidden', 'start with . or _'],
    ['_Style', 'start with . or _'],
    ['_Exports', 'start with . or _'],
    ['  .padded', 'start with . or _'],
    ['..', 'start with . or _'],
  ])('refuses %j in plain words', (name, words) => {
    expect(clientNameProblem(name)).toContain(words);
  });

  it.each([
    ['Amit Studio', 'a plain space'],
    ['מאפיית הצפון', 'Hebrew'],
    ['Café Amit', 'accents'],
    ['日本 スタジオ', 'CJK'],
    ['أمل ستوديو', 'Arabic'],
  ])('accepts %j (%s)', (name) => {
    expect(clientNameProblem(name)).toBeNull();
  });

  it('trims spaces at the ends, so they can not make a look-alike either', () => {
    expect(clientNameProblem('  Amit Studio  ')).toBeNull();
    expect(normalizeClientName('  Amit Studio  ')).toBe('Amit Studio');
    expect(clientNameProblem('Amit Studio\u00A0')).toBeNull();
  });

  it('counts characters, not bytes or UTF-16 units, and after trimming', () => {
    expect(clientNameProblem(`${'x'.repeat(CLIENT_NAME_MAX_LENGTH)}   `)).toBeNull();
    // A decomposed e + accent is one character once written in NFC.
    expect(clientNameProblem('é'.repeat(CLIENT_NAME_MAX_LENGTH))).toBeNull();
  });
});

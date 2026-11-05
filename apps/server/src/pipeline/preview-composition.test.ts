import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { previewFromHtml, readPreview } from './preview-composition.js';

const SAMPLE = fileURLToPath(new URL('./testdata/preview/', import.meta.url));
const FILE = 'edit/preview/index.html';

/** A page whose root element has the given attribute text. */
const page = (attributes: string, extra = ''): string =>
  `<!doctype html><html><head><title>x</title></head><body>${extra}<div id="root" ${attributes}></div></body></html>`;

const GOOD = 'data-composition-id="main" data-width="1080" data-height="1920" data-duration="6"';

const problemOf = (html: string): string => {
  const check = previewFromHtml(html);
  if (check.ok) throw new Error('expected a problem');
  return check.problem;
};

describe('previewFromHtml', () => {
  it("reads W9's sample composition: 6 s, 1080x1920", () => {
    const html = readFileSync(join(SAMPLE, 'index.html'), 'utf8');
    expect(previewFromHtml(html)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('reads the attributes however they are written', () => {
    const ok = (preview: { durationSec: number; width: number; height: number }) => ({
      ok: true,
      preview,
    });
    const want = ok({ durationSec: 28.4, width: 1080, height: 1920 });
    // Single quotes.
    expect(
      previewFromHtml(
        page(
          `data-composition-id='main' data-width='1080' data-height='1920' data-duration='28.4'`,
        ),
      ),
    ).toEqual(want);
    // Bare values.
    expect(
      previewFromHtml(
        page('data-composition-id=main data-width=1080 data-height=1920 data-duration=28.4'),
      ),
    ).toEqual(want);
    // Upper-case names and tag.
    expect(
      previewFromHtml(
        '<DIV DATA-COMPOSITION-ID="main" Data-Width="1080" DATA-HEIGHT="1920" data-DURATION="28.4"></DIV>',
      ),
    ).toEqual(want);
    // Attributes over several lines, with spaces around the equals sign.
    expect(
      previewFromHtml(
        '<div\n  id="root"\n  data-composition-id = "main"\n  data-width\n    =\n    "1080"\n\tdata-height="1920"\n  data-duration="28.4"\n>',
      ),
    ).toEqual(want);
    // Self-closing, and a > inside an earlier quoted value.
    expect(
      previewFromHtml(
        `<div title="a > b" data-note='x>y' data-composition-id="main" data-width="1080" data-height="1920" data-duration="28.4" />`,
      ),
    ).toEqual(want);
    // Padding inside the value.
    expect(
      previewFromHtml(
        page(
          'data-composition-id="main" data-width=" 1080 " data-height="1920" data-duration=" 28.4"',
        ),
      ),
    ).toEqual(want);
  });

  it('takes the first attribute of a name', () => {
    expect(previewFromHtml(page(`${GOOD} data-width="720"`))).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('parses a length with decimals', () => {
    expect(
      previewFromHtml(
        page('data-composition-id="m" data-width="1080" data-height="1920" data-duration="28.4"'),
      ),
    ).toEqual({ ok: true, preview: { durationSec: 28.4, width: 1080, height: 1920 } });
  });

  it('uses the first element with a data-composition-id; a sub-composition host after it changes nothing', () => {
    const html = `<body>
      <div id="root" ${GOOD}>
        <div id="host" data-composition-id="badge" data-composition-src="compositions/badge.html" data-width="500" data-height="500" data-duration="3"></div>
      </div>
    </body>`;
    expect(previewFromHtml(html)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('is the first element even when it is the one with the problem', () => {
    const html = `<div data-composition-id="main" data-width="abc" data-height="1920" data-duration="6"></div>
      <div data-composition-id="badge" data-width="500" data-height="500" data-duration="3"></div>`;
    expect(problemOf(html)).toBe(
      'data-width="abc" on the root element of edit/preview/index.html is not a whole number above 0.',
    );
  });

  it('skips tags without a data-composition-id', () => {
    const html = `<div data-width="1" data-height="1" data-duration="1"></div><span class="x"></span><div ${GOOD}></div>`;
    expect(previewFromHtml(html)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  describe('text that only looks like a root', () => {
    it('is not the root in a comment', () => {
      expect(problemOf(`<!-- <div ${GOOD}> --><body></body>`)).toBe(
        'edit/preview/index.html has no element with data-composition-id.',
      );
    });

    it('is not the root in a script string', () => {
      const html = `<body><script>const html = '<div ${GOOD}>';</script></body>`;
      expect(problemOf(html)).toBe(
        'edit/preview/index.html has no element with data-composition-id.',
      );
    });

    it('is not the root in a template element, a style or an uppercase SCRIPT', () => {
      expect(problemOf(`<template><div ${GOOD}></div></template>`)).toMatch(/no element with/);
      expect(problemOf(`<style>/* <div ${GOOD}> */</style>`)).toMatch(/no element with/);
      expect(problemOf(`<SCRIPT type="x">"<div ${GOOD}>"</SCRIPT>`)).toMatch(/no element with/);
    });

    it('lets the real root after such text win', () => {
      const html = `<!-- <div data-composition-id="x" data-width="1" data-height="1" data-duration="1"> -->
        <script>'<div data-composition-id="y">'</script>
        <div ${GOOD}></div>`;
      expect(previewFromHtml(html)).toEqual({
        ok: true,
        preview: { durationSec: 6, width: 1080, height: 1920 },
      });
    });
  });

  describe('the problems, word for word', () => {
    it('no root', () => {
      expect(problemOf('')).toBe(
        'edit/preview/index.html has no element with data-composition-id.',
      );
      expect(problemOf('<html><body><div id="x"></div></body></html>')).toBe(
        'edit/preview/index.html has no element with data-composition-id.',
      );
    });

    it('an empty id', () => {
      const empty = 'the root element of edit/preview/index.html has an empty data-composition-id.';
      expect(
        problemOf(page('data-composition-id="" data-width="1" data-height="1" data-duration="1"')),
      ).toBe(empty);
      expect(
        problemOf(
          page('data-composition-id="  " data-width="1" data-height="1" data-duration="1"'),
        ),
      ).toBe(empty);
      expect(
        problemOf(page('data-composition-id data-width="1" data-height="1" data-duration="1"')),
      ).toBe(empty);
    });

    it('a missing attribute, width first, then height, then duration', () => {
      expect(problemOf(page('data-composition-id="main"'))).toBe(
        'the root element of edit/preview/index.html has no data-width.',
      );
      expect(problemOf(page('data-composition-id="main" data-width="1080"'))).toBe(
        'the root element of edit/preview/index.html has no data-height.',
      );
      expect(
        problemOf(page('data-composition-id="main" data-width="1080" data-height="1920"')),
      ).toBe('the root element of edit/preview/index.html has no data-duration.');
      expect(
        problemOf(page('data-composition-id="main" data-duration="6" data-height="1920"')),
      ).toBe('the root element of edit/preview/index.html has no data-width.');
    });

    it('a bad width or height', () => {
      const bad = (width: string, height = '1920') =>
        problemOf(
          page(
            `data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="6"`,
          ),
        );
      const whole = (name: string, value: string) =>
        `${name}="${value}" on the root element of edit/preview/index.html is not a whole number above 0.`;
      expect(bad('1080.5')).toBe(whole('data-width', '1080.5'));
      expect(bad('0')).toBe(whole('data-width', '0'));
      expect(bad('-6')).toBe(whole('data-width', '-6'));
      expect(bad('abc')).toBe(whole('data-width', 'abc'));
      expect(bad('6s')).toBe(whole('data-width', '6s'));
      expect(bad('')).toBe(whole('data-width', ''));
      expect(bad('1080', '1920.5')).toBe(whole('data-height', '1920.5'));
      expect(bad('1080', '0')).toBe(whole('data-height', '0'));
      expect(bad('1080', '')).toBe(whole('data-height', ''));
      // Width is judged before height.
      expect(bad('x', 'y')).toBe(whole('data-width', 'x'));
    });

    it('a bad duration', () => {
      const bad = (duration: string) =>
        problemOf(
          page(
            `data-composition-id="main" data-width="1080" data-height="1920" data-duration="${duration}"`,
          ),
        );
      const number = (value: string) =>
        `data-duration="${value}" on the root element of edit/preview/index.html is not a number above 0.`;
      expect(bad('abc')).toBe(number('abc'));
      expect(bad('0')).toBe(number('0'));
      expect(bad('-6')).toBe(number('-6'));
      expect(bad('6s')).toBe(number('6s'));
      expect(bad('')).toBe(number(''));
      expect(bad('Infinity')).toBe(number('Infinity'));
      expect(bad('NaN')).toBe(number('NaN'));
    });

    it('quotes a long value cut to 19 characters plus an ellipsis', () => {
      const long = 'x'.repeat(40);
      expect(
        problemOf(
          page(
            `data-composition-id="main" data-width="${long}" data-height="1920" data-duration="6"`,
          ),
        ),
      ).toBe(
        `data-width="${'x'.repeat(19)}…" on the root element of edit/preview/index.html is not a whole number above 0.`,
      );
      // 20 characters are still quoted whole, 21 are cut.
      const twenty = `${'1'.repeat(19)}x`;
      expect(
        problemOf(
          page(
            `data-composition-id="main" data-width="1080" data-height="1920" data-duration="${twenty}"`,
          ),
        ),
      ).toBe(
        `data-duration="${twenty}" on the root element of edit/preview/index.html is not a number above 0.`,
      );
      expect(
        problemOf(
          page(
            `data-composition-id="main" data-width="1080" data-height="1920" data-duration="${twenty}y"`,
          ),
        ),
      ).toBe(
        `data-duration="${'1'.repeat(19)}…" on the root element of edit/preview/index.html is not a number above 0.`,
      );
    });
  });

  it('does not need the timeline registry line', () => {
    expect(previewFromHtml(page(GOOD)).ok).toBe(true);
  });

  it('survives hostile text without hanging', () => {
    const html = `<div ${'a '.repeat(20_000)}`;
    expect(previewFromHtml(html).ok).toBe(false);
    expect(previewFromHtml(`<div a="${'x'.repeat(100_000)}`).ok).toBe(false);
    expect(previewFromHtml(`<!-- ${'x'.repeat(100_000)}`).ok).toBe(false);
  });
});

describe('readPreview', () => {
  let jobDir: string;

  beforeEach(() => {
    jobDir = mkdtempSync(join(tmpdir(), 'studio-preview-composition-'));
  });

  afterEach(() => {
    rmSync(jobDir, { recursive: true, force: true });
  });

  function writeIndex(html: string, dir = jobDir): void {
    mkdirSync(join(dir, 'edit', 'preview'), { recursive: true });
    writeFileSync(join(dir, FILE), html);
  }

  it('reads the preview from a composition on disk', async () => {
    writeIndex(page(GOOD));
    expect(await readPreview(jobDir)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it("reads W9's sample copied into a job", async () => {
    writeIndex(readFileSync(join(SAMPLE, 'index.html'), 'utf8'));
    expect(await readPreview(jobDir)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('reads a job folder with spaces and Hebrew in its path', async () => {
    const hebrew = join(jobDir, 'מאפיית הצפון', 'פרומו לסוף השבוע');
    writeIndex(page(GOOD), hebrew);
    expect(await readPreview(hebrew)).toEqual({
      ok: true,
      preview: { durationSec: 6, width: 1080, height: 1920 },
    });
  });

  it('says the file is missing when there is no index.html', async () => {
    mkdirSync(join(jobDir, 'edit', 'preview'), { recursive: true });
    expect(await readPreview(jobDir)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html is missing.',
    });
  });

  it('says the file is missing when there is no edit/ at all', async () => {
    expect(await readPreview(jobDir)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html is missing.',
    });
  });

  it('says the file is missing when edit/ is a file (ENOTDIR)', async () => {
    writeFileSync(join(jobDir, 'edit'), 'x');
    expect(await readPreview(jobDir)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html is missing.',
    });
  });

  it('says it is not a file when a folder has that name', async () => {
    mkdirSync(join(jobDir, FILE), { recursive: true });
    expect(await readPreview(jobDir)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html is not a file.',
    });
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'says it could not be read, with the error code, when it has no permissions',
    async () => {
      writeIndex(page(GOOD));
      chmodSync(join(jobDir, FILE), 0o000);
      try {
        expect(await readPreview(jobDir)).toEqual({
          ok: false,
          problem: 'edit/preview/index.html could not be read (EACCES).',
        });
      } finally {
        chmodSync(join(jobDir, FILE), 0o644);
      }
    },
  );

  it('reports what is wrong inside the file', async () => {
    writeIndex('<html><body>nothing here</body></html>');
    expect(await readPreview(jobDir)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html has no element with data-composition-id.',
    });
  });
});

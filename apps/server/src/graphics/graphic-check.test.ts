import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkGraphicWork, graphicCompositionPath, readGraphicAbout } from './graphic-check.js';
import { cannedComposition, writeCannedGraphic } from './test-utils.js';

// The engine's static check of a run's work (GR1): about.json, the composition's template, id,
// timeline and text fields, and the references it names. Real temp folders.

const ID = '0a1b2c3d4e5f';
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'studio-graphic-check-'));
});

afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function put(relPath: string, content: string): void {
  const path = join(work, relPath);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** A graphic that passes, then `edit` changes its composition. */
function graphic(edit: (html: string) => string = (html) => html): void {
  writeCannedGraphic(work, ID, 1, { name: 'Name on a white pill' });
  put(graphicCompositionPath(ID), edit(cannedComposition(ID)));
}

async function problem(): Promise<string> {
  const result = await checkGraphicWork(work, ID);
  if (result.ok) throw new Error('the check passed');
  return result.error;
}

describe('checkGraphicWork', () => {
  it('passes a graphic that has everything, and answers its about.json', async () => {
    graphic();

    const result = await checkGraphicWork(work, ID);

    expect(result).toMatchObject({
      ok: true,
      about: { name: 'Name on a white pill', kind: 'lower-third', lengthSec: 3 },
    });
  });

  it('lets inline SVG keep its xmlns, a data: image and a #fragment', async () => {
    graphic((html) =>
      html.replace(
        '<svg ',
        '<svg data-x="1" xmlns:xlink="http://www.w3.org/1999/xlink" style="fill: url(#gradient)"><use href="#shape" /></svg><img src="data:image/png;base64,AAAA" /><svg ',
      ),
    );

    expect((await checkGraphicWork(work, ID)).ok).toBe(true);
  });

  describe('about.json', () => {
    it('is needed', async () => {
      graphic();
      rmSync(join(work, 'about.json'));

      expect(await problem()).toBe('The run finished without writing about.json.');
    });

    it('must be JSON', async () => {
      graphic();
      put('about.json', '{ not json');

      expect(await problem()).toBe('about.json is not valid JSON.');
    });

    it('must fit the schema, and the sentence names the field', async () => {
      graphic();
      put(
        'about.json',
        JSON.stringify({ kind: 'banner', lengthSec: 3, variables: [], when: 'w', reply: 'r' }),
      );

      const error = await problem();
      expect(error).toMatch(/^about\.json is not right at "kind": /);
      expect(error).toMatch(/\.$/);
    });

    it('can be read on its own, for a version’s folder', async () => {
      graphic();
      expect(await readGraphicAbout(work)).toMatchObject({ ok: true });
      expect(await readGraphicAbout(join(work, 'nowhere'))).toMatchObject({ ok: false });
    });
  });

  describe('the composition', () => {
    it('must be there', async () => {
      graphic();
      rmSync(join(work, graphicCompositionPath(ID)));

      expect(await problem()).toBe(`The graphic file compositions/lib-${ID}.html is missing.`);
    });

    it('must have a template', async () => {
      graphic((html) => html.replace(/<\/?template[^>]*>/g, ''));

      expect(await problem()).toContain('has no <template>');
    });

    it('must have the right composition id, and says which one it found', async () => {
      graphic((html) =>
        html.replaceAll(`data-composition-id="lib-${ID}"`, 'data-composition-id="pill"'),
      );

      expect(await problem()).toBe(
        `compositions/lib-${ID}.html has the composition id "pill" where it needs "lib-${ID}".`,
      );
    });

    it('must register its timeline under that id', async () => {
      graphic((html) => html.replace(`__timelines["lib-${ID}"]`, '__timelines["pill"]'));

      expect(await problem()).toContain(`window.__timelines["lib-${ID}"]`);
    });

    it('takes a timeline registered with single quotes', async () => {
      graphic((html) => html.replace(`__timelines["lib-${ID}"]`, `__timelines['lib-${ID}']`));

      expect((await checkGraphicWork(work, ID)).ok).toBe(true);
    });

    it('must declare every text field of about.json', async () => {
      writeCannedGraphic(work, ID, 1, {
        variables: [
          { id: 'name', label: 'Name', default: 'Dana' },
          { id: 'role', label: 'Role', default: 'Lawyer' },
        ],
      });
      put(
        graphicCompositionPath(ID),
        cannedComposition(ID, [{ id: 'name', label: 'Name', default: 'Dana' }]),
      );

      expect(await problem()).toContain('does not declare the text field "role"');
    });

    it('says when data-composition-variables is not a JSON list', async () => {
      graphic((html) =>
        html.replace(/data-composition-variables='[^']*'/, "data-composition-variables='nope'"),
      );

      expect(await problem()).toContain('not a valid JSON list');
    });

    it('needs no declaration when the graphic has no text fields', async () => {
      writeCannedGraphic(work, ID, 1, { variables: [] });

      expect((await checkGraphicWork(work, ID)).ok).toBe(true);
    });
  });

  describe('what it loads', () => {
    it('refuses a URL in src, href and url()', async () => {
      for (const reference of [
        'src="https://cdn.example.com/gsap.js"',
        'href="http://example.com/a.css"',
        'poster="//example.com/a.png"',
      ]) {
        graphic((html) => html.replace('<svg ', `<img ${reference} /><svg `));
        expect(await problem(), reference).toContain('from the internet');
      }
      graphic((html) =>
        html.replace('src: url("lib', 'src: url("https://fonts.example.com/Heebo.ttf"), url("lib'),
      );
      expect(await problem()).toContain('https://fonts.example.com/Heebo.ttf');
    });

    it('refuses an absolute path', async () => {
      for (const path of [
        '/Users/owner/logo.png',
        '~/logo.png',
        'C:\\logo.png',
        'file:///tmp/a.png',
      ]) {
        graphic((html) => html.replace('<svg ', `<img src="${path}" /><svg `));
        expect(await problem(), path).toMatch(/absolute path|from the internet/);
      }
    });

    it('refuses a file that is not there, naming it', async () => {
      graphic((html) => html.replace('<svg ', '<img src="lib/missing/logo.png" /><svg '));

      expect(await problem()).toBe(
        `compositions/lib-${ID}.html uses lib/missing/logo.png, but that file is not there.`,
      );
    });

    it('refuses a path that leaves the graphic’s folder', async () => {
      graphic((html) => html.replace('<svg ', '<img src="../refs/logo.png" /><svg '));

      expect(await problem()).toContain('outside the graphic');
    });

    it('takes a relative file that is there, with a query and an escaped name', async () => {
      put(`lib/${ID}/my logo.png`, 'png');
      graphic((html) => html.replace('<svg ', `<img src="lib/${ID}/my%20logo.png?v=2" /><svg `));

      expect((await checkGraphicWork(work, ID)).ok).toBe(true);
    });

    it('leaves out placeholders, comments and the data-var-src variable id', async () => {
      graphic((html) =>
        html.replace(
          '<svg ',
          '<!-- <img src="https://example.com/x.png" /> --><img data-var-src="heroImage" src="data:image/gif;base64,R0lG" /><img src="\u0024{base}/a.png" /><svg ',
        ),
      );

      expect((await checkGraphicWork(work, ID)).ok).toBe(true);
    });

    it('answers the first problem only, in the order about.json, composition, loads', async () => {
      graphic((html) => html.replace('<svg ', '<img src="https://example.com/x.png" /><svg '));
      put('about.json', '{');

      expect(await problem()).toBe('about.json is not valid JSON.');
    });
  });
});

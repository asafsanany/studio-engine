import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { jobFormatsOf } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { withFrameSize, writeFakePreview } from './fake-preview.js';
import { previewFromHtml, readPreview } from './preview-composition.js';
import { extraFinalPath, extraPreviewDirPath, extraPreviewIndexPath } from './preview-files.js';

// Formats (GN7): a run that ends in Review succeeds only when the composition of EVERY format is
// valid. A job with one format is read as it always was.

const root = (width: number, height: number, duration: number): string =>
  `<!doctype html><html><body><div data-composition-id="main" data-width="${width}" data-height="${height}" data-duration="${duration}"></div></body></html>`;

const TWO = jobFormatsOf(['1080x1920', '1080x1080']);
const THREE = jobFormatsOf(['1080x1920', '1080x1080', '1080x1350']);

let jobDir: string;

beforeEach(() => {
  jobDir = mkdtempSync(join(tmpdir(), 'studio-preview-formats-'));
});

afterEach(() => {
  rmSync(jobDir, { recursive: true, force: true });
});

function put(path: string, html: string): void {
  mkdirSync(join(jobDir, path, '..'), { recursive: true });
  writeFileSync(join(jobDir, path), html);
}

describe('the paths of an extra format', () => {
  it('is edit/preview-<id>/ next to edit/preview/', () => {
    expect(extraPreviewDirPath('1x1')).toBe(join('edit', 'preview-1x1'));
    expect(extraPreviewIndexPath('4x5')).toBe(join('edit', 'preview-4x5', 'index.html'));
    expect(extraFinalPath('1x1')).toBe(join('edit', 'final-1x1.mp4'));
  });
});

describe('previewFromHtml with another path', () => {
  it('names that path in its problems', () => {
    const check = previewFromHtml('<div></div>', 'edit/preview-1x1/index.html');
    expect(check).toEqual({
      ok: false,
      problem: 'edit/preview-1x1/index.html has no element with data-composition-id.',
    });
  });

  it('names the default path as before', () => {
    expect(previewFromHtml('<div></div>')).toEqual({
      ok: false,
      problem: 'edit/preview/index.html has no element with data-composition-id.',
    });
  });
});

describe('readPreview with formats', () => {
  it('returns the main composition when every format is valid', async () => {
    put('edit/preview/index.html', root(1080, 1920, 28.4));
    put('edit/preview-1x1/index.html', root(1080, 1080, 28.4));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: true,
      preview: { durationSec: 28.4, width: 1080, height: 1920 },
    });
  });

  it('is the old answer for a job with one format or none, even with extra files lying around', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    expect(await readPreview(jobDir)).toEqual(await readPreview(jobDir, []));
    expect(await readPreview(jobDir, TWO.slice(0, 1))).toEqual(await readPreview(jobDir));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem: 'edit/preview-1x1/index.html is missing.',
    });
  });

  it('fails when the main composition is wrong, before looking at the others', async () => {
    put('edit/preview-1x1/index.html', root(1080, 1080, 6));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem: 'edit/preview/index.html is missing.',
    });
  });

  it('fails when an extra format has no composition', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem: 'edit/preview-1x1/index.html is missing.',
    });
  });

  it('fails with the problem of the extra composition when it has no usable root', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    put('edit/preview-1x1/index.html', '<div data-composition-id="x" data-width="1080"></div>');
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem: 'the root element of edit/preview-1x1/index.html has no data-height.',
    });
  });

  it('fails when one of three formats is missing, naming that one', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    put('edit/preview-1x1/index.html', root(1080, 1080, 6));
    expect(await readPreview(jobDir, THREE)).toEqual({
      ok: false,
      problem: 'edit/preview-4x5/index.html is missing.',
    });
    put('edit/preview-4x5/index.html', root(1080, 1350, 6));
    expect((await readPreview(jobDir, THREE)).ok).toBe(true);
  });

  it('fails when an extra composition is not the format’s shape', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    put('edit/preview-1x1/index.html', root(1080, 1920, 6));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem: 'edit/preview-1x1/index.html is 1080x1920, but the 1:1 format is 1080x1080.',
    });
  });

  it('takes another size of the same shape: the ratio is what counts', async () => {
    put('edit/preview/index.html', root(1080, 1920, 6));
    put('edit/preview-1x1/index.html', root(1440, 1440, 6));
    expect((await readPreview(jobDir, TWO)).ok).toBe(true);
  });

  it('fails when an extra composition is not the length of the main one: one cut, one length', async () => {
    put('edit/preview/index.html', root(1080, 1920, 28.4));
    put('edit/preview-1x1/index.html', root(1080, 1080, 31));
    expect(await readPreview(jobDir, TWO)).toEqual({
      ok: false,
      problem:
        'edit/preview-1x1/index.html is 31 s long, but edit/preview/index.html is 28.4 s: every format is the same cut.',
    });
  });

  it('allows a difference of up to half a second', async () => {
    put('edit/preview/index.html', root(1080, 1920, 28.4));
    put('edit/preview-1x1/index.html', root(1080, 1080, 28.8));
    expect((await readPreview(jobDir, TWO)).ok).toBe(true);
  });
});

describe('the fake composition of an extra format', () => {
  it('has the format’s size on the root and the page, and passes readPreview with the others', async () => {
    mkdirSync(join(jobDir, 'edit'), { recursive: true });
    const editDir = join(jobDir, 'edit');
    await writeFakePreview(editDir, 'Teaser');
    await writeFakePreview(editDir, 'Teaser', undefined, {
      dirName: 'preview-1x1',
      size: { width: 1080, height: 1080 },
    });
    const html = readFileSync(join(editDir, 'preview-1x1', 'index.html'), 'utf8');
    expect(html).toContain(
      'data-composition-id="main" data-start="0" data-width="1080" data-height="1080"',
    );
    expect(html).toContain('width=1080, height=1080');
    expect(html).toContain('width: 1080px; height: 1080px;');
    expect(html).not.toContain('1920');
    expect((await readPreview(jobDir, TWO)).ok).toBe(true);
    // The main one is the sample as it was.
    expect(readFileSync(join(editDir, 'preview', 'index.html'), 'utf8')).toContain(
      'data-height="1920"',
    );
  });

  it('withFrameSize changes the viewport, the root and the page, and nothing else', () => {
    const html =
      '<meta name="viewport" content="width=1080, height=1920"> data-width="1080" data-height="1920"';
    expect(withFrameSize(html, { width: 1080, height: 1350 })).toBe(
      '<meta name="viewport" content="width=1080, height=1350"> data-width="1080" data-height="1350"',
    );
  });
});

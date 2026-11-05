import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';

// The sample composition (testdata/preview/): what the dev gallery plays and what the fake runner
// copies into a fake job. These checks keep it a valid, self-contained live composition: the
// player is picky (a missing timeline registry, an absolute URL or a `crossorigin` breaks it) and
// nothing else would notice until someone watched it in a browser.

const ROOT = fileURLToPath(new URL('./testdata/preview/', import.meta.url));
const text = (name: string) => readFileSync(join(ROOT, name), 'utf8');

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? filesUnder(join(dir, entry.name)) : [join(dir, entry.name)],
  );
}

/** The top-level boxes of an MP4: [type, offset] in file order. */
function topLevelBoxes(bytes: Buffer): Array<[string, number]> {
  const boxes: Array<[string, number]> = [];
  let offset = 0;
  while (offset + 8 <= bytes.length) {
    let size = bytes.readUInt32BE(offset);
    const type = bytes.toString('latin1', offset + 4, offset + 8);
    boxes.push([type, offset]);
    if (size === 1) size = Number(bytes.readBigUInt64BE(offset + 8));
    if (size === 0) break; // the last box runs to the end of the file
    offset += size;
  }
  return boxes;
}

describe('the sample preview composition', () => {
  it('holds exactly the files the contract names', () => {
    const files = filesUnder(ROOT)
      .map((path) => relative(ROOT, path).split('\\').join('/'))
      .sort();
    expect(files).toEqual([
      'assets/fonts/noto-sans-hebrew-hebrew-700-normal.woff2',
      'compositions/badge.html',
      'cut.mp4',
      'index.html',
      'vendor/gsap.min.js',
    ]);
  });

  describe('index.html', () => {
    const html = text('index.html');

    it('is a 1080×1920 composition of 6 seconds, id main', () => {
      const root = /<div id="root"[^>]*>/.exec(html)?.[0] ?? '';
      expect(root).toContain('data-composition-id="main"');
      expect(root).toContain('data-width="1080"');
      expect(root).toContain('data-height="1920"');
      expect(root).toContain('data-duration="6"');
    });

    it('creates the timeline registry itself before it registers its timeline', () => {
      const registry = html.indexOf('window.__timelines = window.__timelines || {}');
      const register = html.indexOf('window.__timelines["main"]');
      expect(registry).toBeGreaterThan(-1);
      expect(register).toBeGreaterThan(registry);
    });

    it('says "Sample preview" exactly twice, the two texts the fake runner replaces', () => {
      expect(html.match(/Sample preview/g)).toHaveLength(2);
      expect(html).toContain('<title>Sample preview</title>');
      expect(html).toContain('dir="auto">Sample preview</div>');
    });

    it('lets the video carry the sound (not muted) and the player copy it (data-has-audio)', () => {
      const video = /<video[^>]*>/.exec(html)?.[0] ?? '';
      expect(video).not.toMatch(/\bmuted\b/);
      expect(video).toContain('data-has-audio="true"');
      expect(video).toContain('data-duration="6"');
    });

    it('hosts the badge sub-composition between 2 and 5 seconds', () => {
      const host = /<div id="badge-host"[^>]*>/.exec(html)?.[0] ?? '';
      expect(host).toContain('data-composition-id="badge"');
      expect(host).toContain('data-composition-src="compositions/badge.html"');
      expect(host).toContain('data-start="2"');
      expect(host).toContain('data-duration="3"');
    });
  });

  describe('compositions/badge.html', () => {
    const html = text('compositions/badge.html');

    it('keeps its composition, style and script inside a <template>', () => {
      const template = /<template>([\s\S]*)<\/template>/.exec(html)?.[1] ?? '';
      expect(template).toContain('data-composition-id="badge"');
      expect(template).toContain('<style>');
      expect(template).toContain('window.__timelines["badge"]');
    });
  });

  describe('references', () => {
    const pages = ['index.html', 'compositions/badge.html'];

    it('are all relative and name a file that exists in the folder', () => {
      const found: Array<{ page: string; ref: string }> = [];
      for (const page of pages) {
        const html = text(page);
        for (const match of html.matchAll(/\b(?:src|data-composition-src)="([^"]*)"/g)) {
          found.push({ page, ref: match[1] ?? '' });
        }
        for (const match of html.matchAll(/url\(\s*["']?([^"')]*)["']?\s*\)/g)) {
          found.push({ page, ref: match[1] ?? '' });
        }
      }
      expect(found.length).toBeGreaterThanOrEqual(4);
      for (const { page, ref } of found) {
        expect(ref, `${page}: ${ref}`).not.toMatch(/^(?:[a-z][a-z0-9+.-]*:|\/\/|\/)/i);
        // `src` and `data-composition-src` resolve against the folder; the badge page is only read
        // by the player (its path is the host's `data-composition-src`), never as a base.
        expect(existsSync(join(ROOT, ref)), `${page}: ${ref}`).toBe(true);
      }
    });

    it('never ask for CORS (crossorigin) anywhere', () => {
      for (const path of filesUnder(ROOT)) {
        if (!/\.(?:html|js)$/.test(path)) continue;
        expect(readFileSync(path, 'utf8'), path).not.toContain('crossorigin');
      }
    });
  });

  describe('cut.mp4', () => {
    const bytes = readFileSync(join(ROOT, 'cut.mp4'));

    it('is at most 300 KB', () => {
      expect(statSync(join(ROOT, 'cut.mp4')).size).toBeLessThanOrEqual(307_200);
    });

    it('starts with ftyp and has moov before mdat (faststart), so it seeks without downloading', () => {
      const boxes = topLevelBoxes(bytes);
      const types = boxes.map(([type]) => type);
      expect(types[0]).toBe('ftyp');
      expect(types).toContain('moov');
      expect(types).toContain('mdat');
      expect(types.indexOf('moov')).toBeLessThan(types.indexOf('mdat'));
    });

    it('carries H.264 video and AAC audio', () => {
      expect(bytes.includes(Buffer.from('avc1'))).toBe(true);
      expect(bytes.includes(Buffer.from('mp4a'))).toBe(true);
    });
  });

  it('ships GSAP 3.15.0 with its license notice', () => {
    const gsap = text('vendor/gsap.min.js');
    expect(gsap.startsWith('/*!\n * GSAP 3.15.0\n')).toBe(true);
    expect(gsap).toContain('gsap.com/standard-license');
  });

  it('ships a WOFF2 font', () => {
    const font = readFileSync(join(ROOT, 'assets/fonts/noto-sans-hebrew-hebrew-700-normal.woff2'));
    expect(font.toString('latin1', 0, 4)).toBe('wOF2');
  });
});

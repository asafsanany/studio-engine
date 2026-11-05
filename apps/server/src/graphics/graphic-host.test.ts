import { GRAPHIC_BACKGROUNDS, GRAPHIC_SIZE_PIXELS, GRAPHIC_SIZES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { injectTimelineRegistry, TIMELINE_REGISTRY_SCRIPT } from '../routes/composition-files.js';
import {
  type GraphicHostOptions,
  HOST_REGISTRY_SCRIPT,
  HOST_TAIL_SEC,
  renderGraphicHost,
  SAMPLE_FRAMES_BASE,
  sampleFrameFile,
} from './graphic-host.js';

const ID = '5a3e1c0de001';

function host(options: Partial<GraphicHostOptions> = {}): string {
  return renderGraphicHost({
    id: ID,
    lengthSec: 3,
    size: '9x16',
    background: 'frame',
    values: {},
    ...options,
  });
}

/** The opening tag of the element with `id="<id>"`. */
function tagOf(html: string, id: string): string {
  const at = html.indexOf(`id="${id}"`);
  expect(at, id).toBeGreaterThan(-1);
  return html.slice(html.lastIndexOf('<', at), html.indexOf('>', at) + 1);
}

/** The `data-variable-values` attribute, read back the way a browser reads it. */
function mountedValues(html: string): unknown {
  const tag = tagOf(html, 'graphic');
  const raw = /data-variable-values="([^"]*)"/.exec(tag)?.[1] ?? '';
  const text = raw
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
  return JSON.parse(text);
}

describe('renderGraphicHost', () => {
  it('is a whole HTML document with a transparent page', () => {
    const html = host();
    expect(html.startsWith('<!doctype html>')).toBe(true);
    expect(html).toContain('<meta charset="UTF-8" />');
    expect(html).toMatch(/html, body \{[^}]*background: transparent/);
  });

  it.each(GRAPHIC_SIZES)('sizes the root composition for %s in pixels', (size) => {
    const { width, height } = GRAPHIC_SIZE_PIXELS[size];
    const html = host({ size });
    const root = tagOf(html, 'root');
    expect(root).toContain('data-composition-id="main"');
    expect(root).toContain(`data-width="${width}"`);
    expect(root).toContain(`data-height="${height}"`);
    expect(html).toContain(`<meta name="viewport" content="width=${width}, height=${height}" />`);
    expect(html).toContain(`html, body { width: ${width}px; height: ${height}px;`);
  });

  it('plays for the graphic’s length plus the tail, so the loop breathes', () => {
    expect(HOST_TAIL_SEC).toBe(0.8);
    expect(tagOf(host({ lengthSec: 3 }), 'root')).toContain('data-duration="3.8"');
    expect(tagOf(host({ lengthSec: 2.4 }), 'root')).toContain('data-duration="3.2"');
    expect(tagOf(host({ lengthSec: 0.5 }), 'root')).toContain('data-duration="1.3"');
    expect(tagOf(host({ lengthSec: 12.25 }), 'root')).toContain('data-duration="13.05"');
  });

  it('puts the timeline registry first, then GSAP from vendor/, with relative paths', () => {
    const html = host();
    // The same line the preview routes add to a root composition, so they leave this page alone.
    expect(HOST_REGISTRY_SCRIPT).toBe(TIMELINE_REGISTRY_SCRIPT);
    expect(injectTimelineRegistry(html)).toBe(html);
    const registry = html.indexOf(TIMELINE_REGISTRY_SCRIPT);
    const gsap = html.indexOf('<script src="vendor/gsap.min.js"></script>');
    expect(registry).toBeGreaterThan(-1);
    expect(gsap).toBeGreaterThan(registry);
    // The first script of the page is the registry line.
    expect(html.indexOf('<script')).toBe(registry);
  });

  it('registers an empty paused root timeline under "main"', () => {
    const html = host();
    expect(html).toContain('window.__timelines["main"] = gsap.timeline({ paused: true });');
    // Nothing is tweened on it: the graphic's own timeline is the only motion.
    expect(html).not.toMatch(/\.(to|from|fromTo|set)\(/);
  });

  it('mounts compositions/lib-<id>.html once, for the graphic’s length', () => {
    const html = host({ lengthSec: 2.5 });
    const mount = tagOf(html, 'graphic');
    expect(mount).toContain(`data-composition-id="lib-${ID}"`);
    expect(mount).toContain(`data-composition-src="compositions/lib-${ID}.html"`);
    expect(mount).toContain('data-start="0"');
    expect(mount).toContain('data-duration="2.5"');
    expect(mount).toContain('data-width="1080"');
    expect(mount).toContain('data-height="1920"');
    expect(html.match(/data-composition-src=/g)).toHaveLength(1);
  });

  it('gives the mount the size’s pixels', () => {
    const mount = tagOf(host({ size: '16x9' }), 'graphic');
    expect(mount).toContain('data-width="1920"');
    expect(mount).toContain('data-height="1080"');
  });

  describe('values', () => {
    it('are the mount’s data-variable-values, as JSON', () => {
      expect(mountedValues(host({ values: { name: 'Dana', role: 'Founder' } }))).toEqual({
        name: 'Dana',
        role: 'Founder',
      });
      expect(mountedValues(host({ values: {} }))).toEqual({});
    });

    it('keep Hebrew, emoji and empty text as they are', () => {
      const values = { name: 'דנה לוי', role: '', note: 'שלום 👋' };
      expect(mountedValues(host({ values }))).toEqual(values);
    });

    it('are HTML-escaped: quotes, brackets and ampersands cannot leave the attribute', () => {
      const values = {
        name: '"><script>alert(1)</script>',
        role: `it's & "quoted" </div>`,
      };
      const html = host({ values });
      expect(mountedValues(html)).toEqual(values);
      expect(html).not.toContain('<script>alert(1)</script>');
      expect(html).not.toContain('"><script');
      // The only scripts are the registry, GSAP and the page's own timeline.
      expect(html.match(/<script/g)).toHaveLength(3);
      // No attribute was added by the text: the mount still has exactly its own.
      const names = [...tagOf(html, 'graphic').matchAll(/ ([a-z-]+)="[^"]*"/g)].map((m) => m[1]);
      expect(names).toEqual([
        'id',
        'data-composition-id',
        'data-composition-src',
        'data-start',
        'data-duration',
        'data-track-index',
        'data-width',
        'data-height',
        'data-variable-values',
      ]);
    });
  });

  describe('the background', () => {
    it('is a plain div that is not a clip, before the graphic', () => {
      for (const background of GRAPHIC_BACKGROUNDS) {
        const html = host({ background });
        const div = tagOf(html, 'background');
        expect(div).toBe('<div id="background">');
        expect(div).not.toContain('data-start');
        expect(div).not.toContain('class=');
        expect(html.indexOf('id="background"')).toBeLessThan(html.indexOf('id="graphic"'));
      }
    });

    it.each(GRAPHIC_SIZES)('frame: the sample frame of %s', (size) => {
      const html = host({ size, background: 'frame' });
      expect(html).toContain(`url("${SAMPLE_FRAMES_BASE}/sample-${size}.svg")`);
      expect(html).toContain('center / cover no-repeat');
      expect(sampleFrameFile(size)).toBe(`sample-${size}.svg`);
    });

    it('frame: reads the sample frames from assetsBase when told (the dev gallery)', () => {
      const html = host({ size: '1x1', assetsBase: '/__dev/graphic-sample/assets/' });
      expect(html).toContain('url("/__dev/graphic-sample/assets/sample-1x1.svg")');
      expect(html).not.toContain(SAMPLE_FRAMES_BASE);
    });

    it('checker: a CSS checkerboard, 20 squares across the short side', () => {
      const html = host({ background: 'checker', size: '9x16' });
      expect(html).toContain('repeating-conic-gradient(#3f3f46 0 25%, transparent 0 50%)');
      expect(html).toContain('background-size: 54px 54px;');
      expect(html).not.toContain('.svg');
      expect(host({ background: 'checker', size: '16x9' })).toContain(
        'background-size: 54px 54px;',
      );
    });

    it('black: black', () => {
      const html = host({ background: 'black' });
      expect(html).toContain('#background { position: absolute; inset: 0; background: #000; }');
      expect(html).not.toContain('.svg');
    });

    it('none (the run’s work/index.html): no background div and no rule', () => {
      const html = host({ background: null });
      expect(html).not.toContain('background"');
      expect(html).not.toContain('#background');
      expect(html).not.toContain('sample-');
      expect(html).toContain('id="graphic"');
    });
  });

  it('escapes the id wherever it goes', () => {
    const html = host({ id: 'a"b<c' });
    expect(html).not.toContain('a"b<c');
    expect(html).toContain('lib-a&quot;b&lt;c');
  });
});

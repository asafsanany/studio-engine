/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The Home Screen app is a few plain files (public/ and index.html) that must agree with each
// other: the manifest names icons that exist at their size, and index.html points at them. Checked
// as text and bytes, since no component test sees them.
const read = (path: string) => readFileSync(new URL(path, import.meta.url));
const html = read('./index.html').toString('utf8');
const manifest = JSON.parse(read('./public/manifest.webmanifest').toString('utf8')) as {
  name: string;
  short_name: string;
  start_url: string;
  scope: string;
  display: string;
  background_color: string;
  theme_color: string;
  icons: { src: string; sizes: string; type: string; purpose?: string }[];
};

/** The width and height in a PNG's header (IHDR), or null when it is not a PNG. */
function pngSize(bytes: Buffer): { width: number; height: number } | null {
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!bytes.subarray(0, 8).equals(signature)) return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

function metaContent(name: string): string | undefined {
  return html.match(new RegExp(`<meta\\s+name="${name}"\\s+content="([^"]*)"`))?.[1];
}

describe('manifest.webmanifest', () => {
  it('is the app: standalone, opening on Jobs, dark', () => {
    expect(manifest).toMatchObject({
      name: 'Studio Engine',
      short_name: 'Studio',
      display: 'standalone',
      start_url: '/jobs',
      scope: '/',
      background_color: '#09090B',
      theme_color: '#09090B',
    });
  });

  it('lists a 192, a 512 and a maskable 512 icon, each a PNG of that size', () => {
    expect(manifest.icons.map((icon) => [icon.sizes, icon.purpose ?? 'any'])).toEqual([
      ['192x192', 'any'],
      ['512x512', 'any'],
      ['512x512', 'maskable'],
    ]);
    for (const icon of manifest.icons) {
      expect(icon.type).toBe('image/png');
      const size = pngSize(read(`./public${icon.src}`));
      expect(`${size?.width}x${size?.height}`, icon.src).toBe(icon.sizes);
    }
  });
});

describe('index.html', () => {
  it('links the manifest and the 180 px apple-touch-icon, which exist', () => {
    expect(html).toContain('<link rel="manifest" href="/manifest.webmanifest" />');
    expect(html).toContain('<link rel="apple-touch-icon" href="/apple-touch-icon.png" />');
    expect(pngSize(read('./public/apple-touch-icon.png'))).toEqual({ width: 180, height: 180 });
  });

  it('lets the page reach under the notch and the home indicator', () => {
    expect(metaContent('viewport')).toContain('viewport-fit=cover');
  });

  it('makes the Home Screen app open full screen, dark, under a translucent status bar', () => {
    expect(metaContent('apple-mobile-web-app-capable')).toBe('yes');
    expect(metaContent('mobile-web-app-capable')).toBe('yes');
    expect(metaContent('apple-mobile-web-app-status-bar-style')).toBe('black-translucent');
    expect(metaContent('apple-mobile-web-app-title')).toBe('Studio Engine');
    expect(metaContent('theme-color')).toBe('#09090B');
    expect(metaContent('color-scheme')).toBe('dark');
  });

  it('paints the page dark before the stylesheet arrives', () => {
    expect(html).toMatch(/<style>\s*html\s*\{[^}]*background-color:\s*#09090b;[^}]*\}\s*<\/style>/);
    expect(html).toContain('<html lang="en" class="dark">');
  });
});

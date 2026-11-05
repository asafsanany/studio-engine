import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { StyleDocument } from './StyleDocument';

const render = (markdown: string) => renderToStaticMarkup(<StyleDocument markdown={markdown} />);

/** The opening tag of the first `<tag>` in the markup. */
const opening = (markup: string, tag: string) =>
  markup.match(new RegExp(`<${tag}\\b[^>]*>`))?.[0] ?? '';

const KOVA = `# Style: Kova Coffee
Learned from השקת תפריט חדש (20 Oct 2026), plus your files: logo.png, notes.txt.
## Look
- Colours: orange #EA580C (accent), cream #FFF7ED (text)
- Fonts: Rubik 700 for titles
## Don’t
- Show prices
`;

describe('<StyleDocument>', () => {
  it('draws the title, the line under it, the sections and their bullet lines', () => {
    const markup = render(KOVA);
    expect(markup).toMatch(/<h1[^>]*>Style: Kova Coffee<\/h1>/);
    expect(markup).toMatch(/<p[^>]*>Learned from השקת תפריט חדש/);
    expect(markup).toMatch(/<h2[^>]*>Look<\/h2>/);
    expect(markup).toMatch(/<h2[^>]*>Don’t<\/h2>/);
    expect(markup.match(/<li\b/g)).toHaveLength(3);
    expect(markup.indexOf('<h1')).toBeLessThan(markup.indexOf('<h2'));
  });

  it('draws the title as the board does: 24 px, semibold, tight', () => {
    const h1 = opening(render('# Style: X'), 'h1');
    for (const token of ['text-2xl', 'font-semibold', 'leading-tight', 'tracking-[-0.02em]']) {
      expect(h1).toContain(token);
    }
  });

  it('draws a section heading at 16 px with space above it', () => {
    const h2 = opening(render('## Look'), 'h2');
    for (const token of ['pt-4', 'text-base', 'font-semibold']) expect(h2).toContain(token);
  });

  it('lets every block of text pick its reading direction and sit flush left', () => {
    const markup = render('# כותרת\n\nשורה בעברית\n\n- פריט');
    for (const tag of ['h1', 'p', 'li']) {
      const opened = opening(markup, tag);
      expect(opened).toContain('dir="auto"');
      expect(opened).toContain('[unicode-bidi:plaintext]');
      expect(opened).toContain('text-left');
    }
  });

  it('draws the bullets itself, at the left, so a Hebrew line keeps its bullet there', () => {
    const markup = render('- one\n- two');
    expect(markup).toMatch(/<ul[^>]*class="[^"]*list-none/);
    expect(markup).toMatch(/<li[^>]*class="[^"]*before:absolute[^"]*before:-left-4\.5/);
  });

  it('shows HTML as text: nothing in a style.md becomes an element of the page', () => {
    const markup = render(
      'A <b>bold</b> word.\n\n<script>alert(1)</script>\n\n<img src=x onerror=alert(1)>',
    );
    expect(markup).not.toContain('<b>');
    expect(markup).not.toContain('<script');
    expect(markup).not.toContain('<img');
    expect(markup).toContain('&lt;b&gt;bold&lt;/b&gt;');
  });

  it('opens a link in a new tab, without handing over the page', () => {
    const markup = render('See [the brand site](https://example.com/brand).');
    expect(markup).toMatch(
      /<a href="https:\/\/example\.com\/brand" target="_blank" rel="noreferrer noopener"[^>]*>the brand site<\/a>/,
    );
  });

  it('does not follow a javascript: link', () => {
    expect(render('[click](javascript:alert(1))')).not.toContain('javascript:');
  });

  it('draws no pictures: an image names a file in the style folder, not an address', () => {
    const markup = render('![the logo](logo.png)\n\n![](https://example.com/x.png)');
    expect(markup).not.toContain('<img');
    expect(markup).not.toContain('logo.png');
  });

  it('draws bold, code and quotes, so a hand-written file still reads', () => {
    const markup = render('**Bold** and `code`\n\n> quoted\n\n1. first\n2. second\n\n---');
    expect(markup).toMatch(/<strong[^>]*>Bold<\/strong>/);
    expect(markup).toMatch(/<code[^>]*>code<\/code>/);
    expect(markup).toMatch(/<blockquote[^>]*>/);
    expect(markup).toMatch(/<ol[^>]*>/);
    expect(markup).toContain('<hr');
  });

  it('is a column of its blocks, with the gap of the board', () => {
    expect(render('# A\n\nB')).toMatch(/^<div class="flex flex-col gap-3"/);
  });

  it('draws nothing for an empty file', () => {
    expect(render('')).toBe('<div class="flex flex-col gap-3" data-slot="style-document"></div>');
  });
});

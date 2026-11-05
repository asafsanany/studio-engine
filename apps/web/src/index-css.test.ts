/// <reference types="node" />
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

// The stylesheet carries a few rules the app's look depends on and that no component test can
// see: they are checked as text.
const css = readFileSync(new URL('./index.css', import.meta.url), 'utf8');

describe('index.css', () => {
  it('gives everything clickable the pointer cursor, which Tailwind v4 no longer does', () => {
    const rule = css.match(/button:not\(:disabled\)[^{]*\{[^}]*\}/)?.[0] ?? '';
    for (const selector of ['[role="tab"]', '[role="button"]', 'a[href]', '[role="menuitem"]']) {
      expect(rule).toContain(selector);
    }
    expect(rule).toContain('cursor: pointer');
    // A disabled control must not match.
    expect(rule).toContain(':not(:disabled)');
    expect(rule).toContain(`:not([aria-disabled="true"])`);
  });

  it("draws focus rings in a neutral grey, not blue (the owner's review)", () => {
    expect(css).toMatch(/--ring:\s*#71717a;/);
    expect(css).toMatch(/--sidebar-ring:\s*#71717a;/);
  });

  it('has the violet Review colour as a token and a utility colour', () => {
    expect(css).toMatch(/--status-review:\s*#a78bfa;/);
    expect(css).toMatch(/--color-status-review:\s*var\(--status-review\);/);
  });

  it('has the safe-area variables and padding utilities the phone layout uses', () => {
    for (const side of ['top', 'right', 'bottom', 'left']) {
      expect(css).toContain(`--safe-${side}: env(safe-area-inset-${side}, 0px);`);
    }
    for (const [utility, property, side] of [
      ['pt-safe', 'padding-top', 'top'],
      ['pr-safe', 'padding-right', 'right'],
      ['pb-safe', 'padding-bottom', 'bottom'],
      ['pl-safe', 'padding-left', 'left'],
    ]) {
      expect(css).toMatch(
        new RegExp(`@utility ${utility} \\{\\s*${property}: var\\(--safe-${side}\\);\\s*\\}`),
      );
    }
  });

  it('leaves font smoothing at the browser default, like the canvas boards', () => {
    expect(css).not.toMatch(/@apply[^;]*\bantialiased\b/);
  });
});

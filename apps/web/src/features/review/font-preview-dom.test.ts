import type { FontFaceInfo } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fontPickerCatalog } from '@/features/library-picker/font-picker';
import { FONT_LIST } from '@/features/library-picker/test-helpers';
import { type FontPreviewFont, type FontPreviewPlan, fontPreviewPlan } from './font-preview';
import {
  CAPTION_SELECTOR,
  currentStack,
  FontPreviewApplier,
  fontFaceCss,
  fontRuleCss,
  previewFamily,
  splitFamilies,
  TITLE_SELECTOR,
} from './font-preview-dom';

// The restyling of the player's page, on a hand-made document (the repo has no DOM environment):
// the order of the two styles, where the text is, the stack it was set in, Compare, and the ways it
// can fail. That it looks right in a real player is e2e/fonts-preview.spec.ts.

// --- a document with just what the module uses ---------------------------------------------------

interface FakeText {
  nodeType: 3;
  textContent: string;
}

/** `[attr]`, `[attr="value"]` and `:not([attr])` joined, and comma lists of those. */
function matches(element: FakeElement, selector: string): boolean {
  return selector.split(/\s*,\s*/).some((part) => {
    if (part === '*') return true;
    const checks = [...part.matchAll(/(:not\()?\[([\w-]+)(?:="((?:[^"\\]|\\.)*)")?\]\)?/g)];
    if (checks.length === 0) return false;
    return checks.every(([, not, name, value]) => {
      const actual = element.getAttribute(name as string);
      const hit = value === undefined ? actual !== null : actual === value.replace(/\\(.)/g, '$1');
      return not ? !hit : hit;
    });
  });
}

class FakeElement {
  readonly nodeType = 1;
  childNodes: (FakeElement | FakeText)[] = [];
  parent: FakeElement | null = null;
  textContent: string | null = '';
  private readonly attrs = new Map<string, string>();

  constructor(
    readonly tagName: string,
    attrs: Record<string, string> = {},
    /** What `getComputedStyle` answers for it. */
    public fontFamily = '',
  ) {
    for (const [name, value] of Object.entries(attrs)) this.attrs.set(name, value);
  }

  get id(): string {
    return this.attrs.get('id') ?? '';
  }

  set id(value: string) {
    this.attrs.set('id', value);
  }

  get children(): FakeElement[] {
    return this.childNodes.filter((node): node is FakeElement => node.nodeType === 1);
  }

  getAttribute(name: string): string | null {
    return this.attrs.get(name) ?? null;
  }

  appendChild<T extends FakeElement | FakeText>(child: T): T {
    if (child.nodeType === 1) (child as FakeElement).parent = this;
    this.childNodes.push(child);
    return child;
  }

  remove(): void {
    if (this.parent) this.parent.childNodes = this.parent.childNodes.filter((n) => n !== this);
    this.parent = null;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap((child) => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    return this.descendants().filter((element) => matches(element, selector));
  }

  querySelector(selector: string): FakeElement | null {
    return this.querySelectorAll(selector)[0] ?? null;
  }
}

/** An element with its text. */
function el(
  tag: string,
  attrs: Record<string, string> = {},
  text: string | null = null,
  fontFamily = '',
  ...kids: FakeElement[]
): FakeElement {
  const element = new FakeElement(tag, attrs, fontFamily);
  if (text !== null) element.appendChild({ nodeType: 3, textContent: text });
  for (const kid of kids) element.appendChild(kid);
  return element;
}

const FONT_STACK = '"Noto Sans Hebrew", Heebo, sans-serif';

interface FakeDoc {
  doc: Document;
  head: FakeElement;
  root: FakeElement;
  load: ReturnType<typeof vi.fn>;
  style(id: string): FakeElement | null;
}

function fakeDoc(
  children: FakeElement[],
  load: (font: string) => Promise<unknown[]> = async () => [{}],
): FakeDoc {
  const head = el('head');
  const root = el('div', { id: 'root', 'data-composition-id': 'main' }, null, '', ...children);
  const html = el('html', {}, null, '', head, el('body', {}, null, '', root));
  const loadFn = vi.fn(load);
  const doc = {
    head,
    documentElement: html,
    defaultView: {
      getComputedStyle: (element: FakeElement) => ({ fontFamily: element.fontFamily }),
    },
    fonts: { load: loadFn },
    createElement: (tag: string) => new FakeElement(tag.toUpperCase()),
    getElementById: (id: string) => html.descendants().find((e) => e.id === id) ?? null,
    querySelectorAll: (selector: string) => html.querySelectorAll(selector),
    querySelector: (selector: string) => html.querySelector(selector),
  };
  return {
    doc: doc as unknown as Document,
    head,
    root,
    load: loadFn,
    style: (id) => doc.getElementById(id),
  };
}

const FACES = '__studio-font-preview-faces';
const RULES = '__studio-font-preview-rules';

/** The captions host of a captioned composition: a line of text in the video's own stack. */
const captionsHost = (text = 'ככה הכול התחיל') =>
  el(
    'div',
    { id: 'captions-host', 'data-composition-id': 'captions', 'data-track-kind': 'captions' },
    null,
    '',
    el('div', { class: 'cap' }, null, FONT_STACK, el('span', {}, text, FONT_STACK)),
  );

const catalog = fontPickerCatalog(FONT_LIST);
const plan = (text: string): FontPreviewPlan => {
  const found = fontPreviewPlan(text, catalog);
  if (found === null) throw new Error(`no plan for ${text}`);
  return found;
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

// --- the pieces ----------------------------------------------------------------------------------

describe('splitFamilies', () => {
  it('splits a computed font-family at its commas, keeping quoted names whole', () => {
    expect(splitFamilies('"Noto Sans Hebrew", Heebo, sans-serif')).toEqual([
      '"Noto Sans Hebrew"',
      'Heebo',
      'sans-serif',
    ]);
    expect(splitFamilies('"A, B", C')).toEqual(['"A, B"', 'C']);
    expect(splitFamilies('')).toEqual([]);
  });
});

describe('currentStack', () => {
  const win = (doc: FakeDoc) => doc.doc.defaultView as Window;

  it('is the families of the text, each once, then one generic', () => {
    const host = el(
      'div',
      {},
      null,
      '',
      el('p', {}, 'a', 'Akrobat, HeeboCap, serif'),
      el('p', {}, 'b', 'Heebo, Akrobat'),
    );
    const doc = fakeDoc([host]);
    expect(currentStack([host as unknown as Element], win(doc))).toBe(
      'Akrobat, HeeboCap, Heebo, serif',
    );
  });

  it('ends in sans-serif when the text names no generic family', () => {
    const host = el('div', {}, 'x', 'Heebo');
    const doc = fakeDoc([host]);
    expect(currentStack([host as unknown as Element], win(doc))).toBe('Heebo, sans-serif');
  });

  it('is null while the host holds no text (the runtime has not mounted it yet), and skips style and script', () => {
    const host = el(
      'div',
      {},
      null,
      '',
      el('style', {}, '.a{}', 'Courier'),
      el('script', {}, 'x', 'Courier'),
    );
    const doc = fakeDoc([host]);
    expect(currentStack([host as unknown as Element], win(doc))).toBeNull();
  });
});

describe('the CSS', () => {
  const font = plan('captions in @Heebo Bold').captions;
  if (font === null) throw new Error('no font');

  it('gives each font on each scope a family name of its own', () => {
    const captions = previewFamily('captions', font);
    expect(captions).toMatch(/^__studio_font_captions_[A-Za-z0-9_-]+$/);
    expect(previewFamily('titles', font)).not.toBe(captions);
    const other = plan('captions in @Heebo Medium').captions;
    expect(other && previewFamily('captions', other)).not.toBe(captions);
  });

  it('declares the file with its real weight and slant', () => {
    expect(fontFaceCss('captions', font)).toBe(
      `@font-face{font-family:"${previewFamily('captions', font)}";src:url("/api/fonts/file/heebo-700?v=1761350400000") format("truetype");font-weight:700;font-style:normal;font-display:block}`,
    );
  });

  it('sets the family before the current stack and the style, both !important, on the host and what is in it', () => {
    const css = fontRuleCss('titles', font, { selector: TITLE_SELECTOR, stack: FONT_STACK });
    expect(css).toBe(
      `:is(${TITLE_SELECTOR}),:is(${TITLE_SELECTOR}) *{font-family:"${previewFamily('titles', font)}",${FONT_STACK} !important;font-style:normal !important}`,
    );
    // Never the font shorthand: it would reset the size.
    expect(css).not.toMatch(/(^|[;{])font:/);
  });

  // C51: a `font-weight` on the text reaches every glyph in it, the video's own Hebrew words that
  // fall back to the next family of the stack included, so the rule leaves the weight alone and the
  // @font-face holds the chosen weight (one value, even for a file that several weights share).
  it('does not set the weight of the text: the words the font cannot draw keep theirs', () => {
    const css = fontRuleCss('captions', font, { selector: CAPTION_SELECTOR, stack: FONT_STACK });
    expect(css).not.toContain('font-weight');
    expect(fontFaceCss('captions', font)).toContain(';font-weight:700;');
  });

  it('declares one weight even for a face of a variable file that several weights share', () => {
    const faces: FontFaceInfo[] = FONT_LIST.catalog
      .filter((face) => face.family === 'Rubik' && (face.weight === 400 || face.weight === 700))
      .map((face) => ({ ...face, fileId: 'rubik-variable' }));
    const list = {
      ...FONT_LIST,
      catalog: [...FONT_LIST.catalog.filter((f) => f.family !== 'Rubik'), ...faces],
    };
    const bold = fontPreviewPlan('captions in @Rubik Bold', fontPickerCatalog(list))?.captions;
    const regular = fontPreviewPlan('captions in @Rubik', fontPickerCatalog(list))?.captions;
    if (!bold || !regular) throw new Error('no font');
    // Each weight is a family of its own, held at its own weight: the axis follows the descriptor.
    expect(fontFaceCss('captions', bold)).toContain(';font-weight:700;');
    expect(fontFaceCss('captions', regular)).toContain(';font-weight:400;');
    expect(previewFamily('captions', bold)).not.toBe(previewFamily('captions', regular));
  });

  it('keeps a face lighter than bold from being faux-bolded under bold text, and only that face', () => {
    const regular = plan('captions in @Heebo').captions;
    const medium = plan('captions in @Heebo Medium').captions;
    const semiBold = plan('captions in @Heebo SemiBold').captions;
    if (!regular || !medium || !semiBold) throw new Error('no font');
    const rule = (face: FontPreviewFont) =>
      fontRuleCss('captions', face, { selector: CAPTION_SELECTOR, stack: FONT_STACK });
    expect(rule(regular)).toContain(';font-synthesis-weight:none !important}');
    expect(rule(medium)).toContain(';font-synthesis-weight:none !important}');
    expect(rule(semiBold)).not.toContain('font-synthesis');
    expect(rule(font)).not.toContain('font-synthesis');
  });
});

// --- the applier ---------------------------------------------------------------------------------

describe('FontPreviewApplier', () => {
  it('declares the file first, and adds the rule only when the file has loaded', async () => {
    let finish: (value: unknown[]) => void = () => {};
    const page = fakeDoc([captionsHost()], () => new Promise((resolve) => (finish = resolve)));
    const applier = new FontPreviewApplier(page.doc);
    const shown = applier.show(plan('captions in @Heebo Bold'));
    await vi.advanceTimersByTimeAsync(0);
    expect(page.style(FACES)?.textContent).toContain('@font-face');
    expect(page.style(RULES)).toBeNull();
    finish([{}]);
    const status = await shown;
    expect(status?.shown).toEqual([expect.objectContaining({ label: '@Heebo Bold' })]);
    expect(page.style(RULES)?.textContent).toContain(`:is(${CAPTION_SELECTOR})`);
    expect(page.style(RULES)?.textContent).toContain(FONT_STACK);
    expect(page.style(RULES)?.textContent).not.toContain('font-weight');
    expect(page.style(FACES)?.textContent).toContain(';font-weight:700;');
    // It asked the page's fonts for the face it declared, in its real weight.
    expect(page.load).toHaveBeenCalledWith(
      expect.stringMatching(/^700 40px "__studio_font_captions_/),
    );
  });

  it('puts the styles in the head and nowhere else', async () => {
    const page = fakeDoc([captionsHost()]);
    await new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    expect(page.head.children.map((child) => child.id)).toEqual([FACES, RULES]);
    expect(page.root.descendants().some((child) => child.tagName === 'STYLE')).toBe(false);
  });

  it('shows the font on the captions only when only the captions are asked for', async () => {
    const page = fakeDoc([captionsHost()]);
    const status = await new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    expect(page.style(RULES)?.textContent).not.toContain(TITLE_SELECTOR);
    expect(status?.shown).toHaveLength(1);
  });

  it('sets the italic slant for an italic face', async () => {
    const italics = {
      ...FONT_LIST,
      catalog: FONT_LIST.catalog.map((face) =>
        face.family === 'Heebo' && face.weight === 400
          ? { ...face, name: 'Heebo Italic', italic: true }
          : face,
      ),
    };
    const found = fontPreviewPlan('captions in @Heebo Italic', fontPickerCatalog(italics));
    if (found === null) throw new Error('no plan');
    const page = fakeDoc([captionsHost()]);
    await new FontPreviewApplier(page.doc).show(found);
    expect(page.style(FACES)?.textContent).toContain('font-style:italic');
    expect(page.style(RULES)?.textContent).toContain('font-style:italic !important');
    expect(page.load).toHaveBeenCalledWith(expect.stringMatching(/^italic 400 40px/));
  });

  it('shows two fonts, one on each scope, and says both', async () => {
    const titles = el(
      'div',
      { id: 'titles', 'data-timeline-role': 'title' },
      null,
      '',
      el('p', {}, 'הבית ליד הים', FONT_STACK),
    );
    const page = fakeDoc([captionsHost(), titles]);
    const status = await new FontPreviewApplier(page.doc).show(
      plan('Titles in @Rubik Black and captions in @Heebo Medium'),
    );
    const rules = page.style(RULES)?.textContent ?? '';
    expect(rules).toContain(`:is(${CAPTION_SELECTOR})`);
    expect(rules).toContain(`:is(${TITLE_SELECTOR})`);
    expect(rules).not.toContain('font-weight');
    const faces = page.style(FACES)?.textContent ?? '';
    expect(faces).toContain(';font-weight:500;');
    expect(faces).toContain(';font-weight:900;');
    expect(status?.shown.map((font) => font.label).sort()).toEqual([
      '@Heebo Medium',
      '@Rubik Black',
    ]);
  });

  it('shows one font on both scopes as one font', async () => {
    const titles = el('div', { 'data-timeline-role': 'title' }, 'כותרת', FONT_STACK);
    const page = fakeDoc([captionsHost(), titles]);
    const status = await new FontPreviewApplier(page.doc).show(
      plan('Use @Heebo Bold for the text'),
    );
    expect(status?.shown).toHaveLength(1);
    expect(page.style(FACES)?.textContent?.match(/@font-face/g)).toHaveLength(2);
  });

  describe('where the titles are', () => {
    it('finds them by the mark the edit prompt asks for, whatever they are called', async () => {
      const page = fakeDoc([
        el('div', { id: 'xyz', 'data-timeline-role': 'title' }, 'כותרת', FONT_STACK),
      ]);
      const status = await new FontPreviewApplier(page.doc).show(plan('titles in @Rubik Black'));
      expect(page.style(RULES)?.textContent).toContain(`:is(${TITLE_SELECTOR})`);
      expect(status?.shown).toHaveLength(1);
    });

    it('guesses them by name on an old job: the host of a sub-composition, and a root-level #title', async () => {
      const page = fakeDoc([
        el('div', { id: 'title-1', 'data-composition-id': 'lib-abc__hf1' }, 'one', FONT_STACK),
        el('div', { id: 'host', 'data-composition-id': 'lower-third' }, 'two', FONT_STACK),
        el('div', { id: 'title' }, 'three', FONT_STACK),
        el('div', { id: 'search', 'data-composition-id': 'search' }, 'four', FONT_STACK),
      ]);
      await new FontPreviewApplier(page.doc).show(plan('titles in @Rubik Black'));
      const rules = page.style(RULES)?.textContent ?? '';
      expect(rules).toContain('[id="title-1"]');
      expect(rules).toContain('[data-composition-id="lower-third"]');
      expect(rules).toContain('[id="title"]');
      expect(rules).not.toContain('search');
    });

    it('reads the original name of a composition the runtime renamed', async () => {
      const page = fakeDoc([
        el(
          'div',
          {
            id: 'h1',
            'data-composition-id': 'x__hf1',
            'data-hf-original-composition-id': 'titles',
          },
          'one',
          FONT_STACK,
        ),
      ]);
      await new FontPreviewApplier(page.doc).show(plan('titles in @Rubik Black'));
      expect(page.style(RULES)?.textContent).toContain(
        '[data-hf-original-composition-id="titles"]',
      );
    });

    it('prefers the marks to the guess when a job has both', async () => {
      const page = fakeDoc([
        el('div', { id: 'title-1', 'data-composition-id': 'title-1' }, 'one', FONT_STACK),
        el('div', { id: 'end', 'data-timeline-role': 'title' }, 'two', FONT_STACK),
      ]);
      await new FontPreviewApplier(page.doc).show(plan('titles in @Rubik Black'));
      const rules = page.style(RULES)?.textContent ?? '';
      expect(rules).toContain(TITLE_SELECTOR);
      expect(rules).not.toContain('title-1');
    });

    it('shows nothing for the titles of a job that has none to find, once the wait is over', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      const shown = applier.show(plan('titles in @Rubik Black'));
      await vi.advanceTimersByTimeAsync(3200);
      const status = await shown;
      expect(status?.shown).toEqual([]);
      expect(page.style(RULES)).toBeNull();
    });

    it('does not count a composition called "main" or the root as a title', async () => {
      const page = fakeDoc([el('div', { id: 'something' }, 'x', FONT_STACK)]);
      const shown = new FontPreviewApplier(page.doc).show(plan('titles in @Rubik Black'));
      await vi.advanceTimersByTimeAsync(3200);
      expect((await shown)?.shown).toEqual([]);
    });
  });

  it('waits for the sub-compositions the runtime mounts after ready', async () => {
    const host = el('div', { 'data-track-kind': 'captions', 'data-composition-id': 'captions' });
    const page = fakeDoc([host]);
    const shown = new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    await vi.advanceTimersByTimeAsync(500);
    expect(page.style(RULES)).toBeNull();
    host.appendChild(el('p', {}, 'ככה הכול התחיל', FONT_STACK));
    await vi.advanceTimersByTimeAsync(200);
    const status = await shown;
    expect(status?.shown).toHaveLength(1);
    expect(page.style(RULES)?.textContent).toContain(FONT_STACK);
  });

  it('shows nothing, and no error, for captions that are not there (an old job with none)', async () => {
    const page = fakeDoc([el('div', { id: 'title' }, 'x', FONT_STACK)]);
    const shown = new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    await vi.advanceTimersByTimeAsync(3200);
    expect((await shown)?.shown).toEqual([]);
    expect(page.style(RULES)).toBeNull();
  });

  it('leaves out a font whose file cannot be had, and still shows the other', async () => {
    const titles = el('div', { 'data-timeline-role': 'title' }, 'כותרת', FONT_STACK);
    const page = fakeDoc([captionsHost(), titles], async (font) => {
      if (font.includes('__studio_font_titles_')) throw new Error('404');
      return [{}];
    });
    const status = await new FontPreviewApplier(page.doc).show(
      plan('Titles in @Rubik Black and captions in @Heebo Medium'),
    );
    expect(status?.shown.map((font) => font.label)).toEqual(['@Heebo Medium']);
    expect(page.style(RULES)?.textContent).toContain(`:is(${CAPTION_SELECTOR})`);
    expect(page.style(RULES)?.textContent).not.toContain(TITLE_SELECTOR);
  });

  it('counts a face the page did not recognise (nothing loaded) as a failure too', async () => {
    const page = fakeDoc([captionsHost()], async () => []);
    const status = await new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    expect(status?.shown).toEqual([]);
    expect(page.style(RULES)).toBeNull();
  });

  it('works on a page that has no font loading API, by trusting the declaration', async () => {
    const page = fakeDoc([captionsHost()]);
    (page.doc as unknown as { fonts?: unknown }).fonts = undefined;
    const status = await new FontPreviewApplier(page.doc).show(plan('captions in @Heebo Bold'));
    expect(status?.shown).toHaveLength(1);
  });

  describe('Compare', () => {
    it('takes the rules out while it is held and puts them back, leaving the files declared', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      const rules = page.style(RULES)?.textContent;
      applier.setCompare(true);
      expect(page.style(RULES)).toBeNull();
      expect(page.style(FACES)?.textContent).toContain('@font-face');
      applier.setCompare(false);
      expect(page.style(RULES)?.textContent).toBe(rules);
    });

    it('is held through a new plan: the rules do not come back until it is let go', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      applier.setCompare(true);
      const status = await applier.show(plan('captions in @Heebo Medium'));
      expect(status?.shown).toEqual([expect.objectContaining({ label: '@Heebo Medium' })]);
      expect(page.style(RULES)).toBeNull();
      applier.setCompare(false);
      expect(page.style(RULES)?.textContent).toContain('heebo-500');
    });

    it('can be held before anything is shown', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      applier.setCompare(true);
      await applier.show(plan('captions in @Heebo Bold'));
      expect(page.style(RULES)).toBeNull();
      expect(page.style(FACES)).not.toBeNull();
    });
  });

  describe('changing and removing', () => {
    it('takes both styles out for no plan: the chip’s ×', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      const status = await applier.show(null);
      expect(status).toEqual({ shown: [] });
      expect(page.style(RULES)).toBeNull();
      expect(page.style(FACES)).toBeNull();
      expect(page.head.children).toEqual([]);
    });

    it('swaps one font for another without leaving the text on the fallback', async () => {
      let finish: (value: unknown[]) => void = () => {};
      let slow = false;
      const page = fakeDoc([captionsHost()], () =>
        slow ? new Promise((resolve) => (finish = resolve)) : Promise.resolve([{}]),
      );
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      const first = page.style(RULES)?.textContent ?? '';
      slow = true;
      const next = applier.show(plan('captions in @Rubik Black'));
      await vi.advanceTimersByTimeAsync(0);
      // The new file is declared, the rule still uses the old one, and the old file is still there.
      expect(page.style(RULES)?.textContent).toBe(first);
      expect(page.style(FACES)?.textContent?.match(/@font-face/g)).toHaveLength(2);
      finish([{}]);
      await next;
      expect(page.style(RULES)?.textContent).not.toBe(first);
      expect(page.style(RULES)?.textContent).toContain('rubik-900');
      expect(page.style(FACES)?.textContent?.match(/@font-face/g)).toHaveLength(1);
    });

    it('reads the stack the text was set in once: after a rule is in it keeps following the original', async () => {
      const host = captionsHost();
      const page = fakeDoc([host]);
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      // Now the page reports the chosen family first, as a real page would.
      for (const element of host.descendants()) {
        element.fontFamily = '"__studio_font_captions_x", "Noto Sans Hebrew", Heebo, sans-serif';
      }
      await applier.show(plan('captions in @Rubik Black'));
      const rules = page.style(RULES)?.textContent ?? '';
      expect(rules).toContain(FONT_STACK);
      expect(rules).not.toContain('"__studio_font_captions_x"');
    });

    it('answers null to a show that a newer one has taken over from', async () => {
      let finish: (value: unknown[]) => void = () => {};
      let slow = true;
      const page = fakeDoc([captionsHost()], () =>
        slow ? new Promise((resolve) => (finish = resolve)) : Promise.resolve([{}]),
      );
      const applier = new FontPreviewApplier(page.doc);
      const older = applier.show(plan('captions in @Heebo Bold'));
      await vi.advanceTimersByTimeAsync(0);
      slow = false;
      const newer = applier.show(plan('captions in @Rubik Black'));
      finish([{}]);
      expect(await older).toBeNull();
      expect((await newer)?.shown).toEqual([expect.objectContaining({ label: '@Rubik Black' })]);
      expect(page.style(RULES)?.textContent).toContain('rubik-900');
    });

    it('stops looking for text when a newer show has taken over', async () => {
      const page = fakeDoc([el('div', { id: 'title' }, 'x', FONT_STACK)]);
      const applier = new FontPreviewApplier(page.doc);
      const older = applier.show(plan('captions in @Heebo Bold'));
      await vi.advanceTimersByTimeAsync(300);
      await applier.show(null);
      await vi.advanceTimersByTimeAsync(300);
      expect(await older).toBeNull();
    });

    it('dispose takes everything out and stops a show on its way', async () => {
      const page = fakeDoc([captionsHost()]);
      const applier = new FontPreviewApplier(page.doc);
      await applier.show(plan('captions in @Heebo Bold'));
      const next = applier.show(plan('captions in @Rubik Black'));
      applier.dispose();
      expect(await next).toBeNull();
      expect(page.head.children).toEqual([]);
    });
  });
});

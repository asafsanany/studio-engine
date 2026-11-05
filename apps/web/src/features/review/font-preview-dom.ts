// Shows a font note in the player's page (Fonts plan, "The live preview"; FN18's findings). The
// composition plays in an iframe of our own origin, so its document can be reached; this adds two
// <style> tags to that document in memory and takes them out again. A job's files are never written.
//
//   <style id="__studio-font-preview-faces">   one @font-face per font: the engine's file, its real
//                                              weight (one value: a variable file's axis is held
//                                              there) and slant, a family name of its own
//   <style id="__studio-font-preview-rules">   :is(<the captions>), :is(<the captions>) * {
//                                                font-family: "<chosen>", <the current stack> !important;
//                                                font-style: normal|italic !important }
//
// - Where the text is: the captions are found by the markers HyperFrames and our edits put on their
//   host (`data-track-kind="captions"` and the others below); the titles by `data-timeline-role=
//   "title"`, which the edit prompt (preview-finish.md) asks for. A job made before that has no such
//   mark: its titles are guessed from the names of the hosts (`title-1`, `lower-third`, ...). Where
//   nothing is found a scope shows nothing, and the note works as ever.
// - "Chosen, then current": the family stack of the text as it is now (read once, before the first
//   rule) follows the chosen font, so a Hebrew word in a font without Hebrew stays in the video's own.
// - The weight is not set on the text (C51). A `font-weight` on an element reaches every glyph in
//   it, the video's own Hebrew words included, which would draw them heavier than the edit will.
//   The chosen font's weight is held by its `@font-face` instead: the descriptor is the face's own
//   weight, so whatever weight the text asks for, the family has that one face (a variable file's
//   axis is clamped to it) and the letters it draws come out in the file's weight, while the words
//   it cannot draw fall to the next family of the stack at the weight the text had. A face lighter
//   than 600 also says `font-synthesis-weight: none`, so a bold text is not faux-bolded over it.
// - The runtime scopes the composition's own rules three selectors deep, so the rule says
//   `!important`; it sets font-family and style (and the synthesis) only, never the `font`
//   shorthand (which would reset the size). A plain rule keeps working while the video plays or is
//   moved: the composition's elements are not rebuilt.
// - No flash: the @font-face is declared and loaded (`fonts.load`) before the rule that uses it is
//   added, and every font has a family name of its own, so swapping one for another never leaves
//   the text on the fallback while the new file comes.
// - The sub-compositions are mounted by the runtime a moment after the player says `ready`: the
//   hosts are looked for until they are there (about three seconds), the rule itself can go in at once.
// - Compare is the rules taken out and put back (the @font-face stays), at once.

import type {
  FontPreviewFont,
  FontPreviewPlan,
  FontPreviewStatus,
  PreviewScope,
} from './font-preview';

const FACES_ID = '__studio-font-preview-faces';
const RULES_ID = '__studio-font-preview-rules';

/** What marks the captions: HyperFrames' contract and the host every captioned composition has. */
export const CAPTION_SELECTOR = [
  '[data-track-kind="captions"]',
  '[data-timeline-role="captions"]',
  '[data-text-role="caption"]',
  '[data-caption-root]',
].join(', ');

/** What marks a title, lower third, callout or end card: the mark the edit prompt asks for. */
export const TITLE_SELECTOR = '[data-timeline-role="title"]';

/** The names an old job's title hosts go by (`titles`, `title-1`, `lower-third`, `main-headline`). */
export const TITLE_NAME = /(^|[-_])(titles?|headline|heading|lower-?third)([-_]|$)/i;

/** Elements whose text is not text on the picture. */
const NOT_TEXT = new Set(['STYLE', 'SCRIPT', 'TEMPLATE', 'NOSCRIPT', 'TITLE', 'HEAD']);

/** The generic families: one of them ends a stack. */
const GENERIC_FAMILIES = new Set([
  'serif',
  'sans-serif',
  'monospace',
  'cursive',
  'fantasy',
  'system-ui',
  'ui-serif',
  'ui-sans-serif',
  'ui-monospace',
  'ui-rounded',
  'math',
  'emoji',
  'fangsong',
]);

/** How long the hosts are looked for after a font is asked for, and how often. */
export interface FontPreviewTiming {
  waitMs: number;
  pollMs: number;
}

export const FONT_PREVIEW_TIMING: FontPreviewTiming = { waitMs: 3000, pollMs: 100 };

/** Where one scope's text is and what it is set in now. */
interface Target {
  selector: string;
  stack: string;
}

// --- finding the text ---------------------------------------------------------------------------

/** An attribute selector for `name="value"` (the value's quotes and backslashes escaped). */
function attributeSelector(name: string, value: string): string {
  return `[${name}="${value.replace(/["\\]/g, '\\$&')}"]`;
}

function hasOwnText(element: Element): boolean {
  if (NOT_TEXT.has(element.tagName.toUpperCase())) return false;
  for (const node of Array.from(element.childNodes)) {
    if (node.nodeType === 3 && (node.textContent ?? '').trim() !== '') return true;
  }
  return false;
}

/** The elements of the hosts that hold text of their own. */
function textElements(hosts: readonly Element[]): Element[] {
  const found = new Set<Element>();
  for (const host of hosts) {
    if (hasOwnText(host)) found.add(host);
    for (const element of Array.from(host.querySelectorAll('*'))) {
      if (hasOwnText(element)) found.add(element);
    }
  }
  return [...found];
}

/** The families of a computed `font-family`: `"Noto Sans Hebrew", sans-serif` is two. */
export function splitFamilies(value: string): string[] {
  const families: string[] = [];
  let current = '';
  let quote = '';
  for (const char of value) {
    if (quote !== '') {
      current += char;
      if (char === quote) quote = '';
    } else if (char === '"' || char === "'") {
      quote = char;
      current += char;
    } else if (char === ',') {
      if (current.trim() !== '') families.push(current.trim());
      current = '';
    } else {
      current += char;
    }
  }
  if (current.trim() !== '') families.push(current.trim());
  return families;
}

/**
 * The stack the text of `hosts` is set in now, to follow the chosen font: every named family of
 * every text element, once each in the order they come, then one generic. `null` while the hosts
 * hold no text yet (the runtime has not mounted them).
 */
export function currentStack(hosts: readonly Element[], win: Window): string | null {
  const elements = textElements(hosts);
  if (elements.length === 0) return null;
  const names: string[] = [];
  let generic: string | null = null;
  for (const element of elements) {
    for (const family of splitFamilies(win.getComputedStyle(element).fontFamily)) {
      if (GENERIC_FAMILIES.has(family.toLowerCase())) generic ??= family;
      else if (!names.includes(family)) names.push(family);
    }
  }
  return [...names, generic ?? 'sans-serif'].join(', ');
}

function captionTarget(doc: Document): { selector: string; hosts: Element[] } | null {
  const hosts = Array.from(doc.querySelectorAll(CAPTION_SELECTOR));
  return hosts.length === 0 ? null : { selector: CAPTION_SELECTOR, hosts };
}

/**
 * The titles: the elements marked `data-timeline-role="title"`; without any (a job made before the
 * mark) the hosts and root-level elements whose id or composition id says what they are.
 */
function titleTarget(doc: Document): { selector: string; hosts: Element[] } | null {
  const marked = Array.from(doc.querySelectorAll(TITLE_SELECTOR));
  if (marked.length > 0) return { selector: TITLE_SELECTOR, hosts: marked };
  // Old jobs: the hosts of sub-compositions, and what sits straight in the root composition (the
  // fake edit's `#title`). The runtime renames a composition mounted twice (`title__hf1`), so the
  // host's own id and the original name are what a guess can go by.
  const root = doc.querySelector('[data-composition-id]:not([data-composition-src])');
  const candidates = [
    ...Array.from(
      doc.querySelectorAll(
        '[data-composition-src], [data-composition-id], [data-hf-original-composition-id]',
      ),
    ),
    ...Array.from(root?.children ?? []),
  ];
  const hosts: Element[] = [];
  const selectors = new Set<string>();
  for (const element of candidates) {
    if (element === root) continue;
    const named = (['id', 'data-composition-id', 'data-hf-original-composition-id'] as const)
      .map((name) => [name, element.getAttribute(name)] as const)
      .find(([, value]) => value !== null && TITLE_NAME.test(value));
    if (named === undefined || named[1] === null) continue;
    if (!hosts.includes(element)) hosts.push(element);
    selectors.add(attributeSelector(named[0], named[1]));
  }
  return hosts.length === 0 ? null : { selector: [...selectors].join(', '), hosts };
}

// --- the styles ---------------------------------------------------------------------------------

/** The page's family name for a font on one scope: its own, so a swap never reuses a loading one. */
export function previewFamily(scope: PreviewScope, font: Pick<FontPreviewFont, 'key'>): string {
  return `__studio_font_${scope}_${font.key.replace(/[^a-zA-Z0-9_-]/g, '_')}`;
}

/**
 * The `@font-face` of a font on a scope: the file, with the face's own weight as the one weight of
 * the family (the text is not given a weight: see the header).
 */
export function fontFaceCss(scope: PreviewScope, font: FontPreviewFont): string {
  return `@font-face{font-family:"${previewFamily(scope, font)}";src:${font.src};font-weight:${font.weight};font-style:${font.italic ? 'italic' : 'normal'};font-display:block}`;
}

/** The weight under which a face of a lighter weight would be faux-bolded under bold text. */
const BOLD_FROM = 600;

/**
 * The rule that sets a scope's text in a font: the chosen family first, then what it was in. It
 * leaves `font-weight` alone, so the words that fall to the next family keep their weight.
 */
export function fontRuleCss(scope: PreviewScope, font: FontPreviewFont, target: Target): string {
  const { selector, stack } = target;
  const synthesis = font.weight < BOLD_FROM ? ';font-synthesis-weight:none !important' : '';
  return `:is(${selector}),:is(${selector}) *{font-family:"${previewFamily(scope, font)}",${stack} !important;font-style:${font.italic ? 'italic' : 'normal'} !important${synthesis}}`;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** What one scope has ready to show. */
interface Ready {
  scope: PreviewScope;
  font: FontPreviewFont;
  target: Target;
}

/**
 * Shows plans in one document (one per loaded composition: a new round or "Try again" is a new
 * document and gets a new applier). `show` is for a new plan, `setCompare` for the Compare button.
 */
export class FontPreviewApplier {
  private readonly win: Window;
  /** Bumped by every `show`: an older one that is still waiting stops. */
  private run = 0;
  private comparing = false;
  /** The stack each scope was set in before any rule of ours, read once. */
  private readonly stacks: Partial<Record<PreviewScope, string>> = {};
  /** The `@font-face` rules declared, by family name. */
  private readonly faces = new Map<string, string>();
  /** The rules for what is showing; `''` when nothing is. */
  private rules = '';

  constructor(
    private readonly doc: Document,
    private readonly timing: FontPreviewTiming = FONT_PREVIEW_TIMING,
  ) {
    this.win = doc.defaultView as Window;
  }

  /** Compare held (`true`): the rules are out and the original shows; let go: they are back. */
  setCompare(on: boolean): void {
    this.comparing = on;
    this.write();
  }

  /**
   * Shows `plan` (`null`: nothing) and says what is showing. `null` back means a newer `show` has
   * taken over. A font whose file cannot be had, or a scope whose text is not to be found, shows
   * nothing; the rest of the plan does.
   */
  async show(plan: FontPreviewPlan | null): Promise<FontPreviewStatus | null> {
    const run = ++this.run;
    if (plan === null) {
      this.faces.clear();
      this.rules = '';
      this.write();
      return { shown: [] };
    }
    const wanted: [PreviewScope, FontPreviewFont][] = [];
    if (plan.captions !== null) wanted.push(['captions', plan.captions]);
    if (plan.titles !== null) wanted.push(['titles', plan.titles]);

    // Declare the files first (the old ones stay until the new rules are in), then wait for them.
    for (const [scope, font] of wanted)
      this.faces.set(previewFamily(scope, font), fontFaceCss(scope, font));
    this.writeFaces();
    const results = await Promise.all(
      wanted.map(async ([scope, font]): Promise<Ready | null> => {
        const [loaded, target] = await Promise.all([this.load(scope, font), this.find(scope, run)]);
        return loaded && target !== null ? { scope, font, target } : null;
      }),
    );
    if (run !== this.run) return null;

    const ready = results.filter((result): result is Ready => result !== null);
    this.rules = ready
      .map(({ scope, font, target }) => fontRuleCss(scope, font, target))
      .join('\n');
    this.faces.clear();
    for (const { scope, font } of ready)
      this.faces.set(previewFamily(scope, font), fontFaceCss(scope, font));
    this.write();
    const shown = new Map<string, { key: string; label: string }>();
    for (const { font } of ready) shown.set(font.key, { key: font.key, label: font.label });
    return { shown: [...shown.values()] };
  }

  /** Takes both styles out: the player's page is as it was loaded. A `show` on its way stops. */
  dispose(): void {
    this.run += 1;
    this.faces.clear();
    this.rules = '';
    this.comparing = false;
    this.write();
  }

  /** Waits for a font file to be in the page; `false` when it cannot be had. */
  private async load(scope: PreviewScope, font: FontPreviewFont): Promise<boolean> {
    const fonts = (this.doc as Document & { fonts?: FontFaceSet }).fonts;
    if (fonts === undefined) return true;
    try {
      const loaded = await fonts.load(
        `${font.italic ? 'italic ' : ''}${font.weight} 40px "${previewFamily(scope, font)}"`,
      );
      return loaded.length > 0;
    } catch {
      return false;
    }
  }

  /**
   * Where a scope's text is and what it is set in, looked for until it is there. `null` when the
   * time is up, or a newer `show` has taken over.
   */
  private async find(scope: PreviewScope, run: number): Promise<Target | null> {
    const deadline = Date.now() + this.timing.waitMs;
    for (;;) {
      if (run !== this.run) return null;
      const found = scope === 'captions' ? captionTarget(this.doc) : titleTarget(this.doc);
      if (found !== null) {
        // Read once, before the first rule of ours: after it the text is in the chosen font.
        const stack = this.stacks[scope] ?? currentStack(found.hosts, this.win);
        if (stack !== null) {
          this.stacks[scope] = stack;
          return { selector: found.selector, stack };
        }
      }
      if (Date.now() >= deadline) return null;
      await sleep(this.timing.pollMs);
    }
  }

  private styleElement(id: string): HTMLStyleElement {
    const existing = this.doc.getElementById(id);
    if (existing !== null) return existing as HTMLStyleElement;
    const style = this.doc.createElement('style');
    style.id = id;
    (this.doc.head ?? this.doc.documentElement).appendChild(style);
    return style;
  }

  private removeStyle(id: string): void {
    this.doc.getElementById(id)?.remove();
  }

  private writeFaces(): void {
    if (this.faces.size === 0) this.removeStyle(FACES_ID);
    else this.styleElement(FACES_ID).textContent = [...this.faces.values()].join('\n');
  }

  /** The two styles as the state says: the faces always, the rules unless Compare is held. */
  private write(): void {
    this.writeFaces();
    if (this.rules === '' || this.comparing) this.removeStyle(RULES_ID);
    else this.styleElement(RULES_ID).textContent = this.rules;
  }
}

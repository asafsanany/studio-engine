import type { FontFamilyDetail } from '@studio/shared';
import { QueryClientProvider } from '@tanstack/react-query';
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from '@tanstack/react-router';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { fontKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { validateFontsSearch } from '../font-address';
import { FontFrameView } from './FontFrameView';
import { FontPane, OpenFontPane, type OpenFontPaneProps } from './FontPane';
import { FontPaneEmpty, FontPaneView, type FontPaneViewProps } from './FontPaneView';
import { FontTextView, type FontTextViewProps } from './FontTextView';
import { FONT_PANE_TEXT, paneFonts } from './font-pane-model';
import { heeboDetail, poppinsDetail, secularOneDetail } from './test-fixtures';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

// --- helpers ------------------------------------------------------------------------------------

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

type Props = Record<string, unknown>;
type Match = (type: unknown, props: Props) => boolean;

/** Every element of a (not yet rendered) React tree for which `match` is true. */
function findAll(node: ReactNode, match: Match): { type: unknown; props: Props }[] {
  if (Array.isArray(node)) return node.flatMap((child) => findAll(child, match));
  if (!isValidElement<Props>(node)) return [];
  const here = match(node.type, node.props) ? [{ type: node.type, props: node.props }] : [];
  return [
    ...here,
    ...Children.toArray(node.props.children as ReactNode).flatMap((child) => findAll(child, match)),
  ];
}

/** The first match; a miss fails the test. */
function must(node: ReactNode, match: Match): { type: unknown; props: Props } {
  const found = findAll(node, match)[0];
  if (!found) throw new Error('No element matched.');
  return found;
}

const slot =
  (name: string): Match =>
  (_type, props) =>
    props['data-slot'] === name;
const lang =
  (code: string, text: string): Match =>
  (_type, props) =>
    props.lang === code && props.children === text;

/** An element's inline style. */
const styleOf = (element: { props: Props }) => element.props.style as Record<string, unknown>;

/** A pane's props with nothing special. */
function viewProps(overrides: Partial<FontPaneViewProps> = {}): FontPaneViewProps {
  const detail = overrides.detail ?? heeboDetail();
  const face = overrides.face ?? (detail.faces.find((one) => one.weight === 400) as never);
  return {
    detail,
    face,
    fonts: paneFonts(detail, face, null),
    view: 'text',
    onView: vi.fn(),
    frame: 'person',
    onFrame: vi.fn(),
    tryText: '',
    onTryText: vi.fn(),
    onFace: vi.fn(),
    failed: false,
    now: NOW,
    inNotes: true,
    ...overrides,
  };
}

function textViewProps(overrides: Partial<FontTextViewProps> = {}): FontTextViewProps {
  const { detail, face, fonts, tryText, onTryText, onFace, failed } = viewProps(overrides);
  return { detail, face, fonts, tryText, onTryText, onFace, failed, ...overrides };
}

/** The pane the way the page mounts it: at /fonts?family=<slug>, with these fonts in the cache. */
async function pane(
  path: string,
  options: { details?: FontFamilyDetail[]; inNotes?: boolean } = {},
) {
  const { details = [], inNotes = true } = options;
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { fonts: true, fontsInNotes: inNotes });
  for (const detail of details) queryClient.setQueryData(fontKey(detail.slug), detail);
  const rootRoute = createRootRoute();
  const fontsRoute = createRoute({
    getParentRoute: () => rootRoute,
    path: '/fonts',
    component: FontPane,
    validateSearch: validateFontsSearch,
  });
  const router = createRouter({
    routeTree: rootRoute.addChildren([fontsRoute]),
    history: createMemoryHistory({ initialEntries: [path] }),
  });
  await router.load();
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <RouterProvider router={router} />
    </QueryClientProvider>,
  );
}

/** `OpenFontPane` with the pane's state handed in. */
function open(slug: string, details: FontFamilyDetail[], state: Partial<OpenFontPaneProps> = {}) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { fonts: true, fontsInNotes: true });
  for (const detail of details) queryClient.setQueryData(fontKey(detail.slug), detail);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <OpenFontPane
        slug={slug}
        view="text"
        onView={vi.fn()}
        frame="person"
        onFrame={vi.fn()}
        tryText=""
        onTryText={vi.fn()}
        choices={{}}
        onChoices={vi.fn()}
        {...state}
      />
    </QueryClientProvider>,
  );
}

// --- the pane on the page -----------------------------------------------------------------------

describe('<FontPane> with nothing open', () => {
  it('says to pick a font, centred', async () => {
    const html = await pane('/fonts');
    expect(textOf(html)).toBe('Font preview Pick a font to see it.');
    expect(html).toContain('justify-center');
    expect(html).toContain('data-slot="font-pane"');
  });
});

describe('<FontPane> while the font is on its way', () => {
  it('shows its outline, and no skeleton before the wait is over', async () => {
    const html = await pane('/fonts?family=heebo');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('<h2');
  });
});

describe('<FontPane> for a family with Hebrew', () => {
  it('shows the name, its line, the switch, the weights, the facts and how to name it', async () => {
    const html = await pane('/fonts?family=heebo', { details: [heeboDetail()] });
    const text = textOf(html);
    expect(html).toContain('>Heebo</h2>');
    expect(text).toContain('Sans · Hebrew + English · 9 weights');
    expect(html).toContain('aria-label="Show"');
    expect(text).toContain('Text On a frame');
    expect(text).toContain('Aa אב');
    expect(text).toContain('Every great edit starts with a cut');
    expect(text).toContain('כל עריכה טובה מתחילה בחיתוך');
    expect(html).toContain('placeholder="Type to try your own text"');
    for (const weight of [
      'Thin',
      'ExtraLight',
      'Light',
      'Regular',
      'Medium',
      'SemiBold',
      'Bold',
      'ExtraBold',
      'Black',
    ]) {
      expect(text).toContain(weight);
    }
    expect(text).toContain('Script Hebrew + English');
    expect(text).toContain('Weights Thin–Black');
    expect(text).toContain('Files 9 TTF · 0.4 MB');
    expect(text).toContain('Used in 14 jobs');
    expect(text).toContain('To use it, write @Heebo in a note on a job.');
    expect(html).not.toContain('data-slot="font-no-hebrew"');
  });

  it('opens on Regular, with its tag in the sentence, and a check on that row', async () => {
    const html = await pane('/fonts?family=heebo', { details: [heeboDetail()] });
    expect(html.match(/aria-pressed="true"/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-weight="400"/);
    // The Regular row's tag is the family alone.
    expect(textOf(html)).toContain('Regular @Heebo Medium @Heebo Medium');
  });

  it('uses the remembered weight of the family for the specimen, the row and the sentence', () => {
    const html = open('heebo', [heeboDetail()], { choices: { heebo: '700' } });
    expect(html).toMatch(/aria-pressed="true"[^>]*data-weight="700"/);
    expect(html).toContain('font-weight:700');
    const text = textOf(html);
    expect(text).toContain('To use it, write @Heebo Bold in a note on a job.');
    // Another family's choice does not reach this one.
    expect(textOf(open('heebo', [heeboDetail()], { choices: { poppins: '700' } }))).toContain(
      'write @Heebo in a note',
    );
  });

  it('leaves the sentence and "Used in" out while notes cannot name a font', async () => {
    const html = await pane('/fonts?family=heebo', {
      details: [heeboDetail({ usedIn: null })],
      inNotes: false,
    });
    const text = textOf(html);
    expect(text).not.toContain('To use it');
    expect(text).not.toContain('Used in');
    expect(text).toContain('Added');
  });
});

describe('<FontPane> for a family with no Hebrew', () => {
  it('says so, dims the Hebrew parts and sets them in Heebo from the library', async () => {
    const html = await pane('/fonts?family=poppins', {
      details: [poppinsDetail(), heeboDetail()],
    });
    const text = textOf(html);
    expect(html).toContain('role="note"');
    expect(text).toContain(
      'No Hebrew letters in this font. Hebrew text keeps the font it has now (Heebo here); only the English words change.',
    );
    expect(html).toContain('Sans · English only · 9 weights');
    expect(html).toContain('opacity:0.55');
    // The Hebrew is in Heebo's file for the same weight; the English is in Poppins's.
    expect(html).toContain('&quot;fe-heebo-400&quot;');
    expect(html).toContain('&quot;fe-poppins-400&quot;');
  });

  it('falls back to a Heebo the Mac has when the library has none', async () => {
    const html = await pane('/fonts?family=poppins', { details: [poppinsDetail()] });
    expect(html).toContain('&quot;Heebo&quot;, &quot;Noto Sans Hebrew&quot;, sans-serif');
    expect(html).not.toContain('fe-heebo');
  });

  it('follows the chosen weight to the same weight of Heebo', () => {
    const html = open('poppins', [poppinsDetail(), heeboDetail()], { choices: { poppins: '900' } });
    expect(html).toContain('&quot;fe-heebo-900&quot;');
    expect(html).toContain('&quot;fe-poppins-900&quot;');
    expect(textOf(html)).toContain('@Poppins Black');
  });
});

describe('<FontPane> for a family with one weight', () => {
  it('has one row, chosen, and names the family alone', async () => {
    const html = await pane('/fonts?family=secular-one', { details: [secularOneDetail()] });
    const text = textOf(html);
    expect(text).toContain('Display · Hebrew + English · 1 weight');
    expect(html.match(/data-weight=/g)).toHaveLength(1);
    expect(html).toMatch(/aria-pressed="true"[^>]*data-weight="400"/);
    expect(text).toContain('Weights Regular');
    expect(text).toContain('Files 1 TTF · 0.1 MB');
    expect(text).toContain('To use it, write @Secular One in a note on a job.');
  });
});

describe('<OpenFontPane> on the second view', () => {
  it('shows the On a frame view instead of the Text view, under the same name and facts', () => {
    const html = open('heebo', [heeboDetail()], { view: 'frame' });
    expect(html).toContain('data-slot="font-frame-view"');
    expect(html).not.toContain('data-slot="font-text-view"');
    expect(html).toContain('>Heebo</h2>');
    expect(textOf(html)).toContain('Script Hebrew + English');
    expect(textOf(html)).toContain('To use it, write @Heebo in a note on a job.');
  });
});

describe('<OpenFontPane> remembering the view and the frame', () => {
  // The view and the frame belong to the pane (FontPane's state), so the pane hands the same ones to
  // whichever family is open: moving to the next row does not send them back to Text or to Person.
  const library = [heeboDetail(), poppinsDetail(), secularOneDetail()];

  it('shows the frame they left on for every family he moves to', () => {
    for (const slug of ['heebo', 'poppins', 'secular-one']) {
      const html = open(slug, library, { view: 'frame', frame: 'interior' });
      expect(html, slug).toContain('src="/api/fonts/frame/interior.jpg"');
      expect(html, slug).toContain('data-slot="font-frame-view"');
      expect(html, slug).not.toContain('data-slot="font-text-view"');
      expect(textOf(html), slug).toContain('Photo: The Anchor, Unsplash');
    }
  });

  it('starts on Person when nothing was chosen', () => {
    const html = open('heebo', library, { view: 'frame' });
    expect(html).toContain('src="/api/fonts/frame/person.jpg"');
    expect(html).toMatch(/aria-pressed="true"[^>]*>Person</);
  });

  it('keeps the weight chosen for a family on the frame, with the view on', () => {
    const html = open('heebo', library, {
      view: 'frame',
      frame: 'street',
      choices: { heebo: '800' },
    });
    expect(html).toContain('font-weight:800');
    expect(html).toContain('>@Heebo ExtraBold</span>');
    expect(html).toContain('&quot;fe-heebo-800&quot;');
    expect(textOf(html)).toContain('To use it, write @Heebo ExtraBold in a note on a job.');
  });

  it('puts the Hebrew line of a font with no Hebrew in the library’s Heebo, and says so', () => {
    const html = open('poppins', library, { view: 'frame', choices: { poppins: '600' } });
    expect(html).toContain('&quot;fe-heebo-600&quot;');
    expect(html).toContain('&quot;fe-poppins-600&quot;');
    expect(textOf(html)).toContain(
      'No Hebrew letters in this font, so the Hebrew line is in Heebo.',
    );
    expect(html).toContain('>@Poppins SemiBold</span>');
  });

  it('is the Text view for a pane that was never switched', () => {
    const html = open('heebo', library);
    expect(html).toContain('data-slot="font-text-view"');
    expect(html).not.toContain('data-slot="font-frame-view"');
  });
});

describe('<FontPaneEmpty>', () => {
  it('has a quiet line for a font that could not be opened', () => {
    expect(textOf(renderToStaticMarkup(<FontPaneEmpty text={FONT_PANE_TEXT.gone} />))).toBe(
      'Font preview This font could not be opened.',
    );
  });
});

// --- the Text view ------------------------------------------------------------------------------

describe('<FontTextView> specimen', () => {
  it('sets Aa and אב at 64 px and the two lines at 22 px in the chosen weight', () => {
    const detail = heeboDetail();
    const bold = detail.faces.find((face) => face.weight === 700);
    if (!bold) throw new Error('no bold');
    const tree = FontTextView(textViewProps({ detail, face: bold }));

    const glyphs = must(tree, slot('font-glyphs'));
    expect(String(glyphs.props.className)).toContain('text-[64px]');
    expect(styleOf(glyphs)).toMatchObject({ fontWeight: 700, fontStyle: 'normal' });
    const lines = must(tree, slot('font-lines'));
    expect(String(lines.props.className)).toContain('text-[22px]');
    expect(styleOf(lines)).toMatchObject({ fontWeight: 700 });

    const aa = must(tree, lang('en', 'Aa'));
    expect(styleOf(aa).fontFamily).toBe('"fe-heebo-700", sans-serif');
    const english = must(tree, lang('en', 'Every great edit starts with a cut'));
    expect(styleOf(english).fontFamily).toBe('"fe-heebo-700", sans-serif');
  });

  it('marks the Hebrew right to left and sets it in the font itself, not dimmed', () => {
    const tree = FontTextView(textViewProps());
    for (const text of ['אב', 'כל עריכה טובה מתחילה בחיתוך']) {
      const hebrew = must(tree, lang('he', text));
      expect(hebrew.props.dir).toBe('rtl');
      expect(styleOf(hebrew)).toMatchObject({
        fontFamily: '"fe-heebo-400", sans-serif',
        opacity: 1,
      });
    }
    expect(findAll(tree, slot('font-no-hebrew'))).toHaveLength(0);
  });

  it('dims the Hebrew of a font without it, sets it in Heebo, and says so with a warning icon', () => {
    const detail = poppinsDetail();
    const face = detail.faces.find((one) => one.weight === 400);
    if (!face) throw new Error('no regular');
    const fonts = paneFonts(detail, face, { fileId: 'heebo-400' });
    const tree = FontTextView(textViewProps({ detail, face, fonts }));

    for (const text of ['אב', 'כל עריכה טובה מתחילה בחיתוך']) {
      expect(styleOf(must(tree, lang('he', text)))).toMatchObject({
        fontFamily: '"fe-heebo-400", "Heebo", "Noto Sans Hebrew", sans-serif',
        opacity: 0.55,
      });
    }
    // The English stays in the font itself, at full strength.
    const english = must(tree, lang('en', 'Every great edit starts with a cut'));
    expect(styleOf(english).fontFamily).toBe('"fe-poppins-400", sans-serif');
    expect(styleOf(english).opacity).toBeUndefined();

    const note = must(tree, slot('font-no-hebrew'));
    expect(note.props.role).toBe('note');
    const html = renderToStaticMarkup(<FontTextView {...textViewProps({ detail, face, fonts })} />);
    expect(textOf(html)).toContain('No Hebrew letters in this font.');
    expect(html).toContain('text-amber-400');
    expect(html).toContain('aria-hidden="true"');
  });

  it('says so, and shows the stand-in, when the file could not be loaded', () => {
    const html = renderToStaticMarkup(<FontTextView {...textViewProps({ failed: true })} />);
    expect(textOf(html)).toContain(FONT_PANE_TEXT.fileFailed);
    expect(renderToStaticMarkup(<FontTextView {...textViewProps()} />)).not.toContain(
      'data-slot="font-file-failed"',
    );
  });
});

describe('<FontTextView> try box', () => {
  const isInput: Match = (_type, props) => props['aria-label'] === 'Try your own text';

  it('is a text box that follows the text it is typed in (dir auto)', () => {
    const onTryText = vi.fn();
    const tree = FontTextView(textViewProps({ onTryText, tryText: 'שלום' }));
    const input = must(tree, isInput);
    expect(input.props.dir).toBe('auto');
    expect(input.props.placeholder).toBe('Type to try your own text');
    expect(input.props.value).toBe('שלום');
    (input.props.onChange as (event: unknown) => void)({ target: { value: 'Hello' } });
    expect(onTryText).toHaveBeenCalledWith('Hello');
  });

  it('shows the two sample lines until there is text, then only the text in their place', () => {
    const empty = FontTextView(textViewProps({ tryText: '' }));
    expect(findAll(empty, slot('font-lines'))).toHaveLength(1);
    expect(findAll(empty, slot('font-own-text'))).toHaveLength(0);

    const typed = FontTextView(textViewProps({ tryText: '  Hello world  ' }));
    expect(findAll(typed, slot('font-lines'))).toHaveLength(0);
    const own = must(typed, slot('font-own-text'));
    expect(own.props.dir).toBe('auto');
    expect(own.props.children).toBe('Hello world');
    // The big Aa אב stays.
    expect(findAll(typed, slot('font-glyphs'))).toHaveLength(1);

    // Spaces alone are no text.
    expect(
      findAll(FontTextView(textViewProps({ tryText: '   ' })), slot('font-lines')),
    ).toHaveLength(1);
  });

  it('sets the typed text in the font, with Heebo for the letters a font without Hebrew lacks', () => {
    const detail = poppinsDetail();
    const face = detail.faces.find((one) => one.weight === 400);
    if (!face) throw new Error('no regular');
    const fonts = paneFonts(detail, face, { fileId: 'heebo-400' });
    const own = must(
      FontTextView(textViewProps({ detail, face, fonts, tryText: 'Hi שלום' })),
      slot('font-own-text'),
    );
    expect(styleOf(own).fontFamily).toBe(
      '"fe-poppins-400", "fe-heebo-400", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
    expect(styleOf(own).opacity).toBeUndefined();
  });
});

describe('<FontTextView> weights', () => {
  const weightRows = (tree: ReactNode) =>
    findAll(tree, (type, props) => type === 'button' && props['data-weight'] !== undefined);

  it('has one row per weight, each set in its own weight and file', () => {
    const rows = weightRows(FontTextView(textViewProps()));
    expect(rows.map((row) => row.props['data-weight'])).toEqual([
      100, 200, 300, 400, 500, 600, 700, 800, 900,
    ]);
    const html = renderToStaticMarkup(<FontTextView {...textViewProps()} />);
    expect(html).toContain('font-weight:300');
    expect(html).toContain('&quot;fe-heebo-300&quot;');
    expect(html).toContain('>@Heebo ExtraBold<');
    expect(html).toContain('>@Heebo<');
    expect(html).toContain('font-mono');
  });

  it('marks the chosen row and checks it', () => {
    const detail = heeboDetail();
    const medium = detail.faces.find((face) => face.weight === 500);
    if (!medium) throw new Error('no medium');
    const rows = weightRows(FontTextView(textViewProps({ detail, face: medium })));
    expect(rows.filter((row) => row.props['aria-pressed'] === true)).toHaveLength(1);
    expect(rows.find((row) => row.props['aria-pressed'] === true)?.props['data-weight']).toBe(500);
  });

  it('chooses a weight on a click', () => {
    const onFace = vi.fn();
    const rows = weightRows(FontTextView(textViewProps({ onFace })));
    const bold = rows.find((row) => row.props['data-weight'] === 700);
    if (!bold) throw new Error('no Bold row');
    (bold.props.onClick as () => void)();
    expect(onFace).toHaveBeenCalledTimes(1);
    expect(onFace.mock.calls[0]?.[0]).toMatchObject({ weight: 700, name: 'Heebo Bold' });
  });

  it('has a single row for a single-weight family', () => {
    const detail = secularOneDetail();
    const face = detail.faces[0];
    if (!face) throw new Error('no face');
    expect(weightRows(FontTextView(textViewProps({ detail, face })))).toHaveLength(1);
  });
});

// --- the switch ---------------------------------------------------------------------------------

describe('<FontPaneView> switch', () => {
  it('has Text and On a frame, with the open one on', () => {
    const html = renderToStaticMarkup(<FontPaneView {...viewProps({ view: 'frame' })} />);
    expect(html).toMatch(/data-state="active"[^>]*>On a frame</);
    expect(html).toMatch(/data-state="inactive"[^>]*>Text</);
  });

  it('moves between the views, and ignores a value it does not know', () => {
    const onView = vi.fn();
    const tree = FontPaneView(viewProps({ onView }));
    const tabs = must(tree, (_type, props) => typeof props.onValueChange === 'function');
    const change = tabs.props.onValueChange as (value: string) => void;
    change('frame');
    change('wall');
    change('text');
    expect(onView.mock.calls).toEqual([['frame'], ['text']]);
  });

  it('hands the frame view the chosen face, the fonts, the frame and what failed', () => {
    const onFrame = vi.fn();
    const props = viewProps({ view: 'frame', frame: 'street', onFrame, failed: true });
    const slotted = must(FontPaneView(props), (type) => type === FontFrameView);
    expect(slotted.props.face).toBe(props.face);
    expect(slotted.props.fonts).toBe(props.fonts);
    expect(slotted.props.detail).toBe(props.detail);
    expect(slotted.props.frame).toBe('street');
    expect(slotted.props.onFrame).toBe(onFrame);
    expect(slotted.props.failed).toBe(true);
  });

  it('shows one view at a time', () => {
    const onText = renderToStaticMarkup(<FontPaneView {...viewProps({ view: 'text' })} />);
    expect(onText).toContain('data-slot="font-text-view"');
    expect(onText).not.toContain('data-slot="font-frame-view"');
    const onFrame = renderToStaticMarkup(<FontPaneView {...viewProps({ view: 'frame' })} />);
    expect(onFrame).toContain('data-slot="font-frame-view"');
    expect(onFrame).not.toContain('data-slot="font-text-view"');
  });
});

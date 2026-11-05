import type { FontFamilyDetail, FontFrame } from '@studio/shared';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { FontFrameView, type FontFrameViewProps } from './FontFrameView';
import { paneFonts } from './font-pane-model';
import { heeboDetail, poppinsDetail, secularOneDetail } from './test-fixtures';

// The On a frame view (FN8, board FOPage `start=frame`). The repo has no DOM environment, so the
// view is a plain function: the tests read the element tree it returns, and render it to markup
// for the words.

type Props = Record<string, unknown>;
type Match = (type: unknown, props: Props) => boolean;

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

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
const styleOf = (element: { props: Props }) => element.props.style as Record<string, unknown>;

/** The view for `detail` on its `weight`, the Hebrew stand-in being Heebo's file of that weight. */
function frameProps(
  detail: FontFamilyDetail,
  weight: number,
  overrides: Partial<FontFrameViewProps> = {},
): FontFrameViewProps {
  const face = detail.faces.find((one) => one.weight === weight);
  if (!face) throw new Error(`no ${weight} face`);
  return {
    detail,
    face,
    fonts: paneFonts(detail, face, { fileId: `heebo-${weight}` }),
    frame: 'person',
    onFrame: vi.fn(),
    ...overrides,
  };
}

const heeboExtraBold = (overrides: Partial<FontFrameViewProps> = {}) =>
  frameProps(heeboDetail(), 800, overrides);
const poppinsSemiBold = (overrides: Partial<FontFrameViewProps> = {}) =>
  frameProps(poppinsDetail(), 600, overrides);

// --- the picture --------------------------------------------------------------------------------

describe('<FontFrameView> the frame', () => {
  it('is a 252×448 box with the photo of the chosen frame filling it', () => {
    const tree = FontFrameView(heeboExtraBold());
    const box = must(tree, slot('font-frame'));
    expect(styleOf(box)).toEqual({ width: 252, height: 448 });
    // The photo is 252×448 inside the 1 px border, as on the board (so the box is 254×450).
    expect(String(box.props.className)).toContain('box-content');
    expect(String(box.props.className)).toContain('border');
    expect(String(box.props.className)).toContain('overflow-hidden');
    expect(String(box.props.className)).toContain('rounded-[8px]');

    const image = must(tree, (type) => type === 'img');
    expect(image.props.src).toBe('/api/fonts/frame/person.jpg');
    expect(image.props.alt).toBe('A frame from a video');
    expect(image.props.width).toBe(252);
    expect(image.props.height).toBe(448);
    expect(String(image.props.className)).toContain('object-cover');
  });

  it.each([
    ['person', '/api/fonts/frame/person.jpg'],
    ['street', '/api/fonts/frame/street.jpg'],
    ['interior', '/api/fonts/frame/interior.jpg'],
  ] as [FontFrame, string][])('shows the %s photo', (frame, src) => {
    const image = must(FontFrameView(heeboExtraBold({ frame })), (type) => type === 'img');
    expect(image.props.src).toBe(src);
  });

  it('puts a dark gradient over the bottom of the photo, behind the caption', () => {
    const tree = FontFrameView(heeboExtraBold());
    const gradient = must(tree, (_type, props) => props['aria-hidden'] === 'true');
    expect(styleOf(gradient).background).toBe(
      'linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0) 48%)',
    );
  });
});

// --- the caption --------------------------------------------------------------------------------

describe('<FontFrameView> the caption of a font with Hebrew', () => {
  it('has the Hebrew line at 32 px, right to left, and the English line at 17 px', () => {
    const tree = FontFrameView(heeboExtraBold());
    const hebrew = must(tree, lang('he', 'ככה הכול התחיל'));
    expect(hebrew.props.dir).toBe('rtl');
    expect(String(hebrew.props.className)).toContain('text-[32px]');
    expect(String(hebrew.props.className)).toContain('leading-[1.15]');

    const english = must(tree, lang('en', 'That’s how it all started'));
    expect(String(english.props.className)).toContain('text-[17px]');
    expect(String(english.props.className)).toContain('leading-tight');
  });

  it('sets both lines in the font itself, in the chosen weight, centred, with a shadow', () => {
    const tree = FontFrameView(heeboExtraBold());
    const caption = must(tree, slot('font-caption'));
    expect(styleOf(caption)).toMatchObject({
      fontWeight: 800,
      fontStyle: 'normal',
      textShadow: '0 2px 10px rgba(0,0,0,0.75)',
    });
    expect(String(caption.props.className)).toContain('text-center');
    expect(String(caption.props.className)).toContain('items-center');
    expect(String(caption.props.className)).toContain('text-white');

    expect(styleOf(must(tree, lang('he', 'ככה הכול התחיל'))).fontFamily).toBe(
      '"fe-heebo-800", sans-serif',
    );
    expect(styleOf(must(tree, lang('en', 'That’s how it all started'))).fontFamily).toBe(
      '"fe-heebo-800", sans-serif',
    );
  });

  it('follows the chosen weight', () => {
    const light = FontFrameView(frameProps(heeboDetail(), 300));
    expect(styleOf(must(light, slot('font-caption'))).fontWeight).toBe(300);
    expect(styleOf(must(light, lang('en', 'That’s how it all started'))).fontFamily).toBe(
      '"fe-heebo-300", sans-serif',
    );
  });

  it('has no note about Hebrew', () => {
    const tree = FontFrameView(heeboExtraBold());
    expect(findAll(tree, slot('font-frame-no-hebrew'))).toHaveLength(0);
    expect(textOf(renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />))).not.toContain(
      'No Hebrew letters',
    );
  });

  it('badges the frame with the tag they write in a note', () => {
    const tag = (props: FontFrameViewProps) =>
      must(FontFrameView(props), slot('font-frame-tag')).props.children;
    expect(tag(heeboExtraBold())).toBe('@Heebo ExtraBold');
    // Regular is the family alone; a family with one weight too.
    expect(tag(frameProps(heeboDetail(), 400))).toBe('@Heebo');
    expect(tag(frameProps(secularOneDetail(), 400))).toBe('@Secular One');
    expect(tag(poppinsSemiBold())).toBe('@Poppins SemiBold');
  });

  it('puts the tag top-left in a small dark pill', () => {
    const tag = must(FontFrameView(heeboExtraBold()), slot('font-frame-tag'));
    const classes = String(tag.props.className);
    for (const part of ['top-2', 'left-2', 'h-5', 'rounded-full', 'bg-black/55', 'text-[11px]']) {
      expect(classes, part).toContain(part);
    }
  });
});

describe('<FontFrameView> the caption of a font with no Hebrew', () => {
  it('sets the Hebrew line in Heebo and the English line in the font itself', () => {
    const tree = FontFrameView(poppinsSemiBold());
    expect(styleOf(must(tree, lang('he', 'ככה הכול התחיל'))).fontFamily).toBe(
      '"fe-heebo-600", "Heebo", "Noto Sans Hebrew", sans-serif',
    );
    expect(styleOf(must(tree, lang('en', 'That’s how it all started'))).fontFamily).toBe(
      '"fe-poppins-600", sans-serif',
    );
    expect(styleOf(must(tree, slot('font-caption'))).fontWeight).toBe(600);
  });

  it('does not dim the Hebrew line: it is what the video would show', () => {
    const tree = FontFrameView(poppinsSemiBold());
    expect(styleOf(must(tree, lang('he', 'ככה הכול התחיל'))).opacity).toBeUndefined();
  });

  it('falls back to a Heebo the Mac has when the library has none', () => {
    const detail = poppinsDetail();
    const face = detail.faces.find((one) => one.weight === 400);
    if (!face) throw new Error('no regular');
    const tree = FontFrameView({
      detail,
      face,
      fonts: paneFonts(detail, face, null),
      frame: 'person',
      onFrame: vi.fn(),
    });
    expect(styleOf(must(tree, lang('he', 'ככה הכול התחיל'))).fontFamily).toBe(
      '"Heebo", "Noto Sans Hebrew", sans-serif',
    );
  });

  it('says so under the chips: the Hebrew line is in Heebo', () => {
    const props = poppinsSemiBold();
    const note = must(FontFrameView(props), slot('font-frame-no-hebrew'));
    expect(note.props.role).toBe('note');
    expect(styleOf(note)).toEqual({ width: 252 });
    const html = renderToStaticMarkup(<FontFrameView {...props} />);
    expect(textOf(html)).toContain(
      'No Hebrew letters in this font, so the Hebrew line is in Heebo.',
    );
  });

  it('keeps the note when the frame changes', () => {
    for (const frame of ['person', 'street', 'interior'] as const) {
      const html = renderToStaticMarkup(<FontFrameView {...poppinsSemiBold({ frame })} />);
      expect(html, frame).toContain('data-slot="font-frame-no-hebrew"');
    }
  });
});

// --- the chips and the credit -------------------------------------------------------------------

describe('<FontFrameView> frame chips', () => {
  const chips = (tree: ReactNode) =>
    findAll(tree, (type, props) => type === 'button' && props['aria-pressed'] !== undefined);
  const chipText = (chip: { props: Props }) => chip.props.children;

  it('are Person · Street · Interior, in a group called Frame', () => {
    const tree = FontFrameView(heeboExtraBold());
    expect(chips(tree).map(chipText)).toEqual(['Person', 'Street', 'Interior']);
    const html = renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />);
    expect(html).toMatch(/<fieldset[^>]*>\s*<legend class="sr-only">Frame<\/legend>/);
  });

  it('start on Person: one chip is pressed, and it is the frame shown', () => {
    for (const [frame, label] of [
      ['person', 'Person'],
      ['street', 'Street'],
      ['interior', 'Interior'],
    ] as const) {
      const pressed = chips(FontFrameView(heeboExtraBold({ frame }))).filter(
        (chip) => chip.props['aria-pressed'] === true,
      );
      expect(pressed.map(chipText), frame).toEqual([label]);
    }
  });

  it('choose a frame on a click', () => {
    const onFrame = vi.fn();
    const all = chips(FontFrameView(heeboExtraBold({ onFrame })));
    for (const chip of all) (chip.props.onClick as () => void)();
    expect(onFrame.mock.calls).toEqual([['person'], ['street'], ['interior']]);
  });

  it('are buttons, so the keyboard and the pointer cursor come with them', () => {
    const html = renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />);
    expect(html.match(/<button type="button"/g)).toHaveLength(3);
  });
});

describe('<FontFrameView> credit', () => {
  const credit = (frame: FontFrame) =>
    must(FontFrameView(heeboExtraBold({ frame })), slot('font-frame-credit')).props.children;

  it('names whose photo it is, on the right of the chips', () => {
    expect(credit('person')).toBe('Photo: Benjamin Combs, Unsplash');
    expect(credit('street')).toBe('Photo: Nicholas Swanson, Unsplash');
    expect(credit('interior')).toBe('Photo: The Anchor, Unsplash');
    const html = renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />);
    expect(html.indexOf('Interior')).toBeLessThan(html.indexOf('Photo: Benjamin Combs'));
    expect(html).toContain('justify-between');
  });
});

describe('<FontFrameView> a file that could not be loaded', () => {
  it('says the caption is in a stand-in, and only then', () => {
    const failed = renderToStaticMarkup(<FontFrameView {...heeboExtraBold({ failed: true })} />);
    expect(failed).toContain('data-slot="font-file-failed"');
    expect(textOf(failed)).toContain(
      'The font file could not be loaded, so this is shown in a stand-in font.',
    );
    expect(renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />)).not.toContain(
      'data-slot="font-file-failed"',
    );
  });
});

describe('<FontFrameView> markup', () => {
  it('is the pane’s second view, and has no text-view parts', () => {
    const html = renderToStaticMarkup(<FontFrameView {...heeboExtraBold()} />);
    expect(html).toContain('data-slot="font-frame-view"');
    expect(html).not.toContain('data-slot="font-text-view"');
    expect(html).not.toContain('Type to try your own text');
    expect(html).toContain('lang="he"');
    expect(html).toContain('dir="rtl"');
  });
});

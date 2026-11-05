import { QueryClientProvider } from '@tanstack/react-query';
import { Children, isValidElement, type ReactNode } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { lutKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeLutDetail } from '@/data/test-utils';
import { LutPane } from './LutPane';
import {
  FrameControls,
  LutPaneEmpty,
  LutPaneView,
  type LutPaneViewProps,
  PreviewFrame,
} from './LutPaneView';
import { LUT_FRAME_STORAGE_KEY, LUT_PANE_TEXT } from './lut-pane-model';

const NOW = Date.parse('2026-10-24T10:00:00.000Z');

// --- helpers ------------------------------------------------------------------------------------

function textOf(markup: string): string {
  return markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** The first element of a (not yet rendered) React tree for which `match` is true. */
function find(
  node: ReactNode,
  match: (type: unknown, props: Record<string, unknown>) => boolean,
): { type: unknown; props: Record<string, unknown> } | undefined {
  if (!isValidElement<Record<string, unknown>>(node)) {
    if (Array.isArray(node)) {
      for (const child of node) {
        const found = find(child, match);
        if (found) return found;
      }
    }
    return undefined;
  }
  if (match(node.type, node.props)) return node;
  for (const child of Children.toArray(node.props.children as ReactNode)) {
    const found = find(child, match);
    if (found) return found;
  }
  return undefined;
}

/** Like {@link find}, but a miss fails the test. */
function must(
  node: ReactNode,
  match: (type: unknown, props: Record<string, unknown>) => boolean,
): { type: unknown; props: Record<string, unknown> } {
  const found = find(node, match);
  if (!found) throw new Error('No element matched.');
  return found;
}

const noop = () => {};

function viewProps(overrides: Partial<LutPaneViewProps> = {}): LutPaneViewProps {
  return {
    detail: makeLutDetail(),
    frame: 'person',
    split: 50,
    retry: 0,
    failed: false,
    showSkeleton: false,
    ready: true,
    onLoaded: noop,
    onFailed: noop,
    onRetry: noop,
    onSplit: noop,
    onFrame: noop,
    now: NOW,
    inEdits: false,
    ...overrides,
  };
}

const view = (overrides: Partial<LutPaneViewProps> = {}) =>
  renderToStaticMarkup(<LutPaneView {...viewProps(overrides)} />);

/** The pane the way the page mounts it, with one LUT in the cache and the switches as given. */
function pane(
  slug: string | null,
  options: { inEdits?: boolean; detail?: ReturnType<typeof makeLutDetail> } = {},
) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { luts: true, lutsInEdits: options.inEdits ?? false });
  if (slug !== null && options.detail) queryClient.setQueryData(lutKey(slug), options.detail);
  return renderToStaticMarkup(
    <QueryClientProvider client={queryClient}>
      <LutPane slug={slug} />
    </QueryClientProvider>,
  );
}

afterEach(() => vi.unstubAllGlobals());

// --- tests --------------------------------------------------------------------------------------

describe('<LutPane> with nothing open', () => {
  it('says to pick a LUT, centred', () => {
    const html = pane(null);
    expect(textOf(html)).toBe('Pick a LUT to see it on a frame.');
    expect(html).toContain('justify-center');
    expect(html).toContain('data-slot="lut-pane"');
  });
});

describe('<LutPane> for a LUT in the cache', () => {
  it('shows the name, the description, the frame, the slider, the chips and the facts', () => {
    const html = pane('golden-hour-warm', { detail: makeLutDetail() });
    expect(html).toContain('>Golden Hour Warm</h2>');
    expect(textOf(html)).toContain('Gold-amber highlights over slightly cool shadows.');
    expect(html).toContain('aria-label="Before and after"');
    expect(html).toContain('type="range"');
    expect(html).toContain('value="50"');
    expect(textOf(html)).toContain('Person Street Interior');
    expect(textOf(html)).toContain('Photo: Benjamin Combs, Unsplash');
    expect(html).toContain('/api/luts/golden-hour-warm/preview/person/before.jpg?v=');
    expect(html).toContain('/api/luts/golden-hour-warm/preview/person/after.jpg?v=');
  });

  it('starts on the frame stored in the browser', () => {
    vi.stubGlobal('localStorage', {
      getItem: (key: string) => (key === LUT_FRAME_STORAGE_KEY ? 'interior' : null),
      setItem: noop,
    });
    const html = pane('golden-hour-warm', { detail: makeLutDetail() });
    expect(html).toContain('/preview/interior/before.jpg');
    expect(html).toContain('/preview/interior/after.jpg');
    expect(textOf(html)).toContain('Photo: The Anchor, Unsplash');
  });

  it('works when the browser blocks storage', () => {
    vi.stubGlobal('localStorage', {
      getItem: () => {
        throw new Error('blocked');
      },
      setItem: () => {
        throw new Error('blocked');
      },
    });
    const html = pane('golden-hour-warm', { detail: makeLutDetail() });
    expect(html).toContain('/preview/person/before.jpg');
  });

  it('leaves out the last line while the lutsInEdits switch is off, and shows it once on', () => {
    // While the switch is off the server counts nothing (usedIn is null) and the row is left out.
    const off = pane('golden-hour-warm', { detail: makeLutDetail({ usedIn: null }) });
    expect(off).not.toContain('@luts/');
    expect(off).not.toContain('in a note on a job');
    expect(textOf(off)).not.toContain('Used in');

    const on = pane('golden-hour-warm', { detail: makeLutDetail({ usedIn: 3 }), inEdits: true });
    expect(textOf(on)).toContain('To use it, write @luts/golden-hour-warm in a note on a job.');
    expect(on).toContain('font-mono');
    expect(textOf(on)).toContain('Used in 3 jobs');
  });

  it('draws nothing at first while the LUT is on its way (the skeleton comes after its delay)', () => {
    const html = pane('golden-hour-warm');
    expect(html).toContain('aria-busy="true"');
    expect(html).not.toContain('data-slot="skeleton"');
    expect(html).not.toContain('<h2');
  });

  it('has a quiet line for a LUT that could not be opened', () => {
    expect(textOf(renderToStaticMarkup(<LutPaneEmpty text={LUT_PANE_TEXT.gone} />))).toBe(
      'This LUT could not be opened.',
    );
  });
});

describe('<LutPaneView>', () => {
  it('puts the after still over the before still, clipped from the divider', () => {
    const html = view({ split: 30 });
    const images = html.match(/<img [^>]*>/g) ?? [];
    expect(images).toHaveLength(2);
    expect(images[0]).toContain('alt="The frame before"');
    expect(images[0]).not.toContain('clip-path');
    expect(images[1]).toContain('alt="The frame with Golden Hour Warm"');
    expect(images[1]).toContain('clip-path:inset(0 0 0 30%)');
    expect(images[0]).toContain('width="252"');
    expect(images[0]).toContain('height="448"');
    expect(html).toMatch(/data-slot="lut-divider"[^>]*style="left:30%"/);
    expect(textOf(html)).toContain('Before After');
  });

  it('moves the clip with the slider', () => {
    const onSplit = vi.fn();
    const controls = FrameControls({
      frame: 'person',
      split: 50,
      onSplit,
      onFrame: noop,
      sliderDisabled: false,
    });
    const slider = must(controls, (type, props) => type === 'input' && props.type === 'range');
    expect(slider.props['aria-label']).toBe('Before and after');
    expect(slider.props.value).toBe(50);
    (slider.props.onChange as (event: unknown) => void)({ currentTarget: { value: '72' } });
    expect(onSplit).toHaveBeenCalledWith(72);

    const html = view({ split: 72 });
    expect(html).toContain('clip-path:inset(0 0 0 72%)');
    expect(html).toContain('value="72"');
  });

  it('switches the image addresses with the frame chips', () => {
    const onFrame = vi.fn();
    const controls = FrameControls({
      frame: 'person',
      split: 50,
      onSplit: noop,
      onFrame,
      sliderDisabled: false,
    });
    for (const [label, frame] of [
      ['Street', 'street'],
      ['Interior', 'interior'],
    ] as const) {
      const chip = must(controls, (type, props) => type === 'button' && props.children === label);
      (chip.props.onClick as () => void)();
      expect(onFrame).toHaveBeenLastCalledWith(frame);
    }
    const person = must(
      controls,
      (type, props) => type === 'button' && props.children === 'Person',
    );
    expect(person.props['aria-pressed']).toBe(true);

    const street = view({ frame: 'street' });
    expect(street).toContain('/preview/street/before.jpg');
    expect(street).toContain('/preview/street/after.jpg');
    expect(street).not.toContain('/preview/person/');
    expect(textOf(street)).toContain('Photo: Nicholas Swanson, Unsplash');
    expect(street).toMatch(/aria-pressed="true"[^>]*>Street</);
  });

  it('shows a Camera LUT with the Log pill and its note', () => {
    const html = view({ detail: makeLutDetail({ kind: 'camera', name: 'S-Log3 to Rec.709' }) });
    expect(textOf(html)).toContain('Log After');
    expect(textOf(html)).not.toContain('Before After');
    expect(textOf(html)).toContain(
      'Camera LUTs expect flat log footage, so this is shown on a log sample of the frame.',
    );
    // The before still is still asked for as before.jpg: the server makes it the log twin.
    expect(html).toContain('/preview/person/before.jpg');
  });

  it('shows a Fix with its note', () => {
    const html = view({ detail: makeLutDetail({ kind: 'fix', note: null }) });
    expect(textOf(html)).toContain(
      'Made for footage with one problem, so a clean test frame can look off.',
    );
    expect(textOf(html)).toContain('Before After');
  });

  it('has no note for a Look', () => {
    expect(view()).not.toContain('data-slot="lut-note"');
  });

  it('lists the facts with 80 px labels', () => {
    const html = view({ detail: makeLutDetail({ usedIn: 0, usedLabel: 'Not used yet' }) });
    expect(html).toContain('grid-cols-[80px_minmax(0,1fr)]');
    expect(textOf(html)).toContain(
      'Kind Look Size 33 × 33 × 33 File Golden Hour Warm.cube Used in Not used yet Added 2 days ago',
    );
  });

  it('describes a LUT of Yours by its kind and size', () => {
    const html = view({ detail: makeLutDetail({ description: '' }) });
    expect(textOf(html)).toContain('Look · 33 × 33 × 33');
  });

  it('shows the last line only when inEdits is on', () => {
    expect(view({ inEdits: false })).not.toContain('data-slot="lut-use"');
    const on = view({ inEdits: true });
    expect(on).toContain('data-slot="lut-use"');
    expect(on).toContain('>@luts/golden-hour-warm</span>');
  });
});

describe('<PreviewFrame> while loading and when it fails', () => {
  const frame = (overrides: Partial<LutPaneViewProps> = {}) =>
    renderToStaticMarkup(<PreviewFrame {...viewProps(overrides)} />);

  it('draws no skeleton before its delay, and one after', () => {
    expect(frame({ ready: false, showSkeleton: false })).not.toContain('lut-frame-skeleton');
    expect(frame({ ready: false, showSkeleton: true })).toContain('lut-frame-skeleton');
    expect(frame({ ready: true, showSkeleton: true })).not.toContain('lut-frame-skeleton');
  });

  it('keeps the stills hidden until both have arrived', () => {
    const html = frame({ ready: false });
    expect(html.match(/opacity-0/g)).toHaveLength(2);
    expect(html).not.toContain('lut-divider');
  });

  it('says "Preview not ready." with a Try again button when a still fails', () => {
    const html = frame({ failed: true, ready: false });
    expect(textOf(html)).toBe('Preview not ready. Try again');
    expect(html).not.toContain('<img');
    expect(html).toContain('>Try again</button>');
  });

  it('asks again when Try again is pressed', () => {
    const onRetry = vi.fn();
    const tree = PreviewFrame(viewProps({ failed: true, ready: false, onRetry }));
    const button = must(tree, (_type, props) => props.children === 'Try again');
    (button.props.onClick as () => void)();
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(frame({ retry: 1 })).toContain('-r1');
  });

  it('reports each still that arrives and a still that fails', () => {
    const onLoaded = vi.fn();
    const onFailed = vi.fn();
    const tree = PreviewFrame(viewProps({ onLoaded, onFailed }));
    const after = must(tree, (type, props) => type === 'img' && props['data-side'] === 'after');
    (after.props.onLoad as () => void)();
    expect(onLoaded).toHaveBeenCalledWith('after');
    (after.props.onError as () => void)();
    expect(onFailed).toHaveBeenCalledTimes(1);
  });
});

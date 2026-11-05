import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LookStill, LookStillFrame } from './LookStill';

const frame = (props: Partial<React.ComponentProps<typeof LookStillFrame>> = {}) =>
  renderToStaticMarkup(
    <LookStillFrame
      src="/api/jobs/j1/still"
      label="New look, from Studio tour"
      loaded={false}
      failed={false}
      skeleton={false}
      highlighted={false}
      onLoad={() => {}}
      onError={() => {}}
      {...props}
    />,
  );

describe('<LookStillFrame>', () => {
  it('is the board’s 112 × 199 thumbnail, named for screen readers', () => {
    const markup = frame();
    expect(markup).toContain('role="img"');
    expect(markup).toContain('aria-label="New look, from Studio tour"');
    expect(markup).toContain('h-[199px]');
    expect(markup).toContain('w-28');
    expect(markup).toContain('overflow-hidden');
  });

  it('loads the picture lazily, cropped to fill the frame, and leaves the frame to name it', () => {
    const markup = frame();
    expect(markup).toContain('<img');
    expect(markup).toContain('src="/api/jobs/j1/still"');
    expect(markup).toContain('loading="lazy"');
    expect(markup).toContain('alt=""');
    expect(markup).toContain('object-cover');
  });

  it('fades the picture in once it is loaded, not before', () => {
    expect(frame({ loaded: false })).toContain('opacity-0');
    const loaded = frame({ loaded: true });
    expect(loaded).toContain('opacity-100');
    expect(loaded).not.toContain('opacity-0"');
  });

  it('keeps a quiet empty frame, with a faint image icon, when there is no picture to show', () => {
    for (const markup of [frame({ src: null }), frame({ failed: true })]) {
      expect(markup).not.toContain('<img');
      expect(markup).toContain('lucide-image');
      expect(markup).toContain('bg-muted');
    }
  });

  it('draws the skeleton over the frame only when asked', () => {
    expect(frame({ skeleton: false })).not.toContain('data-slot="skeleton"');
    const markup = frame({ skeleton: true });
    expect(markup).toContain('data-slot="skeleton"');
    expect(markup).toContain('motion-reduce:animate-none');
  });

  it('rings the look that is going to be the client’s', () => {
    expect(frame({ highlighted: true })).toContain('ring-2');
    expect(frame({ highlighted: false })).not.toContain('ring-2');
  });
});

describe('<LookStill>', () => {
  const still = (props: Partial<React.ComponentProps<typeof LookStill>> = {}) =>
    renderToStaticMarkup(<LookStill src="/api/jobs/j1/still" label="Now look" {...props} />);

  it('starts with the picture not loaded, and no skeleton before the wait is noticeable', () => {
    const markup = still();
    expect(markup).toContain('opacity-0');
    expect(markup).not.toContain('data-slot="skeleton"');
  });

  it('shows the skeleton once the wait is noticeable (a zero delay is "now")', () => {
    expect(still({ skeletonDelayMs: 0 })).toContain('data-slot="skeleton"');
  });

  it('waits for something else too: no picture yet, but a skeleton once it takes a while', () => {
    const markup = still({ src: null, waiting: true, skeletonDelayMs: 0 });
    expect(markup).not.toContain('<img');
    expect(markup).toContain('data-slot="skeleton"');
  });

  it('has nothing to wait for with no picture and no wait: no skeleton', () => {
    expect(still({ src: null, skeletonDelayMs: 0 })).not.toContain('data-slot="skeleton"');
  });
});

import { describe, expect, it, vi } from 'vitest';
import type { KeyboardFrame } from './phone-review';
import { type VisualViewportLike, watchKeyboardFrame } from './use-keyboard-frame';

/** `window.visualViewport` as iPhone Safari moves it: a height, a top, and its two events. */
class FakeViewport extends EventTarget implements VisualViewportLike {
  height = 844;
  offsetTop = 0;

  move(height: number, offsetTop: number, event: 'resize' | 'scroll' = 'resize') {
    this.height = height;
    this.offsetTop = offsetTop;
    this.dispatchEvent(new Event(event));
  }
}

describe('watchKeyboardFrame', () => {
  it('says where the page is visible at once, then as the keyboard comes up, scrolls and goes down', () => {
    const viewport = new FakeViewport();
    const frames: KeyboardFrame[] = [];
    watchKeyboardFrame(
      viewport,
      () => 844,
      (frame) => frames.push(frame),
    );

    viewport.move(508, 0);
    viewport.move(464, 44, 'scroll');
    viewport.move(844, 0);

    expect(frames).toEqual([
      { keyboardOpen: false, box: null },
      { keyboardOpen: true, box: { top: 0, height: 508 } },
      { keyboardOpen: true, box: { top: 44, height: 464 } },
      { keyboardOpen: false, box: null },
    ]);
  });

  it('says nothing when nothing changed, and nothing once it is stopped', () => {
    const viewport = new FakeViewport();
    const onFrame = vi.fn();
    const stop = watchKeyboardFrame(viewport, () => 844, onFrame);
    viewport.move(844, 0);
    viewport.move(843.6, 0, 'scroll');
    expect(onFrame).toHaveBeenCalledOnce();

    stop();
    viewport.move(508, 0);
    expect(onFrame).toHaveBeenCalledOnce();
  });
});

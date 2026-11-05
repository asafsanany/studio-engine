import { describe, expect, it, vi } from 'vitest';
import type { TransferLike } from '@/features/style/drop-target';
import { createLutDropTarget } from './lut-drop-target';

const cube = new File(['x'], 'a.cube');

/** A drag event as the browser makes it. */
function drag(types: string[], files: File[] = [], items?: TransferLike['items']) {
  return {
    dataTransfer: { types, files, ...(items && { items }) },
    prevented: 0,
    preventDefault() {
      this.prevented += 1;
    },
  };
}

function setup() {
  const onDrop = vi.fn();
  const onDragging = vi.fn();
  return { target: createLutDropTarget({ onDrop, onDragging }), onDrop, onDragging };
}

describe('createLutDropTarget', () => {
  it('shows the veil on the first dragenter of files and cancels the event', () => {
    const { target, onDragging } = setup();
    const event = drag(['Files']);
    target.dragenter(event);
    expect(onDragging).toHaveBeenCalledWith(true);
    expect(event.prevented).toBe(1);
  });

  it('counts the elements crossed, so the veil does not flicker', () => {
    const { target, onDragging } = setup();
    target.dragenter(drag(['Files']));
    target.dragenter(drag(['Files']));
    target.dragleave(drag(['Files']));
    expect(onDragging).not.toHaveBeenCalledWith(false);
    target.dragleave(drag(['Files']));
    expect(onDragging).toHaveBeenLastCalledWith(false);
  });

  it('does not react to a dragged link or text', () => {
    const { target, onDragging, onDrop } = setup();
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop'] as const) {
      const event = drag(['text/uri-list', 'text/plain']);
      target[type](event);
      expect(event.prevented).toBe(0);
    }
    expect(onDragging).not.toHaveBeenCalled();
    expect(onDrop).not.toHaveBeenCalled();
  });

  it('cancels dragover, which is what lets the drop happen', () => {
    const { target } = setup();
    const event = drag(['Files']);
    target.dragover(event);
    expect(event.prevented).toBe(1);
  });

  it('hides the veil and hands over the dropped files', async () => {
    const { target, onDragging, onDrop } = setup();
    target.dragenter(drag(['Files']));
    const event = drag(['Files'], [cube]);
    target.drop(event);
    expect(event.prevented).toBe(1);
    expect(onDragging).toHaveBeenLastCalledWith(false);
    await vi.waitFor(() => expect(onDrop).toHaveBeenCalledTimes(1));
    expect(onDrop).toHaveBeenCalledWith({ files: [cube], sawFolder: false });
  });

  it('starts again from zero after a drop', () => {
    const { target, onDragging } = setup();
    target.dragenter(drag(['Files']));
    target.dragenter(drag(['Files']));
    target.drop(drag(['Files'], [cube]));
    onDragging.mockClear();
    target.dragenter(drag(['Files']));
    target.dragleave(drag(['Files']));
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('ignores a drop with no data', () => {
    const { target, onDrop } = setup();
    target.drop({ dataTransfer: null, preventDefault: vi.fn() });
    expect(onDrop).not.toHaveBeenCalled();
  });
});

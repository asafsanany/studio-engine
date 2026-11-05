import { describe, expect, it, vi } from 'vitest';
import { carriesFiles, createDropTarget, droppedFiles, type TransferLike } from './drop-target';

const logo = new File(['x'], 'logo.png');
const notes = new File(['x'], 'notes.txt');

/** A drag event as the browser makes it, with what the target reads. */
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
  const onFiles = vi.fn();
  const onDragging = vi.fn();
  return { target: createDropTarget({ onFiles, onDragging }), onFiles, onDragging };
}

describe('carriesFiles', () => {
  it('is true for a drag of files, false for a link or text, and for no data at all', () => {
    expect(carriesFiles({ types: ['Files'], files: [] })).toBe(true);
    expect(carriesFiles({ types: ['text/uri-list', 'text/plain'], files: [] })).toBe(false);
    expect(carriesFiles(null)).toBe(false);
  });
});

describe('droppedFiles', () => {
  it('is the files of the drop, in order', () => {
    expect(droppedFiles({ types: ['Files'], files: [logo, notes] })).toEqual([logo, notes]);
  });

  it('leaves out a folder, which would arrive as a file that cannot be read', () => {
    const folder = new File([], 'Brand');
    const items = [
      { webkitGetAsEntry: () => ({ isDirectory: false }) },
      { webkitGetAsEntry: () => ({ isDirectory: true }) },
      { webkitGetAsEntry: () => ({ isDirectory: false }) },
    ];
    expect(droppedFiles({ types: ['Files'], files: [logo, folder, notes], items })).toEqual([
      logo,
      notes,
    ]);
  });

  it('keeps every file when the items cannot be matched to them', () => {
    const items = [{ webkitGetAsEntry: () => ({ isDirectory: true }) }];
    expect(droppedFiles({ types: ['Files'], files: [logo, notes], items })).toEqual([logo, notes]);
  });

  it('keeps files whose items cannot say what they are', () => {
    expect(droppedFiles({ types: ['Files'], files: [logo], items: [{}] })).toEqual([logo]);
    expect(
      droppedFiles({ types: ['Files'], files: [logo], items: [{ webkitGetAsEntry: () => null }] }),
    ).toEqual([logo]);
  });
});

describe('createDropTarget', () => {
  it('says files are being dragged over when they enter, and cancels the event', () => {
    const { target, onDragging } = setup();
    const event = drag(['Files']);
    target.dragenter(event);

    expect(onDragging).toHaveBeenCalledWith(true);
    expect(event.prevented).toBe(1);
  });

  it('cancels dragover, which is what lets the drop happen', () => {
    const { target } = setup();
    const event = drag(['Files']);
    target.dragover(event);
    expect(event.prevented).toBe(1);
  });

  it('is over the page until as many elements have been left as were entered', () => {
    const { target, onDragging } = setup();
    // The pointer crosses from the page into a box inside it, then leaves the box and the page.
    target.dragenter(drag(['Files']));
    target.dragenter(drag(['Files']));
    target.dragleave(drag(['Files']));
    expect(onDragging).not.toHaveBeenCalledWith(false);
    target.dragleave(drag(['Files']));
    expect(onDragging).toHaveBeenLastCalledWith(false);
  });

  it('hands the dropped files over, and is no longer dragging', () => {
    const { target, onFiles, onDragging } = setup();
    target.dragenter(drag(['Files']));
    target.dragenter(drag(['Files']));
    const event = drag(['Files'], [logo, notes]);
    target.drop(event);

    expect(onFiles).toHaveBeenCalledWith([logo, notes]);
    expect(onDragging).toHaveBeenLastCalledWith(false);
    expect(event.prevented).toBe(1);
    // The count starts over: the next drag is over the page from its first enter to its last leave.
    onDragging.mockClear();
    target.dragenter(drag(['Files']));
    target.dragleave(drag(['Files']));
    expect(onDragging.mock.calls).toEqual([[true], [false]]);
  });

  it('does not count a leave that has no enter (the drag began before the page was listening)', () => {
    const { target, onDragging } = setup();
    target.dragleave(drag(['Files']));
    target.dragenter(drag(['Files']));
    target.dragleave(drag(['Files']));
    expect(onDragging.mock.calls).toEqual([[false], [true], [false]]);
  });

  it('leaves a drag of a link or text alone', () => {
    const { target, onFiles, onDragging } = setup();
    const events = [drag(['text/plain']), drag(['text/uri-list'])];
    for (const event of events) {
      target.dragenter(event);
      target.dragover(event);
      target.dragleave(event);
      target.drop(event);
    }
    expect(onFiles).not.toHaveBeenCalled();
    expect(onDragging).not.toHaveBeenCalled();
    expect(events.map((event) => event.prevented)).toEqual([0, 0]);
  });

  it('leaves a drop with no data alone', () => {
    const { target, onFiles } = setup();
    const event = { dataTransfer: null, preventDefault: vi.fn() };
    target.drop(event);
    expect(onFiles).not.toHaveBeenCalled();
    expect(event.preventDefault).not.toHaveBeenCalled();
  });
});

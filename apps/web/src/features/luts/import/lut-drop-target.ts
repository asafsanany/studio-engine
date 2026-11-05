// Dragging files over the LUTs page: the window's four drag events as one state, like the Style
// page's drop target (features/style/drop-target.ts), but a drop is read asynchronously because a
// dropped folder has to be opened.

import { carriesFiles, type DragLike } from '@/features/style/drop-target';
import { type DroppedFiles, readDroppedFiles } from './lut-files';

export interface LutDropTargetOptions {
  /** Files (folders opened) were dropped. */
  onDrop: (dropped: DroppedFiles) => void;
  /** Files are being dragged over the page, or no longer are. */
  onDragging: (dragging: boolean) => void;
}

export interface LutDropTarget {
  dragenter(event: DragLike): void;
  dragover(event: DragLike): void;
  dragleave(event: DragLike): void;
  drop(event: DragLike): void;
}

/**
 * `dragenter` and `dragleave` fire for every element the pointer crosses, so they are counted: the
 * drag is over the page until as many have left as entered (no flicker). Only a drag that carries
 * files is taken, and every one of those is cancelled, which lets the drop happen and stops the
 * browser from opening the file and leaving the app.
 */
export function createLutDropTarget({ onDrop, onDragging }: LutDropTargetOptions): LutDropTarget {
  let depth = 0;

  return {
    dragenter(event) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth += 1;
      onDragging(true);
    },
    dragover(event) {
      if (!carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
    },
    dragleave(event) {
      if (!carriesFiles(event.dataTransfer)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) onDragging(false);
    },
    drop(event) {
      const transfer = event.dataTransfer;
      if (!transfer || !carriesFiles(transfer)) return;
      event.preventDefault();
      depth = 0;
      onDragging(false);
      // `readDroppedFiles` takes the entries before its first await, inside the event.
      void readDroppedFiles(transfer).then(onDrop);
    },
  };
}

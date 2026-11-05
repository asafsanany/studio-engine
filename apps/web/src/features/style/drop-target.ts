// Dropping files on the Style page. The listeners are on the window, not on the page's box: a drop
// that just misses the box (the sidebar, the header) would make the browser open the file and
// leave the app. Plain functions over the events' own shape, so a test can call them with stand-ins.

/** The part of a `DataTransfer` a drop is read from. */
export interface TransferLike {
  types: readonly string[];
  files: ArrayLike<File>;
  items?: ArrayLike<{ webkitGetAsEntry?: () => { isDirectory: boolean } | null }>;
}

/** The part of a `DragEvent` the drop target uses. */
export interface DragLike {
  dataTransfer: TransferLike | null;
  preventDefault(): void;
}

/** Whether the drag carries files (a dragged link or piece of text is not for this page). */
export function carriesFiles(transfer: TransferLike | null): boolean {
  return transfer?.types.includes('Files') ?? false;
}

/**
 * The files of a drop, minus folders: a folder arrives as a "file" that cannot be read, and sending
 * it would fail the whole upload. When the items cannot be matched to the files, all are kept.
 */
export function droppedFiles(transfer: TransferLike): File[] {
  const files = Array.from(transfer.files);
  const items = transfer.items === undefined ? [] : Array.from(transfer.items);
  if (items.length !== files.length) return files;
  return files.filter((_, i) => items[i]?.webkitGetAsEntry?.()?.isDirectory !== true);
}

export interface DropTargetOptions {
  /** Files were dropped. */
  onFiles: (files: File[]) => void;
  /** Files are being dragged over the page, or no longer are. */
  onDragging: (dragging: boolean) => void;
}

export interface DropTarget {
  dragenter(event: DragLike): void;
  dragover(event: DragLike): void;
  dragleave(event: DragLike): void;
  drop(event: DragLike): void;
}

/**
 * The four drag events as one state. `dragenter` and `dragleave` fire for every element the
 * pointer crosses, so they are counted: the drag is over the page until as many have left as
 * entered. Every event that carries files is cancelled, which is what lets the drop happen and
 * stops the browser from opening the file.
 */
export function createDropTarget({ onFiles, onDragging }: DropTargetOptions): DropTarget {
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
      if (!event.dataTransfer || !carriesFiles(event.dataTransfer)) return;
      event.preventDefault();
      depth = 0;
      onDragging(false);
      onFiles(droppedFiles(event.dataTransfer));
    },
  };
}

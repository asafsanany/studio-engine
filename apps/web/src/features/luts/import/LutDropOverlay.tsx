import { Upload } from 'lucide-react';
import { LUT_IMPORT_TEXT } from './lut-import-text';
import { useWindowLutDrops } from './use-lut-import';

/** The overlay itself: the board's full-page veil with a dashed frame (LUStates 2). */
export function LutDropOverlayView() {
  return (
    <div
      data-slot="lut-drop-overlay"
      aria-hidden="true"
      className="pointer-events-none fixed inset-0 z-30 animate-in bg-background/90 p-4 duration-150 ease-in-out fade-in-0"
    >
      <div className="flex size-full flex-col items-center justify-center gap-2.5 rounded-xl border-2 border-dashed border-foreground/30 text-center">
        <Upload aria-hidden="true" className="size-7" />
        <span className="text-lg font-semibold">{LUT_IMPORT_TEXT.overlayTitle}</span>
        <span className="text-muted-foreground">{LUT_IMPORT_TEXT.overlayHint}</span>
      </div>
    </div>
  );
}

/**
 * Dragging files over the LUTs page (board LUStates 2): a full-page "Drop to import" while the
 * drag lasts, and a drop hands the files (a dropped folder opened) to `onFiles`, which opens the
 * dialog at step 2 (`ImportLutsDialog`'s `initialFiles`). Only drags that carry files count, and
 * `dragenter` / `dragleave` are counted so the veil does not flicker. With `disabled` (the dialog
 * is open and takes drops itself, or the engine cannot be reached) the veil stays away and nothing
 * is handed on, but the drop is still cancelled so the browser does not open the file.
 */
export function LutDropOverlay({
  onFiles,
  disabled = false,
}: {
  onFiles: (files: File[]) => void;
  disabled?: boolean;
}) {
  const dragging = useWindowLutDrops(({ files }) => {
    if (!disabled) onFiles(files);
  });
  return dragging && !disabled ? <LutDropOverlayView /> : null;
}

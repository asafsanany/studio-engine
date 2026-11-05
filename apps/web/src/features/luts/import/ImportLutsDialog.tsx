import { useEffect, useRef } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { dialogSubline, ImportLutsBody } from './ImportLutsBody';
import { LUT_IMPORT_TEXT } from './lut-import-text';
import { useLutImportSession, useWindowLutDrops } from './use-lut-import';

/** What the LUTs page hands the import dialog (LUTs plan, "Import"). */
export interface ImportLutsDialogProps {
  /** Whether the dialog is open: the page's Import LUTs button (or a file dropped on it) opens it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /**
   * Files that opened the dialog (a drop on the page, see `LutDropOverlay`): it starts with them at
   * step 2. Each list is taken once, so the page can leave it set; an empty one is ignored.
   */
  initialFiles?: readonly File[];
  /** The slugs of the LUTs that were added, in the engine's order: the page opens the first. */
  onImported?: (slugs: string[]) => void;
  /** The engine cannot be reached: the zone and its buttons are off (board LUStates 10). */
  offline?: boolean;
  /**
   * The dialog was opened for a job that waits for a camera LUT (LU10): the line under the title at
   * step 1 says what it is looking for ("For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT."), and
   * the files start at Camera.
   */
  forJob?: { subline: string } | null;
}

/**
 * The Import LUTs dialog (boards LUPage and LUStates 3 to 6): 560 px wide, three steps: the drop
 * zone with Choose files… and Choose a folder…, the list of files with their verdicts and a Look /
 * Camera / Fix for each, and "Checking and copying…". A drop anywhere on the window while it is at
 * step 1 counts too. The toast "Imported 2 LUTs" is shown from here (the LUTs route mounts the
 * Toaster). OWNER: LU5.
 */
export function ImportLutsDialog({
  open,
  onOpenChange,
  initialFiles,
  onImported,
  offline = false,
  forJob = null,
}: ImportLutsDialogProps) {
  const { session, state } = useLutImportSession({
    onImported,
    onClose: () => onOpenChange(false),
    defaultKind: forJob === null ? null : 'camera',
  });

  const dragging = useWindowLutDrops(({ files }) => {
    if (!offline) session.take(files);
  }, open);

  // Closed from outside (the page, or a successful import): throw an unfinished upload away.
  useEffect(() => {
    if (!open) session.cancel();
  }, [open, session]);

  // The files that opened the dialog go straight to step 2, once.
  const taken = useRef<readonly File[] | undefined>(undefined);
  useEffect(() => {
    if (!open || !initialFiles?.length || initialFiles === taken.current) return;
    taken.current = initialFiles;
    if (!offline) session.take(initialFiles);
  }, [open, initialFiles, offline, session]);

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape and a click outside: refused while the files are being copied.
        if (!next && session.cancel()) onOpenChange(false);
      }}
    >
      <DialogContent
        showCloseButton={false}
        className="max-w-[560px] gap-0 rounded-xl p-0 sm:max-w-[560px]"
      >
        <div className="flex flex-col gap-1 px-6 pt-6">
          <DialogTitle className="text-lg leading-[1.35] font-semibold">
            {LUT_IMPORT_TEXT.title}
          </DialogTitle>
          <DialogDescription className="text-sm">{dialogSubline(state, forJob)}</DialogDescription>
        </div>
        <ImportLutsBody
          state={state}
          offline={offline}
          dragging={dragging}
          onFiles={session.take}
          onKind={session.setKind}
          onRemove={session.remove}
          onRetry={session.retry}
          onImport={session.importNow}
          onCancel={() => {
            if (session.cancel()) onOpenChange(false);
          }}
        />
      </DialogContent>
    </Dialog>
  );
}

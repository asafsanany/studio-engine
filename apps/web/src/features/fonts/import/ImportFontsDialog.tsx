import { useEffect, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogTitle } from '@/components/ui/dialog';
import { useEngineOffline } from '@/features/phone/use-engine-offline';
import { FontDropOverlay } from './FontDropOverlay';
import { createFontImportIntake } from './font-import-intake';
import { FONT_IMPORT_TEXT } from './font-import-text';
import { ImportFontsBody, importSubline } from './ImportFontsBody';
import { useFontImportSession, useOpenImportedFamily, useWindowFontDrops } from './use-font-import';

/** What the Fonts page hands the import dialog (Fonts plan, "Import"). */
export interface ImportFontsDialogProps {
  /** Whether the dialog is open: the page's Import fonts button (or files dropped on the page) opens it. */
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * The Import fonts dialog (boards FOPage and FOStates 2 to 6): 560 px wide, three steps: the drop
 * zone with Choose files… and Choose a folder…, the families found in the files with a verdict and a
 * tag each (New, Adds N, Already here, Can’t import) and a remove ×, and "Checking and copying…".
 * A drop anywhere on the window while it is at step 1 counts too. After an import it closes, opens
 * the first new family on the page and shows the toast "Imported 2 fonts" (the Fonts route mounts the
 * Toaster).
 *
 * The page always renders it, open or not, so the page-wide "Drop to import" overlay lives here: a
 * drop on the page while the dialog is closed opens it with the files already sent for checking.
 * OWNER: FN9.
 */
export function ImportFontsDialog({ open, onOpenChange }: ImportFontsDialogProps) {
  const offline = useEngineOffline();
  const openImported = useOpenImportedFamily();
  const { session, state } = useFontImportSession({
    onImported: (slugs) => {
      const first = slugs[0];
      if (first !== undefined) openImported(first);
    },
    onClose: () => onOpenChange(false),
  });

  // The intake reads the newest of these through a ref, as the session does.
  const latest = useRef({ offline, onOpenChange });
  latest.current = { offline, onOpenChange };
  const [intake] = useState(() =>
    createFontImportIntake({
      session,
      isOffline: () => latest.current.offline,
      onOpenChange: (next) => latest.current.onOpenChange(next),
    }),
  );

  useEffect(() => intake.openChanged(open), [open, intake]);

  const dragging = useWindowFontDrops(({ files }) => intake.dropInDialog(files), open);

  // While the dialog fades out it keeps showing what it showed when it was closed: the session is
  // already reset by then, and the drop zone must not flash back in over the list.
  const lastOpenState = useRef(state);
  if (open) lastOpenState.current = state;
  const shown = open ? state : lastOpenState.current;

  return (
    <>
      {/* The page's route test looks for this slot while the dialog is closed. */}
      <span hidden data-slot="import-fonts-dialog" />
      <FontDropOverlay disabled={open || offline} onFiles={intake.dropOnPage} />
      <Dialog
        open={open}
        onOpenChange={(next) => {
          // Escape and a click outside: refused while the fonts are being copied.
          if (!next && session.cancel()) onOpenChange(false);
        }}
      >
        <DialogContent
          showCloseButton={false}
          className="max-w-[560px] gap-0 rounded-xl p-0 sm:max-w-[560px]"
        >
          <div className="flex flex-col gap-1 px-6 pt-6">
            <DialogTitle className="text-lg leading-[1.35] font-semibold">
              {FONT_IMPORT_TEXT.title}
            </DialogTitle>
            <DialogDescription className="text-sm">{importSubline(shown)}</DialogDescription>
          </div>
          <ImportFontsBody
            state={shown}
            offline={offline}
            dragging={dragging}
            onFiles={session.take}
            onRemove={session.remove}
            onRetry={session.retry}
            onImport={session.importNow}
            onCancel={() => {
              if (session.cancel()) onOpenChange(false);
            }}
          />
        </DialogContent>
      </Dialog>
    </>
  );
}

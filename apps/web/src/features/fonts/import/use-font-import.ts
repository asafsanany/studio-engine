import type { FontFamilySummary } from '@studio/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import {
  useCancelFontStage,
  useFonts,
  useFontsInNotesEnabled,
  useImportFonts,
  useStageFonts,
} from '@/data';
import { useSelectedFamily } from '../use-selected-family';
import { createFontDropTarget } from './font-drop-target';
import type { DroppedFiles } from './font-files';
import { openImportedStep } from './font-import-open';
import { createFontImportSession, type FontImportSession } from './font-import-session';
import { announceFontsImported } from './font-import-toasts';

/**
 * The import session of one Import fonts dialog, built on the mutations of the data layer. `onClose`
 * is told when every family went in (the dialog should close); `onImported` gets the slugs of the
 * new families, in the engine's order, so the page can open the first.
 */
export function useFontImportSession({
  onImported,
  onClose,
}: {
  onImported?: (slugs: string[]) => void;
  onClose: () => void;
}) {
  const stage = useStageFonts();
  const cancelStage = useCancelFontStage();
  const importStaged = useImportFonts();
  const fontsInNotes = useFontsInNotesEnabled();

  // The session lives as long as the dialog; it reads the newest of everything through this ref.
  const latest = useRef({ stage, cancelStage, importStaged, fontsInNotes, onImported, onClose });
  latest.current = { stage, cancelStage, importStaged, fontsInNotes, onImported, onClose };

  const [session] = useState<FontImportSession>(() =>
    createFontImportSession({
      stage: (send) => latest.current.stage.mutateAsync(send),
      cancelStage: (stageId) => latest.current.cancelStage.mutateAsync(stageId),
      importStaged: (request) => latest.current.importStaged.mutateAsync(request),
      onResult: (imported: readonly FontFamilySummary[], failedCount) => {
        announceFontsImported(imported, failedCount, latest.current.fontsInNotes);
        if (imported.length > 0) latest.current.onImported?.(imported.map((one) => one.slug));
      },
      onClose: () => latest.current.onClose(),
    }),
  );

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}

/**
 * Opens the family an import asked for (`open(slug)`): sets the address's `?family=` once the list
 * has it, and again if the list opened its own first row in the meantime (see font-import-open.ts).
 */
export function useOpenImportedFamily(): (slug: string) => void {
  const { selected, setSelected } = useSelectedFamily();
  const families = useFonts().data?.families;
  const [wanted, setWanted] = useState<string | null>(null);
  const tries = useRef(0);

  useEffect(() => {
    const step = openImportedStep({
      wanted,
      selected,
      slugs: families?.map((family) => family.slug),
      tries: tries.current,
    });
    if (step === 'done') {
      tries.current = 0;
      setWanted(null);
    } else if (step === 'open' && wanted !== null) {
      tries.current += 1;
      setSelected(wanted);
    }
  }, [wanted, selected, families, setSelected]);

  return (slug) => {
    tries.current = 0;
    setWanted(slug);
  };
}

/**
 * Whether files are being dragged over the window, and what to do with a drop. The listeners are on
 * the window so that a drop that just misses the box is still ours (the browser would otherwise
 * open the file and leave the app).
 */
export function useWindowFontDrops(
  onDrop: (dropped: DroppedFiles) => void,
  enabled = true,
): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(onDrop);
  latest.current = onDrop;

  useEffect(() => {
    if (!enabled) return;
    const target = createFontDropTarget({
      onDrop: (dropped) => latest.current(dropped),
      onDragging: setDragging,
    });
    const listeners = [
      ['dragenter', target.dragenter],
      ['dragover', target.dragover],
      ['dragleave', target.dragleave],
      ['drop', target.drop],
    ] as const;
    for (const [type, listener] of listeners) window.addEventListener(type, listener);
    return () => {
      for (const [type, listener] of listeners) window.removeEventListener(type, listener);
      setDragging(false);
    };
  }, [enabled]);

  return dragging;
}

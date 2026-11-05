import type { LutKind, LutSummary } from '@studio/shared';
import { useEffect, useRef, useState, useSyncExternalStore } from 'react';
import { useCancelLutStage, useImportLuts, useLutsInEditsEnabled, useStageLuts } from '@/data';
import { createLutDropTarget } from './lut-drop-target';
import type { DroppedFiles } from './lut-files';
import { createLutImportSession, type LutImportSession } from './lut-import-session';
import { announceLutsImported } from './lut-import-toasts';

/**
 * The import session of one Import LUTs dialog, built on the mutations of the data layer. `onClose`
 * is told when every file went in (the dialog should close); `onImported` gets the slugs of the new
 * LUTs, newest data first as the engine answered, so the page can open the first.
 */
export function useLutImportSession({
  onImported,
  onClose,
  defaultKind,
}: {
  onImported?: (slugs: string[]) => void;
  onClose: () => void;
  /** The kind the checked files start at instead of the guess from their names (a camera LUT for a waiting job). */
  defaultKind?: LutKind | null;
}) {
  const stage = useStageLuts();
  const cancelStage = useCancelLutStage();
  const importStaged = useImportLuts();
  const lutsInEdits = useLutsInEditsEnabled();

  // The session lives as long as the dialog; it reads the newest of everything through this ref.
  const latest = useRef({
    stage,
    cancelStage,
    importStaged,
    lutsInEdits,
    onImported,
    onClose,
    defaultKind: defaultKind ?? null,
  });
  latest.current = {
    stage,
    cancelStage,
    importStaged,
    lutsInEdits,
    onImported,
    onClose,
    defaultKind: defaultKind ?? null,
  };

  const [session] = useState<LutImportSession>(() =>
    createLutImportSession({
      stage: (send) => latest.current.stage.mutateAsync(send),
      cancelStage: (stageId) => latest.current.cancelStage.mutateAsync(stageId),
      importStaged: (request) => latest.current.importStaged.mutateAsync(request),
      onResult: (imported: readonly LutSummary[], failedCount) => {
        announceLutsImported(imported, failedCount, latest.current.lutsInEdits);
        if (imported.length > 0) latest.current.onImported?.(imported.map((lut) => lut.slug));
      },
      onClose: () => latest.current.onClose(),
      defaultKind: () => latest.current.defaultKind,
    }),
  );

  const state = useSyncExternalStore(session.subscribe, session.getState, session.getState);
  return { session, state };
}

/**
 * Whether files are being dragged over the window, and what to do with a drop. The listeners are on
 * the window so that a drop that just misses the box is still ours (the browser would otherwise
 * open the file and leave the app).
 */
export function useWindowLutDrops(
  onDrop: (dropped: DroppedFiles) => void,
  enabled = true,
): boolean {
  const [dragging, setDragging] = useState(false);
  const latest = useRef(onDrop);
  latest.current = onDrop;

  useEffect(() => {
    if (!enabled) return;
    const target = createLutDropTarget({
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

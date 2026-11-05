import { Upload } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '@/components/ui/button';
import { useLuts } from '@/data';
import { CameraLutBanner } from '@/features/luts/camera/CameraLutBanner';
import { type CameraWaitingJob, importForText } from '@/features/luts/camera/camera-wait';
import { useCameraWait } from '@/features/luts/camera/use-camera-wait';
import { ImportLutsDialog } from '@/features/luts/import/ImportLutsDialog';
import { LutDropOverlay } from '@/features/luts/import/LutDropOverlay';
import { LutsOfflineBanner } from '@/features/luts/LutsOfflineBanner';
import { LutList } from '@/features/luts/list/LutList';
import { useLutsAddress } from '@/features/luts/list/use-luts-address';
import { LutPane } from '@/features/luts/pane/LutPane';
import { useEngineLastHeard, useEngineOffline } from '@/features/phone/use-engine-offline';

/** The words of the page's heading (board LUPage). */
export const LUTS_TEXT = {
  title: 'LUTs',
  intro: 'Colour looks the grade can use. Import your own .cube files.',
  import: 'Import LUTs',
} as const;

/**
 * The LUTs page (LUTs plan, "The page (web)"; boards LUPage and LUStates): a main column with the
 * heading, the Import LUTs button and the list, and a 440 px pane on the right with the open LUT's
 * before / after. It only exists while the LUTs switch is on (the route shows Not found
 * otherwise), and only on the Mac.
 *
 * The three parts are the list (features/luts/list), the pane (features/luts/pane) and the import
 * (features/luts/import: the dialog and the page-wide drop veil). The page holds what they share:
 * which LUT is open (a slug in the address, `null` for the first in the list), whether the import
 * dialog is open, and the files that opened it when they were dropped on the page. A finished
 * import opens the first new LUT (on the All tab, so a Camera LUT is not hidden by the Looks tab).
 * The page fills the shell's content area to its edges, so the pane's
 * border reaches the header and the window's bottom, as in the board.
 *
 * When the engine can't be reached a bar says so under the header and the list stays as it was;
 * Import LUTs, the dialog's zone and the drop veil wait until it answers (the same watch the phone's
 * "Can't reach your Mac" screen uses). If the list never arrived, the list's own "Can't reach the
 * engine." and "Try again" say it instead.
 */
export function LutsPage() {
  // Which LUT is open lives in the address (`?lut=`), so a reload keeps it (the list owns the rules).
  const { selected, setSelected, showNew, forJob, clearForJob } = useLutsAddress();
  const offline = useEngineOffline();
  const heardAt = useEngineLastHeard();
  const { data } = useLuts();
  const [importing, setImporting] = useState(false);
  // Files dropped on the page: they open the dialog at its second step.
  const [dropped, setDropped] = useState<readonly File[]>([]);
  // Jobs that wait for a camera LUT (LU10): the banner, and the job the dialog was opened for.
  const camera = useCameraWait();
  const [importingFor, setImportingFor] = useState<CameraWaitingJob | null>(null);

  // "Import LUT" on a job's row or sheet comes here with `?for=<job>`: open the dialog for it, once.
  useEffect(() => {
    if (forJob === null || !camera.loaded) return;
    const job = camera.waiting.find((item) => item.job.id === forJob);
    if (job !== undefined) {
      setImportingFor(job);
      setImporting(true);
    }
    clearForJob();
  }, [forJob, camera.loaded, camera.waiting, clearForJob]);

  return (
    <div
      data-slot="luts-page"
      className="-mx-6 -mt-6 -mb-10 flex min-h-[calc(100svh-3.5rem)] flex-col"
    >
      {offline && data !== undefined && <LutsOfflineBanner heardAt={heardAt} />}
      <CameraLutBanner
        waiting={camera.waiting}
        imported={camera.imported}
        resumed={camera.resumed}
        offline={offline}
        onImport={(job) => {
          setImportingFor(job);
          setImporting(true);
        }}
        onResume={camera.resume}
      />
      <div className="flex flex-1 items-stretch">
        <section className="flex min-w-0 flex-1 flex-col gap-4 px-8 pt-6 pb-10">
          <div className="flex items-start justify-between gap-4">
            <div className="flex flex-col gap-1">
              <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
                {LUTS_TEXT.title}
              </h1>
              <p className="text-muted-foreground">{LUTS_TEXT.intro}</p>
            </div>
            <Button
              type="button"
              className="flex-none"
              disabled={offline}
              onClick={() => setImporting(true)}
            >
              <Upload aria-hidden="true" />
              {LUTS_TEXT.import}
            </Button>
          </div>
          <LutList selected={selected} onSelect={setSelected} onImport={() => setImporting(true)} />
        </section>
        <aside
          aria-label="Preview"
          // Pinned while the list scrolls under it, so the LUT being picked stays in view.
          className="sticky top-0 flex h-[calc(100svh-3.5rem)] w-[440px] flex-none flex-col gap-3.5 self-start overflow-y-auto border-l p-6"
        >
          <LutPane slug={selected} />
        </aside>
      </div>
      <LutDropOverlay
        disabled={importing || offline}
        onFiles={(files) => {
          setDropped(files);
          setImporting(true);
        }}
      />
      <ImportLutsDialog
        open={importing}
        onOpenChange={(open) => {
          setImporting(open);
          if (!open) {
            setDropped([]);
            setImportingFor(null);
          }
        }}
        initialFiles={dropped}
        onImported={(slugs) => {
          const first = slugs[0];
          if (first !== undefined) showNew(first);
          if (importingFor !== null) camera.markImported();
        }}
        offline={offline}
        forJob={
          importingFor === null
            ? null
            : { subline: importForText(importingFor.title, importingFor.wait) }
        }
      />
    </div>
  );
}

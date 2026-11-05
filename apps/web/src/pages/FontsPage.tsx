import { Upload } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { useFonts, useFontsInNotesEnabled } from '@/data';
import { ImportFontsDialog } from '@/features/fonts/import/ImportFontsDialog';
import { FontList } from '@/features/fonts/list/FontList';
import { OfflineFontsBanner } from '@/features/fonts/list/FontListStates';
import { MissingFontBar } from '@/features/fonts/list/MissingFontBar';
import { FontPane } from '@/features/fonts/pane/FontPane';
import { useEngineLastHeard, useEngineOffline } from '@/features/phone/use-engine-offline';

/** The words of the page's heading (board FOPage). */
export const FONTS_TEXT = {
  title: 'Fonts',
  intro: 'Every edit can use these. Import your own.',
  import: 'Import fonts',
} as const;

/**
 * The Fonts page (Fonts plan, "The page (web)"; boards FOPage and FOStates): a main column with
 * the heading, the Import fonts button and the list, and a 440 px pane on the right with the open
 * family's specimen. In a narrow window the pane is the one that gives way (CVP-367): the column
 * keeps 360 px (a 296 px list, what the tabs need) and the pane takes the rest, down to 320 px;
 * only a window too narrow for both lets the column go below 360 px, and its tabs then shorten
 * their labels instead of running under the pane. The 56 px header bar with "Fonts" is the shell's
 * (the trail). It only exists while the Fonts switch is on (the route shows Not found otherwise),
 * and only on the Mac.
 *
 * FN1 owns this frame; the three parts are FN6 (the list), FN7 and FN8 (the pane) and FN9 (the
 * import dialog), which change only their own files. Which family is open lives in the address
 * (`?family=`): the list and the pane share it through `useSelectedFamily()`. The page holds the
 * one thing the dialog and the list share, whether the dialog is open. It fills the shell's
 * content area to its edges, so the pane's border reaches the header and the window's bottom, as
 * in the board.
 *
 * When the engine can't be reached a bar says so under the header and the list stays as it was
 * (board FOStates 10, as on the LUTs page); Import fonts and the dialog wait until it answers. If
 * the list never arrived, the list's own "Can't reach the engine." and "Try again" say it instead.
 * While notes can name a font (the fontsInNotes switch) a second bar says when a note asked for a
 * font the library does not have, until it is imported (FN16, board FOStates 9): its button opens
 * the same import dialog (it says "is using" the closest font while that job is still editing, "used"
 * after). With the switch off nothing makes a request and no bar shows.
 * The pane is pinned while the list scrolls under it, and scrolls inside itself when it is tall
 * (nine weights and the facts).
 */
export function FontsPage() {
  const offline = useEngineOffline();
  const heardAt = useEngineLastHeard();
  const { data } = useFonts();
  const inNotes = useFontsInNotesEnabled();
  const [importing, setImporting] = useState(false);

  return (
    <div
      data-slot="fonts-page"
      className="-mx-6 -mt-6 -mb-10 flex min-h-[calc(100svh-3.5rem)] flex-col"
    >
      {offline && data !== undefined && <OfflineFontsBanner heardAt={heardAt} />}
      {inNotes && data !== undefined && data.requests.length > 0 && (
        <MissingFontBar
          requests={data.requests}
          offline={offline}
          onImport={() => setImporting(true)}
        />
      )}
      <div className="flex flex-1 items-stretch">
        <section className="flex min-w-[min(22.5rem,calc(100%-20rem))] flex-1 flex-col gap-4 px-8 pt-6 pb-10">
          <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
            <div className="flex max-w-fit min-w-32 flex-1 basis-32 flex-col gap-1">
              <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
                {FONTS_TEXT.title}
              </h1>
              <p className="text-muted-foreground">{FONTS_TEXT.intro}</p>
            </div>
            <Button
              type="button"
              className="flex-none"
              disabled={offline}
              onClick={() => setImporting(true)}
            >
              <Upload aria-hidden="true" />
              {FONTS_TEXT.import}
            </Button>
          </div>
          <FontList onImport={() => setImporting(true)} />
          <ImportFontsDialog open={importing} onOpenChange={setImporting} />
        </section>
        <aside
          aria-label="Preview"
          // Pinned while the list scrolls under it, so the font being looked at stays in view.
          className="sticky top-0 flex h-[calc(100svh-3.5rem)] w-[440px] min-w-80 flex-col gap-3.5 self-start overflow-y-auto border-l p-6"
        >
          <FontPane />
        </aside>
      </div>
    </div>
  );
}

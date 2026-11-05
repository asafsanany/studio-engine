import { isFolderDeleted, type Job } from '@studio/shared';
import { useJobMusic } from '@/data';
import { type RowActions, RowActionsContext } from '@/features/jobs/cells/use-row-actions';
import { openPreview } from '@/features/review/preview-viewer';
import { JobPanelTools } from './JobPanelTools';
import { JobSheetDetails } from './JobSheetDetails';
import { JobSheetGenerated } from './JobSheetGenerated';
import { JobSheetHistory } from './JobSheetHistory';
import { JobSheetNotes } from './JobSheetNotes';
import { JobSheetNow } from './JobSheetNow';
import { JobSheetSteps } from './JobSheetSteps';
import { JobSheetStock } from './JobSheetStock';
import { JobSheetVersions } from './JobSheetVersions';
import { useSheetInstagram } from './use-sheet-instagram';

/**
 * Everything about a job, open under its row in the list (a click on the row opens it, a second
 * click closes it). The job sheet's parts, in two columns from 1024 px up and one below:
 *
 * - left, where the job is and what to do: Now (the sentence and the buttons that move it on),
 *   Steps, Generated (a job made without footage) and Notes;
 * - right, what it is made of and where it has been: Details, Stock media, Versions and History.
 *
 * Show in Finder and ⋯ (the row's menu) sit at the top right; the row above already says the name,
 * the client and the status. Each part decides for itself whether it has anything to say.
 *
 * It is the second line of the row's grid (`JobRow`), across all of its columns, starting under the
 * name (28 px in from the row's own padding).
 *
 * The parts act on the row's set of requests (`actions`, `RowActionsContext`): the row's button,
 * its right-click menu, ⋯ and the parts' buttons are one set, so a press in one disables the others.
 */
export function JobRowPanel({ job, actions }: { job: Job; actions: RowActions }) {
  // The job's music for Details' Music row (Soundtrack): nothing is asked while the switch is off.
  const music = useJobMusic(job.id).data ?? null;
  // The linked reel's numbers for Details' On Instagram row (Clients × Instagram), asked only while the switch is on.
  const instagram = useSheetInstagram(job);
  return (
    <RowActionsContext.Provider value={actions}>
      <section
        data-slot="job-row-panel"
        aria-label={job.name}
        className="relative col-span-full grid animate-in cursor-auto grid-cols-1 gap-6 pr-12 pb-5 pl-7 duration-200 ease-in-out fade-in-0 lg:grid-cols-2 lg:gap-x-12"
        // A right-click here is the browser's (copy a path), not the row's menu.
        onContextMenu={(event) => event.stopPropagation()}
      >
        <div className="absolute -top-1 right-0">
          <JobPanelTools job={job} actions={actions} />
        </div>
        <div data-slot="job-row-panel-now" className="flex min-w-0 flex-col gap-6">
          <JobSheetNow job={job} />
          <JobSheetSteps job={job} />
          <JobSheetGenerated job={job} />
          <JobSheetNotes job={job} />
        </div>
        <div data-slot="job-row-panel-about" className="flex min-w-0 flex-col gap-6">
          <JobSheetDetails job={job} music={music} instagram={instagram} />
          <JobSheetStock job={job} />
          {!isFolderDeleted(job) && (
            <JobSheetVersions
              job={job}
              // The current cut is the live preview, which is what "View preview" shows too.
              onView={(version) => openPreview(job.id, version.current ? null : version.n)}
            />
          )}
          <JobSheetHistory job={job} />
        </div>
      </section>
    </RowActionsContext.Provider>
  );
}

import { Check } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { type CameraWaitingJob, jobsText, otherJobsText, waitingExplanation } from './camera-wait';

/** The banner's buttons. */
export const CAMERA_BANNER_TEXT = {
  import: 'Import a camera LUT',
  resume: 'Resume',
} as const;

export interface CameraLutBannerProps {
  /** The jobs that wait for a camera LUT, longest waiting first (`cameraWaitingJobs`). */
  waiting: readonly CameraWaitingJob[];
  /** A camera LUT was imported on this page a moment ago: the banner says so. */
  imported: boolean;
  /** The titles of the jobs Resume was just pressed for ("Ofek · FPV 3"); empty for none. */
  resumed: readonly string[];
  /** "Import a camera LUT": opens the import dialog for this job. */
  onImport: (job: CameraWaitingJob) => void;
  /** "Resume": runs these jobs again, now that the library has their LUT. */
  onResume: (jobs: readonly CameraWaitingJob[]) => void;
  /** The engine can't be reached: the buttons wait with it. */
  offline?: boolean;
}

/** The words of the banner for these jobs, as a list of text and bold parts. */
function Bold({ children }: { children: string }) {
  return <b className="font-semibold">{children}</b>;
}

/**
 * The line under the header when a job waits for a camera LUT (board LUPage, state `needed`, and
 * LUStates 9): an amber dot, what the job is waiting for, and the button that opens Import. When the
 * library has the LUT for a waiting job's footage it says so, and the button is Resume. A moment
 * after Resume it says which jobs went on. Nothing at all while no job waits.
 */
export function CameraLutBanner({
  waiting,
  imported,
  resumed,
  onImport,
  onResume,
  offline = false,
}: CameraLutBannerProps) {
  const ready = waiting.filter((item) => item.fit.kind === 'ready');
  const first = waiting[0];

  if (ready.length > 0) {
    const titles = ready.map((item) => item.title);
    const lut = ready[0]?.fit.kind === 'ready' ? ready[0].fit.lut : null;
    return (
      <Shell state="ready">
        <span className="min-w-0 flex-1">
          {imported || lut === null ? (
            'Imported. Resume '
          ) : (
            <>
              <Bold>{`“${lut.name}”`}</Bold>
              {' matches. Resume '}
            </>
          )}
          <Bold>{jobsText(titles)}</Bold>
          {' to use it.'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-none px-2.5 text-[13px]"
          disabled={offline}
          onClick={() => onResume(ready)}
        >
          {CAMERA_BANNER_TEXT.resume}
        </Button>
      </Shell>
    );
  }

  if (first !== undefined) {
    const others = waiting.length - 1;
    return (
      <Shell state="waiting">
        <span className="min-w-0 flex-1">
          <Bold>{first.title}</Bold>
          {others > 0 ? ` ${otherJobsText(others)} are` : ' is'}
          {` waiting for a camera LUT. ${waitingExplanation(first)}`}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          className="h-7 flex-none px-2.5 text-[13px]"
          disabled={offline}
          onClick={() => onImport(first)}
        >
          {CAMERA_BANNER_TEXT.import}
        </Button>
      </Shell>
    );
  }

  if (resumed.length > 0) {
    return (
      <Shell state="resumed">
        <span className="min-w-0 flex-1">
          {'Resumed '}
          <Bold>{jobsText(resumed)}</Bold>
          {'.'}
        </span>
      </Shell>
    );
  }

  return null;
}

/** The bar itself: full width under the 56 px header with a hairline, like the offline bar. */
function Shell({
  state,
  children,
}: {
  state: 'waiting' | 'ready' | 'resumed';
  children: ReactNode;
}) {
  return (
    <div
      role="status"
      data-slot="camera-lut-banner"
      data-state={state}
      className="flex flex-none items-center gap-2.5 border-b bg-card px-6 py-2 text-[13px] text-card-foreground"
    >
      {state === 'resumed' ? (
        <Check aria-hidden="true" className="size-4 flex-none text-status-ready" />
      ) : (
        <span aria-hidden="true" className="size-2 flex-none rounded-full bg-status-held" />
      )}
      {children}
    </div>
  );
}

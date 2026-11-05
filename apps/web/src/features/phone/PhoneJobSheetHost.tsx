import type { Job } from '@studio/shared';
import { useRouter, useRouterState } from '@tanstack/react-router';
import { useEffect, useRef, useState } from 'react';
import { Sheet, SheetContent } from '@/components/ui/sheet';
import { useListedJobs, useOrphanDeliveries } from '@/data';
import { closeJobSheet, dropJobParam, jobIdOf } from '@/features/job-sheet/job-sheet-search';
import { sheetState } from '@/features/job-sheet/job-sheet-state';
import { CancelDialogHost, DeleteJobDialogHost } from '@/features/jobs/cells';
import { MarkPaidDialogHost } from '@/features/jobs/mark-paid/MarkPaidDialogHost';
import { UseLookDialogHost } from '@/features/jobs/use-look/UseLookDialogHost';
import { PhoneJobSheet, PhoneJobSheetGone } from './PhoneJobSheet';
import { PhoneMarkPaidSheet } from './PhoneMarkPaidSheet';
import { PhoneNoteDialogHost } from './PhoneNoteSheet';
import { ignoreMessageTaps, PHONE_SHEET_CLASSES } from './phone-sheet-shell';

/** Closes closer together than this are one: closing goes Back, and Back must not be sent twice. */
const CLOSE_DEBOUNCE_MS = 400;

/**
 * The phone job sheet's place in the shell: `PhoneShell` mounts it beside the page, so every phone
 * page gets it. It is driven by the address, like the Mac's sheet (`JobSheetHost`): `?job=<id>` is
 * the job shown, so a reload keeps it open, Back closes it, and a link can point straight at a job.
 * Whoever opens it (the phone Jobs list, a notification) calls `openJobSheet`, the same function
 * the Mac's rows call; nothing else passes between the page and the sheet.
 *
 * - The job is looked up in the whole list (`useListedJobs`: the unpaid videos whose folder was
 *   deleted too), so a job the page's tab or search leaves out still opens.
 * - An address that names no job is cleaned (replaced) once the list has arrived. A job that was
 *   open and leaves the list says "This job is gone" and stays until closed.
 * - The sheet closes with ×, a tap on the dimmed page, Esc, or Back; a tap on a message (its
 *   Undo) leaves it open. It has no ↑ ↓ and no J K keys
 *   (the Mac's walk through the list): on the phone you go back to the list and tap the next job.
 *
 * It also holds the dialogs the sheet's rows ask for (`askForNote`, `askToCancel`, `askToUseLook`,
 * `askToMarkPaid`): the phone Jobs list has no `JobsListSection` to mount them, so they live here,
 * and the Mac's `JobsListSection` leaves its own out while the phone layout shows (see there), so a
 * Mac page inside the phone shell (a client's page) does not draw each twice. Mark paid is the
 * phone's bottom sheet (`PhoneMarkPaidSheet`) over whatever page or job sheet asked for it, and so
 * is the note for the editor while the Songs switch is on (`PhoneNoteSheet`, with Add photo; off,
 * it is the dialog it always was). Review's host (`PhoneReviewHost`) is in the shell too.
 *
 * `jobs` is the live job list of the shell, for the dialogs; the sheet reads the listed one.
 */
export function PhoneJobSheetHost({ jobs }: { jobs: readonly Job[] | undefined }) {
  const router = useRouter();
  const openId = useRouterState({ select: (state) => jobIdOf(state.location.search) });
  const { data: listed } = useListedJobs();
  const orphans = useOrphanDeliveries();
  const all = listed ?? jobs;

  // The job as last shown: for the exit animation, and for "gone".
  const [seen, setSeen] = useState<Job | null>(null);
  const state = sheetState({
    openId,
    jobs: all,
    // The list is whole once the videos without a folder have been asked for too.
    listComplete: all !== undefined && !orphans.isPending,
    seenId: seen?.id ?? null,
  });
  if (state.kind === 'open' && seen !== state.job) setSeen(state.job);

  // An address that names no job opens nothing and is cleaned up.
  const unknown = state.kind === 'unknown';
  useEffect(() => {
    if (unknown) void dropJobParam(router);
  }, [unknown, router]);

  // A second close right after the first would go Back once more, out of the page.
  const closedAt = useRef(0);
  const close = () => {
    const now = Date.now();
    if (now - closedAt.current < CLOSE_DEBOUNCE_MS) return;
    closedAt.current = now;
    closeJobSheet(router);
  };

  const open = state.kind === 'open' || state.kind === 'gone';
  // While it closes, the sheet keeps showing the job it had.
  const shown: Job | null = state.kind === 'open' ? state.job : seen;
  const content = useRef<HTMLDivElement>(null);

  return (
    <>
      <Sheet open={open} onOpenChange={(next) => !next && close()}>
        <SheetContent
          ref={content}
          side="bottom"
          showCloseButton={false}
          aria-describedby={undefined}
          className={PHONE_SHEET_CLASSES}
          // The focus starts on the sheet itself: no button is lit by the tap that opened it.
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            content.current?.focus();
          }}
          // A tap on a message (its Undo) is not a tap on the page behind: the sheet stays.
          onInteractOutside={ignoreMessageTaps}
        >
          {state.kind === 'gone' && seen !== null ? (
            <PhoneJobSheetGone last={seen} onClose={close} />
          ) : shown !== null ? (
            <PhoneJobSheet key={shown.id} job={shown} jobs={all ?? []} onClose={close} />
          ) : null}
        </SheetContent>
      </Sheet>
      {/* Page-level dialogs the sheet's rows ask for: they hold their own state, keyed by job. */}
      <CancelDialogHost jobs={jobs} />
      <DeleteJobDialogHost />
      <PhoneNoteDialogHost jobs={jobs} />
      <UseLookDialogHost jobs={jobs} />
      {/* The whole listed jobs: a video whose folder was deleted is still payable. */}
      <MarkPaidDialogHost jobs={all} view={PhoneMarkPaidSheet} />
    </>
  );
}

import { jobsUnreachable, useListedJobs } from '@/data';
import { JobSheetHost } from '@/features/job-sheet/JobSheetHost';
import { usePhoneLayout } from '@/features/phone/use-phone-layout';
import { PreviewViewerHost } from '@/features/review/PreviewViewerHost';
import { ReviewDialogHost } from '@/features/review/ReviewDialogHost';
import { SeriesDialogHosts } from '@/features/series/SeriesDialogHosts';
import {
  CancelDialogHost,
  DeleteJobDialogHost,
  NoteDialogHost,
  RenameJobDialogHost,
} from './cells';
import { JobsList } from './JobsList';
import { MarkPaidDialogHost } from './mark-paid/MarkPaidDialogHost';
import { RefusedActionsHost } from './RefusedActionsHost';
import { UseLookDialogHost } from './use-look/UseLookDialogHost';

/**
 * The Jobs list over the live job list, with the dialogs and notices its rows ask for. The Jobs
 * page shows every job; a client's page passes its `clientId` and shows that client's, and a
 * series page also passes its `seriesId` and shows only that series' episodes. All of them also
 * list the unpaid videos whose folder was deleted (`useListedJobs`), which are still payable.
 *
 * Under the phone layout this page is a Mac page shown inside the phone shell, whose
 * `PhoneJobSheetHost` already holds the job sheet and the dialogs its rows ask for (Stop this edit?,
 * Note for the editor, Use this look, and Mark paid as a bottom sheet), `PhoneReviewHost` the
 * full-screen Review, and the shell the one toaster. The page leaves its own out then, or each
 * would be drawn twice: the sheet's two kinds, each dialog and the messages.
 */
export function JobsListSection({ clientId, seriesId }: { clientId?: string; seriesId?: string }) {
  const { data: jobs, isError, failureCount, refetch } = useListedJobs();
  const phoneLayout = usePhoneLayout();
  return (
    <>
      {/*
        A list that has not arrived after a failed fetch is "can't reach the engine" (the list
        shows it with a retry link); the query keeps trying in the background and the list fills
        in by itself when the engine is back. A failed refetch with data leaves the list as it
        is: the list only reads `failed` while there is no list.
      */}
      <JobsList
        jobs={jobs}
        failed={jobsUnreachable({ data: jobs, isError, failureCount })}
        onRetry={() => void refetch()}
        clientId={clientId}
        seriesId={seriesId}
      />
      {/* The "Stop this edit?" dialog belongs to the page, not to a row: rows move between pages. */}
      {!phoneLayout && <CancelDialogHost jobs={jobs} />}
      {!phoneLayout && <DeleteJobDialogHost />}
      {/* "Rename this video": the folder and the export are renamed with it. The phone has no rename. */}
      {!phoneLayout && <RenameJobDialogHost />}
      {/* The review dialog: a job in Review's live preview, its notes, Send and Approve. Page level too. */}
      {!phoneLayout && <ReviewDialogHost jobs={jobs} />}
      {!phoneLayout && <PreviewViewerHost jobs={jobs} />}
      {/* So does "Note for the editor": it holds the job while the person writes (auto-hold). */}
      {!phoneLayout && <NoteDialogHost jobs={jobs} />}
      {/* And "Use this look for <client>?", asked for from a ready row's menu (its message, with Undo, is drawn by the toaster below). */}
      {!phoneLayout && <UseLookDialogHost jobs={jobs} />}
      {/* And "Start a series from <job>?" and "Use <job> as the format?", asked for from a ready row's menu (their messages, with Undo, are drawn by the toaster below). */}
      <SeriesDialogHosts />
      {/* And "Mark paid · <client>", asked for from a delivered row's banknote button or menu (its message, with Undo, is drawn by the toaster too). The phone shell has the bottom sheet of it. */}
      {!phoneLayout && <MarkPaidDialogHost jobs={jobs} />}
      {/* A refused Hold, Release, Resume or Retry whose row has left the page is said here, as a toast. The phone shell draws the toasts: one toaster, not two. */}
      <RefusedActionsHost jobs={jobs} toaster={!phoneLayout} />
      {/* And the job sheet: a click on a row opens a panel with everything about the job (behind the Job sheet switch). */}
      {!phoneLayout && <JobSheetHost jobs={jobs} clientId={clientId} seriesId={seriesId} />}
    </>
  );
}

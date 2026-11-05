import type { Job } from '@studio/shared';
import { draftStageOf } from '@studio/shared';
import { X } from 'lucide-react';
import { type ComponentProps, Suspense } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogTitle,
} from '@/components/ui/dialog';
import { useJobAction, useJobFeed } from '@/data';
import { ChatStage } from '@/features/job-chat/ChatStage';
import { DraftProgress } from '@/features/job-chat/DraftProgress';
import { JobChat } from '@/features/job-chat/JobChat';
import {
  progressTitle,
  runningLabel,
  stageWaiting,
  waitingFooter,
} from '@/features/job-chat/job-chat-logic';
import { useRunningCut } from '@/features/job-chat/use-running-cut';
import { CONTROLS_HEIGHT } from '@/features/review/fit-player';
import { LazyPreviewPlayer } from '@/features/review/LazyPreviewPlayer';
import { REVIEW_DIALOG_TEXT } from '@/features/review/review-text';
import { useViewportSize } from '@/features/review/use-viewport-size';

/** The player's stage while the job runs: the phone Review's with its notes open (260 px). */
const STAGE_HEIGHT = 260;

/**
 * The phone's Review while the job runs (Draft & chat, DR8; board DCPhone, the first phone): full
 * screen, the job and what runs in the header, the cut the run changes (`useRunningCut`; before
 * cut 1 its place says so), the progress box with Stop, the chat as it grows, and a footer that says
 * when Send opens. Once the job
 * is in Review the host shows the phone Review again, with the chat in its notes panel.
 */
export function PhoneChatReview({
  job,
  open,
  onOpenChange,
  onCloseAutoFocus,
}: {
  job: Job;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}) {
  const feed = useJobFeed(job.id, { enabled: open, live: true });
  const cancel = useJobAction('cancel');
  const items = feed.data?.items ?? [];
  const runCut = useRunningCut(job, open);
  const { width: viewportWidth } = useViewportSize();
  const stage = (waiting: string | null) => (
    <ChatStage width="100%" height={STAGE_HEIGHT + CONTROLS_HEIGHT} waiting={waiting} />
  );
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        data-slot="phone-chat"
        showCloseButton={false}
        className="inset-0 z-50 flex h-dvh w-full max-w-none translate-x-0 translate-y-0 flex-col gap-0 overflow-hidden rounded-none border-0 bg-background p-0 pt-safe pr-safe pl-safe shadow-none transition-none [-webkit-tap-highlight-color:transparent] data-[state=closed]:zoom-out-100 data-[state=open]:zoom-in-100 sm:max-w-none"
        onOpenAutoFocus={(event) => event.preventDefault()}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <header className="flex h-12 shrink-0 items-center gap-2 border-b border-white/10 pr-1 pl-4">
          <div className="flex min-w-0 flex-1 flex-col">
            <DialogTitle className="truncate text-sm leading-tight font-semibold">
              {job.name}
            </DialogTitle>
            <span className="truncate text-xs text-muted-foreground">
              {job.client} · {runningLabel(job)}
            </span>
          </div>
          <DialogClose asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon"
              aria-label={REVIEW_DIALOG_TEXT.close}
              className="size-11 flex-none text-muted-foreground dark:hover:bg-accent"
            >
              <X aria-hidden="true" className="size-5" />
            </Button>
          </DialogClose>
        </header>
        <DialogDescription className="sr-only">{REVIEW_DIALOG_TEXT.description}</DialogDescription>
        {runCut.play === null ? (
          stage(stageWaiting(job, runCut.loading))
        ) : (
          <Suspense fallback={stage(null)}>
            <LazyPreviewPlayer
              src={runCut.play.src}
              videoWidth={runCut.play.width}
              videoHeight={runCut.play.height}
              durationSec={runCut.play.durationSec}
              maxWidth={viewportWidth}
              maxHeight={STAGE_HEIGHT}
              fitToStage
              className="flex-none"
              stageClassName="h-[260px] shrink-0"
            />
          </Suspense>
        )}
        <DraftProgress
          title={progressTitle(job)}
          stage={job.runKind === 'edit' && job.state === 'editing' ? draftStageOf(job.step) : null}
          stages={job.runKind === 'edit'}
          stopping={cancel.isPending}
          disabled={job.state !== 'editing'}
          onStop={() => cancel.mutate(job.id)}
        />
        <JobChat jobId={job.id} items={items} live={job.state === 'editing'} />
        <p
          data-slot="phone-chat-footer"
          className="m-0 shrink-0 border-t border-white/10 px-4 pt-3 pb-[max(12px,env(safe-area-inset-bottom))] text-[13px] text-muted-foreground"
        >
          {waitingFooter(job)}
        </p>
      </DialogContent>
    </Dialog>
  );
}

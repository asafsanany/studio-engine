import { draftStageOf, type Job } from '@studio/shared';
import type { ReactNode } from 'react';
import { Button } from '@/components/ui/button';
import { useJobAction, useJobFeed } from '@/data';
import { DraftProgress } from './DraftProgress';
import { JobChat } from './JobChat';
import { isRunning, progressTitle } from './job-chat-logic';
import { JOB_CHAT_TEXT } from './job-chat-text';

/**
 * The job's chat as Review's right-hand column (Draft & chat, DR7; board DCDialog, card 38): 440 px
 * with its left border. While the job runs, the progress box sits on top with Stop (Stop is Cancel:
 * what the run made is kept and Resume carries on). Then the chat, polled while the run goes on,
 * with the notes that wait for Send at its end (`notes`), and the composer under it (`composer`).
 */
export function JobChatPanel({
  job,
  open,
  notes,
  composer,
}: {
  job: Job;
  /** The dialog is open: only then is the chat asked for. */
  open: boolean;
  /** The unsent notes, under "Not sent yet"; nothing when there are none. */
  notes?: ReactNode;
  /** The note box, the recording box, or the line that says notes wait. */
  composer: ReactNode;
}) {
  const running = isRunning(job);
  const feed = useJobFeed(job.id, { enabled: open, live: running });
  const cancel = useJobAction('cancel');
  const items = feed.data?.items ?? [];

  return (
    <section
      data-slot="review-chat"
      aria-label="Chat"
      className="flex w-[440px] shrink-0 flex-col border-l"
    >
      {running && (
        <DraftProgress
          title={progressTitle(job)}
          stage={job.runKind === 'edit' && job.state === 'editing' ? draftStageOf(job.step) : null}
          stages={job.runKind === 'edit'}
          stopping={cancel.isPending}
          disabled={job.state !== 'editing'}
          onStop={() => cancel.mutate(job.id)}
        />
      )}
      {feed.isError && feed.data === undefined ? (
        <div className="m-auto flex flex-col items-center gap-3 p-6 text-center">
          <p className="m-0 text-muted-foreground">{JOB_CHAT_TEXT.failed}</p>
          <Button type="button" variant="outline" size="sm" onClick={() => void feed.refetch()}>
            {JOB_CHAT_TEXT.retry}
          </Button>
        </div>
      ) : (
        <JobChat
          jobId={job.id}
          items={items}
          live={job.state === 'editing'}
          empty={
            feed.data === undefined ? (
              <span role="status" className="m-auto text-muted-foreground">
                {JOB_CHAT_TEXT.loading}
              </span>
            ) : (
              <div className="my-auto flex flex-col gap-1.5">
                <h3 className="m-0 text-base font-semibold">{JOB_CHAT_TEXT.emptyTitle}</h3>
                <p className="m-0 text-muted-foreground [text-wrap:pretty]">
                  {JOB_CHAT_TEXT.emptyHint}
                </p>
              </div>
            )
          }
          after={notes}
        />
      )}
      {composer}
    </section>
  );
}

import type { Job } from '@studio/shared';
import { IconAction } from '@/components/jobs/IconAction';
import { useDraftChatEnabled, useIsAdmin } from '@/data';
import { isRunning } from '@/features/job-chat/job-chat-logic';
import { canViewPreview, openPreview } from '@/features/review/preview-viewer';
import { openReview } from '@/features/review/review-dialog';
import { askToMarkPaid } from '../mark-paid/request';
import { ActionError } from './ActionError';
import { nextStepAction } from './row-actions';
import { type RowActions, useRowActions, useRowActionsContext } from './use-row-actions';

/**
 * Action: the one icon button for the row's next step (see `nextStepAction`): Start now, Release,
 * Retry from <step>, Resume, Mark delivered (an approved job), Mark paid… (a delivered one), or
 * Review. When there is no next step and a preview exists, it opens the playback-only viewer.
 * With Draft & chat on, a job that waits in line or runs opens its chat (Review) from the same icon,
 * "Open the chat", so the draft can be watched as it goes.
 * Review and View preview send nothing, so a request in flight does not disable them; Mark paid…
 * likewise only asks the page for its dialog. Hold, Cancel…, Download MP4, Copy error and the
 * ways back from a stage are in the row's right-click menu (`JobRow`).
 *
 * - Server actions go through the row's actions (`useRowActions`), which move the job to its next
 *   state at once and put it back if the server refuses. While one of the row's requests is in
 *   flight its server action is disabled.
 * - A refused action (409, server unreachable) explains itself in a tooltip under the button,
 *   whether the button or the row's menu sent it. If the row has left the page by the time the
 *   answer comes (it moves as jobs change), the tooltip went with it; then the page says it
 *   instead, as a toast (`RefusedActionsHost`).
 *
 * Inside the Jobs list the row owns the actions, because its menu shares them; a cell rendered on
 * its own makes its own.
 */
export function ActionCell({ job }: { job: Job }) {
  const shared = useRowActionsContext();
  return shared === null ? (
    <OwnActionCell job={job} />
  ) : (
    <NextStepButton job={job} actions={shared} />
  );
}

function OwnActionCell({ job }: { job: Job }) {
  const actions = useRowActions(job);
  return <NextStepButton job={job} actions={actions} />;
}

function NextStepButton({ job, actions }: { job: Job; actions: RowActions }) {
  // Mark delivered and Mark paid… are the admin's: an editor's ready row has no button.
  const action = nextStepAction(job, useIsAdmin());
  const chat = useDraftChatEnabled() && isRunning(job);
  return (
    <ActionError message={actions.refusal} onDismiss={actions.dismissRefusal}>
      {/* Always 32 px tall, even with no button, so the refusal tooltip has something to point at. */}
      <div data-row-actions={job.id} className="flex min-h-8 items-center justify-end">
        {action === null ? (
          chat ? (
            <IconAction action="review" label="Open the chat" onClick={() => openReview(job.id)} />
          ) : canViewPreview(job) && job.state !== 'review' ? (
            <IconAction action="review" label="View preview" onClick={() => openPreview(job.id)} />
          ) : null
        ) : action.kind === 'review' ? (
          <IconAction action="review" label={action.label} onClick={() => openReview(job.id)} />
        ) : action.kind === 'pay' ? (
          <IconAction action="pay" label={action.label} onClick={() => askToMarkPaid(job)} />
        ) : (
          <IconAction
            action={action.kind}
            label={action.label}
            disabled={actions.busy}
            onClick={() => actions.run(action)}
          />
        )}
      </div>
    </ActionError>
  );
}

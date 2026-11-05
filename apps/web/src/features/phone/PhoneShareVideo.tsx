import type { Job } from '@studio/shared';
import { Download, Loader2, Send, Share } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { useMoneyPrice } from '@/data';
import { ActionError } from '@/features/jobs/cells/ActionError';
import { STAGE_LABELS } from '@/features/jobs/cells/row-actions';
import type { RowActions } from '@/features/jobs/cells/use-row-actions';
import { REVIEW_DIALOG_TEXT } from '@/features/review/review-text';
import {
  gettingLabel,
  SHARE_FAILED_REASON,
  SHARE_UNSUPPORTED_REASON,
  type ShareFlow,
  type ShareTarget,
  sentItLine,
} from './share-video';
import type { ShareVideo } from './use-share-video';

/** The big button's look: 48 px, the whole width, 15 px words and an 18 px icon (as `NowButtons`'). */
const BIG_BUTTON = "h-12 w-full text-[15px] [&_svg:not([class*='size-'])]:size-[18px]";

/**
 * The sheet's big button for an Approved job (board MJobSheet, state approved), by where the share
 * flow is:
 *
 * - on its way: "Getting the video · 12 of 27 MB", a fill growing in the button's place
 * - in hand: Share video, which opens the share sheet from the tap
 * - a browser that can't share a file, or a fetch that failed: Download MP4 (the Mac's), and for a
 *   failed fetch why, under it
 */
export function ShareVideoButton({
  flow,
  target,
  onShare,
}: {
  flow: ShareFlow;
  target: ShareTarget;
  onShare: () => void;
}) {
  if (flow.phase === 'unsupported' || flow.phase === 'failed') {
    return (
      <div className="flex flex-col gap-2">
        <Button asChild className={BIG_BUTTON}>
          <a href={target.url} download data-sheet-action="download">
            <Download aria-hidden="true" />
            Download MP4
          </a>
        </Button>
        {flow.phase === 'failed' && (
          <p data-slot="share-failed" className="text-[13px] text-pretty text-muted-foreground">
            {SHARE_FAILED_REASON(flow.message)}
          </p>
        )}
        {flow.phase === 'unsupported' && (
          <p
            data-slot="share-unsupported"
            className="text-[13px] text-pretty text-muted-foreground"
          >
            {SHARE_UNSUPPORTED_REASON}
          </p>
        )}
      </div>
    );
  }
  if (flow.phase === 'ready' || flow.phase === 'sharing' || flow.phase === 'asking') {
    return (
      <Button
        type="button"
        data-sheet-action="share"
        // While the share sheet is open a second tap does nothing (it is under the share sheet).
        aria-disabled={flow.phase === 'sharing' || undefined}
        onClick={onShare}
        className={BIG_BUTTON}
      >
        <Share aria-hidden="true" />
        Share video
      </Button>
    );
  }
  // Getting the video, or about to (the fetch starts as the sheet opens).
  const { label, pct } =
    flow.phase === 'getting'
      ? gettingLabel(flow.loaded, flow.total)
      : gettingLabel(0, target.sizeBytes);
  return (
    <div
      role="status"
      data-slot="share-getting"
      className="relative h-12 overflow-hidden rounded-md bg-primary/25"
    >
      <div
        aria-hidden="true"
        data-slot="share-getting-fill"
        className="absolute inset-y-0 left-0 bg-primary transition-[width] duration-200 ease-in-out"
        style={{ width: `${pct}%` }}
      />
      <span className="absolute inset-0 flex items-center justify-center text-[15px] font-medium text-primary-foreground tabular-nums">
        {label}
      </span>
    </div>
  );
}

/**
 * The Review header's icon for the preview video (U16, in place of Download the preview video), by
 * where the share flow is: a spinner while the small MP4 comes in, the Share icon once it is in
 * hand (the tap opens the share sheet), and the Mac's download link only where the browser can't
 * share a file, or the fetch failed, with the reason as its tooltip.
 */
export function ShareIconButton({
  flow,
  target,
  onShare,
}: {
  flow: ShareFlow;
  target: ShareTarget;
  onShare: () => void;
}) {
  const className = 'size-11 flex-none text-muted-foreground dark:hover:bg-accent';
  if (flow.phase === 'unsupported' || flow.phase === 'failed') {
    return (
      <Button asChild variant="ghost" size="icon" className={className}>
        <a
          href={target.url}
          download
          data-sheet-action="download"
          aria-label={REVIEW_DIALOG_TEXT.downloadPreview}
          title={
            flow.phase === 'failed' ? SHARE_FAILED_REASON(flow.message) : SHARE_UNSUPPORTED_REASON
          }
        >
          <Download aria-hidden="true" className="size-5" />
        </a>
      </Button>
    );
  }
  if (flow.phase === 'idle' || flow.phase === 'getting') {
    return (
      <Button
        type="button"
        variant="ghost"
        size="icon"
        data-sheet-action="share-getting"
        aria-label={REVIEW_DIALOG_TEXT.gettingPreview}
        aria-disabled="true"
        aria-busy="true"
        className={className}
      >
        <Loader2 aria-hidden="true" className="size-5 animate-spin" />
      </Button>
    );
  }
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      data-sheet-action="share"
      aria-label={REVIEW_DIALOG_TEXT.sharePreview}
      // While the share sheet is open a second tap does nothing (it is under the share sheet).
      aria-disabled={flow.phase === 'sharing' || undefined}
      onClick={onShare}
      className={className}
    >
      <Share aria-hidden="true" className="size-5" />
    </Button>
  );
}

/**
 * "Sent it to <client>?" (board MJobSheetSent): after the share sheet closed with the video sent.
 * Mark delivered is the Mac's (the deliver route, then "Delivered to <client> · ₪40 counts in
 * October" with Undo); Not yet goes back to Share video. Both wait while a request for the job is
 * on its way.
 */
export function SentItCard({
  client,
  line,
  busy,
  onNotYet,
  onDeliver,
}: {
  client: string;
  line: string;
  busy: boolean;
  onNotYet: () => void;
  onDeliver: () => void;
}) {
  return (
    <div
      role="status"
      data-slot="share-sent"
      className="flex flex-col gap-3 rounded-[10px] border border-status-delivered/35 bg-status-delivered/7 p-3.5"
    >
      <div className="flex flex-col gap-0.5">
        <span className="text-base leading-[1.43] font-semibold">
          Sent it to <bdi>{client}</bdi>?
        </span>
        <span className="text-pretty text-muted-foreground">{line}</span>
      </div>
      <div className="flex gap-2">
        <Button
          type="button"
          variant="outline"
          data-share-answer="not-yet"
          disabled={busy}
          onClick={onNotYet}
          className="h-11 flex-1 text-[15px]"
        >
          Not yet
        </Button>
        <Button
          type="button"
          data-share-answer="deliver"
          disabled={busy}
          onClick={onDeliver}
          className="h-11 flex-1 text-[15px]"
        >
          <Send aria-hidden="true" className="size-4" />
          {STAGE_LABELS.deliver}
        </Button>
      </div>
    </div>
  );
}

/**
 * What the share flow shows, from its state: the big button, or "Sent it to <client>?" once the
 * video was shared. `price` is the line under the question (`sentItLine`). A refusal of the job's
 * last request (Mark delivered from here or from the list) is explained under it, as under the
 * other big buttons.
 */
export function ShareVideoView({
  job,
  share,
  line,
  actions,
}: {
  job: Pick<Job, 'client'>;
  share: Pick<ShareVideo, 'flow' | 'target' | 'share' | 'notYet'> & { target: ShareTarget };
  line: string;
  actions: Pick<RowActions, 'run' | 'busy' | 'refusal' | 'dismissRefusal'>;
}) {
  return (
    <ActionError message={actions.refusal} onDismiss={actions.dismissRefusal}>
      <div data-slot="share-video">
        {share.flow.phase === 'asking' ? (
          <SentItCard
            client={job.client}
            line={line}
            busy={actions.busy}
            onNotYet={share.notYet}
            onDeliver={() => actions.run({ kind: 'deliver', label: STAGE_LABELS.deliver })}
          />
        ) : (
          <ShareVideoButton flow={share.flow} target={share.target} onShare={share.share} />
        )}
      </div>
    </ActionError>
  );
}

/**
 * Share video in the phone job sheet, for an Approved job (Mobile 4): the share flow
 * (`useShareVideo`) and the price Mark delivered would record (`useMoneyPrice`), asked as the
 * sheet opens. `share` is the sheet's flow (it also decides the list: Download MP4 leaves the list
 * when it is the button).
 */
export function PhoneShareVideo({
  job,
  share,
  actions,
}: {
  job: Job;
  share: ShareVideo;
  actions: RowActions;
}) {
  const { target } = share;
  const price = useMoneyPrice(job.client, { enabled: target !== null });
  if (target === null) return null;
  return (
    <ShareVideoView
      job={job}
      share={{ ...share, target }}
      line={sentItLine(price.data, new Date())}
      actions={actions}
    />
  );
}

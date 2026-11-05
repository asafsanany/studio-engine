import { Check, CircleAlert, Info, LoaderCircle } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Progress } from '@/components/ui/progress';
import { cn } from '@/lib/utils';
import type { StyleStatus } from './style-status';

/** The status text, with the job's name (if it has one) in a `<bdi>` so Hebrew does not scramble the sentence. */
export function StatusText({ status }: { status: StyleStatus }) {
  const job = status.kind === 'busy' ? status.job : undefined;
  const at = job === undefined ? -1 : status.text.indexOf(job);
  if (job === undefined || at < 0) return <>{status.text}</>;
  return (
    <>
      {status.text.slice(0, at)}
      <bdi>{job}</bdi>
      {status.text.slice(at + job.length)}
    </>
  );
}

/** A spinner that stands still for people who asked for less motion. */
export function Spinner({ className }: { className?: string }) {
  return (
    <LoaderCircle
      aria-hidden="true"
      className={cn('animate-spin motion-reduce:animate-none', className)}
    />
  );
}

/**
 * The one line above the style.md that says what is going on: bytes on their way (with a bar),
 * the files being analysed, the files added (for 10 s), or what went wrong, with Retry when the
 * style run failed. A calm box like the board's, not a toast: it is part of the page.
 */
export function StyleStatusLine({
  status,
  onRetry,
  retrying = false,
}: {
  status: StyleStatus;
  onRetry: () => void;
  retrying?: boolean;
}) {
  const failed = status.kind === 'error';
  return (
    <div
      role={failed ? 'alert' : 'status'}
      data-status={status.kind}
      className={cn(
        'flex flex-col gap-2 rounded-md border px-3 py-2.5 text-[13px]',
        failed
          ? 'border-status-failed/40 bg-status-failed/10 text-status-failed-foreground'
          : 'bg-muted/30 text-zinc-300',
      )}
    >
      <div className="flex items-center gap-2">
        {status.kind === 'done' ? (
          <Check aria-hidden="true" className="size-4 shrink-0 text-status-ready" />
        ) : failed ? (
          <CircleAlert aria-hidden="true" className="size-4 shrink-0" />
        ) : status.kind === 'info' ? (
          <Info aria-hidden="true" className="size-4 shrink-0" />
        ) : (
          <Spinner className="size-4 shrink-0" />
        )}
        <span dir="auto" className="min-w-0 flex-1 text-left [unicode-bidi:plaintext]">
          <StatusText status={status} />
        </span>
        {status.kind === 'error' && status.retry && (
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={retrying}
            onClick={onRetry}
            className="-my-1 shrink-0 text-foreground"
          >
            Retry
          </Button>
        )}
      </div>
      {status.kind === 'uploading' && (
        <Progress value={status.percent} aria-label="Upload progress" className="h-1.5" />
      )}
    </div>
  );
}

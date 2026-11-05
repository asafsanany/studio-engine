import { type DmConnection, type DmItem, relativeTime } from '@studio/shared';
import { RefreshCw } from 'lucide-react';
import { useState } from 'react';
import { toast } from 'sonner';
import { useNow } from '@/components/jobs/use-now';
import { Button } from '@/components/ui/button';
import { Toaster } from '@/components/ui/sonner';
import { useCheckDms, useDms, useRevealDm } from '@/data';
import { DmList } from '@/features/dms/DmList';
import { DmSheet } from '@/features/dms/DmSheet';
import { at, DMS_TEXT } from '@/features/dms/dm-text';
import { cn } from '@/lib/utils';

/** "Checked 2 min ago", or what went wrong last time. */
function ConnectionLine({ connection }: { connection: DmConnection }) {
  const now = useNow();
  if (connection.state === 'failing') {
    return <p className="text-sm text-destructive">{connection.error}</p>;
  }
  if (connection.checkedAt === null) {
    return <p className="text-sm text-muted-foreground">{DMS_TEXT.checking}</p>;
  }
  return (
    <p className="text-sm text-muted-foreground">
      Checked {relativeTime(connection.checkedAt, now).toLowerCase()}
    </p>
  );
}

/** The steps to the key, while .env has none. */
function Connect() {
  return (
    <section className="flex max-w-2xl flex-col gap-3 rounded-lg border p-6">
      <h2 className="text-base font-semibold">{DMS_TEXT.connectTitle}</h2>
      <p className="text-sm text-muted-foreground">{DMS_TEXT.connectIntro}</p>
      <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm">
        {DMS_TEXT.connectSteps.map((step) => (
          <li key={step}>{step}</li>
        ))}
      </ol>
      <p className="text-sm text-muted-foreground">{DMS_TEXT.connectAfter}</p>
    </section>
  );
}

/**
 * The Instagram DMs page (the admin's, on the Mac): the reels @owner_account and the studio's
 * Instagram send each other in a DM, newest first, as a quiet list like the Jobs page's. A click
 * opens the reel in a sheet with its video; the row's button is the download (or the link, when
 * there is no file), and the rest is in the right-click menu. While .env has no key the page shows the steps
 * to make one. Not linked to anything else: no client, job or song.
 */
export function DmsPage() {
  const { data, isError, refetch } = useDms();
  const check = useCheckDms();
  const reveal = useRevealDm();
  const [openId, setOpenId] = useState<string | null>(null);
  const open = data?.items.find((item) => item.id === openId) ?? null;

  const onReveal = (item: DmItem) =>
    reveal.mutate(item.id, { onError: (error) => toast.error(error.message) });
  const onCheck = () => check.mutate(undefined, { onError: (error) => toast.error(error.message) });

  const connection = data?.connection;
  const sender = connection?.from[0];
  const from = sender === undefined ? 'your own account' : at(sender);
  const account =
    connection?.account === undefined || connection.account === null
      ? 'the studio account'
      : at(connection.account);

  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
        <div className="flex min-w-0 flex-col gap-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            {DMS_TEXT.title}
          </h1>
          <p className="text-muted-foreground">{DMS_TEXT.intro(from, account)}</p>
        </div>
        {connection !== undefined && connection.state !== 'off' && (
          <div className="flex items-center gap-3">
            <ConnectionLine connection={connection} />
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={check.isPending}
              onClick={onCheck}
            >
              <RefreshCw
                className={cn(check.isPending && 'animate-spin motion-reduce:animate-none')}
              />
              {check.isPending ? DMS_TEXT.checking : DMS_TEXT.checkNow}
            </Button>
          </div>
        )}
      </div>

      {data === undefined && isError && (
        <div className="flex items-center gap-3 text-sm text-muted-foreground">
          {DMS_TEXT.unreachable}
          <Button type="button" variant="outline" size="sm" onClick={() => void refetch()}>
            {DMS_TEXT.tryAgain}
          </Button>
        </div>
      )}
      {connection?.state === 'off' && <Connect />}
      {data !== undefined && connection?.state !== 'off' && data.items.length === 0 && (
        <p className="text-sm text-muted-foreground">{DMS_TEXT.empty(from, account)}</p>
      )}
      {data !== undefined && data.items.length > 0 && (
        <DmList
          items={data.items}
          openId={openId}
          actions={{ open: (item) => setOpenId(item.id), reveal: onReveal }}
        />
      )}

      <DmSheet item={open} onClose={() => setOpenId(null)} onReveal={onReveal} />
      <Toaster />
    </>
  );
}

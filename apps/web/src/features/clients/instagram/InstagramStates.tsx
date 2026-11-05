// The places of the Instagram section's states (board CLStates), put where InstagramSection has
// them: no account yet (S8), the first scan (S2), a scan that can't run (S3) and none of our videos
// linked (S9). The words and the rules of which one shows are in states-view.ts.

import type { ClientInstagram } from '@studio/shared';
import { AtSign, CircleAlert, Loader2, Lock, Plus, Search } from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { SKELETON_DELAY_MS, useDelayedFlag } from '@/features/jobs/delayed-flag';
import { cn } from '@/lib/utils';
import { askToEditInstagram } from './instagram-dialog';
import type { TextOptions } from './instagram-text';
import {
  APIFY_BILLING_URL,
  APIFY_TOKEN_URL,
  isFirstScan,
  NO_ACCOUNT_TEXT,
  readingLine,
  type ScanProblem,
  scanProblem,
  unlinkedNotice,
} from './states-view';
import { useStartScan } from './use-start-scan';

/**
 * The section of a client with no Instagram account, in place of the whole section (board S8): a
 * dashed box that says what an account is for and what it costs, with Add Instagram, which opens
 * the Instagram… dialog.
 */
export function InstagramNoAccount({ clientId }: { clientId: string }) {
  return (
    <section
      aria-label="Instagram"
      data-slot="instagram-no-account"
      className="flex min-h-[220px] flex-col items-center justify-center gap-2.5 rounded-[12px] border border-dashed px-6 py-8 text-center"
    >
      <AtSign aria-hidden="true" className="size-[22px] text-muted-foreground" />
      <p className="font-medium text-pretty">{NO_ACCOUNT_TEXT.title}</p>
      <p className="text-[13px] text-muted-foreground">{NO_ACCOUNT_TEXT.detail}</p>
      <Button variant="outline" size="sm" onClick={() => askToEditInstagram(clientId)}>
        <Plus aria-hidden="true" />
        {NO_ACCOUNT_TEXT.add}
      </Button>
    </section>
  );
}

/** The grey places of the tiles and the chart, the sizes they will have (as the section's first load). */
function GreyPlaces() {
  return (
    <div aria-hidden="true" className="flex flex-col gap-4">
      <div className="grid grid-cols-1 gap-4 min-[640px]:grid-cols-2 min-[1200px]:grid-cols-4">
        {['followers', 'plays', 'likes', 'shares'].map((name) => (
          <Skeleton key={name} className="h-[130px] rounded-[12px] motion-reduce:animate-none" />
        ))}
      </div>
      <Skeleton className="h-[330px] rounded-[12px] motion-reduce:animate-none" />
    </div>
  );
}

/**
 * The first scan (board S2): "Reading @falcon.fpv… about a minute" and, once the wait is noticeable,
 * the grey places of the tiles and the chart. The page fills in by itself when the scan ends (the
 * `client-instagram` event loads the numbers again).
 */
function FirstScan({ handle }: { handle: string }) {
  const grey = useDelayedFlag(true, SKELETON_DELAY_MS);
  return (
    <div data-slot="instagram-first-scan" aria-busy="true" className="flex flex-col gap-4">
      <p role="status" className="flex items-center gap-2.5">
        <Loader2
          aria-hidden="true"
          className="size-4 animate-spin text-muted-foreground motion-reduce:animate-none"
        />
        {readingLine(handle)}
      </p>
      {grey && <GreyPlaces />}
    </div>
  );
}

const PROBLEM_ICON_CLASS = 'mt-0.5 size-4 shrink-0';

/** The icon of a problem: a lock, a magnifier, and a ring with a mark in amber (to set up) or red (failed). */
function ProblemIcon({ problem }: { problem: ScanProblem }) {
  if (problem.outcome === 'private') {
    return <Lock aria-hidden="true" className={cn(PROBLEM_ICON_CLASS, 'text-muted-foreground')} />;
  }
  if (problem.outcome === 'not-found') {
    return (
      <Search aria-hidden="true" className={cn(PROBLEM_ICON_CLASS, 'text-muted-foreground')} />
    );
  }
  return (
    <CircleAlert
      aria-hidden="true"
      className={cn(
        PROBLEM_ICON_CLASS,
        problem.tone === 'error' ? 'text-red-400' : 'text-amber-400',
      )}
    />
  );
}

/** How to set the Apify key up: where to copy it from and where it goes. A button that opens its own dialog. */
function ApifyHowTo({ label }: { label: string }) {
  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="outline" size="sm">
          {label}
        </Button>
      </DialogTrigger>
      <DialogContent showCloseButton={false} className="sm:max-w-[460px]">
        <DialogHeader>
          <DialogTitle className="leading-[1.43]">Set up Apify</DialogTitle>
          <DialogDescription>
            Studio Engine reads Instagram through Apify, so it needs your Apify key.
          </DialogDescription>
        </DialogHeader>
        <ol className="flex list-decimal flex-col gap-2 pl-5 text-sm marker:text-muted-foreground">
          <li>
            In{' '}
            <a
              href={APIFY_TOKEN_URL}
              target="_blank"
              rel="noreferrer"
              className="underline underline-offset-4 hover:text-foreground"
            >
              Apify’s settings
            </a>
            , copy your personal API token.
          </li>
          <li>
            In the Studio Engine folder, add a line to the <code className="font-mono">.env</code>{' '}
            file: <code className="font-mono">APIFY_TOKEN=</code> and the token.
          </li>
          <li>Press Scan now.</li>
        </ol>
      </DialogContent>
    </Dialog>
  );
}

/**
 * One scan that can't run (board S3): what went wrong, what to do about it, and the button for it:
 * Edit account (private, no such account), How to (no Apify key), Open Apify (no credit) or Retry
 * (failed). Whatever numbers there are stay under it.
 */
function ScanProblemLine({ problem, clientId }: { problem: ScanProblem; clientId: string }) {
  const scan = useStartScan(clientId);
  return (
    <div
      data-slot="scan-problem"
      data-outcome={problem.outcome}
      className="flex items-start gap-3 rounded-[12px] border px-4 py-3"
    >
      <ProblemIcon problem={problem} />
      <div className="flex min-w-0 flex-1 flex-col gap-0.5">
        <p className="font-medium text-pretty">{problem.title}</p>
        <p
          title={problem.error ?? undefined}
          className="text-[13px] text-pretty text-muted-foreground"
        >
          {problem.detail}
        </p>
      </div>
      {problem.action === 'edit' && (
        <Button variant="outline" size="sm" onClick={() => askToEditInstagram(clientId)}>
          {problem.actionLabel}
        </Button>
      )}
      {problem.action === 'how-to' && <ApifyHowTo label={problem.actionLabel} />}
      {problem.action === 'open-apify' && (
        <Button variant="outline" size="sm" asChild>
          <a href={APIFY_BILLING_URL} target="_blank" rel="noreferrer">
            {problem.actionLabel}
          </a>
        </Button>
      )}
      {problem.action === 'retry' && (
        <Button
          variant="outline"
          size="sm"
          disabled={scan.busy}
          aria-busy={scan.busy || undefined}
          onClick={scan.start}
        >
          {problem.actionLabel}
        </Button>
      )}
    </div>
  );
}

/**
 * Under the head, while the account has no numbers: the first scan is queued or running (board S2:
 * "Reading @falcon.fpv…" and grey places), or the scan could not read the profile (S3: one line with
 * its button and nothing under it), or there is nothing to say yet.
 */
export function InstagramNoNumbers({
  data,
  clientId,
  textOptions,
}: {
  data: ClientInstagram;
  clientId: string;
  textOptions?: TextOptions;
}) {
  if (isFirstScan(data)) return <FirstScan handle={data.account?.handle ?? ''} />;
  const problem = scanProblem(data, textOptions);
  if (problem !== null) return <ScanProblemLine problem={problem} clientId={clientId} />;
  return (
    <div className="flex min-h-24 items-center justify-center rounded-[12px] border text-center">
      <p className="text-sm text-muted-foreground">No numbers yet.</p>
    </div>
  );
}

/**
 * Between the head and the tiles, when the numbers are there but something needs saying: the last
 * scan couldn't run and these are older numbers (S3), or none of our videos is linked to a reel yet
 * (S9: how many we delivered, which, and where to link them). Nothing otherwise.
 */
export function InstagramNotices({
  data,
  clientId,
  textOptions,
}: {
  data: ClientInstagram;
  clientId: string;
  textOptions?: TextOptions;
}) {
  const problem = scanProblem(data, textOptions);
  const unlinked = unlinkedNotice(data);
  if (problem === null && unlinked === null) return null;
  return (
    <div className="flex flex-col gap-3">
      {problem !== null && <ScanProblemLine problem={problem} clientId={clientId} />}
      {unlinked !== null && (
        <div data-slot="none-linked" className="flex flex-col gap-2.5 rounded-[12px] border p-4">
          <p className="font-medium text-pretty">{unlinked.title}</p>
          <p className="text-[13px] text-pretty text-muted-foreground">
            We delivered {unlinked.count} (
            {unlinked.names.map((name, index) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: two videos can have the same name
              <span key={`${index}:${name}`}>
                {index > 0 && ', '}
                <bdi>{name}</bdi>
              </span>
            ))}
            {unlinked.more > 0 && ` and ${unlinked.more} more`}). {unlinked.after}
          </p>
        </div>
      )}
    </div>
  );
}

import { CircleAlert, LoaderCircle, RotateCcw } from 'lucide-react';
import { useEffect, useRef } from 'react';
import { ClaudeRow, CopyErrorButton, StepIcon, YourMessage } from '@/components/chat/ChatRows';
import { Play, Square } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import type { ChatRow, StepState, StepView } from './studio-logic';
import { stoppedLine } from './studio-logic';
import { CHAT_TEXT, COMPOSER_TEXT, STARTERS } from './studio-text';
import { Tip } from './Tip';

interface ChatThreadProps {
  rows: readonly ChatRow[];
  /** A changed value scrolls the chat to its end (a row was added, or one changed status). */
  signature: string;
  /** The version the player shows; its chip reads "· showing". */
  shown: number | null;
  /** A version is being made: Retry waits. */
  making: boolean;
  /** The engine cannot be reached: the buttons wait. */
  offline: boolean;
  /** The row whose Stop or Retry is on its way: its button waits. */
  pendingId?: string | null;
  onShow: (version: number) => void;
  onStop: (messageId: string) => void;
  onRetry: (messageId: string) => void;
  /** A starter fills the composer with its request. */
  onStarter: (request: string) => void;
}

/**
 * The left column's thread (board GRStudio): The owner's messages as right-aligned bubbles with their
 * files, and Claude's rows, each one of the making box, the reply with its version chip, the
 * red failure box or the stopped line. An empty chat asks "What graphic do you need?" and offers
 * four starters. It scrolls to the newest row whenever the chat changes.
 */
export function ChatThread({
  rows,
  signature,
  shown,
  making,
  offline,
  pendingId = null,
  onShow,
  onStop,
  onRetry,
  onStarter,
}: ChatThreadProps) {
  const scroller = useRef<HTMLDivElement>(null);
  /** Why Retry waits, or `null` when it works. */
  const retryReason = offline ? COMPOSER_TEXT.offline : making ? CHAT_TEXT.retryWaits : null;

  // biome-ignore lint/correctness/useExhaustiveDependencies: the signature is what says the chat changed
  useEffect(() => {
    const element = scroller.current;
    if (element) element.scrollTop = element.scrollHeight;
  }, [signature]);

  return (
    <div
      ref={scroller}
      data-slot="chat-thread"
      className="flex min-h-0 flex-1 flex-col gap-5 overflow-y-auto p-5"
    >
      {rows.length === 0 && <EmptyChat onStarter={onStarter} />}
      {rows.map((row) => (
        <ChatRowView
          key={row.id}
          row={row}
          shown={shown}
          offline={offline}
          retryReason={retryReason}
          pendingId={pendingId}
          onShow={onShow}
          onStop={onStop}
          onRetry={onRetry}
        />
      ))}
    </div>
  );
}

interface ChatRowViewProps {
  row: ChatRow;
  shown: number | null;
  offline: boolean;
  /** Why Retry waits, or `null` when it works. */
  retryReason: string | null;
  pendingId: string | null;
  onShow: (version: number) => void;
  onStop: (messageId: string) => void;
  onRetry: (messageId: string) => void;
}

/** One row of the thread. */
function ChatRowView({
  row,
  shown,
  offline,
  retryReason,
  pendingId,
  onShow,
  onStop,
  onRetry,
}: ChatRowViewProps) {
  const waiting = pendingId === row.id ? CHAT_TEXT.working : retryReason;
  switch (row.kind) {
    case 'you':
      return <YourMessage text={row.text} refs={row.refs} />;
    case 'making':
      return (
        <ClaudeRow>
          <MakingBox
            version={row.version}
            steps={row.steps}
            left={row.left}
            disabled={offline}
            stopping={pendingId === row.id}
            onStop={() => onStop(row.id)}
          />
        </ClaudeRow>
      );
    case 'done':
      return (
        <ClaudeRow>
          <p dir="auto" className="m-0 text-zinc-200 [unicode-bidi:plaintext]">
            {row.text}
          </p>
          {row.version !== null && (
            <div className="flex items-center gap-2.5">
              <VersionChip version={row.version} showing={row.version === shown} onShow={onShow} />
              {row.took !== '' && <span className="text-xs text-zinc-500">{row.took}</span>}
            </div>
          )}
        </ClaudeRow>
      );
    case 'failed':
      return (
        <ClaudeRow>
          <FailedBox
            version={row.version}
            text={row.text}
            unchanged={row.unchanged}
            error={row.error}
            retryReason={waiting}
            onRetry={() => onRetry(row.id)}
          />
        </ClaudeRow>
      );
    case 'stopped':
      return (
        <ClaudeRow>
          <div className="flex items-center justify-between gap-2">
            <span className="text-muted-foreground">{stoppedLine(row.note)}</span>
            <RetryButton reason={waiting} onClick={() => onRetry(row.id)} />
          </div>
        </ClaudeRow>
      );
  }
}

function EmptyChat({ onStarter }: { onStarter: (request: string) => void }) {
  return (
    <div data-slot="chat-empty" className="my-auto flex flex-col gap-5">
      <div className="flex flex-col gap-1.5">
        <h2 className="m-0 text-lg leading-[1.3] font-semibold">{CHAT_TEXT.emptyTitle}</h2>
        <p className="m-0 text-muted-foreground">{CHAT_TEXT.emptyHint}</p>
      </div>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-zinc-500">{CHAT_TEXT.startFrom}</span>
        {STARTERS.map((starter) => (
          <Button
            key={starter.id}
            type="button"
            variant="outline"
            data-starter={starter.id}
            onClick={() => onStarter(starter.request)}
            className="h-10 justify-start gap-2.5 px-3 font-normal has-[>svg]:px-3"
          >
            <svg
              aria-hidden="true"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              className="text-muted-foreground"
            >
              <path d={starter.icon} />
            </svg>
            {starter.label}
          </Button>
        ))}
      </div>
    </div>
  );
}

const STEP_COLOR: Readonly<Record<StepState, string>> = {
  done: 'text-foreground',
  running: 'text-foreground',
  waiting: 'text-zinc-500',
};

/** The box that shows a version being made: three steps, "About 2 min" and Stop. */
function MakingBox({
  version,
  steps,
  left,
  disabled,
  stopping,
  onStop,
}: {
  version: number;
  steps: readonly StepView[];
  left: string;
  disabled: boolean;
  stopping: boolean;
  onStop: () => void;
}) {
  return (
    <div
      data-slot="making-box"
      data-version={version}
      className="flex flex-col gap-2.5 rounded-[10px] border p-3"
    >
      <div className="flex items-center justify-between gap-2">
        <span className="font-medium">Making v{version}</span>
        <span className="text-xs text-muted-foreground">{left}</span>
      </div>
      <ol className="m-0 flex list-none flex-col gap-2 p-0">
        {steps.map((step) => (
          <li
            key={step.label}
            data-step={step.state}
            className={cn('flex items-center gap-2.5 text-[13px]', STEP_COLOR[step.state])}
          >
            <StepIcon state={step.state} />
            <span>{step.label}</span>
          </li>
        ))}
      </ol>
      <div className="flex justify-end">
        <Button
          type="button"
          variant="outline"
          size="sm"
          disabled={disabled || stopping}
          aria-busy={stopping}
          onClick={onStop}
        >
          {stopping ? (
            <LoaderCircle aria-hidden="true" className="size-3 animate-spin" />
          ) : (
            <Square aria-hidden="true" className="size-3 fill-current stroke-none" />
          )}
          {CHAT_TEXT.stop}
        </Button>
      </div>
    </div>
  );
}

function VersionChip({
  version,
  showing,
  onShow,
}: {
  version: number;
  showing: boolean;
  onShow: (version: number) => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={showing}
      title={`Show v${version}`}
      onClick={() => onShow(version)}
      className={cn(
        'inline-flex h-[26px] items-center gap-1.5 rounded-full border pr-2.5 pl-2 text-xs font-medium transition-colors ease-in-out hover:border-white/30 focus-visible:ring-[3px] focus-visible:ring-ring/35 focus-visible:outline-none',
        showing ? 'border-white/25 bg-secondary' : 'border-white/12 bg-transparent',
      )}
    >
      <Play aria-hidden="true" className="size-2.5 fill-current stroke-none" />v{version}
      {showing && <span className="font-normal text-muted-foreground">· showing</span>}
    </button>
  );
}

function RetryButton({ reason, onClick }: { reason: string | null; onClick: () => void }) {
  return (
    <Tip tip={reason} disabled={reason !== null} side="top">
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled={reason !== null}
        onClick={onClick}
      >
        <RotateCcw aria-hidden="true" className="size-3.5" />
        {CHAT_TEXT.retry}
      </Button>
    </Tip>
  );
}

/** The red box of a run that could not make its version: why, Retry and Copy error. */
function FailedBox({
  version,
  text,
  unchanged,
  error,
  retryReason,
  onRetry,
}: {
  version: number;
  text: string;
  /** What the failure left as it was, after the reason; `null` when there is nothing to say. */
  unchanged: string | null;
  error: string;
  retryReason: string | null;
  onRetry: () => void;
}) {
  return (
    <div
      data-slot="failed-box"
      className="flex flex-col gap-2 rounded-[10px] border border-[#F87171]/35 bg-[#F87171]/[0.06] p-3"
    >
      <span className="flex items-center gap-2 font-medium text-[#FCA5A5]">
        <CircleAlert aria-hidden="true" className="size-3.5" />
        Couldn’t finish v{version}
      </span>
      <p dir="auto" className="m-0 text-zinc-200 [unicode-bidi:plaintext]">
        {text}
        {unchanged !== null && ` ${unchanged}`}
      </p>
      <div className="flex gap-2">
        <RetryButton reason={retryReason} onClick={onRetry} />
        <CopyErrorButton error={error} />
      </div>
    </div>
  );
}

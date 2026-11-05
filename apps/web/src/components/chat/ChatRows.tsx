import { Check, Circle, Copy, FileText, Film, Image, LoaderCircle } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { toast } from 'sonner';
import { Button } from '@/components/ui/button';
import { copyError } from '@/features/jobs/copy-error';
import { cn } from '@/lib/utils';

// The parts of a chat with Claude that Graphics (GraphicStudio's thread) and a job's chat (Draft &
// chat) share (DR5): Claude's row with its small name above, the owner's right-aligned bubble with the
// files it carries, a file chip, a step's icon and the Copy error button. Each keeps the look and
// the data-slot it had in Graphics, so the boards and the tests read them the same way.

/** The words the parts say. */
export const CHAT_ROW_TEXT = {
  claude: 'Claude',
  copyError: 'Copy error',
  copied: 'Copied',
  done: 'Done',
  working: 'Working',
  waiting: 'Waiting',
} as const;

/** The icon of an attached file, by what its name says it is. */
function fileIcon(name: string) {
  if (/\.(png|jpe?g|gif|webp|svg|heic|avif|bmp)$/i.test(name)) return Image;
  if (/\.(mp4|mov|m4v|webm|mkv|avi)$/i.test(name)) return Film;
  return FileText;
}

/** A file chip: an icon and the file's name. */
export function FileChip({ name, children }: { name: string; children?: ReactNode }) {
  const Icon = fileIcon(name);
  return (
    <span
      data-slot="file-chip"
      className="inline-flex h-[26px] max-w-full items-center gap-1.5 rounded-md border pr-2.5 pl-2.5 text-xs text-zinc-300"
    >
      <Icon aria-hidden="true" className="size-3 shrink-0" />
      <span dir="auto" className="truncate [unicode-bidi:plaintext]">
        {name}
      </span>
      {children}
    </span>
  );
}

/** The owner's message: right-aligned, its files above it, its text in a bubble. */
export function YourMessage({
  text,
  refs = [],
  children,
}: {
  text: string;
  refs?: readonly string[];
  /** Under the bubble: the time chip of a note, its fix line… */
  children?: ReactNode;
}) {
  return (
    <div data-slot="your-message" className="flex max-w-[86%] flex-col items-end gap-1.5 self-end">
      {refs.map((name) => (
        <FileChip key={name} name={name} />
      ))}
      {text.trim() !== '' && (
        <div
          dir="auto"
          className="rounded-xl bg-secondary px-3 py-2 break-words whitespace-pre-wrap [unicode-bidi:plaintext]"
        >
          {text}
        </div>
      )}
      {children}
    </div>
  );
}

/** Claude's row: its small name, then what it says or shows. */
export function ClaudeRow({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <div data-slot="claude-message" className={cn('flex flex-col gap-2', className)}>
      <span className="text-xs font-medium text-muted-foreground">{CHAT_ROW_TEXT.claude}</span>
      {children}
    </div>
  );
}

/** Where a step of a run stands. */
export type ChatStepState = 'done' | 'running' | 'waiting';

/** A step's icon: a check when done, the blue spinner while running, a ring while it waits. */
export function StepIcon({ state }: { state: ChatStepState }) {
  if (state === 'done') {
    return (
      <Check
        role="img"
        aria-label={CHAT_ROW_TEXT.done}
        className="size-3.5 text-muted-foreground"
      />
    );
  }
  if (state === 'running') {
    return (
      <LoaderCircle
        role="img"
        aria-label={CHAT_ROW_TEXT.working}
        className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none"
      />
    );
  }
  return (
    <Circle role="img" aria-label={CHAT_ROW_TEXT.waiting} className="size-3.5 text-zinc-600" />
  );
}

/** Copy error: copies `error`, says "Copied" for a moment; only a failure gets a toast. */
export function CopyErrorButton({ error }: { error: string }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(timer.current), []);

  async function copy() {
    const done = await copyError(error, {
      notify: {
        success: () => undefined,
        error: (message, options) => toast.error(message, options),
      },
    });
    if (!done) return;
    setCopied(true);
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), 1500);
  }

  return (
    <Button
      type="button"
      variant="ghost"
      size="sm"
      onClick={() => void copy()}
      className="text-muted-foreground"
    >
      <Copy aria-hidden="true" className="size-3.5" />
      {copied ? CHAT_ROW_TEXT.copied : CHAT_ROW_TEXT.copyError}
    </Button>
  );
}

import { Check, Clock, Info, Loader2, type LucideIcon, Send, Undo2 } from 'lucide-react';
import { type ReactNode, useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { type NoteFixLine, type NoteFixLineKind, startsRtl } from './fix-lines';
import { FIX_TEXT } from './review-text';

/** How long the line takes to open and close (ms), and the card's border to change. */
const REVEAL_MS = 200;

/**
 * Opens and closes smoothly: the card grows to make room for what is shown and gives it back, so
 * nothing jumps when a line or the bar appears. The content mounts closed and opens on the next
 * frame, except when it is there from the first render (a card that opens with its line), which
 * shows at once. It stays mounted until it has closed, showing what it showed last.
 *
 * `gap` is the card's gap above this: a closed reveal takes no room, gap included.
 */
function Reveal({
  open,
  gap,
  children,
}: {
  open: boolean;
  /** The classes that pull the reveal back over the card's gap while it is shut (`-mt-1.5`). */
  gap: string;
  children: ReactNode;
}) {
  const last = useRef<ReactNode>(children);
  if (open) last.current = children;
  const [mounted, setMounted] = useState(open);
  const [shown, setShown] = useState(open);
  useEffect(() => {
    if (open) {
      setMounted(true);
      const frame = requestAnimationFrame(() => setShown(true));
      return () => cancelAnimationFrame(frame);
    }
    setShown(false);
    const timer = setTimeout(() => setMounted(false), REVEAL_MS);
    return () => clearTimeout(timer);
  }, [open]);

  if (!mounted) return null;
  return (
    <div
      data-slot="reveal"
      data-state={shown ? 'open' : 'closed'}
      className={cn(
        'grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-in-out motion-reduce:transition-none',
        shown ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0',
        !shown && gap,
      )}
    >
      {/* A 3 px margin of padding so a focus ring is not cut off by the clipping. */}
      <div className="-m-[3px] min-h-0 overflow-hidden p-[3px]">{last.current}</div>
    </div>
  );
}

/** The icon, and its colour, of each line (board QFReview). */
const ICONS: Readonly<Record<NoteFixLineKind, { icon: LucideIcon; color: string }>> = {
  reading: { icon: Loader2, color: 'text-muted-foreground' },
  queued: { icon: Clock, color: 'text-muted-foreground' },
  running: { icon: Loader2, color: 'text-blue-300' },
  fixed: { icon: Check, color: 'text-[#34D399]' },
  sends: { icon: Send, color: 'text-muted-foreground' },
  escalated: { icon: Info, color: 'text-[#FBBF24]' },
  undone: { icon: Undo2, color: 'text-muted-foreground' },
};

/** A line that says what happened ("Fixing it now", "Fixed") is brighter than one that says what waits. */
const BRIGHT: ReadonlySet<NoteFixLineKind> = new Set(['running', 'fixed']);

interface NoteFixLineViewProps {
  /** The line to show, or `null` for none (the card keeps its place for it while it closes). */
  line: NoteFixLine | null;
  /** The card is the phone's: a 32 px Undo for a finger, no tooltip. */
  phone: boolean;
  /** Undo was pressed on this fix. */
  onUndo: (fixId: string) => void;
  /** An Undo is on its way: the button waits. */
  undoing: boolean;
}

/**
 * The line under a note that answers it, like a reply in a chat (board QFReview): an icon, one
 * line of 13 px muted words, and, on a fix that landed, a ghost "Undo". While a fix runs a 2 px bar
 * under the line fills in quarters (`progress`). The words are a live region, so a screen reader
 * hears "Fixing it now · Changing the caption font" and then "Fixed in 38 s." as they change.
 */
export function NoteFixLineView({ line, phone, onUndo, undoing }: NoteFixLineViewProps) {
  // The card's gap above (6 px, the phone's 4 px), taken back while the line is shut.
  const gap = phone ? '-mt-1' : '-mt-1.5';
  return (
    <Reveal open={line !== null} gap={gap}>
      {line === null ? null : (
        <div data-slot="note-fix" data-kind={line.kind} className="flex flex-col">
          <FixRow line={line} phone={phone} onUndo={onUndo} undoing={undoing} />
          <Bar progress={line.progress} />
        </div>
      )}
    </Reveal>
  );
}

function FixRow({
  line,
  phone,
  onUndo,
  undoing,
}: {
  line: NoteFixLine;
  phone: boolean;
  onUndo: (fixId: string) => void;
  undoing: boolean;
}) {
  const { icon: Icon, color } = ICONS[line.kind];
  const spins = line.kind === 'reading' || line.kind === 'running';
  const undoFixId = line.undoFixId;
  const undo =
    undoFixId === null ? null : (
      <Button
        type="button"
        variant="ghost"
        size="xs"
        disabled={undoing || line.undoBlocked}
        className={cn(
          // Taller than the 18 px line, so it hangs over it evenly (the line stays one line high).
          'flex-none rounded-sm text-muted-foreground hover:text-foreground -my-[3px]',
          phone && '-my-[7px] h-8 px-2.5 text-[13px] has-[>svg]:px-2.5',
        )}
        onClick={() => onUndo(undoFixId)}
      >
        <Undo2 aria-hidden="true" />
        {FIX_TEXT.undo}
      </Button>
    );
  return (
    <div className="flex items-start gap-2">
      <span aria-hidden="true" className={cn('flex h-[18px] w-3.5 flex-none items-center', color)}>
        <Icon
          className={cn('size-3.5', spins && 'animate-spin')}
          strokeWidth={line.kind === 'fixed' ? 2.4 : 2}
        />
      </span>
      <span
        role="status"
        className={cn(
          'min-w-0 flex-1 text-[13px] leading-[18px] text-pretty',
          BRIGHT.has(line.kind) ? 'text-zinc-300' : 'text-muted-foreground',
        )}
      >
        {line.text}
        {line.tail === null ? null : <FixSaid said={line.tail} />}
      </span>
      {undo === null ? null : phone || undoing || line.undoBlocked ? (
        undo
      ) : (
        <Tooltip>
          <TooltipTrigger asChild>{undo}</TooltipTrigger>
          <TooltipContent sideOffset={6}>{FIX_TEXT.undoTip}</TooltipContent>
        </Tooltip>
      )}
    </div>
  );
}

/**
 * What the fix said, in its own text direction (`dir="auto"`), so a Hebrew sentence doesn't share
 * the line's left-to-right order. An English one follows the words on the same line, as before; a
 * Hebrew one goes on its own line below, lined up on the right like the Hebrew note above it.
 */
function FixSaid({ said }: { said: string }) {
  if (startsRtl(said)) {
    return (
      <span dir="auto" data-slot="note-fix-said" className="block pr-1 [unicode-bidi:plaintext]">
        {said}
      </span>
    );
  }
  return (
    <>
      {' '}
      <bdi dir="auto" data-slot="note-fix-said">
        {said}
      </bdi>
    </>
  );
}

/** The 2 px bar under the line of a fix that runs: blue, at 25, 50, 75 or 100 %, easing to the next. */
function Bar({ progress }: { progress: number | null }) {
  return (
    <Reveal open={progress !== null} gap="">
      <div aria-hidden="true" className="ml-[22px] pt-2">
        <div className="h-0.5 overflow-hidden rounded-[1px] bg-secondary">
          <div
            data-slot="note-fix-bar"
            className="h-full bg-[#3B82F6] transition-[width] duration-[600ms] ease-in-out motion-reduce:transition-none"
            style={{ width: `${progress ?? 0}%` }}
          />
        </div>
      </div>
    </Reveal>
  );
}

import type { FeedImage, FeedRunItem, FeedTool, JobFeedItem } from '@studio/shared';
import { ChevronDown, ChevronRight, CircleAlert, Clapperboard, LoaderCircle } from 'lucide-react';
import { Fragment, type ReactNode, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ClaudeRow, CopyErrorButton, StepIcon } from '@/components/chat/ChatRows';
import { feedPictureUrl } from '@/data';
import { cn } from '@/lib/utils';
import { FeedCardView } from './FeedCards';
import {
  commandsLine,
  currentWork,
  type FeedSection,
  feedPictures,
  feedSections,
  foldedLine,
  isFoldedRun,
  runDivider,
  runTook,
  textPieces,
} from './job-chat-logic';
import { JOB_CHAT_TEXT } from './job-chat-text';
import { PictureLightbox } from './PictureLightbox';

// A job's chat (Draft & chat, DR6; board DCDialog): everything the job's runs said, ran and looked
// at, in order, built by the engine from the job log. Each run opens with a divider ("Draft started",
// "Round 1") and a round shows the notes it was sent; Claude's lines, its folded commands, the
// pictures it opened and the cards follow. The runs that made the footage before the Draft fold up
// under one line. A run that failed ends with its reason and Copy error. The newest line stays in
// view while the chat grows, unless the owner scrolled up to read.

/** How close to the end counts as "at the end", so a new line scrolls into view. */
const STICK_PX = 48;

export interface JobChatProps {
  jobId: string;
  items: readonly JobFeedItem[];
  /** The run goes on: a working line closes the chat. */
  live?: boolean;
  /** What the run is doing now, for the working line ("Transcribe the footage"). */
  liveLabel?: string | null;
  /** After the feed: The owner's notes that wait for Send. */
  after?: ReactNode;
  /** The chat is empty and nothing has started: what shows instead. */
  empty?: ReactNode;
  /** Shown on a run that failed, next to Copy error. */
  onRetry?: () => void;
  className?: string;
}

export function JobChat({
  jobId,
  items,
  live = false,
  liveLabel = null,
  after,
  empty,
  onRetry,
  className,
}: JobChatProps) {
  const scroller = useRef<HTMLDivElement>(null);
  const atEnd = useRef(true);
  const [picture, setPicture] = useState<string | null>(null);
  const sections = feedSections(items);
  const pictures = feedPictures(items);

  // A new line, a changed one or a note keeps the chat at its end, unless the owner scrolled up.
  const size = `${items.length}:${JSON.stringify(items[items.length - 1] ?? null).length}`;
  // biome-ignore lint/correctness/useExhaustiveDependencies: the size says the chat changed
  useLayoutEffect(() => {
    const element = scroller.current;
    if (element !== null && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [size, after]);

  function onScroll() {
    const element = scroller.current;
    if (element === null) return;
    atEnd.current = element.scrollHeight - element.scrollTop - element.clientHeight < STICK_PX;
  }

  // The runs before the Draft fold up together, under one line.
  const folded = sections.filter((section) => isFoldedRun(section.run));
  const open = sections.filter((section) => !isFoldedRun(section.run));

  return (
    <div
      ref={scroller}
      data-slot="job-chat"
      onScroll={onScroll}
      className={cn('flex min-h-0 flex-1 flex-col gap-[18px] overflow-y-auto p-4', className)}
    >
      {items.length === 0 && empty}
      {folded.length > 0 && (
        <FoldedRuns sections={folded} jobId={jobId} onPicture={setPicture} onRetry={onRetry} />
      )}
      {open.map((section, index) => (
        <SectionView
          key={section.run?.id ?? `start-${index}`}
          section={section}
          jobId={jobId}
          onPicture={setPicture}
          onRetry={onRetry}
        />
      ))}
      {live && <WorkingLine label={liveLabel ?? currentWork(items)} />}
      {after}
      <PictureLightbox
        jobId={jobId}
        pictures={pictures}
        open={picture}
        onOpenChange={(name) => setPicture(name)}
      />
    </div>
  );
}

function Divider({ children }: { children: ReactNode }) {
  return (
    <div data-slot="feed-divider" className="flex items-center gap-2.5 text-xs text-zinc-500">
      <span className="h-px flex-1 bg-white/[0.08]" />
      {children}
      <span className="h-px flex-1 bg-white/[0.08]" />
    </div>
  );
}

interface SectionProps {
  section: FeedSection;
  jobId: string;
  onPicture: (name: string) => void;
  onRetry?: () => void;
}

function SectionView({ section, jobId, onPicture, onRetry }: SectionProps) {
  const { run } = section;
  return (
    <>
      {run !== null && <Divider>{runDivider(run)}</Divider>}
      {run !== null && run.notes.length > 0 && <SentNotes run={run} />}
      <SectionItems items={section.items} jobId={jobId} onPicture={onPicture} />
      {run !== null && <RunEnd run={run} onRetry={onRetry} />}
    </>
  );
}

/** The Brief run and Generate, folded under one line (card 8's "Footage made first"). */
function FoldedRuns({
  sections,
  jobId,
  onPicture,
  onRetry,
}: {
  sections: readonly FeedSection[];
  jobId: string;
  onPicture: (name: string) => void;
  onRetry?: () => void;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex w-full cursor-pointer items-center gap-2.5 rounded-[10px] border px-3 py-2.5 text-left text-[13px] transition-colors ease-in-out hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
      >
        <Clapperboard aria-hidden="true" className="size-[15px] text-muted-foreground" />
        <span className="flex-1">{foldedLine(sections)}</span>
        <Chevron aria-hidden="true" className="size-3.5 text-muted-foreground" />
      </button>
      {open &&
        sections.map((section, index) => (
          <SectionView
            key={section.run?.id ?? `folded-${index}`}
            section={section}
            jobId={jobId}
            onPicture={onPicture}
            onRetry={onRetry}
          />
        ))}
    </>
  );
}

/** A round's notes, as they were sent: right-aligned bubbles with their time. */
function SentNotes({ run }: { run: FeedRunItem }) {
  const notes = [...run.notes].sort((a, b) => a.atSec - b.atSec);
  return (
    <div data-slot="sent-notes" className="flex flex-col items-end gap-1.5">
      <span className="text-xs text-zinc-500">
        You · {notes.length} {notes.length === 1 ? 'note' : 'notes'}
      </span>
      {notes.map((note) => (
        <NoteBubble key={note.id} atSec={note.atSec} text={note.text ?? 'A voice note'} />
      ))}
    </div>
  );
}

/** One note as a bubble: its time on the video, then what it says. */
export function NoteBubble({
  atSec,
  text,
  pending = false,
  children,
}: {
  atSec: number;
  text: string;
  /** Not sent yet: a dashed edge. */
  pending?: boolean;
  children?: ReactNode;
}) {
  const minutes = Math.floor(atSec / 60);
  const seconds = (atSec - minutes * 60).toFixed(1).padStart(4, '0');
  return (
    <div
      data-slot="note-bubble"
      className={cn(
        'flex max-w-[86%] flex-col gap-1.5 rounded-xl bg-secondary px-3 py-2',
        pending && 'border border-dashed border-white/[0.18]',
      )}
    >
      <span className="inline-flex h-5 items-center self-start rounded-md bg-zinc-700 px-1.5 text-xs tabular-nums">
        {minutes}:{seconds}
      </span>
      <span dir="auto" className="[text-wrap:pretty] [unicode-bidi:plaintext]">
        {text}
      </span>
      {children}
    </div>
  );
}

/** The items of one run, Claude's name over each stretch of them. */
function SectionItems({
  items,
  jobId,
  onPicture,
}: {
  items: SectionProps['section']['items'];
  jobId: string;
  onPicture: (name: string) => void;
}) {
  if (items.length === 0) return null;
  return (
    <ClaudeRow>
      {items.map((item) => (
        <Fragment key={item.id}>
          {item.kind === 'text' && <ClaudeText text={item.text} />}
          {item.kind === 'tools' && <CommandsFold tools={item.tools} />}
          {item.kind === 'images' && (
            <PictureGroup jobId={jobId} images={item.images} onPicture={onPicture} />
          )}
          {item.kind === 'card' && <FeedCardView card={item.card} />}
        </Fragment>
      ))}
    </ClaudeRow>
  );
}

/** Claude's words: paragraphs, with its **bold** and `code`. */
function ClaudeText({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n{2,}/).map((paragraph, index) => (
        <p
          // biome-ignore lint/suspicious/noArrayIndexKey: a line's paragraphs never move
          key={index}
          dir="auto"
          className="m-0 whitespace-pre-wrap text-zinc-200 [text-wrap:pretty] [unicode-bidi:plaintext]"
        >
          {textPieces(paragraph).map((piece, at) =>
            piece.kind === 'bold' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of a line never move
              <strong key={at} className="font-semibold text-foreground">
                {piece.text}
              </strong>
            ) : piece.kind === 'code' ? (
              // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of a line never move
              <code key={at} className="rounded bg-zinc-800 px-1 font-mono text-[12px]">
                {piece.text}
              </code>
            ) : (
              // biome-ignore lint/suspicious/noArrayIndexKey: the pieces of a line never move
              <Fragment key={at}>{piece.text}</Fragment>
            ),
          )}
        </p>
      ))}
    </>
  );
}

/** "Ran 8 commands · <the last one>", opening to each command's plain words (card 4). */
function CommandsFold({ tools }: { tools: readonly FeedTool[] }) {
  const [open, setOpen] = useState(false);
  const running = tools.find((tool) => tool.state === 'running');
  const failed = tools.filter((tool) => tool.state === 'failed').length;
  const last = running ?? tools[tools.length - 1];
  const Chevron = open ? ChevronDown : ChevronRight;
  return (
    <div data-slot="commands" className="flex flex-col">
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen(!open)}
        className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-muted-foreground transition-colors ease-in-out hover:bg-accent/50 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
      >
        {running !== undefined ? (
          <LoaderCircle
            aria-hidden="true"
            className="size-3.5 shrink-0 animate-spin text-blue-500 motion-reduce:animate-none"
          />
        ) : (
          <Chevron aria-hidden="true" className="size-3.5 shrink-0" />
        )}
        <span className="shrink-0">{commandsLine(tools.length)}</span>
        {failed > 0 && <span className="shrink-0 text-[#FCA5A5]">· {failed} failed</span>}
        {last !== undefined && (
          <span className="min-w-0 flex-1 truncate text-zinc-500">· {last.label}</span>
        )}
      </button>
      {open && (
        <ul className="m-0 flex list-none flex-col gap-1 py-1 pr-0 pl-[30px] text-xs text-muted-foreground">
          {tools.map((tool) => (
            <li key={tool.id} className="flex items-start gap-2" title={tool.detail ?? undefined}>
              <span className="mt-px shrink-0 [&>svg]:size-3">
                {tool.state === 'failed' ? (
                  <CircleAlert aria-label="Failed" className="text-[#FCA5A5]" />
                ) : (
                  <StepIcon state={tool.state === 'done' ? 'done' : 'running'} />
                )}
              </span>
              <span dir="auto" className="min-w-0 break-words [unicode-bidi:plaintext]">
                {tool.label}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The pictures Claude opened together: a wide one across the chat, the others three to a row. */
function PictureGroup({
  jobId,
  images,
  onPicture,
}: {
  jobId: string;
  images: readonly FeedImage[];
  onPicture: (name: string) => void;
}) {
  const wide = images.filter((image) => image.wide);
  const small = images.filter((image) => !image.wide);
  return (
    <div data-slot="pictures" className="flex flex-col gap-2">
      {wide.map((image) => (
        <figure key={image.name} className="m-0 flex flex-col gap-1">
          <PictureButton jobId={jobId} image={image} onPicture={onPicture} />
          <figcaption className="truncate text-xs text-zinc-500">
            {image.label}
            {image.path !== null && <span className="text-muted-foreground"> · {image.path}</span>}
          </figcaption>
        </figure>
      ))}
      {small.length > 0 && (
        <div className="grid grid-cols-3 gap-1.5">
          {small.map((image) => (
            <figure key={image.name} className="m-0 flex min-w-0 flex-col gap-1">
              <PictureButton jobId={jobId} image={image} onPicture={onPicture} square />
              <figcaption className="truncate text-[11px] text-zinc-500">{image.label}</figcaption>
            </figure>
          ))}
        </div>
      )}
    </div>
  );
}

function PictureButton({
  jobId,
  image,
  onPicture,
  square = false,
}: {
  jobId: string;
  image: FeedImage;
  onPicture: (name: string) => void;
  square?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={() => onPicture(image.name)}
      aria-label={`${JOB_CHAT_TEXT.open}: ${image.label}`}
      className="block w-full cursor-pointer overflow-hidden rounded-[10px] border bg-black p-0 transition-colors ease-in-out hover:border-white/25 focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
    >
      <img
        src={feedPictureUrl(jobId, image.name)}
        alt={image.label}
        loading="lazy"
        className={cn('block w-full', square ? 'aspect-square object-cover' : 'h-auto')}
      />
    </button>
  );
}

/** How a run ended: its time when it went well, why when it did not. */
function RunEnd({ run, onRetry }: { run: FeedRunItem; onRetry?: () => void }) {
  if (run.outcome === null) return null;
  if (run.outcome === 'succeeded') {
    const took = runTook(run);
    return took === null ? null : <span className="text-xs text-zinc-500">{took}</span>;
  }
  if (run.outcome === 'cancelled' || run.outcome === 'stopped') {
    return (
      <p className="m-0 text-muted-foreground">
        {run.run === 'draft' ? JOB_CHAT_TEXT.stoppedDraft : JOB_CHAT_TEXT.stoppedRun}
      </p>
    );
  }
  const error = run.error ?? 'It ended without saying why.';
  return (
    <div
      data-slot="run-failed"
      className="flex flex-col gap-2 rounded-[10px] border border-[#F87171]/35 bg-[#F87171]/[0.06] p-3"
    >
      <span className="flex items-center gap-2 font-medium text-[#FCA5A5]">
        <CircleAlert aria-hidden="true" className="size-3.5" />
        {run.run === 'draft' ? 'Couldn’t finish the draft' : 'Couldn’t finish this run'}
      </span>
      <p dir="auto" className="m-0 text-zinc-200 [text-wrap:pretty] [unicode-bidi:plaintext]">
        {error}
      </p>
      <div className="flex gap-2">
        {onRetry !== undefined && (
          <button
            type="button"
            onClick={onRetry}
            className="h-8 cursor-pointer rounded-md border px-3 text-[13px] font-medium transition-colors ease-in-out hover:bg-accent focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
          >
            {JOB_CHAT_TEXT.retry}
          </button>
        )}
        <CopyErrorButton error={error} />
      </div>
    </div>
  );
}

/** The run goes on: a spinner and what it is doing. */
function WorkingLine({ label }: { label: string | null }) {
  const [dots, setDots] = useState(0);
  useEffect(() => {
    const timer = setInterval(() => setDots((value) => (value + 1) % 4), 600);
    return () => clearInterval(timer);
  }, []);
  return (
    <div data-slot="working" className="flex items-center gap-2 text-[13px] text-muted-foreground">
      <LoaderCircle
        aria-hidden="true"
        className="size-3.5 animate-spin text-blue-500 motion-reduce:animate-none"
      />
      <span className="truncate">
        {label ?? 'Working'}
        <span aria-hidden="true">{'.'.repeat(dots)}</span>
      </span>
    </div>
  );
}

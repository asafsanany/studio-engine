import type { FeedCard } from '@studio/shared';
import { AudioLines, FileText, ListChecks, Scissors, Volume2 } from 'lucide-react';
import { type ReactNode, useState } from 'react';
import { cn } from '@/lib/utils';
import { clock, cutRows, cutSegments, transcriptOf } from './job-chat-logic';
import { JOB_CHAT_TEXT } from './job-chat-text';

// The job chat's cards (Draft & chat, DR6; DCCards 19, 22, 25, 29): what the run understood, the
// transcript, the plan, the cut list and the loudness. Each is a dark box with an icon, a bold title
// and a grey detail, and opens to the rest with "Show all".

/** How many lines of a long card show before "Show all". */
const TRANSCRIPT_LINES = 2;
const CUT_ROWS = 4;
const PLAN_CHARS = 320;

function CardBox({
  icon,
  title,
  detail,
  children,
  slot,
}: {
  icon: ReactNode;
  title: string;
  detail?: string | null;
  children: ReactNode;
  slot: string;
}) {
  return (
    <div
      data-slot="feed-card"
      data-card={slot}
      className="flex flex-col gap-2.5 rounded-[10px] border bg-[#121214] p-3"
    >
      <div className="flex items-center gap-2">
        <span aria-hidden="true" className="text-muted-foreground [&>svg]:size-3.5">
          {icon}
        </span>
        <span className="font-semibold">{title}</span>
        {detail !== undefined && detail !== null && (
          <span className="min-w-0 truncate text-xs text-zinc-500">{detail}</span>
        )}
      </div>
      {children}
    </div>
  );
}

function MoreButton({
  open,
  onClick,
  label,
}: {
  open: boolean;
  onClick: () => void;
  label?: string;
}) {
  return (
    <button
      type="button"
      aria-expanded={open}
      onClick={onClick}
      className="h-[26px] cursor-pointer self-start rounded-md px-2 text-xs font-medium text-muted-foreground transition-colors ease-in-out hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35"
    >
      {open ? JOB_CHAT_TEXT.showLess : (label ?? JOB_CHAT_TEXT.showAll)}
    </button>
  );
}

function TimeChip({ children }: { children: ReactNode }) {
  return (
    <span className="inline-flex h-5 shrink-0 items-center rounded-md bg-zinc-800 px-1.5 text-xs tabular-nums">
      {children}
    </span>
  );
}

function BriefCard({ card }: { card: Extract<FeedCard, { type: 'brief' }> }) {
  return (
    <CardBox slot="brief" icon={<FileText />} title={JOB_CHAT_TEXT.understood}>
      {card.summary !== null && (
        <p dir="auto" className="m-0 text-zinc-200 [text-wrap:pretty] [unicode-bidi:plaintext]">
          {card.summary}
        </p>
      )}
      {card.facts.length > 0 && (
        <div className="flex flex-wrap gap-1.5">
          {card.facts.map((fact) => (
            <span
              key={fact.label}
              className="inline-flex h-6 items-center gap-1.5 rounded-md border px-2 text-xs text-zinc-300"
            >
              <span className="text-zinc-500">{fact.label}</span>
              <span dir="auto" className="[unicode-bidi:plaintext]">
                {fact.value}
              </span>
            </span>
          ))}
        </div>
      )}
    </CardBox>
  );
}

function TranscriptCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const { sources, phrases } = transcriptOf(text);
  const detail =
    phrases.length > 0
      ? `${sources.length === 1 ? sources[0] : `${sources.length} sources`} · ${phrases.length} ${phrases.length === 1 ? 'phrase' : 'phrases'}`
      : null;
  const shown = open ? phrases : phrases.slice(0, TRANSCRIPT_LINES);
  return (
    <CardBox
      slot="transcript"
      icon={<AudioLines />}
      title={JOB_CHAT_TEXT.transcript}
      detail={detail}
    >
      {phrases.length === 0 ? (
        <pre className="m-0 max-h-48 overflow-auto font-mono text-xs whitespace-pre-wrap text-zinc-300">
          {text}
        </pre>
      ) : (
        shown.map((phrase) => (
          <div key={`${phrase.source}-${phrase.startSec}`} className="flex items-start gap-2">
            <TimeChip>{clock(phrase.startSec)}</TimeChip>
            <span
              dir="auto"
              className="text-[13px] text-zinc-300 [text-wrap:pretty] [unicode-bidi:plaintext]"
            >
              {phrase.text}
            </span>
          </div>
        ))
      )}
      {phrases.length > TRANSCRIPT_LINES && (
        <MoreButton
          open={open}
          onClick={() => setOpen(!open)}
          label={`Show all ${phrases.length} phrases`}
        />
      )}
    </CardBox>
  );
}

function PlanCard({ text }: { text: string }) {
  const [open, setOpen] = useState(false);
  const long = text.length > PLAN_CHARS;
  const shown = open || !long ? text : `${text.slice(0, PLAN_CHARS).trimEnd()}…`;
  return (
    <CardBox slot="plan" icon={<ListChecks />} title={JOB_CHAT_TEXT.plan} detail="project.md">
      <p
        dir="auto"
        className="m-0 text-[13px] whitespace-pre-wrap text-zinc-300 [text-wrap:pretty] [unicode-bidi:plaintext]"
      >
        {shown}
      </p>
      {long && <MoreButton open={open} onClick={() => setOpen(!open)} />}
    </CardBox>
  );
}

function CutsCard({ card }: { card: Extract<FeedCard, { type: 'cuts' }> }) {
  const [open, setOpen] = useState(false);
  const rows = cutRows(card.cuts);
  const segments = cutSegments(card.cuts);
  const shown = open ? rows : rows.slice(0, CUT_ROWS);
  const detail = `${rows.length} ${rows.length === 1 ? 'shot' : 'shots'} · ${card.totalSec.toFixed(1)} s`;
  return (
    <CardBox slot="cuts" icon={<Scissors />} title={JOB_CHAT_TEXT.cuts} detail={detail}>
      <div aria-hidden="true" className="flex h-[22px] gap-0.5 overflow-hidden rounded">
        {segments.map((segment, index) => (
          <span
            // biome-ignore lint/suspicious/noArrayIndexKey: the shots are in cut order and never move
            key={index}
            title={segment.source}
            className="inline-flex h-full shrink-0 items-center justify-center overflow-hidden text-[10px] text-zinc-300"
            style={{ width: segment.width, background: segment.tone }}
          >
            {segment.source}
          </span>
        ))}
      </div>
      {shown.map((row) => (
        <div key={row.index} className="flex items-center gap-2 text-[13px]">
          <span className="w-10 shrink-0 text-muted-foreground tabular-nums">
            {clock(row.atSec).replace(/\.\d$/, '')}
          </span>
          <span
            dir="auto"
            className="min-w-0 flex-1 truncate text-zinc-300 [unicode-bidi:plaintext]"
            title={row.quote ?? undefined}
          >
            {row.beat ?? row.quote ?? '—'}
          </span>
          <span className="shrink-0 text-xs text-zinc-500">{row.source}</span>
          <span className="w-[38px] shrink-0 text-right text-muted-foreground tabular-nums">
            {row.lenSec.toFixed(1)}
          </span>
        </div>
      ))}
      {rows.length > CUT_ROWS && (
        <MoreButton
          open={open}
          onClick={() => setOpen(!open)}
          label={`Show all ${rows.length} shots`}
        />
      )}
    </CardBox>
  );
}

function Stat({ label, value, unit }: { label: string; value: number | null; unit: string }) {
  return (
    <div className="flex flex-col gap-0.5 rounded-lg border bg-[#121214] p-2">
      <span className="text-[11px] text-zinc-500">{label}</span>
      <span className="font-semibold tabular-nums">
        {value === null ? '—' : value.toFixed(1).replace('-', '−')}
      </span>
      <span className="text-[11px] text-zinc-500">{unit}</span>
    </div>
  );
}

function LoudnessCard({ card }: { card: Extract<FeedCard, { type: 'loudness' }> }) {
  return (
    <div data-slot="feed-card" data-card="loudness" className="flex flex-col gap-1.5">
      <span className="flex items-center gap-1.5 text-xs text-zinc-500">
        <Volume2 aria-hidden="true" className="size-3" />
        {JOB_CHAT_TEXT.loudness}
      </span>
      <div className={cn('grid gap-1.5', 'grid-cols-3')}>
        <Stat label="Mix" value={card.integratedLufs} unit="LUFS" />
        <Stat label="Peak" value={card.truePeakDb} unit="dBFS" />
        <Stat label="Range" value={card.rangeLu} unit="LU" />
      </div>
    </div>
  );
}

/** One card of the feed. */
export function FeedCardView({ card }: { card: FeedCard }) {
  switch (card.type) {
    case 'brief':
      return <BriefCard card={card} />;
    case 'transcript':
      return <TranscriptCard text={card.text} />;
    case 'plan':
      return <PlanCard text={card.text} />;
    case 'cuts':
      return <CutsCard card={card} />;
    case 'loudness':
      return <LoudnessCard card={card} />;
  }
}

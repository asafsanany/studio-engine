import type { MoneyLedgerEntry, MoneyResponse } from '@studio/shared';
import { ChevronRight } from 'lucide-react';
import { useMemo, useState } from 'react';
import { ClientAvatar } from '@/components/ClientAvatar';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { type LedgerGrouping, useMoneyUiStore } from '@/stores/money-ui';
import { BANNER_TONE_STYLES } from '../money/banner-view';
import { formatIls, monthName } from '../money/format';
import type { ClientGroup, DetailTone } from '../money/ledger-view';
import { PhoneSegmented } from './PhoneSegmented';
import {
  emptyLedgerText,
  type FooterLine,
  groupCountText,
  groupPreview,
  ledgerColumnLabel,
  type PhoneFooter,
  phoneFooter,
  phoneJobDetail,
  phoneJobRow,
  phoneLedger,
} from './phone-money';

/** The two ways to list the month's videos, as the board's switch names them. */
const GROUPINGS: ReadonlyArray<{ value: LedgerGrouping; label: string }> = [
  { value: 'job', label: 'Every job' },
  { value: 'client', label: 'By client' },
];

/** The hairlines of the board: between rows, and between an open row and its details. */
const RULE = 'border-white/8';
const INNER_RULE = 'border-white/6';

/** A row is a button across the whole width; it greys while pressed, and shows a quiet line for the keyboard. */
const ROW_BUTTON =
  'flex w-full cursor-pointer items-center gap-2.5 px-3 py-2 text-left outline-none transition-colors duration-150 ease-in-out focus-visible:bg-muted/50 focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-solid focus-visible:outline-foreground/30 active:bg-muted/50 [-webkit-tap-highlight-color:transparent]';

/** The colour of an amount at the right of an open video's line (the Mac's: green, red, grey, plain). */
const DETAIL_TONE: Record<DetailTone, string> = {
  green: BANNER_TONE_STYLES.good.accent,
  red: BANNER_TONE_STYLES.bad.accent,
  grey: BANNER_TONE_STYLES.flat.accent,
  plain: '',
};

function Chevron({ open }: { open: boolean }) {
  return (
    <ChevronRight
      aria-hidden="true"
      className={cn(
        'size-4 flex-none text-zinc-500 transition-transform duration-150 ease-in-out',
        open && 'rotate-90',
      )}
    />
  );
}

/** The panel under an open video: Income, Expenses, Profit and Your time, one line each. */
function JobDetail({ entry }: { entry: MoneyLedgerEntry }) {
  return (
    <div data-job-detail={entry.jobId} className="flex flex-col px-3 pb-3">
      {phoneJobDetail(entry).map((row) => (
        <div
          key={row.id}
          data-detail={row.id}
          className={cn('flex items-start justify-between gap-3 border-t py-2', INNER_RULE)}
        >
          <div className="flex min-w-0 flex-col">
            <span className="font-medium">{row.title}</span>
            {row.notes.map((note) => (
              <span key={note} dir="auto" className="text-[13px] text-pretty text-muted-foreground">
                {note}
              </span>
            ))}
          </div>
          <span className={cn('flex-none font-medium tabular-nums', DETAIL_TONE[row.tone])}>
            {row.value}
          </span>
        </div>
      ))}
    </div>
  );
}

/**
 * A video of the month: its name over "client · delivered Oct 21 · Paid Oct 22" ("Not paid yet" in
 * amber), the profit at the right and a chevron. A tap opens the details under it (one video is
 * open on the whole page, the Mac's rule).
 */
function JobRow({
  entry,
  open,
  onToggle,
}: {
  entry: MoneyLedgerEntry;
  open: boolean;
  onToggle: () => void;
}) {
  const row = phoneJobRow(entry);
  return (
    <div data-job-id={entry.jobId} className={cn('border-t', RULE, open && 'bg-muted/35')}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the money details of ${entry.name}`}
        onClick={onToggle}
        className={cn(ROW_BUTTON, 'min-h-[60px]')}
      >
        <span className="flex min-w-0 flex-1 flex-col gap-px">
          <Bidi className="truncate text-[15px] font-medium">{row.name}</Bidi>
          <span className="truncate text-[13px] text-muted-foreground">
            <bdi>{row.client}</bdi>
            {' · '}
            {row.delivered}
            {' · '}
            <span
              data-paid={row.paid.owed ? 'owed' : 'settled'}
              className={cn(row.paid.owed && 'text-amber-200')}
            >
              {row.paid.text}
            </span>
          </span>
        </span>
        <span className="flex-none text-[15px] font-medium tabular-nums">{row.profit}</span>
        <Chevron open={open} />
      </button>
      {open && <JobDetail entry={entry} />}
    </div>
  );
}

/**
 * A client's header in "By client": its avatar, its name over "12 videos", what they kept and a
 * chevron. Open (one at a time), it lists the client's newest videos with where each stands ("Not
 * paid yet", "Paid Oct 20", "Archived"), and says how many more there are.
 */
function ClientGroupRows({
  group,
  open,
  onToggle,
}: {
  group: ClientGroup;
  open: boolean;
  onToggle: () => void;
}) {
  const preview = groupPreview(group);
  return (
    <div data-client-id={group.clientId} className={cn('border-t', RULE)}>
      <button
        type="button"
        aria-expanded={open}
        aria-label={`${open ? 'Hide' : 'Show'} the jobs of ${group.client}`}
        onClick={onToggle}
        className={cn(ROW_BUTTON, 'min-h-14')}
      >
        <ClientAvatar client={group.client} className="size-7" />
        <span className="flex min-w-0 flex-1 flex-col">
          <bdi className="truncate text-[15px] font-medium">{group.client}</bdi>
          <span className="text-[13px] text-muted-foreground">{groupCountText(group)}</span>
        </span>
        <span className="flex-none text-[15px] font-medium tabular-nums">
          {formatIls(group.profit)}
        </span>
        <Chevron open={open} />
      </button>
      {open && (
        <div className="flex flex-col px-3 pb-2 pl-[50px]">
          {preview.rows.map((entry) => (
            <div
              key={entry.jobId}
              className={cn('flex justify-between gap-3 border-t py-2', INNER_RULE)}
            >
              <Bidi className="min-w-0 truncate">{entry.name}</Bidi>
              <span data-paid="" className="flex-none text-muted-foreground tabular-nums">
                {phoneJobRow(entry).paid.text}
              </span>
            </div>
          ))}
          {preview.more !== null && (
            <span
              className={cn('border-t pt-2 pb-1 text-[13px] text-muted-foreground', INNER_RULE)}
            >
              {preview.more}
            </span>
          )}
        </div>
      )}
    </div>
  );
}

const FOOTER_VALUE_TONE: Record<FooterLine['tone'], string> = {
  plain: '',
  red: BANNER_TONE_STYLES.bad.accent,
  muted: 'text-muted-foreground',
};

/**
 * Under the rows, inside the same box: how the month adds up. The videos, what was paid that no
 * video carries (red), a line for a job cost paid in another month when there is one, and the
 * Profit, which is the Profit banner's amount.
 */
function LedgerFooter({ footer }: { footer: PhoneFooter }) {
  return (
    <div
      data-slot="phone-money-footer"
      className="flex flex-col gap-2 border-t border-white/12 px-3 pt-2.5 pb-3 tabular-nums"
    >
      {footer.lines.map((line) => (
        <div key={line.id} data-footer-line={line.id} className="flex flex-col gap-0.5">
          <div className="flex justify-between gap-3">
            <span className={cn(line.tone === 'muted' && 'text-muted-foreground')}>
              {line.label}
            </span>
            <span className={cn('flex-none', FOOTER_VALUE_TONE[line.tone])}>{line.value}</span>
          </div>
          {line.note !== null && line.note !== '' && (
            <p className="text-[13px] text-pretty text-muted-foreground">{line.note}</p>
          )}
        </div>
      ))}
      <div className="flex justify-between gap-3 border-t border-white/12 pt-2 font-semibold">
        <span>Profit</span>
        <span
          data-footer-profit=""
          className={BANNER_TONE_STYLES[footer.profit.tone === 'good' ? 'good' : 'bad'].accent}
        >
          {footer.profit.value}
        </span>
      </div>
    </div>
  );
}

/** The list inside its box: the heading line, the first rows, "Show all N videos" and the footer. */
function LedgerList({ data, grouping }: { data: MoneyResponse; grouping: LedgerGrouping }) {
  const [expanded, setExpanded] = useState(false);
  const open = useMoneyUiStore((state) => state.open);
  const clientOpen = useMoneyUiStore((state) => state.clientOpen);
  const toggleOpen = useMoneyUiStore((state) => state.toggleOpen);
  const setClientOpen = useMoneyUiStore((state) => state.setClientOpen);

  const view = useMemo(
    () => phoneLedger(data.ledger, { grouping, expanded }),
    [data.ledger, grouping, expanded],
  );
  const footer = phoneFooter(data);
  const isOpen = (jobId: string) => open?.kind === 'job' && open.id === jobId;
  // Nothing chosen yet (`undefined`): the first client on the list is open, as on the board.
  const openClient =
    clientOpen === undefined
      ? view.grouping === 'client'
        ? (view.groups[0]?.clientId ?? null)
        : null
      : clientOpen;

  return (
    <div className="overflow-hidden rounded-lg border border-white/10">
      <div className="flex h-9 items-center justify-between px-3 text-[13px] font-medium text-muted-foreground">
        <span>{ledgerColumnLabel(grouping)}</span>
        <span>Profit</span>
      </div>
      {data.ledger.length === 0 && (
        <p className={cn('border-t px-3 py-6 text-center text-muted-foreground', RULE)}>
          {emptyLedgerText(monthName(data.month))}
        </p>
      )}
      {view.grouping === 'job' &&
        view.rows.map((entry) => (
          <JobRow
            key={entry.jobId}
            entry={entry}
            open={isOpen(entry.jobId)}
            onToggle={() => toggleOpen({ kind: 'job', id: entry.jobId })}
          />
        ))}
      {view.grouping === 'client' &&
        view.groups.map((group) => {
          const groupOpen = openClient === group.clientId;
          return (
            <ClientGroupRows
              key={group.clientId}
              group={group}
              open={groupOpen}
              onToggle={() => setClientOpen(groupOpen ? null : group.clientId)}
            />
          );
        })}
      {view.more !== null && (
        <button
          type="button"
          data-slot="phone-money-more"
          onClick={() => setExpanded(!expanded)}
          className={cn(
            'h-12 w-full cursor-pointer border-t text-sm font-medium outline-none transition-colors duration-150 ease-in-out focus-visible:bg-muted/50 active:bg-muted/50 [-webkit-tap-highlight-color:transparent]',
            RULE,
          )}
        >
          {view.more}
        </button>
      )}
      {footer !== null && <LedgerFooter footer={footer} />}
    </div>
  );
}

/**
 * The Ledger on the phone (board MMoney): "Every job | By client" over a box of the month's
 * videos, ten of them and then "Show all 26 videos" (no pager here). The month, the switch, the
 * open video and the open client are the Money page's own store, shared with the Mac.
 */
export function PhoneMoneyLedger({ data }: { data: MoneyResponse }) {
  const grouping = useMoneyUiStore((state) => state.grouping);
  const setGrouping = useMoneyUiStore((state) => state.setGrouping);
  return (
    <section aria-labelledby="phone-ledger-h" className="flex flex-col gap-3">
      <div className="flex flex-col gap-0.5">
        <h2 id="phone-ledger-h" className="text-base font-semibold">
          Ledger
        </h2>
        <p className="text-[13px] text-muted-foreground">
          Every video this month, delivered or not. Tap one for the details.
        </p>
      </div>
      <PhoneSegmented
        label="Group the ledger"
        options={GROUPINGS}
        value={grouping}
        onChange={setGrouping}
      />
      {/* Keyed, so another month or another grouping starts again from the first rows. */}
      <LedgerList key={`${data.month}-${grouping}`} data={data} grouping={grouping} />
    </section>
  );
}

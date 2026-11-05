import { Loader2 } from 'lucide-react';
import { type ComponentProps, useRef } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import type { PayRow } from './pay-list';

/** The words of the dialog (design canvas, Phase 4: "Mark paid"). */
export const MARK_PAID_DIALOG_TEXT = {
  question: 'Which videos does this payment cover, and what was paid for each?',
  /** The amount field's name for a screen reader: "Paid for <video>". */
  paidFor: 'Paid for',
  notPaidYet: 'Not paid yet',
  selectAll: 'Select all',
  clear: 'Clear',
  paidOn: 'Paid on',
  cancel: 'Cancel',
  /** After the name of a video whose folder was deleted (still payable, CVP-204). */
  folderDeleted: 'folder deleted',
} as const;

const PAID_ON_ID = 'mark-paid-on';
const ERROR_ID = 'mark-paid-error';

export interface MarkPaidDialogProps {
  open: boolean;
  /** The client the payment is from, for the title. */
  client: string;
  /** One line per delivered, unpaid video of the client, newest delivery first. */
  rows: readonly PayRow[];
  /** Every video is ticked: the list's button reads "Clear" instead of "Select all". */
  allTicked: boolean;
  /** The "Paid on" day, `YYYY-MM-DD`; empty while the person is typing a new one. */
  paidOn: string;
  /** The latest day a payment can have come in (today); the date input's `max`. */
  today: string;
  /** `paidOn` is a day that can be sent: a full day, not after `today`. */
  paidOnValid: boolean;
  /** The footer's total of what was typed: "Nothing ticked", "1 video · ₪40" or "2 videos · ₪80". */
  total: string;
  /** The primary button: "Mark paid" or "Mark 2 paid". */
  confirm: string;
  /** Something is ticked, every ticked video has an amount, and the day is valid. */
  canConfirm: boolean;
  /** The payment was sent and the answer is not in: everything is off and it cannot be closed. */
  saving: boolean;
  /** Why the last attempt failed, in words for the person; `null` when it did not. */
  error: string | null;
  onToggle: (jobId: string) => void;
  onToggleAll: () => void;
  /** The person typed in a video's amount field (the host ticks the video). */
  onAmountChange: (jobId: string, amount: string) => void;
  onPaidOnChange: (paidOn: string) => void;
  onConfirm: () => void;
  /** Cancel, Escape or a click outside (`false`). Not called while `saving`. */
  onOpenChange: (open: boolean) => void;
  onCloseAutoFocus?: ComponentProps<typeof DialogContent>['onCloseAutoFocus'];
}

/**
 * "Mark paid · <client>": which of the client's delivered videos one payment covers, and the day it
 * came in, and what was paid for each. The list has a header ("Not paid yet · 3" and Select all /
 * Clear) over one 44 px row per video: its checkbox, the name (its own direction, ellipsis) and
 * "Delivered 16 Oct", all three a label for the checkbox, then the amount paid, a small field that
 * starts at the price it was delivered at ("₪ 40") and takes any amount, 0 included. Under it, "Paid on" (today unless changed, never
 * later), then the total on the left of the footer and Cancel and the primary "Mark 2 paid".
 *
 * The first checkbox has the focus when it opens. Presentational: `MarkPaidDialogHost` owns the
 * state and the request.
 */
export function MarkPaidDialog({
  open,
  client,
  rows,
  allTicked,
  paidOn,
  today,
  paidOnValid,
  total,
  confirm,
  canConfirm,
  saving,
  error,
  onToggle,
  onToggleAll,
  onAmountChange,
  onPaidOnChange,
  onConfirm,
  onOpenChange,
  onCloseAutoFocus,
}: MarkPaidDialogProps) {
  const list = useRef<HTMLDivElement>(null);
  const text = MARK_PAID_DIALOG_TEXT;

  return (
    <Dialog
      open={open}
      // Escape or a click outside must not hide the dialog while the payment is on its way.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <DialogContent
        // The board has no close button: Cancel is the way out.
        showCloseButton={false}
        // The board's dialog is 460 px wide and reads at a 1.5 line height (the page's is 1.43).
        className="leading-normal sm:max-w-[460px]"
        onOpenAutoFocus={(event) => {
          // The first video's checkbox, not "Select all": Space ticks it, and nothing happens by accident.
          const first = list.current?.querySelector<HTMLElement>('[role="checkbox"]');
          if (!first) return;
          event.preventDefault();
          first.focus();
        }}
        onCloseAutoFocus={onCloseAutoFocus}
      >
        <DialogHeader className="gap-1.5 text-left">
          <DialogTitle className="leading-[1.3]">
            Mark paid · <bdi>{client}</bdi>
          </DialogTitle>
          <DialogDescription className="leading-normal">{text.question}</DialogDescription>
        </DialogHeader>

        <div ref={list} className="flex flex-col overflow-hidden rounded-md border">
          <div className="flex h-9 shrink-0 items-center justify-between border-b pr-2 pl-3 text-[13px] text-muted-foreground">
            <span>
              {text.notPaidYet} · {rows.length}
            </span>
            <Button
              variant="ghost"
              disabled={saving}
              onClick={onToggleAll}
              className="h-7 px-2 text-[13px] text-foreground"
            >
              {allTicked ? text.clear : text.selectAll}
            </Button>
          </div>
          {/* Scrolls past six or seven videos; the header stays. */}
          <div className="max-h-72 overflow-y-auto">
            {rows.map((row) => (
              <div
                key={row.id}
                data-slot="mark-paid-row"
                className="relative transition-colors ease-in-out hover:bg-accent/60"
              >
                {/* The whole row is the checkbox's label; the amount field lies over its last
                    column, outside it, so a click in the field does not tick or untick. */}
                <label
                  htmlFor={`mark-paid-${row.id}`}
                  className={cn(
                    'grid h-11 cursor-pointer grid-cols-[16px_minmax(0,1fr)_auto_76px] items-center gap-3 px-3',
                    saving && 'cursor-default',
                  )}
                >
                  <Checkbox
                    id={`mark-paid-${row.id}`}
                    checked={row.checked}
                    disabled={saving}
                    onCheckedChange={() => onToggle(row.id)}
                  />
                  {row.folderDeleted ? (
                    <span className="flex min-w-0 items-baseline gap-2">
                      <Bidi className="min-w-0 truncate font-medium">{row.name}</Bidi>
                      <span className="shrink-0 text-[13px] text-muted-foreground">
                        {text.folderDeleted}
                      </span>
                    </span>
                  ) : (
                    <Bidi className="font-medium">{row.name}</Bidi>
                  )}
                  <span className="text-[13px] whitespace-nowrap text-muted-foreground">
                    Delivered {row.delivered}
                  </span>
                </label>
                <span className="absolute inset-y-0 right-3 my-auto h-8">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-2 flex items-center text-muted-foreground"
                  >
                    {row.sign}
                  </span>
                  <Input
                    type="text"
                    inputMode="decimal"
                    autoComplete="off"
                    value={row.amount}
                    disabled={saving}
                    aria-label={`${text.paidFor} ${row.name}`}
                    aria-invalid={!row.amountValid}
                    onFocus={(event) => event.currentTarget.select()}
                    onChange={(event) => onAmountChange(row.id, event.target.value)}
                    // 32 px high like the day's field; an unticked video's amount is quiet.
                    className={cn(
                      'h-8 w-[76px] bg-transparent pr-2 pl-6 text-right text-sm tabular-nums dark:bg-transparent',
                      !row.checked && 'text-muted-foreground',
                    )}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label htmlFor={PAID_ON_ID} className="text-muted-foreground">
            {text.paidOn}
          </label>
          <Input
            id={PAID_ON_ID}
            type="date"
            value={paidOn}
            max={today}
            disabled={saving}
            aria-invalid={!paidOnValid}
            aria-describedby={error === null ? undefined : ERROR_ID}
            onChange={(event) => onPaidOnChange(event.target.value)}
            // The board's field: 32 px high, as wide as its date, the calendar drawn for a dark page.
            className="h-8 w-auto cursor-pointer bg-transparent px-2.5 text-sm [color-scheme:dark] dark:bg-transparent"
          />
        </div>

        {error !== null && (
          <p id={ERROR_ID} role="alert" className="text-sm text-destructive">
            {error}
          </p>
        )}

        <DialogFooter className="flex-row items-center pt-1">
          <span aria-live="polite" className="flex-1 text-muted-foreground tabular-nums">
            {total}
          </span>
          <Button variant="outline" disabled={saving} onClick={() => onOpenChange(false)}>
            {text.cancel}
          </Button>
          <Button disabled={saving || !canConfirm} aria-busy={saving} onClick={onConfirm}>
            {saving && <Loader2 aria-hidden="true" className="animate-spin" />}
            {confirm}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

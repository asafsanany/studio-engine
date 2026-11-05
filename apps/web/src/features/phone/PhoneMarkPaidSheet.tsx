import { Loader2 } from 'lucide-react';
import { useRef } from 'react';
import { ROW_ACTION_ICONS } from '@/components/jobs/IconAction';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import {
  MARK_PAID_DIALOG_TEXT,
  type MarkPaidDialogProps,
} from '@/features/jobs/mark-paid/MarkPaidDialog';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { ignoreMessageTaps, PHONE_SHEET_CLASSES } from './phone-sheet-shell';

const PAID_ON_ID = 'phone-mark-paid-on';
const ERROR_ID = 'phone-mark-paid-error';

/**
 * "Mark paid · <client>" as a bottom sheet (board MMarkPaid): the Mac dialog's question and rules,
 * drawn for a thumb. It takes the dialog's props (`MarkPaidDialogProps`), so `MarkPaidDialogHost`
 * keeps the rules (which videos are owed, newest first, only the asked one ticked, archived ones
 * left out, the total, the request) and only what draws them changes.
 *
 * Top to bottom: the grabber, the title with the question under it, a bordered list (the header
 * "Not paid yet · 3" with Select all / Clear, then one 56 px row per video: its 20 px checkbox, the
 * name in its own direction and "Delivered 16 Oct" with "· folder deleted" when its folder is gone,
 * all a label for the checkbox, then the amount paid, a field that starts at the price it was
 * delivered at and takes any amount, 0 included, with a number pad), "Paid on" with a date field
 * (16 px text, so iOS does not zoom, never later than today), the full-width primary "Mark paid" /
 * "Mark 2 paid", and the total under it. There is no Cancel: the grabber, a tap on the dimmed page
 * and Esc close it, and none of them while the payment is on its way.
 *
 * It opens over whatever asked for it, the job sheet included; a tap on a message does not close it.
 */
export function PhoneMarkPaidSheet({
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
}: MarkPaidDialogProps) {
  const content = useRef<HTMLDivElement>(null);
  const text = MARK_PAID_DIALOG_TEXT;
  const PayIcon = ROW_ACTION_ICONS.pay;

  return (
    <Sheet
      open={open}
      // Escape or a tap outside must not hide the sheet while the payment is on its way.
      onOpenChange={(next) => {
        if (!saving) onOpenChange(next);
      }}
    >
      <SheetContent
        ref={content}
        side="bottom"
        showCloseButton={false}
        data-slot="phone-mark-paid-sheet"
        className={cn(PHONE_SHEET_CLASSES, '[-webkit-tap-highlight-color:transparent]')}
        // The focus starts on the sheet itself: no checkbox is lit by the tap that opened it, and
        // there is no trigger to give it back to when it closes.
        onOpenAutoFocus={(event) => {
          event.preventDefault();
          content.current?.focus();
        }}
        onCloseAutoFocus={(event) => event.preventDefault()}
        onInteractOutside={ignoreMessageTaps}
      >
        <SheetGrabber
          onClose={() => {
            if (!saving) onOpenChange(false);
          }}
          className="pt-2"
        />
        <div className="flex flex-col gap-1 px-4 pt-3.5 pb-3">
          <SheetTitle className="text-lg leading-[1.3]">
            Mark paid · <bdi>{client}</bdi>
          </SheetTitle>
          <SheetDescription className="text-sm">{text.question}</SheetDescription>
        </div>

        <div className="mx-4 flex flex-col overflow-hidden rounded-[10px] border">
          <div className="flex h-11 shrink-0 items-center justify-between border-b pr-1 pl-3.5 text-[13px] text-muted-foreground">
            <span>
              {text.notPaidYet} · {rows.length}
            </span>
            <Button
              type="button"
              variant="ghost"
              disabled={saving}
              onClick={onToggleAll}
              className="h-10 px-3 text-sm text-foreground"
            >
              {allTicked ? text.clear : text.selectAll}
            </Button>
          </div>
          {/* Scrolls past six or seven videos; the header and the button below stay in reach. */}
          <div
            data-slot="phone-mark-paid-list"
            className="max-h-[min(336px,40dvh)] overflow-y-auto overscroll-contain"
          >
            {rows.map((row, index) => (
              <div
                key={row.id}
                data-slot="phone-mark-paid-row"
                className={cn('relative', index > 0 && 'border-t border-white/[0.08]')}
              >
                {/* The whole row is the checkbox's label; the amount field lies over its last
                    column, outside it, so a tap in the field does not tick or untick. */}
                <label
                  htmlFor={`phone-mark-paid-${row.id}`}
                  className={cn(
                    'grid min-h-14 cursor-pointer grid-cols-[20px_minmax(0,1fr)_84px] items-center gap-3 px-3.5 py-1.5 transition-colors duration-150 ease-in-out active:bg-white/5',
                    saving && 'cursor-default',
                  )}
                >
                  <Checkbox
                    id={`phone-mark-paid-${row.id}`}
                    checked={row.checked}
                    disabled={saving}
                    onCheckedChange={() => onToggle(row.id)}
                    className="size-5 rounded-[5px] [&_svg]:size-4"
                  />
                  <span className="flex min-w-0 flex-col gap-px">
                    <Bidi className="truncate text-[15px] font-medium">{row.name}</Bidi>
                    <span className="text-[13px] text-muted-foreground">
                      Delivered {row.delivered}
                      {row.folderDeleted && ` · ${text.folderDeleted}`}
                    </span>
                  </span>
                </label>
                <span className="absolute inset-y-0 right-3.5 my-auto h-10">
                  <span
                    aria-hidden="true"
                    className="pointer-events-none absolute inset-y-0 left-2.5 flex items-center text-muted-foreground"
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
                    // 40 px high with 16 px text (iOS zooms into anything smaller); an unticked video's amount is quiet.
                    className={cn(
                      'h-10 w-[84px] border-white/15 bg-white/[0.045] pr-2.5 pl-7 text-right text-base tabular-nums focus-visible:ring-0 dark:bg-white/[0.045]',
                      !row.checked && 'text-muted-foreground',
                    )}
                  />
                </span>
              </div>
            ))}
          </div>
        </div>

        <div className="flex items-center gap-3 px-4 pt-3.5">
          <label htmlFor={PAID_ON_ID} className="flex-1 text-muted-foreground">
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
            // 40 px high with 16 px text (iOS zooms into anything smaller), the calendar drawn for a dark page.
            className="h-10 w-auto cursor-pointer border-white/15 bg-white/[0.045] px-3 text-base [color-scheme:dark] focus-visible:ring-0 dark:bg-white/[0.045]"
          />
        </div>

        {error !== null && (
          <p id={ERROR_ID} role="alert" className="px-4 pt-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <div className="flex flex-col gap-2 px-4 pt-4">
          <Button
            type="button"
            data-slot="phone-mark-paid-confirm"
            disabled={saving || !canConfirm}
            aria-busy={saving}
            onClick={onConfirm}
            className="h-12 w-full text-[15px] [&_svg:not([class*='size-'])]:size-[18px]"
          >
            {saving ? <Loader2 aria-hidden="true" className="animate-spin" /> : <PayIcon />}
            {confirm}
          </Button>
          <p
            aria-live="polite"
            className="text-center text-[13px] text-muted-foreground tabular-nums"
          >
            {total}
          </p>
        </div>
      </SheetContent>
    </Sheet>
  );
}

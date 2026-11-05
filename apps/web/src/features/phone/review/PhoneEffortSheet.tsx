import type { Effort } from '@studio/shared';
import { Check } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { SheetGrabber } from '@/components/ui/sheet-grabber';
import { effortOfOption, reviewEffortOf } from '@/features/jobs/effort-options';
import { REVIEW_EFFORT_TEXT } from '@/features/review/ReviewEffortMenu';
import { cn } from '@/lib/utils';
import { effortChoices, PHONE_REVIEW_TEXT } from './phone-review';

interface PhoneEffortSheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The job's level; `null` is Default, or Auto while `auto` is set. */
  effort: Effort | null;
  /** A choice was tapped: the level is saved (as the Mac's menu does) and the sheet closes. */
  onChange: (effort: Effort | null) => void;
  /** Quick fixes are on: `effort` is the job's review effort, and the choices start with Auto. */
  auto?: boolean;
}

/**
 * "Effort for the fixes" (board MReviewEffort): a bottom sheet over the review with the same four
 * choices as the Mac's menu (`EFFORT_OPTIONS`: Default · Extra high, Medium, High, Extra high), the
 * job's level checked, as 52 px rows. The level is the job's, so the fixes round that Send starts
 * uses it; Approve takes none.
 *
 * With Quick fixes on (`auto`) the choices are the Mac's: Auto (Default, sparkles, with its line of
 * help under it), then Medium, High and Extra high, each waiting for Send. The line under the
 * title is then only for screen readers: Auto's help is on its row, and Approve takes a level too.
 */
export function PhoneEffortSheet({
  open,
  onOpenChange,
  effort,
  onChange,
  auto = false,
}: PhoneEffortSheetProps) {
  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent
        side="bottom"
        showCloseButton={false}
        // Board MReviewEffort: the review is dimmed to 60 %, not the stock 50 %.
        overlayClassName="bg-black/60"
        data-slot="phone-effort-sheet"
        className="z-[60] gap-0 rounded-t-2xl border-t border-white/10 bg-card p-0 pb-[max(34px,var(--safe-bottom))] data-[state=closed]:duration-200 data-[state=open]:duration-200"
      >
        <SheetGrabber onClose={() => onOpenChange(false)} className="pt-2" />
        <div className="flex flex-col gap-1 px-4 pt-3.5 pb-2.5">
          <SheetTitle className="text-lg leading-[1.43] font-semibold">
            {REVIEW_EFFORT_TEXT.menuLabel}
          </SheetTitle>
          <SheetDescription
            className={cn('text-[13px] text-pretty text-muted-foreground', auto && 'sr-only')}
          >
            {auto ? PHONE_REVIEW_TEXT.effortHintAuto : PHONE_REVIEW_TEXT.effortHint}
          </SheetDescription>
        </div>
        <div role="radiogroup" aria-label={REVIEW_EFFORT_TEXT.menuLabel} className="flex flex-col">
          {effortChoices(effort, auto).map((choice) => {
            const Icon = choice.icon;
            return (
              <Button
                key={choice.id}
                type="button"
                variant="ghost"
                role="radio"
                aria-checked={choice.checked}
                data-option={choice.id}
                onClick={() => {
                  onChange(auto ? reviewEffortOf(choice.id) : effortOfOption(choice.id));
                  onOpenChange(false);
                }}
                className={cn(
                  'h-[52px] w-full justify-start gap-3 rounded-none px-4 text-[15px] font-normal has-[>svg]:px-4 hover:bg-white/5 active:bg-white/5 dark:hover:bg-white/5',
                  choice.ruleAbove && 'border-t border-white/[0.08]',
                  // Auto's line of help makes its row taller than the others.
                  choice.sub !== null && 'h-auto min-h-[52px] py-2.5',
                )}
              >
                <Icon aria-hidden="true" className="size-[18px] flex-none text-muted-foreground" />
                {choice.sub === null ? (
                  <span className="flex-1 text-left">{choice.label}</span>
                ) : (
                  <span className="flex min-w-0 flex-1 flex-col gap-0.5 text-left">
                    <span>{choice.label}</span>
                    <span className="text-[13px] font-normal text-pretty whitespace-normal text-muted-foreground">
                      {choice.sub}
                    </span>
                  </span>
                )}
                <span className="text-[13px] text-muted-foreground">{choice.hint}</span>
                <span className="flex w-5 flex-none justify-center">
                  {choice.checked && <Check aria-hidden="true" className="size-[18px]" />}
                </span>
              </Button>
            );
          })}
        </div>
      </SheetContent>
    </Sheet>
  );
}

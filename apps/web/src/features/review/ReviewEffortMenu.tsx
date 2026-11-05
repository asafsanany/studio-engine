import { type Effort, effortLabel } from '@studio/shared';
import { ChevronDown } from 'lucide-react';
import { effortIcon, gaugeIcon } from '@/components/effort-gauge';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import {
  EFFORT_OPTIONS,
  type EffortOption,
  effortOfOption,
  optionIdOf,
  REVIEW_EFFORT_OPTIONS,
  REVIEW_EFFORT_WORDS,
  reviewChoiceOf,
  reviewEffortOf,
} from '../jobs/effort-options';

/** The words of the Effort button's menu (design canvas, page "Effort", board "Review"). */
export const REVIEW_EFFORT_TEXT = {
  /** The heading of the list: the level is for the round of fixes that Send starts. */
  menuLabel: 'Effort for the fixes',
} as const;

interface ReviewEffortMenuProps {
  /** The job's level; `null` is Default, or Auto while `auto` is set. */
  effort: Effort | null;
  onChange: (effort: Effort | null) => void;
  /** Send is on its way: the level it started with is the one the fixes use. */
  disabled?: boolean;
  /**
   * Quick fixes are on: `effort` is the job's review effort, whose `null` is Auto. The button wears
   * sparkles for Auto, and the menu starts with Auto (Default) and its line of help.
   */
  auto?: boolean;
}

/** The text of one choice: its label with its hint at the end, and Auto's line of help under them. */
function OptionText({ option }: { option: EffortOption }) {
  if (option.sub === undefined) {
    return (
      <>
        <span>{option.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span>
      </>
    );
  }
  return (
    <span className="flex flex-1 flex-col gap-0.5">
      <span className="flex">
        <span>{option.label}</span>
        <span className="ml-auto text-xs text-muted-foreground">{option.hint}</span>
      </span>
      <span className="text-xs text-muted-foreground">{option.sub}</span>
    </span>
  );
}

/**
 * The list the Effort button opens: its heading, a line, then the choices with the job's checked.
 * Without Quick fixes they are Default and the three levels (`EFFORT_OPTIONS`); with it (`auto`)
 * they are Auto (Default, with its line of help), a line, then the levels, each waiting for Send
 * (board "Effort with Auto"). Picking one tells `onChange` the level, `null` for Default or Auto.
 */
export function ReviewEffortList({
  effort,
  onChange,
  auto = false,
}: Pick<ReviewEffortMenuProps, 'effort' | 'onChange' | 'auto'>) {
  const options = auto ? REVIEW_EFFORT_OPTIONS : EFFORT_OPTIONS;
  return (
    <>
      <DropdownMenuLabel>{REVIEW_EFFORT_TEXT.menuLabel}</DropdownMenuLabel>
      <DropdownMenuSeparator />
      <DropdownMenuRadioGroup
        value={auto ? reviewChoiceOf(effort) : optionIdOf(effort)}
        onValueChange={(id) => onChange(auto ? reviewEffortOf(id) : effortOfOption(id))}
      >
        {options.map((option) => (
          <div key={option.id} className="contents">
            <DropdownMenuRadioItem
              value={option.id}
              // The check sits on the first line when the choice has a second one.
              className={option.sub === undefined ? undefined : '[&>span:first-child]:top-[9px]'}
            >
              <OptionText option={option} />
            </DropdownMenuRadioItem>
            {option.separatorAfter === true && <DropdownMenuSeparator />}
          </div>
        ))}
      </DropdownMenuRadioGroup>
    </>
  );
}

/**
 * The review dialog's Effort button, in the footer before "Send N notes": a gauge at the job's
 * level and "Effort: Max" (or "Effort: Default"), which opens the same levels as the row's
 * Effort ▸ menu, the one in use checked. The level belongs to the job, so the fixes round that
 * Send queues uses it. A render after Approve never does, so without Quick fixes the footer shows
 * the button only beside Send.
 *
 * With Quick fixes on (`auto`) the button shows the job's review effort, "Effort: Auto" with
 * sparkles for `null`, and the list starts with Auto. It is there beside Approve too, since Auto
 * decides what happens to the next note.
 */
export function ReviewEffortMenu({
  effort,
  onChange,
  disabled = false,
  auto = false,
}: ReviewEffortMenuProps) {
  const Icon = auto ? effortIcon(reviewChoiceOf(effort)) : gaugeIcon(effort);
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button type="button" variant="outline" data-slot="review-effort" disabled={disabled}>
          <Icon aria-hidden="true" />
          Effort: {auto && effort === null ? REVIEW_EFFORT_WORDS.auto : effortLabel(effort)}
          <ChevronDown aria-hidden="true" className="text-muted-foreground" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" side="top" className={auto ? 'w-82.5' : 'w-62'}>
        <ReviewEffortList effort={effort} onChange={onChange} auto={auto} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

import { Calendar } from 'lucide-react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { monthLabel } from './format';
import { monthOptions } from './months';

/**
 * The phone's look (board MMoney): a 40 px outlined button with the month and a chevron, no
 * calendar icon, and 44 px rows in the list for a thumb. The same Select, with the same months.
 */
const PHONE_TRIGGER =
  'data-[size=default]:h-10 gap-1.5 rounded-lg border-white/15 bg-white/[0.045] pr-2.5 pl-3 shadow-none dark:bg-white/[0.045] dark:hover:bg-white/[0.045] dark:active:bg-muted [&_svg]:opacity-100 [-webkit-tap-highlight-color:transparent]';
const PHONE_ITEM = 'min-h-11 text-[15px]';

/**
 * The month picker: a Select of the months that have deliveries or charges (newest first, this
 * month always among them). It shows the month that is picked even before the list has arrived.
 * `phone` gives it the phone page's look; nothing else changes.
 */
export function MonthSelect({
  month,
  months,
  onChange,
  phone = false,
}: {
  /** The month shown, YYYY-MM. */
  month: string;
  /** The months the server lists, or `undefined` until the first answer. */
  months: readonly string[] | undefined;
  onChange: (month: string) => void;
  /** The phone page's button (PH19); the Mac's page leaves it out. */
  phone?: boolean;
}) {
  return (
    <Select value={month} onValueChange={onChange}>
      <SelectTrigger aria-label="Month" className={cn('font-medium', phone && PHONE_TRIGGER)}>
        {!phone && <Calendar aria-hidden="true" />}
        {/* Spelled out, so the trigger reads right before the list of items has mounted. */}
        <SelectValue>{monthLabel(month)}</SelectValue>
      </SelectTrigger>
      <SelectContent align="end">
        {monthOptions(month, months).map((option) => (
          <SelectItem key={option} value={option} className={cn(phone && PHONE_ITEM)}>
            {monthLabel(option)}
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}

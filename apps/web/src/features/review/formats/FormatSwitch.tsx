import type { JobFormat } from '@studio/shared';
import { cn } from '@/lib/utils';
import { FORMAT_TEXT } from './format-logic';

/**
 * The little frame in front of a label, as the board draws it: 8 × 13 for 9:16, 11 × 11 for 1:1;
 * the other shapes keep a 13 px long side.
 */
function frameSize(format: Pick<JobFormat, 'width' | 'height'>): { width: number; height: number } {
  const ratio = format.width / format.height;
  if (ratio === 1) return { width: 11, height: 11 };
  return ratio > 1
    ? { width: 13, height: Math.ceil(13 / ratio) }
    : { width: Math.ceil(13 * ratio), height: 13 };
}

interface FormatSwitchProps {
  formats: readonly JobFormat[];
  /** The format on show. */
  value: JobFormat;
  onChange: (format: JobFormat) => void;
  /**
   * `phone` (board GNPhone): bigger buttons for a finger and no frame in front of the label; it sits
   * on its own row above the player. Default: the Mac's header control (board GNReview).
   */
  variant?: 'mac' | 'phone';
  className?: string;
}

/**
 * The format switch of Review, on a job with two formats (boards GNReview, GNPhone): a segmented
 * control "9:16 | 1:1". The one on show is pressed. It changes what the player loads and which format
 * a new note is written on; the dialog does the rest.
 */
export function FormatSwitch({
  formats,
  value,
  onChange,
  variant = 'mac',
  className,
}: FormatSwitchProps) {
  const phone = variant === 'phone';
  return (
    // biome-ignore lint/a11y/useSemanticElements: a <fieldset> brings a border, padding and a legend; this is only a named group of two toggle buttons
    <div
      role="group"
      aria-label={FORMAT_TEXT.group}
      data-slot="format-switch"
      className={cn(
        'inline-flex shrink-0 items-center gap-0.5 rounded-lg border border-white/[0.08] bg-zinc-900',
        phone ? 'rounded-[10px] p-[3px]' : 'h-8 p-0.5',
        className,
      )}
    >
      {formats.map((format) => {
        const pressed = format.id === value.id;
        const frame = frameSize(format);
        return (
          <button
            key={format.id}
            type="button"
            aria-pressed={pressed}
            data-format={format.id}
            className={cn(
              'inline-flex cursor-pointer items-center justify-center gap-1.5 font-medium transition-colors duration-150 ease-in-out outline-none focus-visible:ring-[3px] focus-visible:ring-ring/35',
              phone
                ? 'h-[38px] min-w-[88px] rounded-lg px-3.5 text-[15px]'
                : 'h-[26px] rounded-md px-2.5 text-[13px]',
              pressed
                ? 'bg-zinc-700 text-foreground'
                : 'text-muted-foreground hover:text-foreground',
            )}
            onClick={() => onChange(format)}
          >
            {phone ? null : (
              <span
                aria-hidden="true"
                className="inline-block rounded-[2px] border-[1.5px] border-current"
                style={{ width: frame.width, height: frame.height }}
              />
            )}
            {format.label}
          </button>
        );
      })}
    </div>
  );
}

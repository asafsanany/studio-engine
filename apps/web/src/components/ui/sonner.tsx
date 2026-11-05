import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from 'lucide-react';
import type { CSSProperties } from 'react';
import { Toaster as Sonner, type ToasterProps } from 'sonner';
import { cn } from '@/lib/utils';

// shadcn's stock Sonner wrapper, with these changes for this app:
// - no `next-themes`: dark is the only theme (see index.css), so the theme is fixed;
// - toasts move with ease-in-out like the rest of the app. Sonner sets its own `transition` in an
//   unlayered stylesheet, which beats Tailwind's layered utilities, hence the important modifier.
// - toasts stay clickable under a modal. A Radix dialog or sheet turns pointer events off on the
//   body, and the toaster (outside the dialog) inherits that, so a message's Undo would not
//   respond while the job sheet is open.
// - `phone` places the messages for the phone layout (see `toasterPlacement`).

/** How far a message on the phone is from both sides of the screen (boards MJobSheet, MMarkPaid). */
export const PHONE_TOAST_GUTTER = 12;

/**
 * The bottom of a message on the phone: 8 px above the home bar (the board's 42 px is its 34 px +
 * 8), or above the tab bar while that shows with nothing over it (`--phone-toast-bottom`, set by
 * index.css from the shell's `data-phone-tab-bar`).
 */
export const PHONE_TOAST_BOTTOM = 'var(--phone-toast-bottom, calc(var(--safe-bottom) + 8px))';

/**
 * The classes of a message on the phone, which win over sonner's own (its stylesheet is unlayered,
 * hence the `!`): 14 px text that wraps as the boards' does (`text-wrap: pretty`, so a long line
 * never leaves one word alone on the last), 12 px padding with 16 px before the words, and a 36 px
 * Undo (the Mac's is 28 px) whose touch area reaches 44 px.
 */
const PHONE_TOAST_CLASSES = 'py-3! pr-3! pl-4! text-sm! text-pretty!';
const PHONE_TOASTER_CLASSES =
  '[&_[data-button]]:relative [&_[data-button]]:h-9! [&_[data-button]]:px-3! [&_[data-button]]:text-sm! [&_[data-button]]:before:absolute [&_[data-button]]:before:-inset-1 [&_[data-button]]:before:content-[""]';

/**
 * Where messages are drawn. The Mac's are sonner's own: the bottom right corner, 24 px in. On the
 * phone layout (the narrow window with the Phone switch on) they sit in the middle at the bottom,
 * {@link PHONE_TOAST_GUTTER} px from both sides and above the home bar, which at the phone's width
 * is the screen less the gutters (sonner's own rule below 600 px). Pure, so the switch is tested
 * without a browser.
 */
export function toasterPlacement(
  phone: boolean,
): Pick<ToasterProps, 'position' | 'offset' | 'mobileOffset'> {
  if (!phone) return {};
  const offset = {
    left: PHONE_TOAST_GUTTER,
    right: PHONE_TOAST_GUTTER,
    bottom: PHONE_TOAST_BOTTOM,
  };
  // Sonner reads `mobileOffset` below 600 px and `offset` above: a phone-layout window can be either.
  return { position: 'bottom-center', offset, mobileOffset: offset };
}

function Toaster({
  toastOptions,
  phone = false,
  className,
  ...props
}: ToasterProps & {
  /** The phone shell's toaster: the messages are placed for the phone (see {@link toasterPlacement}). */
  phone?: boolean;
}) {
  return (
    <Sonner
      theme="dark"
      className={cn('toaster group', phone && PHONE_TOASTER_CLASSES, className)}
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          '--normal-bg': 'var(--popover)',
          '--normal-text': 'var(--popover-foreground)',
          '--normal-border': 'var(--border)',
          '--border-radius': 'var(--radius)',
          pointerEvents: 'auto',
        } as CSSProperties
      }
      toastOptions={{
        ...toastOptions,
        className: cn('ease-in-out!', phone && PHONE_TOAST_CLASSES, toastOptions?.className),
      }}
      {...toasterPlacement(phone)}
      {...props}
    />
  );
}

export { Toaster };

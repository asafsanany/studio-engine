import {
  Banknote,
  Check,
  Copy,
  Download,
  ExternalLink,
  RotateCcw,
  Send,
  Undo2,
} from 'lucide-react';
import { Pause, Play, Square } from '@/components/icons';
import { Button } from '@/components/ui/button';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** The icon of each row action: on the right-column button and in front of its right-click menu item. */
export const ROW_ACTION_ICONS = {
  start: Play,
  hold: Pause,
  release: Play,
  resume: Play,
  cancel: Square,
  retry: RotateCcw,
  download: Download,
  // Open reel: the Instagram reel linked to an Uploaded video, in the right-click menu only.
  reel: ExternalLink,
  review: Play,
  copy: Copy,
  // Approve (the menu only): the check the review dialog's footer had.
  approve: Check,
  // Approved, Delivered, Uploaded and Paid (Phase 4): Send moves a video on to the client, Banknote asks
  // for the payment, and Undo2 is the way back (in the menu only), also from Approved to Review.
  deliver: Send,
  pay: Banknote,
  undeliver: Undo2,
  unpay: Undo2,
  unapprove: Undo2,
} as const;

export type RowActionIconKind = keyof typeof ROW_ACTION_ICONS;

/** The actions that can be a button: Copy error, Open reel, Approve and the ways back live in the right-click menu only. */
export type IconActionKind = Exclude<
  RowActionIconKind,
  'copy' | 'reel' | 'approve' | 'undeliver' | 'unpay' | 'unapprove'
>;

interface IconActionBase {
  /** The tooltip text and the accessible name: "Start now", "Retry from Render", "Download MP4". */
  label: string;
  disabled?: boolean;
  className?: string;
}

/** Start now, Hold, Release, Resume, Cancel, Retry, Review, Mark delivered, Mark paid…. */
interface PlainAction extends IconActionBase {
  action: Exclude<IconActionKind, 'download'>;
  onClick?: () => void;
}

/** Download MP4: a link when it has an `href`, otherwise a button. */
interface DownloadAction extends IconActionBase {
  action: 'download';
  href?: string;
  onClick?: () => void;
}

export type IconActionProps = PlainAction | DownloadAction;

/**
 * A row action: a 32 px ghost icon button (no fill, outline or shadow; the accent background fades
 * in and out on hover) with a tooltip that carries its label and the same text as its accessible
 * name. Keyboard focus opens the tooltip too, and shows the neutral ring the Button already has
 * for keyboard focus (a mouse click leaves no ring). Needs a TooltipProvider above it.
 */
export function IconAction(props: IconActionProps) {
  const { action, label, disabled, className, onClick } = props;
  const Icon = ROW_ACTION_ICONS[action];
  const icon = <Icon />;
  const href = props.action === 'download' ? props.href : undefined;
  // The Button's own ghost hover is accent at half strength in the dark theme; the row behind it
  // is already muted at half strength, so the button takes the full accent to stay visible on a
  // hovered row (the board's hover colour). The Button's `transition-all` eases it in and out.
  const classes = cn('dark:hover:bg-accent', className);

  // A download with an address is a plain link; everything else is a button.
  const control =
    action === 'download' && href !== undefined && !disabled ? (
      <Button asChild size="icon-sm" variant="ghost" className={classes}>
        <a href={href} download aria-label={label} onClick={onClick}>
          {icon}
        </a>
      </Button>
    ) : (
      <Button
        type="button"
        size="icon-sm"
        variant="ghost"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={classes}
      >
        {icon}
      </Button>
    );

  return (
    <Tooltip>
      <TooltipTrigger asChild>{control}</TooltipTrigger>
      {/* sideOffset 6: the Jobs board puts every tooltip 6 px from its control. */}
      <TooltipContent align="end" sideOffset={6}>
        {label}
      </TooltipContent>
    </Tooltip>
  );
}

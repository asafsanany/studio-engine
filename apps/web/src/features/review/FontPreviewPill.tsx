import { CompareButton } from './CompareButton';
import { FONT_PREVIEW_TEXT, type FontPreviewStatus } from './font-preview';

interface FontPreviewPillProps {
  /** The fonts the video is showing: one is named ("Previewing @Heebo Bold"), more are counted. */
  shown: FontPreviewStatus['shown'];
  /** Compare is held: the video shows the original. */
  comparing: boolean;
  onCompare?(on: boolean): void;
}

/**
 * The pill on the video while the note box names a font (board FOReview, chip and two): "Previewing
 * @Heebo Bold" or "Previewing 2 fonts" at the bottom left, with a ghost Compare button that shows
 * the video as it is while it is held (mouse, or Space/Enter). Drawn inside the player's box, over
 * the click catcher, so a click on it is not a click on the picture; it stays while the video plays.
 *
 * - It says "Previewing", not what the edit will do: the edit lays the text out its own way, and a
 *   wider font may wrap where the edit does not.
 * - The name is cut at the pill's end when the video is narrow.
 * - Space and Enter belong to Compare there (`data-own-keys`), not to play/pause.
 */
export function FontPreviewPill({ shown, comparing, onCompare }: FontPreviewPillProps) {
  const text = FONT_PREVIEW_TEXT.pill(shown);
  return (
    <div
      data-slot="font-preview-pill"
      data-own-keys=""
      className="absolute bottom-2.5 left-2.5 flex h-[34px] max-w-[calc(100%-20px)] items-center gap-1.5 rounded-lg border border-white/[0.14] bg-[rgba(9,9,11,0.88)] pr-1 pl-3 text-xs text-[#FAFAFA]"
    >
      <span dir="ltr" className="min-w-0 truncate" title={text}>
        {text}
      </span>
      <CompareButton comparing={comparing} onCompare={onCompare} />
    </div>
  );
}

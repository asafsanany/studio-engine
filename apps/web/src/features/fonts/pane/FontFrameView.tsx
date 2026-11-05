import {
  FONT_SAMPLE_TEXT,
  type FontFaceInfo,
  type FontFamilyDetail,
  type FontFrame,
  HEBREW_FALLBACK_FONT,
} from '@studio/shared';
import { cn } from '@/lib/utils';
import {
  FONT_FRAME_CAPTION_SHADOW,
  FONT_FRAME_CHIPS,
  FONT_FRAME_TEXT,
  FONT_PANE_FRAME,
  fontFrameCredit,
  fontFrameUrl,
  frameNoHebrewNote,
} from './font-frame-model';
import { FONT_PANE_TEXT, faceTag, type PaneFonts } from './font-pane-model';

/** What the pane hands the On a frame view. */
export interface FontFrameViewProps {
  detail: FontFamilyDetail;
  /** The chosen face (the weight the caption is set in). */
  face: FontFaceInfo;
  /**
   * The `font-family` values for the caption: `fonts.english` for the English line, `fonts.hebrew`
   * for the Hebrew line (Heebo when the font has no Hebrew letters). The pane has already put the
   * font files in the page (`useFontFaces`, use-font-face.ts), so the view only names them.
   */
  fonts: PaneFonts;
  /** The test frame the caption is on. */
  frame: FontFrame;
  /** A frame chip was clicked. */
  onFrame: (frame: FontFrame) => void;
  /** The chosen face's file could not be had: the caption is in a stand-in, and says so. */
  failed?: boolean;
}

/**
 * The "On a frame" view of the pane, shown when the Text | On a frame switch is on "On a frame"
 * (board FOPage, `start=frame`): a 252×448 photo with a dark gradient at the bottom, the Hebrew
 * caption (32 px) and the English one (17 px) centred in the chosen weight with a shadow, and the
 * face's tag (`@Heebo ExtraBold`) top-left; under it the chips Person · Street · Interior with
 * whose photo it is on the right. A font with no Hebrew letters sets the Hebrew line in Heebo (the
 * pane's `fonts.hebrew`) and says so. The name, switch, facts and "To use it" line stay outside it.
 */
export function FontFrameView({
  detail,
  face,
  fonts,
  frame,
  onFrame,
  failed = false,
}: FontFrameViewProps) {
  return (
    <div data-slot="font-frame-view" className="flex flex-col items-center gap-2">
      <div
        data-slot="font-frame"
        className="relative box-content overflow-hidden rounded-[8px] border border-white/10 bg-black"
        style={FONT_PANE_FRAME}
      >
        <img
          src={fontFrameUrl(frame)}
          alt={FONT_FRAME_TEXT.alt}
          {...FONT_PANE_FRAME}
          className="absolute inset-0 object-cover"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{
            background: 'linear-gradient(to top, rgba(0,0,0,0.6), rgba(0,0,0,0) 48%)',
          }}
        />
        <div
          data-slot="font-caption"
          className="absolute right-3.5 bottom-[34px] left-3.5 flex flex-col items-center gap-1.5 text-center text-white"
          style={{
            fontWeight: face.weight,
            fontStyle: face.italic ? 'italic' : 'normal',
            textShadow: FONT_FRAME_CAPTION_SHADOW,
          }}
        >
          <span
            lang="he"
            dir="rtl"
            className="text-[32px] leading-[1.15]"
            style={{ fontFamily: fonts.hebrew }}
          >
            {FONT_SAMPLE_TEXT.captionHebrew}
          </span>
          <span
            lang="en"
            className="text-[17px] leading-tight"
            style={{ fontFamily: fonts.english }}
          >
            {FONT_SAMPLE_TEXT.captionEnglish}
          </span>
        </div>
        <span
          data-slot="font-frame-tag"
          className="absolute top-2 left-2 inline-flex h-5 items-center rounded-full bg-black/55 px-[7px] text-[11px] font-medium text-zinc-50"
        >
          {faceTag(detail, face)}
        </span>
      </div>
      <div className="flex w-full items-center justify-between gap-2">
        <fieldset
          data-slot="font-frame-chips"
          className="m-0 inline-flex min-w-0 items-center gap-0.5 border-0 p-0"
        >
          <legend className="sr-only">{FONT_FRAME_TEXT.chips}</legend>
          {FONT_FRAME_CHIPS.map((chip) => (
            <button
              key={chip.frame}
              type="button"
              aria-pressed={chip.frame === frame}
              onClick={() => onFrame(chip.frame)}
              className={cn(
                'h-6 rounded-md px-2 text-xs font-medium outline-none transition-colors duration-150 ease-in-out focus-visible:ring-[3px] focus-visible:ring-ring/35',
                chip.frame === frame
                  ? 'bg-accent text-foreground'
                  : 'text-muted-foreground hover:bg-accent hover:text-foreground',
              )}
            >
              {chip.label}
            </button>
          ))}
        </fieldset>
        <span data-slot="font-frame-credit" className="text-right text-[11px] text-[#8B8B94]">
          {fontFrameCredit(frame)}
        </span>
      </div>
      {fonts.noHebrew && (
        <p
          role="note"
          data-slot="font-frame-no-hebrew"
          className="mt-1 mb-0 text-[13px] text-pretty text-muted-foreground"
          style={{ width: FONT_PANE_FRAME.width }}
        >
          {frameNoHebrewNote(HEBREW_FALLBACK_FONT)}
        </p>
      )}
      {failed && (
        <p
          role="note"
          data-slot="font-file-failed"
          className="mt-1 mb-0 text-[13px] text-pretty text-muted-foreground"
          style={{ width: FONT_PANE_FRAME.width }}
        >
          {FONT_PANE_TEXT.fileFailed}
        </p>
      )}
    </div>
  );
}

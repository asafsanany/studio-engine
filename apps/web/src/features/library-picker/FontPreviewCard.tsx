import { FONT_SAMPLE_TEXT, type FontFaceInfo, fontScriptLabel } from '@studio/shared';
import { CaseSensitive } from 'lucide-react';
import { faceStack } from '@/features/fonts/pane/font-faces';
import { fontFrameUrl } from '@/features/fonts/pane/font-frame-model';
import { paneFonts } from '@/features/fonts/pane/font-pane-model';
import { cn } from '@/lib/utils';
import { type FontPickerItem, usedInText } from './font-picker';

/** The words of the font card. */
export const FONT_CARD_TEXT = {
  /** The picture's name for a screen reader (the photo is the Fonts page's test frame, not the video). */
  alt: (name: string) => `The caption on a test frame in ${name}`,
  // The job's own font is not always Heebo (it can be Assistant or a custom one): the card says
  // that Hebrew words keep the video's font, and sets its Hebrew sample in Heebo, the usual one.
  noHebrew: 'No Hebrew letters. Hebrew words stay in the video’s own font.',
} as const;

/** The icon in front of a font row. */
export function FontIcon({ className }: { className?: string }) {
  return <CaseSensitive aria-hidden="true" className={className} />;
}

/** The `font-family` and weight a font row or the card's name is set in: the face's own file. */
export function fontRowStyle(face: Pick<FontFaceInfo, 'fileId' | 'weight' | 'italic'>) {
  return {
    fontFamily: faceStack(face),
    fontWeight: face.weight,
    fontStyle: face.italic ? ('italic' as const) : ('normal' as const),
  };
}

interface FontPreviewCardProps {
  item: FontPickerItem;
  /** Heebo's face nearest in weight, when the library has it: the Hebrew line of a font with no Hebrew letters is set in it. */
  heebo: Pick<FontFaceInfo, 'fileId'> | null;
  /**
   * `pane`: the picker's right side, with the test frame. `tip`: the card above a "Uses" chip (about
   * 230 px wide, no picture). Default `pane`.
   */
  variant?: 'pane' | 'tip';
}

/**
 * What the picker's right pane and a "Uses" chip's card show about a font (board FOReview, `card`
 * with `isFont`). The pane: a 140×248 test frame with the Hebrew caption and the English line in
 * that face, the name in its own font at 18 px, "Sans · Hebrew + English", "9 weights · used in 14
 * jobs", and, for a font without Hebrew letters, that Hebrew words keep the video's font. The chip's
 * card: the name in its own font at 22 px, the Hebrew sample at 18 px, the same two facts lines. The
 * font files are already in the page (the list and the chips ask for them: `useFontFaces`); this
 * only names them.
 */
export function FontPreviewCard({ item, heebo, variant = 'pane' }: FontPreviewCardProps) {
  const { face, family } = item;
  const fonts = paneFonts(family, face, heebo);
  const style = {
    fontWeight: face.weight,
    fontStyle: face.italic ? ('italic' as const) : ('normal' as const),
  };
  if (variant === 'tip') {
    return (
      <div
        data-slot="library-preview"
        data-variant="tip"
        className="flex min-w-0 flex-col gap-0.5 text-left"
      >
        <div
          data-slot="font-card-name"
          className="text-[22px] leading-[1.2] [overflow-wrap:anywhere]"
          style={{ ...style, fontFamily: fonts.english }}
        >
          {face.name}
        </div>
        {!import.meta.env.VITE_DEMO && (
          <div
            lang="he"
            dir="rtl"
            data-slot="font-card-hebrew"
            // The card is read left to right: a Hebrew line starts at the left edge too.
            className="text-left text-[18px] leading-[1.3]"
            style={{ ...style, fontFamily: fonts.hebrew }}
          >
            {FONT_SAMPLE_TEXT.captionHebrew}
          </div>
        )}
        <div className="mt-1 text-xs text-muted-foreground">
          {`${family.style} · ${fontScriptLabel(family.he)}`}
        </div>
        <div className="text-xs text-zinc-500">
          {`${family.weightsLabel} · ${usedInText(family.used)}`}
        </div>
        {fonts.noHebrew ? (
          <div data-slot="font-card-no-hebrew" className="mt-1 text-xs text-pretty text-amber-400">
            {FONT_CARD_TEXT.noHebrew}
          </div>
        ) : null}
      </div>
    );
  }
  return (
    <div
      data-slot="library-preview"
      data-variant="pane"
      className="flex w-full flex-col items-center"
    >
      <div
        role="img"
        aria-label={FONT_CARD_TEXT.alt(item.face.name)}
        data-slot="font-card-frame"
        className="relative h-[248px] w-[140px] shrink-0 overflow-hidden rounded-md bg-black"
      >
        <img
          src={fontFrameUrl('person')}
          alt=""
          draggable={false}
          className="absolute inset-0 block size-full object-cover"
        />
        <div
          aria-hidden="true"
          className="absolute inset-0"
          style={{ background: 'linear-gradient(to top, rgba(0,0,0,0.65), rgba(0,0,0,0) 55%)' }}
        />
        <div
          aria-hidden="true"
          data-slot="font-card-caption"
          className="absolute right-1.5 bottom-3 left-1.5 flex flex-col items-center gap-0.5 text-white"
          style={{ ...style, textShadow: '0 1px 6px rgba(0,0,0,0.8)' }}
        >
          {!import.meta.env.VITE_DEMO && (
            <span
              lang="he"
              dir="rtl"
              className="text-[17px] leading-[1.15]"
              style={{ fontFamily: fonts.hebrew }}
            >
              {FONT_SAMPLE_TEXT.captionHebrew}
            </span>
          )}
          <span
            lang="en"
            className="text-[9px] leading-tight"
            style={{ fontFamily: fonts.english }}
          >
            {FONT_SAMPLE_TEXT.captionEnglish}
          </span>
        </div>
      </div>
      <div className="mt-2.5 flex w-full flex-col gap-0.5">
        <div
          data-slot="font-card-name"
          className="text-[18px] leading-tight [overflow-wrap:anywhere]"
          style={{ ...style, fontFamily: fonts.english }}
        >
          {item.face.name}
        </div>
        <div className="text-[13px] text-pretty text-muted-foreground">
          {`${family.style} · ${fontScriptLabel(family.he)}`}
        </div>
        <div className="mt-0.5 text-xs text-zinc-500">
          {`${family.weightsLabel} · ${usedInText(family.used)}`}
        </div>
        {fonts.noHebrew ? (
          <div
            data-slot="font-card-no-hebrew"
            className={cn('mt-1 text-xs text-pretty text-amber-400')}
          >
            {FONT_CARD_TEXT.noHebrew}
          </div>
        ) : null}
      </div>
    </div>
  );
}

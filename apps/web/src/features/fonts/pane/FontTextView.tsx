import {
  FONT_SAMPLE_TEXT,
  type FontFaceInfo,
  type FontFamilyDetail,
  HEBREW_FALLBACK_FONT,
} from '@studio/shared';
import { Check, TriangleAlert } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { faceStack } from './font-faces';
import {
  FONT_PANE_TEXT,
  faceKey,
  faceTag,
  noHebrewNote,
  type PaneFonts,
  sortFaces,
  weightRowLabel,
} from './font-pane-model';

export interface FontTextViewProps {
  detail: FontFamilyDetail;
  /** The chosen face: the specimen is set in its weight. */
  face: FontFaceInfo;
  fonts: PaneFonts;
  /** What they typed in the try box ("" for nothing). */
  tryText: string;
  onTryText: (text: string) => void;
  /** A weight row was clicked. */
  onFace: (face: FontFaceInfo) => void;
  /** The chosen face's file could not be had: the specimen is in a stand-in, and says so. */
  failed: boolean;
}

/** The weight and slant of a face as inline style. */
function weightStyle(face: Pick<FontFaceInfo, 'weight' | 'italic'>) {
  return { fontWeight: face.weight, fontStyle: face.italic ? 'italic' : 'normal' } as const;
}

/**
 * The specimen box (Aa and אב at 64 px, the English and Hebrew lines at 22 px, or their own text in
 * their place), the box to type it in, the no-Hebrew note, and one row per weight. Board FOPage.
 */
export function FontTextView({
  detail,
  face,
  fonts,
  tryText,
  onTryText,
  onFace,
  failed,
}: FontTextViewProps) {
  const own = tryText.trim();
  const style = weightStyle(face);
  const hebrewStyle = { fontFamily: fonts.hebrew, opacity: fonts.hebrewOpacity };

  return (
    <div data-slot="font-text-view" className="flex flex-col gap-3.5">
      <div
        data-slot="font-specimen"
        className="flex flex-col gap-2.5 rounded-xl border bg-[#121214] p-5"
      >
        <div
          className="flex items-baseline gap-[18px] text-[64px] leading-[1.1]"
          style={style}
          data-slot="font-glyphs"
        >
          <span lang="en" style={{ fontFamily: fonts.english }}>
            {FONT_SAMPLE_TEXT.glyphsEnglish}
          </span>
          <span lang="he" dir="rtl" style={hebrewStyle}>
            {FONT_SAMPLE_TEXT.glyphsHebrew}
          </span>
        </div>
        {own === '' ? (
          <div
            data-slot="font-lines"
            className="flex flex-col gap-1 text-[22px] leading-[1.35]"
            style={style}
          >
            <span lang="en" style={{ fontFamily: fonts.english }}>
              {FONT_SAMPLE_TEXT.lineEnglish}
            </span>
            <span lang="he" dir="rtl" className="text-right" style={hebrewStyle}>
              {FONT_SAMPLE_TEXT.lineHebrew}
            </span>
          </div>
        ) : (
          <div
            data-slot="font-own-text"
            dir="auto"
            className="text-[22px] leading-[1.35] [overflow-wrap:anywhere]"
            style={{ ...style, fontFamily: fonts.mixed }}
          >
            {own}
          </div>
        )}
      </div>
      <Input
        type="text"
        dir="auto"
        autoComplete="off"
        aria-label={FONT_PANE_TEXT.tryLabel}
        placeholder={FONT_PANE_TEXT.tryPlaceholder}
        value={tryText}
        onChange={(event) => onTryText(event.target.value)}
        className="h-8 border-border bg-transparent shadow-none transition-colors duration-150 ease-in-out hover:border-white/20 dark:bg-transparent"
      />
      {fonts.noHebrew && (
        <p
          role="note"
          data-slot="font-no-hebrew"
          className="m-0 flex gap-2 text-[13px] text-pretty text-zinc-200"
        >
          <TriangleAlert aria-hidden="true" className="mt-0.5 size-4 flex-none text-amber-400" />
          <span>{noHebrewNote(HEBREW_FALLBACK_FONT)}</span>
        </p>
      )}
      {failed && (
        <p
          role="note"
          data-slot="font-file-failed"
          className="m-0 text-[13px] text-pretty text-muted-foreground"
        >
          {FONT_PANE_TEXT.fileFailed}
        </p>
      )}
      <fieldset data-slot="font-weights" className="m-0 flex min-w-0 flex-col gap-0.5 border-0 p-0">
        <legend className="sr-only">{FONT_PANE_TEXT.weights}</legend>
        {sortFaces(detail.faces).map((row) => {
          const chosen = faceKey(row) === faceKey(face);
          const tag = faceTag(detail, row);
          return (
            <button
              key={faceKey(row)}
              type="button"
              aria-pressed={chosen}
              data-weight={row.weight}
              onClick={() => onFace(row)}
              className={cn(
                'grid h-9 grid-cols-[minmax(0,max-content)_minmax(0,1fr)_16px] items-center gap-3 rounded-lg px-2.5 text-left outline-none transition-colors duration-150 ease-in-out hover:bg-muted/60 focus-visible:ring-[3px] focus-visible:ring-ring/35',
                chosen && 'bg-muted/60',
              )}
            >
              <span
                className="truncate text-base"
                style={{ ...weightStyle(row), fontFamily: faceStack(row) }}
              >
                {weightRowLabel(row)}
              </span>
              <span
                title={tag}
                className="truncate text-right font-mono text-xs text-muted-foreground"
              >
                {tag}
              </span>
              <Check
                aria-hidden="true"
                className={cn('size-3.5 text-foreground', chosen ? 'opacity-100' : 'opacity-0')}
              />
            </button>
          );
        })}
      </fieldset>
    </div>
  );
}

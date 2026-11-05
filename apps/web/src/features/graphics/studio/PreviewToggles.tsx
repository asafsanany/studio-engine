import {
  GRAPHIC_BACKGROUND_LABELS,
  GRAPHIC_BACKGROUNDS,
  GRAPHIC_SIZE_LABELS,
  GRAPHIC_SIZES,
  type GraphicBackground,
  type GraphicSize,
  graphicBackgroundSchema,
  graphicSizeSchema,
} from '@studio/shared';
import { Tabs, TabsList, TabsTrigger } from '@/components/ui/tabs';

// A list may wrap its tabs onto a second line when the preview is narrower than both of them (below
// about 1080 px of window); at the usual widths it is the stock one-line list.
const WRAPPING_LIST = 'h-auto flex-wrap group-data-[orientation=horizontal]/tabs:h-auto';

export interface PreviewTogglesProps {
  size: GraphicSize;
  background: GraphicBackground;
  onSizeChange(size: GraphicSize): void;
  onBackgroundChange(background: GraphicBackground): void;
}

/**
 * The two segmented controls above the picture (board GRStudio): Size (9:16 · 16:9 · 1:1) at the
 * left and Behind it (Sample frame · See-through · Black) at the right. Stock shadcn Tabs; each is
 * one choice of three, so a click is the whole interaction. Side by side when the preview is wide
 * enough, one above the other when not, and a list wraps its own tabs rather than overflowing.
 */
export function PreviewToggles({
  size,
  background,
  onSizeChange,
  onBackgroundChange,
}: PreviewTogglesProps) {
  return (
    <div data-slot="preview-toggles" className="flex flex-wrap items-center justify-between gap-3">
      <Tabs
        value={size}
        onValueChange={(value) => {
          const next = graphicSizeSchema.safeParse(value);
          if (next.success) onSizeChange(next.data);
        }}
      >
        <TabsList aria-label="Size" className={WRAPPING_LIST}>
          {GRAPHIC_SIZES.map((option) => (
            <TabsTrigger key={option} value={option}>
              {GRAPHIC_SIZE_LABELS[option]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
      <Tabs
        value={background}
        onValueChange={(value) => {
          const next = graphicBackgroundSchema.safeParse(value);
          if (next.success) onBackgroundChange(next.data);
        }}
      >
        <TabsList aria-label="Behind the graphic" className={WRAPPING_LIST}>
          {GRAPHIC_BACKGROUNDS.map((option) => (
            <TabsTrigger key={option} value={option}>
              {GRAPHIC_BACKGROUND_LABELS[option]}
            </TabsTrigger>
          ))}
        </TabsList>
      </Tabs>
    </div>
  );
}

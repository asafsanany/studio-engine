import { lutPreviewUrl } from '@/data/luts-api';
import type { PickerItem } from './picker-items';

/**
 * The picture a LUT is shown on in the picker and in a chip's card: the frame before the LUT, and
 * the same frame after each LUT. Until the paused frame of the video is wired in (LU11) it is the
 * test frame "person" of the LUTs page (`lutPreviewUrl`); LU11 passes its own with the same shape.
 */
export interface LibraryFrame {
  /** The frame as it is. `''` when there is none to show. */
  beforeSrc: string;
  /** The frame with the LUT `slug` applied. `previewKey` is the LUT's, for the test frame's cache. */
  afterSrc: (slug: string, previewKey?: string | null) => string;
}

/**
 * The test frame "person" of the LUTs page. Its "before" is the same for every LUT, so one LUT
 * stands for all: the first that is a file (the Cinematic look has none, and its stills are baked
 * from the colour grade, which takes longer and can fail).
 */
export function testLibraryFrame(items: readonly PickerItem[]): LibraryFrame {
  const luts = items.filter((item) => item.type === 'lut');
  const first = luts.find((item) => item.slug !== 'cinematic') ?? luts[0];
  return {
    beforeSrc:
      first === undefined ? '' : lutPreviewUrl(first.slug, 'person', 'before', first.previewKey),
    afterSrc: (slug, previewKey) => lutPreviewUrl(slug, 'person', 'after', previewKey),
  };
}

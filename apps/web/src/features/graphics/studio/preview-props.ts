import type { GraphicDetail, GraphicVars } from '@studio/shared';

/**
 * What the studio gives the preview column. This is the contract with GraphicPreview (GR3):
 * `shownVersion` is the version in the player (the newest unless an older one was picked in the
 * chat), `values` the text of every field (typed, else the default), `making` the version being made
 * (null when none is); the two callbacks are the bar's "Back to vN" and "Use vN again".
 */
export interface GraphicPreviewProps {
  graphic: GraphicDetail | undefined;
  shownVersion: number | null;
  newestVersion: number | null;
  values: GraphicVars;
  making: number | null;
  onBackToNewest: () => void;
  onUseOld: () => void;
}

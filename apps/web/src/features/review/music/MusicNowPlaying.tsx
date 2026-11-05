import type { MusicView } from '@studio/shared';
import { musicNowPlaying } from './music-text';

/**
 * What the preview plays, at the right of the player's controls (board SDReview): "Music v2", "No
 * music". A status, so a screen reader hears it when the soundtrack changes. Nothing for a job
 * without music.
 */
export function MusicNowPlaying({ music }: { music: MusicView | null | undefined }) {
  if (music === null || music === undefined) return null;
  return (
    <span
      role="status"
      data-slot="music-now"
      className="mr-2 min-w-0 truncate text-xs text-muted-foreground"
    >
      {musicNowPlaying(music)}
    </span>
  );
}

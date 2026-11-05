// A stored reel as the API sends it (`InstagramReel`, the shared contract). The link routes answer
// with it; the numbers the Instagram page computes (a reel's × usual) are not the link's to know.

import type { InstagramReel as WireReel } from '@studio/shared';
import type { InstagramReel } from '../db/index.js';
import { toIso } from '../db/mapping.js';

/**
 * The reel as the API sends it. `job` is the video the reel links, with the name the Jobs page
 * shows (a reel's job can be gone: its folder was deleted), and `timesUsual` is `null`: what is
 * usual for the account is the Instagram page's own number.
 */
export function toWireReel(
  reel: InstagramReel,
  job: { id: string; name: string } | null,
): WireReel {
  return {
    shortcode: reel.shortcode,
    url: reel.url,
    postedAt: toIso(reel.postedAt),
    caption: reel.caption ?? '',
    durationSec: reel.durationSec,
    plays: reel.plays,
    likes: reel.likes,
    comments: reel.comments,
    shares: reel.shares,
    sound: reel.sound,
    coauthors: reel.coauthors,
    hashtags: reel.hashtags,
    pinned: reel.pinned,
    paidPartnership: reel.paidPartnership,
    job,
    timesUsual: null,
  };
}

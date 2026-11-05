// The Reels list's link and unlink, ready to call from a menu: the data layer's two mutations (the
// row changes at once, a refusal puts it back) and the messages of reel-link-changes.ts.

import { MutationObserver, useQueryClient } from '@tanstack/react-query';
import { useMemo } from 'react';
import { instagramApi } from '@/data';
import { linkReelMutationOptions, unlinkReelMutationOptions } from '@/data/instagram-mutations';
import type { TextOptions } from './instagram-text';
import { linkReelToJob, type ReelLinkDeps, unlinkReelFromJob } from './reel-link-changes';
import type { ReelLinkToastJob, ReelLinkToastReel } from './reel-link-toasts';

/** What a reel's menu does with its link. Each resolves to whether the change was made. */
export interface ReelLinks {
  link(reel: ReelLinkToastReel, job: ReelLinkToastJob): Promise<boolean>;
  unlink(reel: ReelLinkToastReel, job: ReelLinkToastJob): Promise<boolean>;
}

/**
 * Link to job and Unlink. Each call is its own mutation (a mutation observer made for it, so the
 * messages' Undo works after the list has gone), not the component's `useMutation`, which belongs
 * to one component's life.
 */
export function useReelLinks(textOptions?: TextOptions): ReelLinks {
  const queryClient = useQueryClient();
  return useMemo(() => {
    const params = { queryClient, api: instagramApi };
    const deps: ReelLinkDeps = {
      link: (variables) =>
        new MutationObserver(queryClient, linkReelMutationOptions(params)).mutate(variables),
      unlink: (shortcode) =>
        new MutationObserver(queryClient, unlinkReelMutationOptions(params)).mutate(shortcode),
      textOptions,
    };
    return {
      link: (reel, job) => linkReelToJob(deps, reel, job),
      unlink: (reel, job) => unlinkReelFromJob(deps, reel, job),
    };
  }, [queryClient, textOptions]);
}

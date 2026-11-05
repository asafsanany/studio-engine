// The client page's Instagram data, in one place: the client's Instagram for the range this viewer
// has chosen, read once for the header (handle, followers, bio) and the section below it.

import type { ClientInstagram, InstagramRange } from '@studio/shared';
import { useQuery } from '@tanstack/react-query';
import { instagramApi, useInstagramEnabled } from '@/data';
import { clientInstagramQueryOptions } from '@/data/instagram-query';
import { useInstagramRangeStore } from './instagram-range-store';

export interface InstagramSectionState {
  /** Whether Clients × Instagram is on. While it is off nothing is asked and nothing is drawn. */
  on: boolean;
  /** The client's Instagram for `range`; `undefined` while off, until the first answer, and after a failure. */
  data: ClientInstagram | undefined;
  /** The first answer is on its way. */
  loading: boolean;
  /** The range the viewer chose. */
  range: InstagramRange;
  setRange: (range: InstagramRange) => void;
  /** `data` is still the previous range's while the chosen one loads. */
  stale: boolean;
}

/**
 * The client's Instagram for the chosen range. A change of range keeps showing the old numbers
 * (`stale`) until the new ones arrive, so the page does not blank and the header does not lose its
 * followers; a change of client does not keep the old client's.
 */
export function useInstagramSection(clientId: string): InstagramSectionState {
  const on = useInstagramEnabled();
  const range = useInstagramRangeStore((state) => state.range);
  const setRange = useInstagramRangeStore((state) => state.setRange);
  const query = useQuery({
    ...clientInstagramQueryOptions(instagramApi, clientId, range, on),
    placeholderData: (previous, previousQuery) =>
      previousQuery?.queryKey[1] === clientId ? previous : undefined,
  });
  // Nothing is drawn while the switch is off, even from the cache.
  const data = on ? query.data : undefined;
  return {
    on,
    data,
    loading: on && query.isPending,
    range,
    setRange,
    stale: data !== undefined && query.isPlaceholderData,
  };
}

/**
 * Whether the page has an Instagram section to show (and so a "Jobs" heading under it): the switch
 * is on and the engine has answered. A client with no account shows the empty section (board S8,
 * "Add their Instagram"); with the switch off nothing of Instagram shows.
 */
export function showsInstagram(data: ClientInstagram | undefined): boolean {
  return data !== undefined;
}

import type { ClientInstagram } from '@studio/shared';
import { useMemo, useState } from 'react';
import { useClients, useIsAdmin } from '@/data';
import { useJobSheetOpener } from '@/features/job-sheet/job-sheet-open';
import { copyReelLink } from './copy-reel-link';
import type { TextOptions } from './instagram-text';
import { ReelsList, type ReelsListActions } from './ReelsList';
import type { ReelMenuContext } from './reel-menu';
import { filterReels, type ReelFilter, reelsSubtitle, shownReels } from './reel-rows';
import { useReelLinks } from './use-reel-links';

/**
 * The Reels list of a client's page, under the charts (board CLPage): every reel the scans read,
 * newest first, with its right-click menu. This wires the list to the page: the filter and Show all
 * are the viewer's own and start fresh for each client (the section keys it by client), the menu
 * knows the client's name and the videos that can be linked, Open job opens the job sheet of the page
 * (the same one a Jobs row does), and Link to job and Unlink change the page at once.
 */
export function ReelsCard({
  clientId,
  data,
  textOptions,
}: {
  clientId: string;
  data: ClientInstagram;
  textOptions?: TextOptions;
}) {
  const [filter, setFilter] = useState<ReelFilter>('all');
  const [showAll, setShowAll] = useState(false);
  const admin = useIsAdmin();
  const sheet = useJobSheetOpener();
  const links = useReelLinks(textOptions);
  // The client's name, from the client list the page has loaded; the list's heading says "this client" until it is.
  const { data: clients } = useClients();
  const clientName = clients?.find((row) => row.clientId === clientId)?.client ?? null;

  const { reels } = data;
  const filtered = useMemo(() => filterReels(reels, filter), [reels, filter]);
  const shown = useMemo(() => shownReels(filtered, showAll), [filtered, showAll]);

  const menu = useMemo<ReelMenuContext>(
    () => ({
      clientName,
      linkableJobs: data.linkableJobs,
      linkedJobIds: new Set(reels.flatMap((reel) => (reel.job === null ? [] : [reel.job.id]))),
      admin,
      canOpenJob: sheet !== null,
    }),
    [clientName, data.linkableJobs, reels, admin, sheet],
  );
  const actions = useMemo<ReelsListActions>(
    () => ({
      openJob: sheet === null ? null : (jobId) => sheet.open(jobId),
      link: (reel, job) => void links.link(reel, job),
      unlink: (reel, job) => void links.unlink(reel, job),
      copyLink: (url) => void copyReelLink(url),
    }),
    [sheet, links],
  );

  return (
    <ReelsList
      reels={filtered}
      shown={shown}
      filter={filter}
      onFilterChange={setFilter}
      showAll={showAll}
      onShowAllChange={setShowAll}
      subtitle={reelsSubtitle(data, textOptions)}
      menu={menu}
      actions={actions}
      textOptions={textOptions}
    />
  );
}

// The series items of a job's right-click menu (Series plan §6, boards SeriesJobs and SeriesPage):
//
//   a ready job in no series           "Start a series from this…" (Layers2), after "Use this look"
//   an arriving, queued or held job    a "Series" submenu: the client's series and "Not in a
//   of a client that has series        series", as a radio list
//   any episode                        "Open the series <name>"
//   a ready episode                    "Use as the series format…", or, on the format job itself, a
//                                      disabled "This episode is the format" with a check
//
// On the series' own page (`onSeriesPage`) the menu is the SeriesPage board's: no "Open the series"
// (you are on it), "Use as the series format…" shown (disabled) on every episode that is not ready
// yet, and last "Take out of the series" for an episode that has not started, in place of the
// Series submenu.
//
// `rowMenuEntries` already ends with these. While series are off there are none.

import { canChangeSeries, type Job, type SeriesSummary } from '@studio/shared';
import { Check, CircleMinus, Layers2 } from 'lucide-react';
import type { JobMenuEntry, RowMenuOption } from '@/features/jobs/row-menu';
import { askToStartSeries } from './start-series/start-series-dialog';
import { askToUseAsFormat } from './use-as-format/use-as-format-dialog';

/** What the menu needs to know about series when it opens. */
export interface SeriesMenuContext {
  /** Whether series are on (`useSeriesEnabled`). Off, the menu has no series items. */
  enabled: boolean;
  /** The job's client's series (`useClientSeries`), `[]` until they are loaded. */
  clientSeries: readonly SeriesSummary[];
  /** The list is a series' own page (`useOnSeriesPage`): see the header. */
  onSeriesPage?: boolean;
  /** The Series submenu or "Take out of the series" chose: `null` is "Not in a series". */
  setJobSeries?: (seriesId: string | null) => void;
  /** "Open the series <name>". */
  openSeries?: (series: SeriesSummary) => void;
}

/** Series off, nothing loaded: what the menu has until the row knows better. */
export const NO_SERIES_MENU: SeriesMenuContext = { enabled: false, clientSeries: [] };

/** The id of the Series submenu entry. */
export const SERIES_SUBMENU_ID = 'series';

/** The id of the submenu's last choice, "Not in a series" (a series' own id is 12 hex characters). */
export const NOT_IN_A_SERIES_OPTION = 'none';

/** The Series submenu: a radio list of the client's series and "Not in a series", the job's own checked. */
function seriesSubmenu(job: Job, context: SeriesMenuContext): JobMenuEntry {
  const options: RowMenuOption[] = [
    ...context.clientSeries.map((series) => ({ id: series.id, label: series.name, hint: '' })),
    { id: NOT_IN_A_SERIES_OPTION, label: 'Not in a series', hint: '' },
  ];
  return {
    type: 'submenu',
    id: SERIES_SUBMENU_ID,
    label: 'Series',
    icon: Layers2,
    trailing: null,
    options,
    value: job.seriesId ?? NOT_IN_A_SERIES_OPTION,
    onValueChange: (id) => {
      const seriesId = id === NOT_IN_A_SERIES_OPTION ? null : id;
      // Choosing the series the job is in already is nothing to ask the server.
      if (seriesId !== job.seriesId) context.setJobSeries?.(seriesId);
    },
  };
}

/** The items for a ready job: start a series from it, or, in a series, make it the format. */
function readyEntries(job: Job, series: SeriesSummary | null): JobMenuEntry[] {
  if (job.seriesId === null) {
    return [
      {
        type: 'item',
        id: 'series-start',
        label: 'Start a series from this…',
        icon: Layers2,
        onSelect: () => askToStartSeries(job),
      },
    ];
  }
  // The series is not loaded (yet): nothing to offer that names it.
  if (series === null) return [];
  if (series.formatJobId === job.id) {
    return [
      {
        type: 'item',
        id: 'series-is-format',
        label: 'This episode is the format',
        icon: Check,
        disabled: true,
        onSelect: () => {},
      },
    ];
  }
  return [formatEntry(job, series, false)];
}

/** What the tooltip of a disabled "Use as the series format…" says (board SeriesPage). */
export const FORMAT_NOT_READY_REASON = 'Only an approved episode can be the format';

/** "Use as the series format…": the dialog with the format now and the one it would get. */
function formatEntry(job: Job, series: SeriesSummary, disabled: boolean): JobMenuEntry {
  return {
    type: 'item',
    id: 'series-format',
    label: 'Use as the series format…',
    icon: Layers2,
    disabled,
    ...(disabled ? { disabledReason: FORMAT_NOT_READY_REASON } : {}),
    onSelect: () => askToUseAsFormat(job, series),
  };
}

/** The series items of the job's menu, with their separator (a `JobMenuEntry`, so the Series submenu fits). */
export function seriesMenuEntries(job: Job, context: SeriesMenuContext): JobMenuEntry[] {
  if (!context.enabled) return [];
  const onSeriesPage = context.onSeriesPage ?? false;
  const series =
    job.seriesId === null
      ? null
      : (context.clientSeries.find((candidate) => candidate.id === job.seriesId) ?? null);

  const items: JobMenuEntry[] = [];
  const canChange = canChangeSeries(job);
  if (canChange && !onSeriesPage && context.clientSeries.length > 0) {
    items.push(seriesSubmenu(job, context));
  }
  if (series !== null && !onSeriesPage) {
    const openSeries = context.openSeries;
    items.push({
      type: 'item',
      id: 'series-open',
      label: `Open the series ${series.name}`,
      bidi: series.name,
      icon: Layers2,
      onSelect: () => openSeries?.(series),
    });
  }
  if (job.state === 'ready') {
    items.push(...readyEntries(job, series));
  } else if (onSeriesPage && series !== null) {
    // Only an approved episode can be the format: the item is there, and says no.
    items.push(formatEntry(job, series, true));
  }
  // On the series' own page the way out is the last item (board SeriesPage), after the format's.
  if (canChange && onSeriesPage && job.seriesId !== null) {
    items.push({
      type: 'item',
      id: 'series-take-out',
      label: 'Take out of the series',
      icon: CircleMinus,
      onSelect: () => context.setJobSeries?.(null),
    });
  }

  // A ready job's menu already has the line of its stage group before these; the others start a group.
  if (items.length === 0 || job.state === 'ready') return items;
  return [{ type: 'separator', id: 'series-separator' }, ...items];
}

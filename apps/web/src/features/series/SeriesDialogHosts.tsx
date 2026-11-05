import { StartSeriesDialogHost } from './start-series/StartSeriesDialogHost';
import { UseAsFormatDialogHost } from './use-as-format/UseAsFormatDialogHost';

/**
 * The two series dialogs a job's row menu asks for ("Start a series from <job>?" and "Use <job> as
 * the format?"), for the whole page. Mount it once, next to `UseLookDialogHost`: it draws nothing
 * until a row asks, and a row can only ask while series are on.
 */
export function SeriesDialogHosts() {
  return (
    <>
      <StartSeriesDialogHost />
      <UseAsFormatDialogHost />
    </>
  );
}

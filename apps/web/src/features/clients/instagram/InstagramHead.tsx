import type { ClientInstagram, InstagramRange } from '@studio/shared';
import { scanLine } from './head-view';
import type { TextOptions } from './instagram-text';
import { RangeSwitch } from './RangeSwitch';
import { ScanNowButton } from './ScanNowButton';
import { useStartScan } from './use-start-scan';

/** The id of the section's title, which the section names itself by. */
export const INSTAGRAM_HEADING_ID = 'client-instagram';

/**
 * The section's head: "Instagram" with "Scanned Mon 26 Oct · next scan Mon 2 Nov" under it, and at
 * the right the range (Since us / 90 days / 30 days, left out while there are no numbers to count)
 * and Scan now.
 */
export function InstagramHead({
  clientId,
  data,
  range,
  onRangeChange,
  textOptions,
}: {
  clientId: string;
  data: ClientInstagram;
  range: InstagramRange;
  onRangeChange: (range: InstagramRange) => void;
  textOptions?: TextOptions;
}) {
  const scan = useStartScan(clientId);
  return (
    <div className="flex flex-wrap items-end justify-between gap-3">
      <div className="flex min-w-0 flex-col gap-0.5">
        <h2 id={INSTAGRAM_HEADING_ID} className="text-base leading-[1.43] font-semibold">
          Instagram
        </h2>
        <p className="text-[13px] leading-[1.43] text-muted-foreground">
          {scanLine(data, textOptions)}
        </p>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {data.numbers !== null && <RangeSwitch range={range} onChange={onRangeChange} />}
        <ScanNowButton busy={data.scanning || scan.busy} onScan={scan.start} />
      </div>
    </div>
  );
}

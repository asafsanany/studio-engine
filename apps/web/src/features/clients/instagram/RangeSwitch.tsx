import { INSTAGRAM_RANGES, type InstagramRange } from '@studio/shared';
import { RANGE_LABELS } from './instagram-text';
import { SegmentedSwitch } from './SegmentedSwitch';

const RANGE_OPTIONS = INSTAGRAM_RANGES.map((value) => ({ value, label: RANGE_LABELS[value] }));

/**
 * "Since us" | "90 days" | "30 days": the segmented control in the Instagram section's head. It
 * changes how the section's numbers are counted (see SegmentedSwitch for the look).
 */
export function RangeSwitch({
  range,
  onChange,
}: {
  range: InstagramRange;
  onChange: (range: InstagramRange) => void;
}) {
  return (
    <SegmentedSwitch label="Range" options={RANGE_OPTIONS} value={range} onChange={onChange} />
  );
}

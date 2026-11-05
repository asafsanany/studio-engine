import { AXIS_TEXT, TRACK, WHITE } from './chart-colors';
import { GAUGE_ARC, GAUGE_HEIGHT, GAUGE_THICKNESS, GAUGE_WIDTH, gaugeLayout } from './gauge-layout';

/**
 * A half-circle gauge, drawn by hand in SVG: a track, the part used over it in `color`, a white
 * tick for how far through the month (or week) it is, the figure in the middle and a caption under
 * it. Read-only. `used` and `tick` are shares from 0 to 1.
 */
export function Gauge({
  used,
  tick,
  color,
  percent,
  caption,
  ariaLabel,
}: {
  used: number;
  tick: number | null;
  color: string;
  percent: string;
  caption: string;
  ariaLabel: string;
}) {
  const layout = gaugeLayout(used, tick);
  return (
    <svg
      role="img"
      aria-label={ariaLabel}
      viewBox={`0 0 ${GAUGE_WIDTH} ${GAUGE_HEIGHT}`}
      width={GAUGE_WIDTH}
      height={GAUGE_HEIGHT}
      className="block max-w-full"
    >
      <path
        d={GAUGE_ARC}
        fill="none"
        stroke={TRACK}
        strokeWidth={GAUGE_THICKNESS}
        strokeLinecap="round"
      />
      {used > 0 && (
        <path
          d={GAUGE_ARC}
          fill="none"
          stroke={color}
          strokeWidth={GAUGE_THICKNESS}
          strokeLinecap="round"
          pathLength={100}
          strokeDasharray={layout.dash}
        />
      )}
      {layout.tick !== null && (
        <line
          x1={layout.tick.x1}
          y1={layout.tick.y1}
          x2={layout.tick.x2}
          y2={layout.tick.y2}
          stroke={WHITE}
          strokeWidth={3}
          strokeLinecap="round"
        />
      )}
      <text
        x={120}
        y={112}
        textAnchor="middle"
        fill={WHITE}
        fontSize={34}
        fontWeight={600}
        letterSpacing={-1}
      >
        {percent}
      </text>
      <text x={120} y={140} textAnchor="middle" fill={AXIS_TEXT} fontSize={12}>
        {caption}
      </text>
    </svg>
  );
}

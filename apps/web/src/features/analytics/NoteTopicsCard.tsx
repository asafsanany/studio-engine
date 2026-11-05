import type { AnalyticsReviews } from '@studio/shared';
import { AnalyticsCard } from './AnalyticsCard';
import { ANALYTICS_LAYOUT } from './AnalyticsStates';
import { ANALYTICS_CARDS, noteTopicsSubtitle } from './analytics-copy';
import { CHART_BLUE } from './charts/chart-colors';
import { HoverTip } from './charts/HoverTip';
import { NO_NOTES_YET, noteTopicRows, notGroupedText } from './note-topics-view';

/** A line of its own in the middle of the card: the empty state, and the card with only ungrouped notes. */
function CenteredLine({ children }: { children: string }) {
  return (
    <div className="flex h-full min-h-16 items-center justify-center">
      <p className="text-sm text-muted-foreground">{children}</p>
    </div>
  );
}

/**
 * "What your notes are about": the topics of the review notes, most common first, each a row of
 * topic, bar and count with the clients who got it in muted text under the bar. A muted last line
 * says how many notes have no topic yet. With no note sent the card says "No review notes yet".
 * Client names can be Hebrew, so they read in their own direction. Read-only.
 */
export function NoteTopicsCard({ reviews }: { reviews: AnalyticsReviews }) {
  const rows = noteTopicRows(reviews.noteTopics);
  const notGrouped = notGroupedText(reviews.notGroupedYet);
  return (
    <AnalyticsCard
      title={ANALYTICS_CARDS.noteTopics.title}
      subtitle={noteTopicsSubtitle(reviews.notesSince)}
      className={ANALYTICS_LAYOUT.noteTopics}
    >
      {rows.length === 0 ? (
        <CenteredLine>{notGrouped ?? NO_NOTES_YET}</CenteredLine>
      ) : (
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* pr-1.5: room for the scrollbar, so it never lands on the counts */}
          <ul className="flex min-h-0 flex-col gap-1.5 overflow-y-auto pr-1.5">
            {rows.map((row) => (
              <HoverTip key={row.topic} text={row.title} wide>
                <li className="grid grid-cols-[132px_minmax(0,1fr)_24px] items-center gap-2.5">
                  <span className="truncate text-[13px] text-zinc-300">{row.topic}</span>
                  <div className="flex min-w-0 flex-col gap-[3px]">
                    <div
                      className="h-2.5 min-w-[2px] rounded-[2px]"
                      style={{ width: `${row.barPercent}%`, backgroundColor: CHART_BLUE }}
                    />
                    {/* As on the board (N3): dir="auto" and no text-align, so a line that starts with a
                      Hebrew name reads right to left and sits against the right edge of its column. */}
                    <span
                      dir="auto"
                      className="truncate text-start text-xs text-muted-foreground [unicode-bidi:plaintext]"
                    >
                      {row.clients}
                    </span>
                  </div>
                  <span className="text-right text-[13px] tabular-nums">{row.count}</span>
                </li>
              </HoverTip>
            ))}
          </ul>
          {notGrouped && <p className="shrink-0 text-xs text-muted-foreground">{notGrouped}</p>}
        </div>
      )}
    </AnalyticsCard>
  );
}

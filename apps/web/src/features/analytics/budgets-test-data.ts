import {
  type AnalyticsResponse,
  type ComputeAnalyticsInput,
  computeAnalytics,
  type LimitSnapshot,
  type UsageEntry,
  type UsageTag,
} from '@studio/shared';

// The two budgets with numbers in them, for the tests of the Claude use cards: the app's runs of
// the last day and a half worth $51 (the board's figures), the sessions of the week, and a reading
// of the plan at 96% of the weekly limit. The clock is Saturday 24 October 2026, noon in Israel.

export const ZONE = 'Asia/Jerusalem';
export const NOW = Date.parse('2026-10-24T12:00:00+03:00');
const MILLION = 1_000_000;

/** A usage line worth `usd` dollars: output tokens of Opus 5.5 ($20 per million). */
function worth(usd: number) {
  return {
    'claude-opus-5-5': {
      requests: 1,
      input: 0,
      output: Math.round((usd / 20) * MILLION),
      cacheRead: 0,
      cacheWrite: 0,
    },
  };
}

export function appLine(
  tag: UsageTag,
  hoursAgo: number,
  usd: number,
  job?: { id: string; name: string; client: string },
): UsageEntry {
  return {
    at: new Date(NOW - hoursAgo * 3_600_000).toISOString(),
    from: null,
    source: 'app',
    tag,
    did: `Did ${tag}`,
    session: `app-${tag}-${hoursAgo}`,
    ...(job === undefined ? {} : { client: job.client, job: { id: job.id, name: job.name } }),
    usage: worth(usd),
  };
}

export function sessionLine(tag: UsageTag, daysAgo: number, usd: number): UsageEntry {
  return {
    at: new Date(NOW - daysAgo * 86_400_000).toISOString(),
    from: null,
    source: 'session',
    tag,
    did: `Did ${tag}`,
    session: `s-${tag}`,
    usage: worth(usd),
  };
}

const FALCON = { id: 'j1', name: 'Demo 2', client: 'Falcon FPV' };
const YAEL = { id: 'j2', name: 'Demo 2', client: 'יעל כהן' };

export const APP_LINES: UsageEntry[] = [
  appLine('revise', 30, 20, FALCON),
  appLine('revise', 20, 19, FALCON),
  appLine('edit', 28, 12, YAEL),
  appLine('graphic', 12, 1.15, YAEL),
  appLine('note-topics', 6, 0.06),
];

export const SESSION_LINES: UsageEntry[] = [
  sessionLine('orchestration', 2, 470),
  sessionLine('development', 3, 353),
  sessionLine('planning', 1, 70),
  sessionLine('design', 4, 53),
  sessionLine('process', 2, 45),
  sessionLine('qa', 3, 40),
  sessionLine('personal', 1, 3.41),
  sessionLine('research', 5, 1.63),
];

/** Saturday 21:00 Israel time is when the weekly window resets. */
export const WEEK_RESET = '2026-10-24T18:00:00.000Z';

export function reading(sevenDay: number, fiveHour: number | null = 0.03): LimitSnapshot {
  return {
    at: '2026-10-24T08:50:00.000Z',
    status: 'allowed',
    fiveHour:
      fiveHour === null ? null : { utilization: fiveHour, resetsAt: '2026-10-24T12:50:00.000Z' },
    sevenDay: { utilization: sevenDay, resetsAt: WEEK_RESET },
  };
}

export function inputOf(overrides: Partial<ComputeAnalyticsInput> = {}): ComputeAnalyticsInput {
  return {
    now: NOW,
    timeZone: ZONE,
    jobs: [],
    stepRuns: [],
    sentNotes: [],
    deliveries: [],
    usage: [...APP_LINES, ...SESSION_LINES],
    limits: [reading(0.96)],
    noteTopics: {},
    ...overrides,
  };
}

/** The whole answer with the budgets filled in. */
export function budgetsAnswer(overrides: Partial<ComputeAnalyticsInput> = {}): AnalyticsResponse {
  return computeAnalytics(inputOf(overrides));
}

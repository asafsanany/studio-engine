import { describe, expect, it } from 'vitest';
import {
  FIX_PILL_CORNER_MIN_VIDEO_PX,
  FIX_PILL_NEAR_SEC,
  type FixPillPlan,
  fixBeforeUrl,
  fixPillFit,
  fixPillOf,
  fixPillPlan,
  fixPillText,
} from './fix-pill';
import { FIX_JOB_ID, makeFix } from './test-fixtures';

// The pill on the video for a quick fix (board QFReview, states 3 to 5): the plan the dialog makes
// from the fixes and the notes, and what the player shows of it for where it is.

const notes = [
  { id: 'n1', atSec: 12.4 },
  { id: 'n2', atSec: 30 },
];

describe('fixBeforeUrl', () => {
  it('is the before still of the fix, with the ids escaped', () => {
    expect(fixBeforeUrl(FIX_JOB_ID, 'f1')).toBe(
      `/api/jobs/${FIX_JOB_ID}/fixes/f1/compare/before.png`,
    );
    expect(fixBeforeUrl('a/b', 'x y', 'http://studio.test')).toBe(
      'http://studio.test/api/jobs/a%2Fb/fixes/x%20y/compare/before.png',
    );
  });
});

describe('fixPillPlan', () => {
  it('is nothing without a running or a fixed fix, or before the notes are in', () => {
    expect(fixPillPlan({ jobId: FIX_JOB_ID, fixes: [], notes })).toBeNull();
    expect(fixPillPlan({ jobId: FIX_JOB_ID, fixes: [makeFix()], notes: undefined })).toBeNull();
    for (const status of ['queued', 'escalated', 'failed', 'undone', 'cancelled'] as const) {
      expect(fixPillPlan({ jobId: FIX_JOB_ID, fixes: [makeFix({ status })], notes })).toBeNull();
    }
  });

  it('has the fix that runs, with its note’s time', () => {
    const plan = fixPillPlan({
      jobId: FIX_JOB_ID,
      fixes: [makeFix({ id: 'f2', noteId: 'n2', status: 'running' })],
      notes,
    });
    expect(plan).toEqual({ running: { fixId: 'f2', atSec: 30 }, changed: [] });
  });

  it('has the fixes that landed, each with its moment and its before still', () => {
    const plan = fixPillPlan({
      jobId: FIX_JOB_ID,
      fixes: [makeFix(), makeFix({ id: 'f2', noteId: 'n2' })],
      notes,
    });
    expect(plan?.running).toBeNull();
    expect(plan?.changed).toEqual([
      { fixId: 'f1', atSec: 12.4, beforeSrc: fixBeforeUrl(FIX_JOB_ID, 'f1') },
      { fixId: 'f2', atSec: 30, beforeSrc: fixBeforeUrl(FIX_JOB_ID, 'f2') },
    ]);
  });

  it('has no still for a fix without Compare', () => {
    const plan = fixPillPlan({
      jobId: FIX_JOB_ID,
      fixes: [makeFix({ hasCompare: false })],
      notes,
    });
    expect(plan?.changed).toEqual([{ fixId: 'f1', atSec: 12.4, beforeSrc: null }]);
  });

  it('leaves out a fix whose note is gone: it has no moment', () => {
    expect(
      fixPillPlan({ jobId: FIX_JOB_ID, fixes: [makeFix({ noteId: 'gone' })], notes }),
    ).toBeNull();
  });

  it('has the running fix and the landed ones together', () => {
    const plan = fixPillPlan({
      jobId: FIX_JOB_ID,
      fixes: [makeFix(), makeFix({ id: 'f2', noteId: 'n2', status: 'running' })],
      notes,
    });
    expect(plan?.running?.fixId).toBe('f2');
    expect(plan?.changed.map((moment) => moment.fixId)).toEqual(['f1']);
  });
});

describe('fixPillOf: what the player shows', () => {
  const landed: FixPillPlan = {
    running: null,
    changed: [
      { fixId: 'f1', atSec: 12.4, beforeSrc: '/before-1.png' },
      { fixId: 'f2', atSec: 30, beforeSrc: null },
    ],
  };
  const running: FixPillPlan = { running: { fixId: 'f3', atSec: 12.4 }, changed: [] };
  const base = { plan: landed, ready: true, playing: false, currentSec: 12.4 };

  it('says "Fixing" while a fix runs, with the note’s time, whatever the video does', () => {
    for (const state of [
      { playing: false, currentSec: 0 },
      { playing: true, currentSec: 20 },
    ]) {
      expect(fixPillOf({ ...base, plan: running, ...state })).toEqual({
        kind: 'fixing',
        fixId: 'f3',
        time: '0:12',
      });
    }
  });

  it('says "Changed" with the before still while the video is paused at the fix’s moment', () => {
    expect(fixPillOf(base)).toEqual({
      kind: 'changed',
      fixId: 'f1',
      time: '0:12',
      beforeSrc: '/before-1.png',
    });
  });

  it('keeps the pill within half a second of the moment, on either side', () => {
    expect(FIX_PILL_NEAR_SEC).toBe(0.5);
    expect(fixPillOf({ ...base, currentSec: 12.4 + 0.5 })?.kind).toBe('changed');
    expect(fixPillOf({ ...base, currentSec: 12.4 - 0.5 })?.kind).toBe('changed');
    expect(fixPillOf({ ...base, currentSec: 12.4 + 0.51 })).toBeNull();
    expect(fixPillOf({ ...base, currentSec: 12.4 - 0.51 })).toBeNull();
  });

  it('goes away when the video plays, and comes back when it is paused at the moment', () => {
    expect(fixPillOf({ ...base, playing: true })).toBeNull();
    expect(fixPillOf({ ...base, playing: false })?.kind).toBe('changed');
  });

  it('goes away when the playhead moves off the moment', () => {
    expect(fixPillOf({ ...base, currentSec: 0 })).toBeNull();
    expect(fixPillOf({ ...base, currentSec: 20 })).toBeNull();
  });

  it('is the other fix at its own moment, and without a still when it has none', () => {
    expect(fixPillOf({ ...base, currentSec: 30 })).toEqual({
      kind: 'changed',
      fixId: 'f2',
      time: '0:30',
      beforeSrc: null,
    });
  });

  it('is the nearer of two fixes that are close', () => {
    const close: FixPillPlan = {
      running: null,
      changed: [
        { fixId: 'a', atSec: 10, beforeSrc: null },
        { fixId: 'b', atSec: 10.6, beforeSrc: null },
      ],
    };
    expect(fixPillOf({ ...base, plan: close, currentSec: 10.2 })?.fixId).toBe('a');
    expect(fixPillOf({ ...base, plan: close, currentSec: 10.5 })?.fixId).toBe('b');
  });

  it('is nothing after an Undo: the fix is not a landed one any more', () => {
    const undone = fixPillPlan({
      jobId: FIX_JOB_ID,
      fixes: [makeFix({ status: 'undone' })],
      notes,
    });
    expect(fixPillOf({ ...base, plan: undone })).toBeNull();
  });

  it('is nothing before the player is ready, or without a plan', () => {
    expect(fixPillOf({ ...base, ready: false })).toBeNull();
    expect(fixPillOf({ ...base, plan: running, ready: false })).toBeNull();
    expect(fixPillOf({ ...base, plan: null })).toBeNull();
  });
});

describe('fixPillText', () => {
  const fixing = { kind: 'fixing', fixId: 'f1', time: '0:12' } as const;
  const changed = { kind: 'changed', fixId: 'f1', time: '0:12', beforeSrc: null } as const;

  it('uses the board’s words', () => {
    expect(fixPillText(fixing, false)).toBe('Fixing at 0:12…');
    expect(fixPillText(changed, false)).toBe('Changed at 0:12');
    expect(fixPillText(changed, true)).toBe('Before the fix');
  });

  it('says "Fixing" even if Compare were held: there is no Compare then', () => {
    expect(fixPillText(fixing, true)).toBe('Fixing at 0:12…');
  });
});

describe('fixPillFit: how the pill sits on the video', () => {
  it('stays inside the video on the Mac, however narrow it is', () => {
    expect(fixPillFit({ phone: false, videoWidth: 600 })).toBe('video');
    expect(fixPillFit({ phone: false, videoWidth: 146 })).toBe('video');
  });

  it('sits at the corner on a phone video that is wide enough for it', () => {
    expect(fixPillFit({ phone: true, videoWidth: 390 })).toBe('corner');
    expect(fixPillFit({ phone: true, videoWidth: FIX_PILL_CORNER_MIN_VIDEO_PX })).toBe('corner');
  });

  it('is centered on a narrow phone video: the notes list open (146 px) or the keyboard up', () => {
    expect(fixPillFit({ phone: true, videoWidth: 146 })).toBe('centered');
    expect(fixPillFit({ phone: true, videoWidth: 112 })).toBe('centered');
    expect(fixPillFit({ phone: true, videoWidth: FIX_PILL_CORNER_MIN_VIDEO_PX - 1 })).toBe(
      'centered',
    );
  });

  it('keeps the corner for a video at least as wide as the widest pill with its margins', () => {
    // "Changed at 12:34" with Compare is about 215 px; the corner is 10 px in, and 10 px is left on the right.
    expect(FIX_PILL_CORNER_MIN_VIDEO_PX).toBeGreaterThanOrEqual(215 + 10 + 10);
  });
});

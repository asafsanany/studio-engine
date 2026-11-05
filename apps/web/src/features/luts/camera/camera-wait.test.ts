import { cameraLutWaitSentence, type Job, type LutSummary } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import {
  cameraLutFit,
  cameraWaitingJobs,
  clipsText,
  importForText,
  jobsText,
  otherJobsText,
  waitingExplanation,
  waitingJobTitle,
} from './camera-wait';

const sentence = (curve: Parameters<typeof cameraLutWaitSentence>[0]['curve'], several = false) =>
  cameraLutWaitSentence({ curve, several });

function waitingJob(over: Partial<Job> = {}): Job {
  return makeJob({
    id: 'j-ofek',
    client: 'Ofek',
    name: 'FPV 3',
    state: 'failed',
    failedAt: 5,
    error: sentence('slog3'),
    updatedAt: '2026-10-25T10:00:00.000Z',
    ...over,
  });
}

function lut(name: string, kind: LutSummary['kind'] = 'camera'): LutSummary {
  return {
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    kind,
    size: 33,
    owner: 'yours',
    used: 0,
    usedLabel: 'Not used yet',
    addedAt: null,
    isNew: false,
  };
}

describe('cameraWaitingJobs', () => {
  it('finds failed jobs whose error is the waiting sentence, longest waiting first', () => {
    const later = waitingJob({ id: 'b', name: 'Later', updatedAt: '2026-10-25T11:00:00.000Z' });
    const earlier = waitingJob({ id: 'a', name: 'Earlier', updatedAt: '2026-10-25T09:00:00.000Z' });

    const found = cameraWaitingJobs([later, earlier], []);

    expect(found.map((item) => item.job.id)).toEqual(['a', 'b']);
    expect(found[0]).toMatchObject({
      title: 'Ofek · Earlier',
      wait: { curve: 'slog3', source: null, several: false },
      fit: { kind: 'none' },
    });
  });

  it('leaves out every other job', () => {
    const jobs = [
      waitingJob({ id: 'ok' }),
      waitingJob({ id: 'queued', state: 'queued', error: null }),
      waitingJob({ id: 'editing', state: 'editing', error: sentence('slog3') }),
      waitingJob({
        id: 'other-error',
        error: 'Finished without a final video: ffmpeg is missing.',
      }),
      waitingJob({ id: 'no-error', error: null }),
      waitingJob({ id: 'archived', archivedAt: '2026-10-25T09:00:00.000Z' }),
    ];
    expect(cameraWaitingJobs(jobs, []).map((item) => item.job.id)).toEqual(['ok']);
  });

  it('none wait: an empty list', () => {
    expect(cameraWaitingJobs([], [lut('Sony S-Log3 to Rec709')])).toEqual([]);
  });
});

describe('cameraLutFit', () => {
  const wait = (curve: Parameters<typeof sentence>[0], several = false) => ({
    curve,
    source: null,
    several,
  });

  it('ready: exactly one camera LUT names the curve', () => {
    expect(
      cameraLutFit(wait('slog3'), [lut('Sony S-Log3 to Rec709'), lut('Canon C-Log3 to Rec709')]),
    ).toEqual({ kind: 'ready', lut: expect.objectContaining({ name: 'Sony S-Log3 to Rec709' }) });
  });

  it('several: more than one does', () => {
    expect(
      cameraLutFit(wait('slog3'), [lut('Sony S-Log3 to Rec709'), lut('S-Log3 Cine to Rec709')]),
    ).toEqual({ kind: 'several', names: ['Sony S-Log3 to Rec709', 'S-Log3 Cine to Rec709'] });
  });

  it('none: no camera LUT names it, however many other LUTs there are', () => {
    expect(cameraLutFit(wait('slog3'), [lut('Canon C-Log3 to Rec709')])).toEqual({ kind: 'none' });
    expect(cameraLutFit(wait('slog3'), [lut('S-Log3 teal', 'look')])).toEqual({ kind: 'none' });
    expect(cameraLutFit(wait('slog3'), [])).toEqual({ kind: 'none' });
  });

  it('unknown: the footage does not say which curve, so nothing is matched', () => {
    expect(cameraLutFit(wait(null), [lut('Sony S-Log3 to Rec709')])).toEqual({ kind: 'unknown' });
  });

  it('a waiting job takes it from the library it is given', () => {
    const [item] = cameraWaitingJobs([waitingJob()], [lut('Sony S-Log3 to Rec709')]);
    expect(item?.fit.kind).toBe('ready');
  });
});

describe('the words', () => {
  const item = (
    curve: Parameters<typeof sentence>[0],
    luts: LutSummary[] = [],
    several = false,
  ) => {
    const [first] = cameraWaitingJobs([waitingJob({ error: sentence(curve, several) })], luts);
    if (first === undefined) throw new Error('no waiting job');
    return first;
  };

  it('the title is the client and the job', () => {
    expect(waitingJobTitle({ client: 'Ofek', name: 'FPV 3' })).toBe('Ofek · FPV 3');
  });

  it('what the clips are', () => {
    expect(clipsText({ curve: 'slog3' })).toBe('Sony S-Log3');
    expect(clipsText({ curve: null })).toBe('log footage');
  });

  it('none of your LUTs match (the board’s sentence)', () => {
    expect(waitingExplanation(item('slog3'))).toBe(
      'Its clips are Sony S-Log3 and none of your LUTs match.',
    );
  });

  it('more than one matches: name one in the note', () => {
    const several = item('slog3', [lut('Sony S-Log3 to Rec709'), lut('S-Log3 Cine to Rec709')]);
    expect(waitingExplanation(several)).toBe(
      'Its clips are Sony S-Log3 and more than one of your camera LUTs match: name one in the job’s note.',
    );
  });

  it('the footage names no curve: import it and name it', () => {
    expect(waitingExplanation(item(null))).toBe(
      'Its clips are log footage and the files do not say which camera. Import its camera LUT, then name it in the job’s note.',
    );
  });

  it('jobsText joins titles as the banner reads them', () => {
    expect(jobsText([])).toBe('');
    expect(jobsText(['Ofek · FPV 3'])).toBe('Ofek · FPV 3');
    expect(jobsText(['Ofek · FPV 3', 'Falcon · Reel'])).toBe('Ofek · FPV 3 and Falcon · Reel');
    expect(jobsText(['A', 'B', 'C'])).toBe('A and 2 other jobs');
    expect(otherJobsText(1)).toBe('and 1 other job');
  });

  it('the dialog’s line (the board’s sentence)', () => {
    expect(importForText('Ofek · FPV 3', { curve: 'slog3', source: null, several: false })).toBe(
      'For Ofek · FPV 3: a Sony S-Log3 to Rec709 camera LUT.',
    );
    expect(importForText('Ofek · FPV 3', { curve: null, source: null, several: false })).toBe(
      'For Ofek · FPV 3: a camera LUT for its log footage.',
    );
  });
});

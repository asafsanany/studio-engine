import { describe, expect, it } from 'vitest';
import {
  briefUsage,
  fixRouteUsage,
  graphicRunUsage,
  graphicVoiceUsage,
  jobRunUsage,
  musicUsage,
  noteTopicsUsage,
  quickFixUsage,
  seriesPassUsage,
  stylePassUsage,
  transcribeUsage,
} from './app-usage.js';

const JOB = { id: 'j1', client: 'RGM', name: 'Ep 3' };
const ON_JOB = { client: 'RGM', job: { id: 'j1', name: 'Ep 3' } };

describe('jobRunUsage', () => {
  it('tags each run with its kind', () => {
    expect(jobRunUsage({ ...JOB, runKind: 'edit', round: 0 })).toEqual({
      tag: 'edit',
      did: 'Edited RGM / Ep 3',
      ...ON_JOB,
    });
    expect(jobRunUsage({ ...JOB, runKind: 'revise', round: 2 })).toEqual({
      tag: 'revise',
      did: 'Revised RGM / Ep 3 (round 2)',
      ...ON_JOB,
    });
    expect(jobRunUsage({ ...JOB, runKind: 'render', round: 2 })).toEqual({
      tag: 'render',
      did: 'Rendered RGM / Ep 3',
      ...ON_JOB,
    });
  });
});

describe('briefUsage and transcribeUsage', () => {
  it('count the Brief as part of the edit, and a voice note as transcribe', () => {
    expect(briefUsage(JOB)).toEqual({
      tag: 'edit',
      did: 'Wrote the brief for RGM / Ep 3',
      ...ON_JOB,
    });
    expect(transcribeUsage(JOB)).toEqual({
      tag: 'transcribe',
      did: 'Transcribed a voice note for RGM / Ep 3',
      ...ON_JOB,
    });
  });
});

describe('stylePassUsage', () => {
  it('tags a Read pass with its file count and a Learn pass with its job', () => {
    const file = { name: 'a.md', size: 1 };
    expect(stylePassUsage('RGM', { kind: 'read', mode: 'add', files: [file] })).toEqual({
      tag: 'style-read',
      did: "Read 1 file into RGM's style",
      client: 'RGM',
    });
    expect(stylePassUsage('RGM', { kind: 'read', mode: 'add', files: [file, file] }).did).toBe(
      "Read 2 files into RGM's style",
    );
    expect(
      stylePassUsage('RGM', { kind: 'learn', mode: 'merge', jobId: 'j1', job: 'Ep 3' }),
    ).toEqual({ tag: 'style-learn', did: "Learned RGM's style from Ep 3", ...ON_JOB });
  });
});

describe('seriesPassUsage', () => {
  it('tells Start a series from Use as the series format and from an approval with notes', () => {
    const pass = {
      kind: 'series',
      seriesId: 's1',
      series: 'Weekly',
      jobId: 'j1',
      job: 'Ep 3',
    } as const;
    expect(seriesPassUsage('RGM', { ...pass, mode: 'start' })).toEqual({
      tag: 'series',
      did: 'Started the series Weekly from Ep 3',
      ...ON_JOB,
    });
    expect(seriesPassUsage('RGM', { ...pass, mode: 'replace' }).did).toBe(
      'Made Ep 3 the format of the series Weekly',
    );
    expect(
      seriesPassUsage('RGM', {
        ...pass,
        mode: 'replace',
        notes: [{ name: 'Review notes – Ep 3 – round 1.md', size: 412 }],
      }),
    ).toEqual({
      tag: 'series',
      did: 'Made Ep 3 the format of the series Weekly after its review notes',
      ...ON_JOB,
    });
  });
});

describe('noteTopicsUsage', () => {
  it('tags the topic pass with how many notes it grouped, on no client or job', () => {
    expect(noteTopicsUsage(9)).toEqual({
      tag: 'note-topics',
      did: 'Grouped 9 review notes into topics',
    });
    expect(noteTopicsUsage(1).did).toBe('Grouped 1 review note into topics');
  });
});

describe('graphicRunUsage', () => {
  it('tags a graphic run with the version and the graphic, on no client or job', () => {
    expect(graphicRunUsage('Name on a white pill', 2)).toEqual({
      tag: 'graphic',
      did: 'Made v2 of Name on a white pill',
    });
  });
});

describe('graphicVoiceUsage', () => {
  it('tags a graphic’s voice note as a transcription, on no client or job', () => {
    expect(graphicVoiceUsage()).toEqual({
      tag: 'transcribe',
      did: 'Transcribed a voice note for a graphic',
    });
  });
});

describe('musicUsage', () => {
  it('says which version was made for which job, and how long it is, under the music tag', () => {
    expect(musicUsage(JOB, { id: 'v2', lengthMs: 39_000 })).toEqual({
      tag: 'music',
      did: 'Made music v2 for RGM / Ep 3 (0:39)',
      ...ON_JOB,
    });
    expect(musicUsage(JOB, { id: 'v10', lengthMs: 125_400 }).did).toBe(
      'Made music v10 for RGM / Ep 3 (2:05)',
    );
  });
});

describe('fixRouteUsage', () => {
  it('tags the sorting of a note with the job it is for, under fix-route', () => {
    expect(fixRouteUsage(JOB)).toEqual({
      tag: 'fix-route',
      did: 'Sorted a review note for RGM / Ep 3',
      ...ON_JOB,
    });
  });
});

describe('quickFixUsage', () => {
  it('says what the note asked for, under quick-fix', () => {
    expect(quickFixUsage(JOB, 'Changing the caption font')).toEqual({
      tag: 'quick-fix',
      did: 'Fixed a review note for RGM / Ep 3: Changing the caption font',
      ...ON_JOB,
    });
  });

  it('leaves the kind out when there is none, and trims it', () => {
    expect(quickFixUsage(JOB, '').did).toBe('Fixed a review note for RGM / Ep 3');
    expect(quickFixUsage(JOB, '  Moving the title  ').did).toBe(
      'Fixed a review note for RGM / Ep 3: Moving the title',
    );
  });
});

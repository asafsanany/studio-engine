import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import {
  type BriefDraft,
  briefSchema,
  DRAFT_PENDING_BRIEF_SUMMARY,
  draftPendingBrief,
  noInstructionsBrief,
} from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeJob } from '../events/test-utils.js';
import { makeTempDir } from '../test-temp.js';
import {
  BRIEF_JSON_PATH,
  BRIEF_MD_PATH,
  BriefStep,
  type BriefWriter,
  briefFingerprint,
} from './brief-step.js';

// Draft & chat (DR4): with the switch on, a job with footage has no Brief run. The engine writes the
// placeholder and takes in the brief the Draft writes over it.

const RELPATH = 'Acme/Teaser';

function harness(draft: boolean) {
  const inbox = makeTempDir('studio-brief-draft-');
  const jobDir = join(inbox, RELPATH);
  mkdirSync(jobDir, { recursive: true });
  const write = vi.fn<BriefWriter['write']>(async (_job, run) => {
    const path = join(run.jobDir, BRIEF_JSON_PATH);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        ...noInstructionsBrief(['clip.mp4']),
        summary: 'Written by the Brief run.',
      }),
    );
    return { ok: true };
  });
  const writer: BriefWriter = { write };
  const step = new BriefStep({ inboxPath: inbox, writer, pollIntervalMs: 10, draft });
  const put = (relPath: string, content = 'x') => {
    const path = join(jobDir, relPath);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, content);
  };
  const ctx = { signal: new AbortController().signal, progress: vi.fn() };
  const job = makeJob({ relPath: RELPATH, client: 'Acme', name: 'Teaser', note: 'Make it short.' });
  const readBrief = () => JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8'));
  return { step, writer: { write }, put, ctx, job, jobDir, readBrief };
}

const DRAFTED: BriefDraft = {
  ...noInstructionsBrief(['clip.mp4']),
  summary: 'A 20-second teaser. The logo closes it.',
  files: [
    { path: 'brief.txt', role: 'instructions', note: null },
    { path: 'clip.mp4', role: 'footage', note: null },
  ],
};

describe('the Brief step with Draft & chat on', () => {
  it('writes the placeholder instead of running the Brief for a job with footage', async () => {
    const { step, writer, put, ctx, job, readBrief } = harness(true);
    put('clip.mp4');
    put('brief.txt', 'Keep the logo at the end.');
    const outcome = await step.prepare(job, ctx);
    expect(outcome).toMatchObject({ ok: true, source: 'pending' });
    expect(writer.write).not.toHaveBeenCalled();
    const brief = briefSchema.parse(readBrief());
    expect(brief.summary).toBe(DRAFT_PENDING_BRIEF_SUMMARY);
    expect(brief.files).toEqual([
      { path: 'brief.txt', role: 'instructions', note: null },
      { path: 'clip.mp4', role: 'footage', note: null },
    ]);
  });

  it('still runs the Brief for a job with no footage, which may be a generated video', async () => {
    const { step, writer, put, ctx, job } = harness(true);
    put('script.txt', 'A 30 s ad.');
    put('reference/look.mp4');
    expect(await step.prepare(job, ctx)).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it('runs the Brief as before with the switch off', async () => {
    const { step, writer, put, ctx, job } = harness(false);
    put('clip.mp4');
    put('brief.txt');
    expect(await step.prepare(job, ctx)).toMatchObject({ ok: true, source: 'ran' });
    expect(writer.write).toHaveBeenCalledTimes(1);
  });

  it('keeps the placeholder on a Resume, so the Draft still reads the instructions', async () => {
    const { step, writer, put, ctx, job } = harness(true);
    put('clip.mp4');
    put('brief.txt');
    await step.prepare(job, ctx);
    expect(await step.prepare(job, ctx)).toMatchObject({ ok: true, source: 'reused' });
    expect(writer.write).not.toHaveBeenCalled();
  });
});

describe('adopt', () => {
  it('takes in the brief the Draft wrote: schema, fingerprint and brief.md', async () => {
    const { step, put, ctx, job, jobDir, readBrief } = harness(true);
    put('clip.mp4');
    put('brief.txt');
    await step.prepare(job, ctx);
    const fingerprint = readBrief().fingerprint as string;
    writeFileSync(join(jobDir, BRIEF_JSON_PATH), JSON.stringify(DRAFTED));

    expect(await step.adopt(job)).toBe('adopted');
    const brief = briefSchema.parse(readBrief());
    expect(brief).toMatchObject({ schema: 1, fingerprint, summary: DRAFTED.summary });
    expect(readFileSync(join(jobDir, BRIEF_MD_PATH), 'utf8')).toContain(DRAFTED.summary);
    // A Resume after it reuses it: same fingerprint.
    expect(await step.prepare(job, ctx)).toMatchObject({ source: 'reused' });
  });

  it('leaves the placeholder, a broken brief and a missing one as they are', async () => {
    const { step, put, ctx, job, jobDir } = harness(true);
    expect(await step.adopt(job)).toBe('missing');
    put('clip.mp4');
    put('brief.txt');
    await step.prepare(job, ctx);
    expect(await step.adopt(job)).toBe('pending');
    writeFileSync(join(jobDir, BRIEF_JSON_PATH), JSON.stringify({ summary: 'only this' }));
    expect(await step.adopt(job)).toBe('invalid');
  });

  it('does nothing with the switch off', async () => {
    const { step, job, jobDir } = harness(false);
    mkdirSync(join(jobDir, 'edit'), { recursive: true });
    writeFileSync(join(jobDir, BRIEF_JSON_PATH), JSON.stringify(DRAFTED));
    expect(await step.adopt(job)).toBe('off');
    expect(JSON.parse(readFileSync(join(jobDir, BRIEF_JSON_PATH), 'utf8'))).toEqual(DRAFTED);
  });
});

describe('draftPendingBrief', () => {
  it('guesses each file’s role from its kind and says it is not read yet', () => {
    expect(
      draftPendingBrief([
        { path: 'a.mp4', kind: 'video' },
        { path: 'voice.m4a', kind: 'audio' },
        { path: 'chat.png', kind: 'image' },
      ]),
    ).toMatchObject({
      summary: DRAFT_PENDING_BRIEF_SUMMARY,
      files: [
        { path: 'a.mp4', role: 'footage' },
        { path: 'voice.m4a', role: 'footage' },
        { path: 'chat.png', role: 'instructions' },
      ],
    });
  });

  it('fingerprints like any other brief', () => {
    expect(typeof briefFingerprint([], null)).toBe('string');
  });
});

import { Buffer } from 'node:buffer';
import type { JobFeedItem } from '@studio/shared';
import { jobFeedItemSchema } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  briefCard,
  cutsCard,
  FeedBuilder,
  imageLabel,
  imageSize,
  parseLoudness,
  planText,
  toolLabel,
} from './feed-builder.js';

const JOB = '/inbox/Pinewood/97 Window Ad';

/** A 1x1 PNG, then the same header claiming 1130 x 540 (a frames-and-sound-wave picture). */
function png(width: number, height: number): string {
  const bytes = Buffer.alloc(24);
  bytes.writeUInt32BE(0x89504e47, 0);
  bytes.writeUInt32BE(0x0d0a1a0a, 4);
  bytes.writeUInt32BE(13, 8);
  bytes.write('IHDR', 12);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes.toString('base64');
}

const marker = (event: string, fields: Record<string, unknown> = {}) =>
  JSON.stringify({ type: 'studio_engine', event, at: '2026-10-25T20:58:11.384Z', ...fields });
const assistant = (...content: unknown[]) =>
  JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } });
const results = (...content: unknown[]) =>
  JSON.stringify({ type: 'user', message: { role: 'user', content } });
const text = (value: string) => ({ type: 'text', text: value });
const bash = (id: string, command: string, description?: string) => ({
  type: 'tool_use',
  id,
  name: 'Bash',
  input: description === undefined ? { command } : { command, description },
});
const read = (id: string, path: string) => ({
  type: 'tool_use',
  id,
  name: 'Read',
  input: { file_path: path },
});
const write = (id: string, path: string) => ({
  type: 'tool_use',
  id,
  name: 'Write',
  input: { file_path: path, content: '…' },
});
const done = (id: string, content: unknown = 'ok', isError = false) => ({
  type: 'tool_result',
  tool_use_id: id,
  content,
  is_error: isError,
});
const picture = (data: string) => ({
  type: 'image',
  source: { type: 'base64', data, media_type: 'image/png' },
});

function build(lines: string[], files: Record<string, string> = {}) {
  const saved = new Map<string, Buffer>();
  const builder = new FeedBuilder(
    {
      saveImage: (name, bytes) => saved.set(name, bytes),
      readText: (path) => files[path] ?? null,
    },
    { pendingBriefSummary: 'Not read yet.' },
  );
  for (const line of lines) builder.push(line);
  // Every item must be what the API promises.
  for (const item of builder.items) jobFeedItemSchema.parse(item);
  return { builder, items: builder.items as JobFeedItem[], saved };
}

const EDL = JSON.stringify({
  version: 1,
  ranges: [
    { source: 'A', start: 0, end: 3.0333, beat: 'HOOK alert', out_start: 0, out_end: 3.0333 },
    { source: 'B', start: 0, end: 2.25, beat: 'L1 pour', speed: 0.9, quote: 'Ever poured water?' },
  ],
  total_duration_s: 35,
});

describe('FeedBuilder', () => {
  it('turns a Draft into its run, its words, its folded commands, its pictures and its cards', () => {
    const { items, saved, builder } = build(
      [
        marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
        JSON.stringify({ type: 'system', subtype: 'init', cwd: JOB }),
        assistant(text('Reading the brief first.')),
        assistant(text('Then the footage.')),
        assistant(bash('t1', 'python transcribe_batch.py edit', 'Transcribe the footage')),
        assistant(bash('t2', 'python pack_transcripts.py --edit-dir edit')),
        results(done('t1')),
        results(done('t2')),
        assistant(read('t3', `${JOB}/edit/verify/cut_11.0-21.9.png`)),
        results(done('t3', [picture(png(1130, 540))])),
        assistant(read('t4', `${JOB}/edit/verify/frames/J1.png`)),
        results(done('t4', [picture(png(1080, 1920))])),
        assistant(write('t5', `${JOB}/edit/edl.json`)),
        results(done('t5')),
        assistant(
          bash('t6', 'ffmpeg -i cut.mp4 -af ebur128=peak=true -f null -', 'Measure loudness'),
        ),
        results(
          done(
            't6',
            '  Integrated loudness:\n    I:         -14.1 LUFS\n  Loudness range:\n    LRA:         5.2 LU\n  True peak:\n    Peak:        -1.5 dBFS',
          ),
        ),
        assistant(text('Cut 1 is ready.')),
        marker('end', { outcome: 'succeeded', durationMs: 3_006_153 }),
      ],
      {
        [`${JOB}/edit/takes_packed.md`]:
          '## A\n[0.0-3.0] You won’t believe what’s in your skylights.',
        [`${JOB}/edit/edl.json`]: EDL,
      },
    );

    expect(items.map((item) => item.kind)).toEqual([
      'run',
      'text',
      'tools',
      'card',
      'images',
      'tools',
      'card',
      'tools',
      'card',
      'text',
    ]);
    expect(items[0]).toMatchObject({
      run: 'draft',
      mode: 'start',
      outcome: 'succeeded',
      durationMs: 3_006_153,
    });
    expect(items[1]).toMatchObject({ text: 'Reading the brief first.\n\nThen the footage.' });
    expect(items[2]).toMatchObject({
      tools: [
        { label: 'Transcribe the footage', state: 'done' },
        { label: 'python pack_transcripts.py --edit-dir edit', state: 'done' },
      ],
    });
    expect(items[3]).toMatchObject({ card: { type: 'transcript' } });
    // Reading a picture is the picture, not a command; two in a row share one item.
    expect(items[4]).toMatchObject({
      kind: 'images',
      images: [
        {
          label: 'Frames and sound wave · 11.0–21.9 s',
          path: 'edit/verify/cut_11.0-21.9.png',
          wide: true,
        },
        { label: 'J1', path: 'edit/verify/frames/J1.png', wide: false },
      ],
    });
    expect([...saved.keys()]).toEqual(['L10-0-0.png', 'L12-0-0.png']);
    expect(items[5]).toMatchObject({ tools: [{ label: 'Wrote edit/edl.json' }] });
    expect(items[6]).toMatchObject({
      card: {
        type: 'cuts',
        totalSec: 35,
        cuts: [{ source: 'A', beat: 'HOOK alert' }, { source: 'B' }],
      },
    });
    expect(items[8]).toMatchObject({
      card: { type: 'loudness', integratedLufs: -14.1, truePeakDb: -1.5, rangeLu: 5.2 },
    });
    expect(builder.lines).toBe(18);
  });

  it('gives the same ids and picture names when the same log is built again', () => {
    const lines = [
      marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
      assistant(text('Hello')),
      assistant(read('t1', `${JOB}/edit/x.png`)),
      results(done('t1', [picture(png(10, 10))])),
    ];
    const first = build(lines);
    const second = build(lines);
    expect(second.items).toEqual(first.items);
    expect([...second.saved.keys()]).toEqual([...first.saved.keys()]);
  });

  it('numbers the review rounds and keeps a resumed round’s number', () => {
    const { items } = build([
      marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
      marker('end', { outcome: 'succeeded' }),
      marker('start', { mode: 'start', runKind: 'revise', cwd: JOB }),
      marker('end', { outcome: 'stopped' }),
      marker('start', { mode: 'resume', runKind: 'revise', cwd: JOB }),
      marker('end', { outcome: 'succeeded' }),
      marker('start', { mode: 'start', runKind: 'revise', cwd: JOB }),
      marker('end', { outcome: 'failed', error: 'Finished without a preview' }),
      marker('start', { mode: 'start', runKind: 'render', cwd: JOB }),
    ]);
    expect(
      items.map((item) => (item.kind === 'run' ? [item.run, item.round, item.outcome] : null)),
    ).toEqual([
      ['draft', null, 'succeeded'],
      ['round', 1, 'stopped'],
      ['round', 1, 'succeeded'],
      ['round', 2, 'failed'],
      ['render', null, null],
    ]);
    expect(items[3]).toMatchObject({ error: 'Finished without a preview' });
  });

  it('shows the Brief, Generate and a quick fix as runs, and leaves out the sorting of a note', () => {
    const { items } = build([
      marker('brief_start', { run: 'brief', cwd: JOB }),
      assistant(text('Reading the brief.')),
      marker('brief_end', { run: 'brief', outcome: 'succeeded', durationMs: 54_295 }),
      marker('generate_start', { run: 'generate', cwd: JOB }),
      marker('generate_end', { run: 'generate', outcome: 'succeeded' }),
      marker('fix_route_start'),
      assistant(text('This note is a caption change.')),
      marker('fix_route_end'),
      marker('quick_fix_start', { cwd: JOB }),
      assistant(text('Changed the caption.')),
      marker('quick_fix_end', { outcome: 'succeeded' }),
    ]);
    expect(items.map((item) => (item.kind === 'run' ? item.run : item.kind))).toEqual([
      'brief',
      'text',
      'generate',
      'fix',
      'text',
    ]);
    expect(items.some((item) => item.kind === 'text' && item.text.includes('caption change'))).toBe(
      false,
    );
  });

  it('marks a failed command, and a command cut short when its run is stopped', () => {
    const { items } = build([
      marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
      assistant(bash('t1', 'false', 'Try something')),
      results(done('t1', 'exit 1', true)),
      assistant(bash('t2', 'sleep 100', 'Wait')),
      marker('end', { outcome: 'cancelled' }),
    ]);
    expect(items[1]).toMatchObject({
      tools: [
        { label: 'Try something', state: 'failed' },
        { label: 'Wait', state: 'failed' },
      ],
    });
  });

  it('skips a helper’s own lines, thinking, usage and lines that are not JSON', () => {
    const { items, builder } = build([
      marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
      JSON.stringify({
        type: 'assistant',
        parent_tool_use_id: 'task1',
        message: { content: [text('inside a helper')] },
      }),
      assistant({ type: 'thinking', thinking: 'hmm' }),
      JSON.stringify({ type: 'rate_limit_event' }),
      'not json at all',
      '',
    ]);
    expect(items).toHaveLength(1);
    expect(builder.lines).toBe(6);
  });

  it('shows what a run understood from the brief, but not the placeholder', () => {
    const brief = (summary: string) =>
      JSON.stringify({
        summary,
        length: { targetSec: 35, maxSec: null },
        canvas: { width: 1080, height: 1920 },
        language: 'en',
        platform: ['Instagram Reel'],
        tone: 'Trustworthy',
      });
    const lines = [
      marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
      assistant(write('t1', `${JOB}/edit/brief.json`)),
      results(done('t1')),
    ];
    const real = build(lines, {
      [`${JOB}/edit/brief.json`]: brief('A 35 s ad for window cleaning.'),
    });
    expect(real.items[2]).toMatchObject({
      card: {
        type: 'brief',
        summary: 'A 35 s ad for window cleaning.',
        facts: [
          { label: 'Length', value: '35 s' },
          { label: 'Canvas', value: '1080 × 1920' },
          { label: 'Language', value: 'en' },
          { label: 'For', value: 'Instagram Reel' },
          { label: 'Tone', value: 'Trustworthy' },
        ],
      },
    });
    const placeholder = build(lines, { [`${JOB}/edit/brief.json`]: brief('Not read yet.') });
    expect(placeholder.items.some((item) => item.kind === 'card')).toBe(false);
  });

  it('looks at the files a script names after it ran', () => {
    const { items } = build(
      [
        marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
        assistant(bash('t1', 'python scripts/cutplan.py', 'Write cut plan and EDL')),
        results(done('t1')),
        assistant(bash('t2', 'cat edit/edl.json', 'Show the EDL')),
        results(done('t2')),
      ],
      { [`${JOB}/edit/edl.json`]: EDL },
    );
    // The second command found the same cut list: one card.
    expect(items.filter((item) => item.kind === 'card')).toEqual([
      expect.objectContaining({ card: expect.objectContaining({ type: 'cuts' }) }),
    ]);
  });

  it('shows a file that is the same as last time only once', () => {
    const { items } = build(
      [
        marker('start', { mode: 'start', runKind: 'edit', cwd: JOB }),
        assistant(write('t1', `${JOB}/edit/project.md`)),
        results(done('t1')),
        assistant(write('t2', `${JOB}/edit/project.md`)),
        results(done('t2')),
      ],
      { [`${JOB}/edit/project.md`]: '# Notes\n\n## Strategy\nHook on the alert.\n\n## Cut\n…' },
    );
    expect(items.filter((item) => item.kind === 'card')).toEqual([
      expect.objectContaining({ card: { type: 'plan', text: 'Hook on the alert.' } }),
    ]);
  });
});

describe('the parts', () => {
  it('names pictures by what video-use makes', () => {
    expect(imageLabel('/j/edit/verify/cut_10.5-21.png')).toBe('Frames and sound wave · 10.5–21 s');
    expect(imageLabel('/j/edit/verify/final/tl-1x1.png')).toBe('Frames and sound wave');
    expect(imageLabel('/j/edit/verify/snaps1/contact-sheet-2.jpg')).toBe('Snapshots · snaps1');
    expect(imageLabel('/j/edit/verify/grade_before_after.png')).toBe('Colour, before and after');
    expect(imageLabel('/j/edit/verify/cuts_sheet.png')).toBe('Cut sheet');
    expect(imageLabel('/j/edit/verify/logo_on_light.png')).toBe('Logo on light');
    expect(imageLabel(null)).toBe('Picture');
  });

  it('reads a picture’s size from a PNG or a JPEG header', () => {
    expect(imageSize(Buffer.from(png(1130, 540), 'base64'))).toEqual({ width: 1130, height: 540 });
    const jpeg = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xc0, 0x00, 0x11, 0x08, 0x07, 0x80,
      0x04, 0x38, 0x03,
    ]);
    expect(imageSize(jpeg)).toEqual({ width: 1080, height: 1920 });
    expect(imageSize(Buffer.from('nope'))).toBeNull();
  });

  it('labels commands in plain words', () => {
    expect(
      toolLabel('Bash', { command: 'ls -la\nmore', description: 'List the folder' }, JOB),
    ).toBe('List the folder');
    expect(toolLabel('Bash', { command: 'ls -la\nmore' }, JOB)).toBe('ls -la');
    expect(toolLabel('Read', { file_path: `${JOB}/edit/project.md` }, JOB)).toBe(
      'Read edit/project.md',
    );
    expect(toolLabel('Skill', { skill: 'video-use' }, JOB)).toBe('Opened the video-use skill');
  });

  it('reads loudness from ebur128 or loudnorm, and nothing from other output', () => {
    expect(
      parseLoudness('{"input_i" : "-13.20", "input_tp" : "-1.50", "input_lra" : "4.10"}'),
    ).toEqual({ integratedLufs: -13.2, truePeakDb: -1.5, rangeLu: 4.1 });
    expect(parseLoudness('0:-10 20:-12')).toBeNull();
  });

  it('takes the plan’s strategy, or the top of the file', () => {
    expect(planText('# P\n\n## Strategy\nOne.\nTwo.\n\n## Cut\nx')).toBe('One.\nTwo.');
    expect(planText('# P\nNo sections.')).toBe('# P\nNo sections.');
  });

  it('reads the cut list, and refuses what is not one', () => {
    expect(cutsCard(JSON.parse(EDL))?.cuts).toHaveLength(2);
    expect(cutsCard({ ranges: 'x' })).toBeNull();
    expect(cutsCard({ version: 1 })).toBeNull();
  });

  it('makes no brief card from a brief with nothing in it', () => {
    expect(briefCard({}, null)).toBeNull();
    expect(briefCard('x', null)).toBeNull();
  });
});

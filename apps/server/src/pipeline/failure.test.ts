import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { parseCameraLutWait } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import {
  blockedReason,
  describeFailure,
  describeMissingPreview,
  endsWaitingForCameraLut,
  FINISHED_WITHOUT_PREVIEW,
  isCameraLutWait,
  lastParagraph,
  MAX_ERROR_LENGTH,
  PREVIEW_NOT_REPORTED,
  type RunEnd,
  stripMarkdown,
  trimMessage,
} from './failure.js';
import { emptySummary, parseStreamLine, type StreamSummary, summarize } from './stream-parser.js';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

function summaryOf(name: string): StreamSummary {
  const summary = emptySummary();
  for (const line of readFileSync(`${FIXTURES}${name}`, 'utf8').split('\n')) {
    for (const event of parseStreamLine(line)) summarize(summary, event);
  }
  return summary;
}

function withResult(text: string, isError = false): StreamSummary {
  return { ...emptySummary(), results: 1, lastResult: { subtype: 'success', isError, text } };
}

function end(overrides: Partial<RunEnd>): RunEnd {
  return { exitCode: 1, signal: null, stderr: '', stream: emptySummary(), ...overrides };
}

describe('text helpers', () => {
  it('strips Markdown emphasis, code and links', () => {
    expect(stripMarkdown('**Bold**, `code`, *it*, [link](http://x)')).toBe('Bold, code, it, link');
  });

  it('trims to one line of at most 300 characters, at a word boundary', () => {
    const long = `${'word '.repeat(100)}end`;
    const trimmed = trimMessage(long);
    expect(trimmed.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(trimmed.endsWith('…')).toBe(true);
    expect(trimmed).not.toMatch(/\s…$/);
    expect(trimMessage('a\n\nb   c')).toBe('a b c');
  });

  it('finds the last Blocked: line, also in bold or as a list item', () => {
    expect(blockedReason('Did stuff.\n\nBlocked: ffmpeg is not installed.')).toBe(
      'ffmpeg is not installed.',
    );
    expect(blockedReason('**Blocked:** the disk is full')).toBe('the disk is full');
    expect(blockedReason('- Blocked: a\n- blocked: b')).toBe('b');
    expect(blockedReason('Nothing blocked here')).toBeNull();
  });

  it('takes the last paragraph', () => {
    expect(lastParagraph('one\n\ntwo\nlines\n\n')).toBe('two\nlines');
    expect(lastParagraph('')).toBeNull();
  });
});

describe('describeFailure', () => {
  it('blocked run (E1 fixture): exit 0, no final.mp4 -> its last paragraph', () => {
    const error = describeFailure(end({ exitCode: 0, stream: summaryOf('blocked-run.jsonl') }));
    expect(error).toBe(
      'Finished without a final video: To unblock it, install ffmpeg (brew install ffmpeg) and put an ELEVENLABS_API_KEY in ~/Developer/video-use/.env.',
    );
  });

  it('exit 0 with a Blocked: line -> that line', () => {
    const text =
      'I did the plan.\n\nBlocked: the ElevenLabs key is missing in ~/Developer/video-use/.env.';
    expect(describeFailure(end({ exitCode: 0, stream: withResult(text) }))).toBe(
      'Finished without a final video: the ElevenLabs key is missing in ~/Developer/video-use/.env.',
    );
  });

  it('exit 0 with nothing said -> the bare message', () => {
    expect(describeFailure(end({ exitCode: 0 }))).toBe('Finished without a final video.');
  });

  it('exit 0 without a result falls back to the last thing the agent wrote', () => {
    const stream = { ...emptySummary(), lastText: 'Rendering failed twice.' };
    expect(describeFailure(end({ exitCode: 0, stream }))).toBe(
      'Finished without a final video: Rendering failed twice.',
    );
  });

  it.each([
    ['Not logged in · Please run /login', /^Claude Code is not logged in\. Run `pnpm run doctor`/],
    ['Invalid API key · Please run /login', /^Claude Code is not logged in/],
    ["You've hit your limit · resets 5pm", /^Claude usage limit reached\. .*resets 5pm/],
    [
      'API Error: 529 {"type":"error","error":{"type":"overloaded_error"}}',
      /^Claude's service could not be reached/,
    ],
    ['API Error: Connection error.', /^Claude's service could not be reached/],
  ])('error result %j -> a plain cause', (text, expected) => {
    expect(describeFailure(end({ stream: withResult(text, true) }))).toMatch(expected);
  });

  it('a full disk in stderr -> "The disk is full"', () => {
    const stderr = 'Error: ENOSPC: no space left on device, write\n    at writeSync (node:fs:1)';
    expect(describeFailure(end({ stderr }))).toBe(
      'The disk is full (no space left on device). Free up some space, then retry.',
    );
  });

  it('an unknown error result is shown as the agent wrote it', () => {
    const error = describeFailure(
      end({ stream: withResult('**Execution error**: tool crashed', true) }),
    );
    expect(error).toBe('Claude Code stopped with exit code 1: Execution error: tool crashed');
  });

  it('nothing to go on -> exit code or signal', () => {
    expect(describeFailure(end({}))).toBe('Claude Code stopped with exit code 1.');
    expect(describeFailure(end({ exitCode: null, signal: 'SIGKILL' }))).toBe(
      'Claude Code was stopped by SIGKILL.',
    );
  });

  it('stderr without a known cause: its last lines', () => {
    expect(describeFailure(end({ stderr: 'one\ntwo\nthree\nfour' }))).toBe(
      'Claude Code stopped with exit code 1: two three four',
    );
  });

  it('cannot start: missing or not executable', () => {
    const missing = describeFailure(
      end({ spawnError: { code: 'ENOENT', message: 'spawn ENOENT', bin: '~/bin/claude' } }),
    );
    expect(missing).toBe('Claude Code was not found at ~/bin/claude. Run `pnpm run doctor`.');
    const denied = describeFailure(
      end({ spawnError: { code: 'EACCES', message: 'spawn EACCES', bin: '/x/claude' } }),
    );
    expect(denied).toMatch(/cannot be run \(not executable\)/);
  });

  it('timed out', () => {
    expect(describeFailure(end({ timedOutAfterMs: 90 * 60_000 }))).toMatch(
      /^Timed out after 90 min/,
    );
    expect(describeFailure(end({ timedOutAfterMs: 1_500 }))).toMatch(/^Timed out after 2 s/);
  });

  it('never exceeds 300 characters', () => {
    const huge = `Blocked: ${'x '.repeat(400)}`;
    expect(
      describeFailure(end({ exitCode: 0, stream: withResult(huge) })).length,
    ).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(
      describeFailure(end({ stream: withResult('y'.repeat(1000), true) })).length,
    ).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
  });
});

// LU13: a run that did the work that does not need the camera LUT and ends on the sentence.
describe('endsWaitingForCameraLut', () => {
  const sentence = 'Waiting for a camera LUT: the clips are Sony S-Log3 (A7S_S-Log3_001.mp4).';

  it('reads the sentence when the final message ends with it', () => {
    const text = `All done but the grade.\n\n**Blocked:** ${sentence}\n`;
    expect(endsWaitingForCameraLut(end({ exitCode: 0, stream: withResult(text) }))).toBe(sentence);
  });

  it('is null when the Blocked: line is not the last line, is another reason, or is missing', () => {
    expect(
      endsWaitingForCameraLut(
        end({ exitCode: 0, stream: withResult(`Blocked: ${sentence}\n\nThen I fixed it.`) }),
      ),
    ).toBeNull();
    expect(
      endsWaitingForCameraLut(
        end({ exitCode: 0, stream: withResult('Blocked: ffmpeg is not installed.') }),
      ),
    ).toBeNull();
    expect(endsWaitingForCameraLut(end({ exitCode: 0 }))).toBeNull();
  });
});

// W2: a run that ends in Review and exited 0 without a valid edit/preview/index.html.
describe('describeMissingPreview', () => {
  const problem = 'edit/preview/index.html is missing.';

  it('uses the Blocked: line when there is one', () => {
    const text =
      'I did the plan.\n\nBlocked: the ElevenLabs key is missing in ~/Developer/video-use/.env.';
    expect(describeMissingPreview(end({ exitCode: 0, stream: withResult(text) }), problem)).toBe(
      'Finished without a preview: the ElevenLabs key is missing in ~/Developer/video-use/.env.',
    );
  });

  it('strips Markdown from the Blocked: line', () => {
    const text = '**Blocked:** `ffmpeg` is *not* installed (brew install ffmpeg).';
    expect(describeMissingPreview(end({ exitCode: 0, stream: withResult(text) }), problem)).toBe(
      'Finished without a preview: ffmpeg is not installed (brew install ffmpeg).',
    );
  });

  it('uses the problem, never the last paragraph, when there is no Blocked: line', () => {
    const text = 'Done.\n\nThe composition is in edit/preview/ and it looks good.';
    expect(describeMissingPreview(end({ exitCode: 0, stream: withResult(text) }), problem)).toBe(
      'Finished without a preview: edit/preview/index.html is missing.',
    );
    expect(describeMissingPreview(end({ exitCode: 0 }), problem)).toBe(
      'Finished without a preview: edit/preview/index.html is missing.',
    );
  });

  it('falls back to the last thing the agent wrote when there is no result', () => {
    const stream = { ...emptySummary(), lastText: 'Blocked: no network.' };
    expect(describeMissingPreview(end({ exitCode: 0, stream }), problem)).toBe(
      'Finished without a preview: no network.',
    );
  });

  it('is trimmed to one line of at most 300 characters', () => {
    const text = `Blocked: ${'x '.repeat(400)}`;
    const long = describeMissingPreview(end({ exitCode: 0, stream: withResult(text) }), problem);
    expect(long.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(long.startsWith('Finished without a preview: x x')).toBe(true);
    expect(long.endsWith('…')).toBe(true);
    const longProblem = describeMissingPreview(end({ exitCode: 0 }), `${'y '.repeat(400)}`);
    expect(longProblem.length).toBeLessThanOrEqual(MAX_ERROR_LENGTH);
    expect(longProblem).not.toContain('\n');
  });

  it('keeps the problem of a composition with a bad attribute whole', () => {
    const bad =
      'data-width="1080.5" on the root element of edit/preview/index.html is not a whole number above 0.';
    expect(describeMissingPreview(end({ exitCode: 0 }), bad)).toBe(
      `Finished without a preview: ${bad}`,
    );
  });
});

// LU10: a Blocked: line that says the job waits for a camera LUT is the job's whole error.
describe('a job that waits for a camera LUT', () => {
  const sentence = 'Waiting for a camera LUT: the clips are Sony S-Log3 (C0003.MP4).';

  it('isCameraLutWait: the sentence, in any case, and nothing else', () => {
    expect(isCameraLutWait(sentence)).toBe(true);
    expect(isCameraLutWait('  waiting for a camera lut: the clips are log footage.')).toBe(true);
    expect(isCameraLutWait('ffmpeg is not installed')).toBe(false);
    expect(isCameraLutWait('Still waiting for a camera LUT: x')).toBe(false);
  });

  it('a run that delivers a video: the sentence alone, with no "Finished without" lead', () => {
    const text = `I graded what I could.\n\nBlocked: ${sentence}`;
    expect(describeFailure(end({ exitCode: 0, stream: withResult(text) }))).toBe(sentence);
  });

  it('strips the Markdown the editor puts around it', () => {
    const text = '**Blocked:** Waiting for a camera LUT: the clips are *Sony S-Log3*.';
    expect(describeFailure(end({ exitCode: 0, stream: withResult(text) }))).toBe(
      'Waiting for a camera LUT: the clips are Sony S-Log3.',
    );
  });

  it('a run that ends in Review: the sentence alone, too', () => {
    const text = `Blocked: ${sentence}`;
    expect(
      describeMissingPreview(
        end({ exitCode: 0, stream: withResult(text) }),
        'index.html is missing.',
      ),
    ).toBe(sentence);
  });

  it('the page reads the error back', () => {
    const text = `Blocked: ${sentence}`;
    for (const error of [
      describeFailure(end({ exitCode: 0, stream: withResult(text) })),
      describeMissingPreview(end({ exitCode: 0, stream: withResult(text) }), 'x'),
    ]) {
      expect(parseCameraLutWait(error)).toEqual({
        curve: 'slog3',
        source: 'C0003.MP4',
        several: false,
      });
    }
  });

  it('only a Blocked: line counts: the same words in the middle of a message are an ordinary stop', () => {
    const text = `I was ${sentence} Then I stopped.\n\nThe editor could not finish.`;
    expect(describeFailure(end({ exitCode: 0, stream: withResult(text) }))).toBe(
      'Finished without a final video: The editor could not finish.',
    );
  });

  it('a different Blocked: line keeps its lead', () => {
    expect(
      describeFailure(end({ exitCode: 0, stream: withResult('Blocked: ffmpeg is missing.') })),
    ).toBe('Finished without a final video: ffmpeg is missing.');
  });
});

describe('PREVIEW_NOT_REPORTED', () => {
  it('starts with the same words as the other preview failure', () => {
    expect(FINISHED_WITHOUT_PREVIEW).toBe('Finished without a preview');
    expect(PREVIEW_NOT_REPORTED.startsWith(FINISHED_WITHOUT_PREVIEW)).toBe(true);
    expect(PREVIEW_NOT_REPORTED).toBe(
      'Finished without a preview: the runner did not report the composition.',
    );
  });
});

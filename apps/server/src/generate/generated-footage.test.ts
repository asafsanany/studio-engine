import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { GenerateShots } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  appendGeneratedFootage,
  GENERATED_FOOTAGE_HEADING,
  GeneratedFootageError,
  renderGeneratedFootage,
  windowStamp,
  withoutGeneratedFootage,
} from './generated-footage.js';

// The "Generated footage" section of brief.md (GN4): what the edit run is told about the clips, the
// voice, the effects and the style of a generated job, made from edit/generate/shots.json.

let edit: string;

beforeEach(() => {
  edit = mkdtempSync(join(tmpdir(), 'studio-generated-footage-'));
});

afterEach(() => {
  rmSync(edit, { recursive: true, force: true });
});

const BRIEF = [
  '# Brief: Pinewood · 97 Window Ad',
  '',
  '## Decisions (these override the defaults)',
  '- Canvas: 1080x1920',
  '',
  '## Generated video',
  '- Production: generate. There is no footage; the video is made from the script and the references.',
  '',
  '## Files',
  '- PINEWOOD brief.txt: instructions',
  '',
].join('\n');

/** The shots the Generate run hands over for PINEWOOD (shortened): the skylight clip is used three times. */
const SHOTS: GenerateShots = {
  shots: [
    {
      id: 'A',
      file: 'clips/A/take-1.mp4',
      take: 1,
      windows: [
        { startSec: 0, endSec: 3 },
        { startSec: 8, endSec: 10 },
        { startSec: 12, endSec: 16 },
      ],
      seconds: 10,
      shows: 'The hero skylight: a push-in, then green particles pushed toward the camera',
      model: 'kling-video/v2.5-turbo/standard/image-to-video',
      usd: 0.36,
      belowBar: false,
    },
    {
      id: 'B',
      file: 'clips/B/take-2.mp4',
      take: 2,
      windows: [{ startSec: 3, endSec: 7.5 }],
      seconds: 6,
      shows: 'The homeowner pours water,\nthen the camera tilts up',
      model: 'alibaba/wan-3.0/image-to-video',
      usd: 0.51,
      belowBar: true,
    },
  ],
};

function put(rel: string, content = 'x'): void {
  const path = join(edit, rel);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}

/** The edit folder after a Generate run: brief.md, shots.json and every file the section can name. */
function afterGenerate(shots: GenerateShots = SHOTS): void {
  put('brief.md', BRIEF);
  put('generate/shots.json', JSON.stringify(shots));
  put('generate/shots/A.mp4');
  put('generate/shots/B.mp4');
  put('generate/voice.mp3');
  put('generate/voice-words.json', '{"words":[]}');
  put('generate/sfx/whoosh.mp3');
  put('generate/sfx/alert.mp3');
  put('generate/sfx/.DS_Store');
  put('generate/reference.md', '# the reference');
}

const brief = () => readFileSync(join(edit, 'brief.md'), 'utf8');

describe('windowStamp', () => {
  it('is minutes and seconds, with one decimal only when there is a fraction', () => {
    expect(windowStamp(0)).toBe('0:00');
    expect(windowStamp(3)).toBe('0:03');
    expect(windowStamp(7.5)).toBe('0:07.5');
    expect(windowStamp(7.46)).toBe('0:07.5');
    expect(windowStamp(59.96)).toBe('1:00');
    expect(windowStamp(65)).toBe('1:05');
    expect(windowStamp(-3)).toBe('0:00');
  });
});

describe('appendGeneratedFootage', () => {
  it('appends the section to the end of brief.md and leaves the rest as it was', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);

    const text = brief();
    expect(text.startsWith(BRIEF.trimEnd())).toBe(true);
    expect(text.slice(BRIEF.trimEnd().length)).toMatch(/^\n\n## Generated footage\n/);
    expect(text.endsWith('\n')).toBe(true);
    expect(text.split(GENERATED_FOOTAGE_HEADING)).toHaveLength(2);
  });

  it('lists each clip file in cut order with its windows, what it shows and whether it is below the bar', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);

    const text = brief();
    expect(text).toContain(
      '  - `edit/generate/shots/A.mp4` · 10 s · over 0:00–0:03, 0:08–0:10 and 0:12–0:16 of the voice · shows: The hero skylight: a push-in, then green particles pushed toward the camera\n',
    );
    // Flattened to one line, and told it is below the bar.
    expect(text).toContain(
      '  - `edit/generate/shots/B.mp4` · 6 s · over 0:03–0:07.5 of the voice · shows: The homeowner pours water, then the camera tilts up · BELOW THE BAR: this take failed its check and no better one could be paid for. Cut around it or hide it behind graphics, and say so in Assumptions.',
    );
    expect(text.indexOf('shots/A.mp4')).toBeLessThan(text.indexOf('shots/B.mp4'));
    // Only the clip that is below the bar says so.
    expect(text.split('BELOW THE BAR')).toHaveLength(2);
  });

  it('names the voice as the speech, the effects, and the reference as the style to match', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);

    const text = brief();
    expect(text).toContain(
      '- Speech: `edit/generate/voice.mp3` is the narrator. Its word times are in `edit/generate/voice-words.json`: every spoken word with its line (L1, L2, …) and its time in the voice. Do not transcribe it again; cut to it.',
    );
    // Sorted, and the dot file is left out.
    expect(text).toContain(
      '- Sound effects: `edit/generate/sfx/alert.mp3`, `edit/generate/sfx/whoosh.mp3`. Place them where the brief asks for them.',
    );
    expect(text).toContain(
      '- Style to match: `edit/generate/reference.md` has the reference video’s shot order, timing, captions and offer graphics. Match that style; don’t copy the reference.',
    );
    expect(text).toContain(
      'The voice is the timing master: cut the clips to it, never the other way round',
    );
  });

  it('is idempotent: a second call gives the same brief.md, and a changed shots.json replaces the section', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);
    const first = brief();
    await appendGeneratedFootage(edit);
    expect(brief()).toBe(first);

    const fewer: GenerateShots = {
      shots: [{ ...(SHOTS.shots[0] as object), belowBar: true } as never],
    };
    put('generate/shots.json', JSON.stringify(fewer));
    await appendGeneratedFootage(edit);
    const second = brief();
    expect(second).not.toBe(first);
    expect(second.split(GENERATED_FOOTAGE_HEADING)).toHaveLength(2);
    expect(second).not.toContain('shots/B.mp4');
    expect(second).toContain('BELOW THE BAR');
    // The rest of the brief is untouched by either call.
    expect(second.startsWith(BRIEF.trimEnd())).toBe(true);
  });

  it('replaces a section that sits in the middle and keeps what follows it', async () => {
    afterGenerate();
    put(
      'brief.md',
      `${BRIEF}\n${GENERATED_FOOTAGE_HEADING}\nold text\n- old list\n\n## Client style\nWarm.\n`,
    );
    await appendGeneratedFootage(edit);

    const text = brief();
    expect(text).not.toContain('old text');
    expect(text).toContain('## Client style\nWarm.');
    expect(text.split(GENERATED_FOOTAGE_HEADING)).toHaveLength(2);
    expect(text.endsWith('\n')).toBe(true);
  });

  it('tells a clip or a voice that is not there, and names only the extras that exist', async () => {
    put('brief.md', BRIEF);
    put('generate/shots.json', JSON.stringify(SHOTS));
    put('generate/shots/A.mp4');
    await appendGeneratedFootage(edit);

    const text = brief();
    expect(text).toContain('shots/B.mp4`');
    expect(text).toMatch(
      /shots\/B\.mp4.*THE FILE IS MISSING: do not cut it; say so in Assumptions\./,
    );
    expect(text).not.toMatch(/shots\/A\.mp4.*THE FILE IS MISSING/);
    expect(text).not.toContain('- Speech:');
    expect(text).not.toContain('- Sound effects:');
    expect(text).not.toContain('- Style to match:');
  });

  it('tells the run not to transcribe a voice whose word times it has, and to transcribe one it has not', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);
    expect(brief()).toContain('Do not transcribe it again; cut to it.');
    expect(brief()).not.toContain('Transcribe it like');

    // A voice with no word times (voice-words.json missing) is the old behaviour: transcribe it.
    rmSync(join(edit, 'generate', 'voice-words.json'));
    await appendGeneratedFootage(edit);
    expect(brief()).toContain(
      '- Speech: `edit/generate/voice.mp3` is the narrator. Transcribe it like the speech in footage, and cut to it.',
    );
    expect(brief()).not.toContain('Do not transcribe it again');
  });

  it('writes brief.md in one move: no temporary file is left', async () => {
    afterGenerate();
    await appendGeneratedFootage(edit);
    expect(readdirSync(edit).sort()).toEqual(['brief.md', 'generate']);
  });
});

describe('appendGeneratedFootage: what it refuses', () => {
  it('says so when shots.json or brief.md is missing, and writes nothing', async () => {
    put('brief.md', BRIEF);
    await expect(appendGeneratedFootage(edit)).rejects.toThrow(
      new GeneratedFootageError('edit/generate/shots.json is missing.'),
    );
    expect(brief()).toBe(BRIEF);

    rmSync(join(edit, 'brief.md'));
    put('generate/shots.json', JSON.stringify(SHOTS));
    await expect(appendGeneratedFootage(edit)).rejects.toThrow('edit/brief.md is missing.');
  });

  it('says so when shots.json is not JSON or not the hand-off’s shape', async () => {
    put('brief.md', BRIEF);
    put('generate/shots.json', '{ nope');
    await expect(appendGeneratedFootage(edit)).rejects.toThrow(
      'edit/generate/shots.json is not valid JSON.',
    );

    put('generate/shots.json', JSON.stringify({ shots: [{ id: 'A' }] }));
    await expect(appendGeneratedFootage(edit)).rejects.toThrow(
      /edit\/generate\/shots\.json doesn’t match its shape \(shots\.0\.file\)/,
    );
    expect(brief()).toBe(BRIEF);
  });

  it('is a GeneratedFootageError, so the Generate stage can tell it from a bug', async () => {
    put('brief.md', BRIEF);
    await expect(appendGeneratedFootage(edit)).rejects.toBeInstanceOf(GeneratedFootageError);
  });
});

describe('renderGeneratedFootage and withoutGeneratedFootage', () => {
  it('says none were made for an empty hand-off, and names nothing else when nothing exists', () => {
    const text = renderGeneratedFootage(
      { shots: [] },
      { clips: new Set(), voice: false, voiceWords: false, reference: false, sfx: [] },
    );
    expect(text).toContain('  - (none were made)');
    expect(text).not.toContain('- Speech:');
  });

  it('only a section of that name goes, wherever it is', () => {
    expect(withoutGeneratedFootage('# Brief\n\n## Files\n- a\n')).toBe(
      '# Brief\n\n## Files\n- a\n',
    );
    expect(withoutGeneratedFootage(`${GENERATED_FOOTAGE_HEADING}\nx\n`)).toBe('');
    expect(withoutGeneratedFootage(`# B\n\n${GENERATED_FOOTAGE_HEADING}\nx\n\n## Z\nz\n`)).toBe(
      '# B\n\n## Z\nz\n',
    );
    // A heading that only starts with the same words is not it.
    expect(withoutGeneratedFootage('# B\n\n## Generated footage notes\nx\n')).toBe(
      '# B\n\n## Generated footage notes\nx\n',
    );
  });
});

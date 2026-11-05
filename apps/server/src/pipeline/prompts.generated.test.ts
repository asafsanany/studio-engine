import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { jobFormatsOf } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { parseArgs as parseVoiceArgs } from '../../assets/generate/make-voice.mjs';
import {
  buildPrompt,
  COLOR_GRADE_SCRIPT,
  type GeneratedPromptVars,
  generatedValues,
  PROMPTS_DIR,
  type PromptVars,
  renderTemplate,
} from './prompts.js';
import { RUN_MODES } from './runner.js';

// Generated videos (GN6): a job whose brief says `production: generate` gets generated.md in its edit
// prompts (start, resume and retry) and generate-revise.md in its revise prompt, with the money. A
// footage job, and a render run of any job, gets exactly the prompt it always did.

const BASE: PromptVars = { client: 'Pinewood', job: '97 Window Ad', step: 5, error: 'it broke' };

const GENERATED: GeneratedPromptVars = {
  voiceScript: '/repo/apps/server/assets/generate/make-voice.mjs',
  shotsScript: '/repo/apps/server/assets/generate/make-shots.mjs',
  editDir: '/inbox/Pinewood/97 Window Ad/edit',
  budgetUsd: 3,
  spentUsd: 2.33,
};

const EDIT_MARKER = 'Generated footage: this video has no footage. Its clips, its voice';
const REVISE_MARKER = 'Generated footage: this video has no footage. Its clips and its voice';

const GOLDEN_DIR = fileURLToPath(new URL('./testdata/prompts/', import.meta.url));
/** The names and numbers behind the golden prompts (Hebrew, a step, an error with braces). */
const GOLDEN_VARS: PromptVars = {
  client: 'מאפיית הצפון',
  job: 'פרומו לסוף השבוע',
  step: 5,
  error: 'Claude Code stopped with exit code 1:\nrender.py failed {{x}}',
};

/** The golden file with the colour-grade line the way a run of today reads it (see prompts.test.ts). */
function withColorGrade(golden: string, kind: 'edit' | 'revise', round = 0): string {
  const name = kind === 'edit' ? 'color-grade' : `color-grade-${kind}`;
  const grade = renderTemplate(readFileSync(`${PROMPTS_DIR}${name}.md`, 'utf8'), {
    colorGradeScript: `'${COLOR_GRADE_SCRIPT.replaceAll("'", "'\\''")}'`,
    round: String(round),
    lutsGradeNote: '',
  })
    .replace(/[ \t]+$/gm, '')
    .trimEnd();
  expect(golden).toMatch(/^- iPhone clips:.*$/m);
  return golden.replace(/^- iPhone clips:.*$/m, () => grade);
}

describe('a footage job (no generated key, or null)', () => {
  it.each(RUN_MODES)('%s: is the golden edit prompt, byte for byte', async (mode) => {
    const golden = withColorGrade(readFileSync(`${GOLDEN_DIR}edit-${mode}.txt`, 'utf8'), 'edit');
    expect(await buildPrompt(mode, GOLDEN_VARS)).toBe(golden);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, generated: null })).toBe(golden);
    expect(await buildPrompt(mode, { ...GOLDEN_VARS, generated: undefined })).toBe(golden);
  });

  it('the revise prompt is the golden one, byte for byte', async () => {
    const over: PromptVars = {
      ...GOLDEN_VARS,
      kind: 'revise',
      round: 1,
      review: true,
      checks: 'slim',
    };
    const golden = withColorGrade(
      readFileSync(`${GOLDEN_DIR}revise-slim.txt`, 'utf8'),
      'revise',
      1,
    );
    expect(await buildPrompt('start', over)).toBe(golden);
    expect(await buildPrompt('start', { ...over, generated: null })).toBe(golden);
  });

  it.each(RUN_MODES)('%s: the Review-on edit prompt has nothing of it', async (mode) => {
    const prompt = await buildPrompt(mode, { ...BASE, review: true, generated: null });
    expect(prompt).toBe(await buildPrompt(mode, { ...BASE, review: true }));
    expect(prompt).not.toContain('Generated footage');
    expect(prompt).not.toContain('voice-words.json');
  });

  it('the revise prompt (full check, music on) has nothing of it either', async () => {
    const vars: PromptVars = {
      ...BASE,
      kind: 'revise',
      round: 3,
      review: true,
      music: true,
      musicScript: '/m/make-music.mjs',
    };
    const prompt = await buildPrompt('start', vars);
    expect(await buildPrompt('start', { ...vars, generated: null })).toBe(prompt);
    expect(prompt).not.toContain('Generated footage');
    expect(prompt).not.toContain('over_budget');
  });
});

describe('a render run of a generated job', () => {
  it('is told nothing: it renders what was approved', async () => {
    const vars: PromptVars = { ...BASE, kind: 'render' };
    const plain = await buildPrompt('start', vars);
    expect(await buildPrompt('start', { ...vars, generated: GENERATED })).toBe(plain);
    expect(plain).not.toContain('Generated footage');
  });
});

describe('the edit run of a generated job', () => {
  it.each(RUN_MODES)('%s: gets the generated part once, and not the revise one', async (mode) => {
    for (const review of [true, false]) {
      const prompt = await buildPrompt(mode, { ...BASE, review, generated: GENERATED });
      expect(prompt.split(EDIT_MARKER)).toHaveLength(2);
      expect(prompt).not.toContain(REVISE_MARKER);
      expect(prompt).not.toContain('over_budget');
      // It is a paragraph of its own between the footage rules and what follows them.
      expect(prompt).toMatch(
        /and the series wins over the style\.\n\nGenerated footage: this video has no footage\./,
      );
    }
  });

  it('keeps the golden prompt everywhere else: take the part out and it is the footage prompt', async () => {
    for (const mode of RUN_MODES) {
      const plain = await buildPrompt(mode, { ...BASE, review: true });
      const generated = await buildPrompt(mode, { ...BASE, review: true, generated: GENERATED });
      const part = readFileSync(`${PROMPTS_DIR}generated.md`, 'utf8').trimEnd();
      expect(generated.replace(`${part}\n\n`, '')).toBe(plain);
    }
  });

  it('sits before the music paragraph and the unattended notes, with the music on', async () => {
    const prompt = await buildPrompt('start', {
      ...BASE,
      review: true,
      generated: GENERATED,
      music: true,
      musicScript: '/m/make-music.mjs',
    });
    const at = (text: string) => prompt.indexOf(text);
    expect(at('If edit/brief.md exists')).toBeGreaterThan(-1);
    expect(at('If edit/brief.md exists')).toBeLessThan(at(EDIT_MARKER));
    expect(at(EDIT_MARKER)).toBeLessThan(at('\nMusic: on this machine'));
    expect(at('\nMusic: on this machine')).toBeLessThan(at('This run is unattended'));
    expect(prompt).toMatch(/\n\nMusic: on this machine/);
  });

  it('says what the Generate step left and how to cut it', async () => {
    const prompt = await buildPrompt('start', { ...BASE, review: true, generated: GENERATED });
    // The clips are the footage, in the order of shots.json, each cut in once for each window.
    expect(prompt).toContain('The footage is the clips of edit/generate/shots.json, in its order');
    expect(prompt).toContain('A clip with several windows is cut in once for each');
    // The voice is the speech: its word times are given, so it is never transcribed again or stretched.
    expect(prompt).toContain('its word times are in edit/generate/voice-words.json');
    expect(prompt).toContain('Do not transcribe it again and do not run the transcribe helper');
    expect(prompt).toContain('edit/transcripts/voice.json from voice-words.json');
    expect(prompt).toContain('never stretch, speed up, trim, re-time or re-encode it');
    expect(prompt).toContain('Time 0 of voice.mp3 is time 0 of the cut');
    // It may open with silence (leadMs): the opening shot and the alert go there, and nothing is added before the voice.
    expect(prompt).toContain(
      'voice.mp3 may open with silence: leadMs in edit/generate/voice-words.json (missing means 0) is how long, and the word times already include it',
    );
    expect(prompt).toContain('is where the opening clips and the alert sound effect go');
    expect(prompt).toContain('and nothing more is added before the voice');
    expect(prompt).not.toContain('no lead-in');
    expect(prompt).toContain('Cut every clip to the voice');
    // Captions: the script's words, the reference's look, in the client's colours.
    expect(prompt).toContain("Captions are the script's words exactly");
    expect(prompt).toContain('edit/generate/reference.md');
    expect(prompt).toContain("in the client's brand colours");
    expect(prompt).toContain("a scene's text is gone before the next scene's comes in");
    // Graphics are the edit's: the alert, the cards, the logo and the end card held 3 seconds.
    expect(prompt).toContain('Graphics are HyperFrames, never part of a clip');
    expect(prompt).toContain('an alert pulse on the alert hits');
    expect(prompt).toContain('no box behind it and no line through its words');
    expect(prompt).toContain('held for at least 3 seconds');
    expect(prompt).toContain("Whatever the brief's must-avoid list names (a phone number");
    // Sound: the voice above the music, the effects at their cues.
    expect(prompt).toContain('the voice sits above the music');
    expect(prompt).toContain('Duck the music 12 to 15 dB under the voice');
    expect(prompt).toContain('The sound effects in edit/generate/sfx/ go at the cues');
    // The odd shots.
    expect(prompt).toContain('A shot marked belowBar in shots.json');
    expect(prompt).toContain('list it in project.md under Assumptions');
    expect(prompt).toContain('slow push-in on its last frame');
    // The edit run spends nothing and never runs the scripts.
    expect(prompt).toContain('never run its scripts');
    expect(prompt).not.toContain('make-shots.mjs');
    expect(prompt).not.toContain('make-voice.mjs');
  });
});

describe('the revise run of a generated job', () => {
  const revise = (generated: GeneratedPromptVars | null, over: Partial<PromptVars> = {}) =>
    buildPrompt('start', { ...BASE, kind: 'revise', round: 2, review: true, generated, ...over });

  it('gets the revise part once, in the list of the notes, and not the edit one', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt.split(REVISE_MARKER)).toHaveLength(2);
    expect(prompt).not.toContain(EDIT_MARKER);
    // After "Do what each note asks", before the unclear-note line and the Round section.
    expect(prompt.indexOf('- Do what each note asks and nothing else.')).toBeLessThan(
      prompt.indexOf(REVISE_MARKER),
    );
    expect(prompt.indexOf(REVISE_MARKER)).toBeLessThan(
      prompt.indexOf('- A note that is unclear: take the most likely reading.'),
    );
    expect(prompt.indexOf(REVISE_MARKER)).toBeLessThan(
      prompt.indexOf('- Add a section "## Round 2" at the end of project.md'),
    );
  });

  it('is the footage prompt with the part in it, nothing else changed', async () => {
    const plain = await revise(null);
    const generated = await revise(GENERATED);
    const part = renderTemplate(
      readFileSync(`${PROMPTS_DIR}generate-revise.md`, 'utf8'),
      { round: '2', ...generatedValues(GENERATED) },
      {},
    ).trimEnd();
    expect(generated.replace(`${part}\n`, '')).toBe(plain);
    expect(part.length).toBeGreaterThan(1000);
  });

  it('sorts the notes into an edit change, what is in a clip and the voice', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain('(a) An edit change');
    expect(prompt).toContain('(b) What is in a clip');
    expect(prompt).toContain('make ONE new take of that scene (a clip)');
    expect(prompt).toContain(
      'with its prompt from edit/generate/plan.json changed for what is wrong',
    );
    expect(prompt).toContain('Two notes about one clip are one take');
    expect(prompt).toContain('(c) The voice');
    expect(prompt).toContain('make a new take of that line only');
    expect(prompt).toContain('Never touch another clip.');
    expect(prompt).toContain('Never make, change or delete any clip or voice line');
  });

  it('gives the budget, what is spent and what is left, and says what to do when it is not enough', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain(
      'The Higgsfield budget for this whole video is $3, every round included',
    );
    expect(prompt).toContain('$2.33 is spent and $0.67 is left');
    expect(prompt).toContain('make as many as $0.67 pays for');
    expect(prompt).toContain('put the worst failure first');
    expect(prompt).toContain('the code over_budget and books nothing');
    expect(prompt).toContain('the end of new takes for this round, not an error');
    expect(prompt).toContain('say so in its line of the round ("not made: the budget is spent")');
    expect(prompt).toContain('which voice lines were made again');
    expect(prompt).toContain('what is left of $3');
    // --budget is the whole video's budget as a number, on every spending call.
    expect(prompt.match(/--budget 3\b/g)).toHaveLength(1);
  });

  it('books the exact credits and declines a preset the connector suggests', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain('credits_exact is the price to book');
    expect(prompt).toContain('declined_preset_id set to the preset id in the notice');
  });

  it('follows the job’s own numbers: another budget, another spend, nothing left', async () => {
    const five = await revise({ ...GENERATED, budgetUsd: 5, spentUsd: 1.2 });
    expect(five).toContain('budget for this whole video is $5, every round included');
    expect(five).toContain('$1.20 is spent and $3.80 is left');
    expect(five).toContain('--budget 5');

    const half = await revise({ ...GENERATED, budgetUsd: 4.5, spentUsd: 0 });
    expect(half).toContain('is $4.50, every round included');
    expect(half).toContain('$0 is spent and $4.50 is left');
    expect(half).toContain('--budget 4.5');

    const over = await revise({ ...GENERATED, spentUsd: 3.2 });
    expect(over).toContain('$3.20 is spent and $0 is left');
  });

  it('names the two scripts and the edit folder, quoted, so a folder with spaces works', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain(
      'node "/repo/apps/server/assets/generate/make-shots.mjs" book "/inbox/Pinewood/97 Window Ad/edit" <id>',
    );
    expect(prompt).toContain(
      'node "/repo/apps/server/assets/generate/make-voice.mjs" assemble "/inbox/Pinewood/97 Window Ad/edit" --order',
    );
    expect(prompt).toContain('ls "/inbox/Pinewood/97 Window Ad/edit/generate/clips/<id>"');
  });

  it('swaps the kept take into shots.json and the cut reads, re-cuts that clip only', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain("change only that shot's file, take, usd, seconds and belowBar");
    expect(prompt).toContain('copy the kept file over edit/generate/shots/<id>.mp4');
    expect(prompt).toContain('re-cut that clip only');
    expect(prompt).toContain('mark that shot belowBar');
  });

  it('remakes a voice line with the same takes and pauses for the others, then shifts the cut', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain(
      "find the line spoken at the note's time in edit/generate/voice-words.json",
    );
    expect(prompt).toContain('its `match` must be true');
    expect(prompt).toContain('assemble');
    expect(prompt).toContain(
      "the pause they had (the next line's startMs minus the previous line's endMs)",
    );
    // The opening before the first word is kept: the same lead goes back into assemble, and is not a pause.
    expect(prompt).toContain(
      '--pauses "L1>L2:<ms>,…" --lead <leadMs>` with the take every line has now',
    );
    expect(prompt).toContain('The `--lead` is the `leadMs` that voice-words.json records');
    expect(prompt).toContain('(leave `--lead` out when it has none)');
    expect(prompt).toContain(
      "The first line's startMs is that opening, not a pause: never count it as one.",
    );
    expect(prompt).toContain('every word after that line moves by the difference');
    expect(prompt).toContain('Shift the cut by it, never stretching the voice');
    expect(prompt).toContain('the windows in shots.json are updated to the new times');
    expect(prompt).toContain('does not count against it');
  });

  it('keeps the keys out of it', async () => {
    const prompt = await revise(GENERATED);
    expect(prompt).toContain('never open a .env file and never print or pass a key');
    expect(prompt).not.toMatch(/HIGGSFIELD_API_KEY|ELEVENLABS_API_KEY|Authorization/);
  });

  it('with the music on, keeps its lines and adds the generated ones right after them', async () => {
    const prompt = await revise(GENERATED, { music: true, musicScript: '/m/make-music.mjs' });
    expect(prompt.indexOf('- Music: keep the pick')).toBeGreaterThan(-1);
    expect(prompt.indexOf('- Music: keep the pick')).toBeLessThan(prompt.indexOf(REVISE_MARKER));
    expect(prompt.indexOf('- At most two makes in this round')).toBeLessThan(
      prompt.indexOf(REVISE_MARKER),
    );
  });

  it('still carries the formats part of a job with two formats, once', async () => {
    const prompt = await revise(GENERATED, { formats: jobFormatsOf(['1080x1920', '1080x1080']) });
    expect(prompt.split('Formats: the brief asks for')).toHaveLength(2);
    expect(prompt.split(REVISE_MARKER)).toHaveLength(2);
  });
});

describe('generatedValues', () => {
  it('is all empty without a generated job', () => {
    for (const value of [undefined, null]) {
      const values = generatedValues(value);
      expect(Object.keys(values)).toHaveLength(7);
      expect(Object.values(values).every((text) => text === '')).toBe(true);
    }
  });

  it('writes the money as the prompt says it', () => {
    expect(generatedValues(GENERATED)).toEqual({
      generateVoiceScript: '/repo/apps/server/assets/generate/make-voice.mjs',
      generateShotsScript: '/repo/apps/server/assets/generate/make-shots.mjs',
      generateEditDir: '/inbox/Pinewood/97 Window Ad/edit',
      generateBudget: '$3',
      generateSpent: '$2.33',
      generateLeft: '$0.67',
      generateBudgetNumber: '3',
    });
  });
});

// The calls the revise part tells the run to make must be ones the scripts take: the voice script's
// own parser accepts every voice call, and every shots call uses only flags that script reads.
describe('every script call in the revise part', () => {
  const SHOTS_FLAGS: Record<string, readonly string[]> = {
    book: ['kind', 'model', 'credits', 'budget', 'take', 'seconds', 'job'],
    save: ['kind', 'take', 'url', 'job'],
    void: ['kind', 'take', 'reason'],
  };
  const REQUIRED: Record<string, readonly string[]> = {
    book: ['kind', 'model', 'credits', 'budget', 'take', 'seconds'],
    save: ['kind', 'take', 'url', 'job'],
    void: ['kind', 'take', 'reason'],
  };

  /** The words of a command line, quotes taken off ('\'' inside single quotes is an apostrophe). */
  function words(line: string): string[] {
    const out: string[] = [];
    let current = '';
    let started = false;
    let quote: '"' | "'" | null = null;
    for (let i = 0; i < line.length; i++) {
      const char = line[i] as string;
      if (quote !== null) {
        if (char === quote) quote = null;
        else current += char;
      } else if (char === '"' || char === "'") {
        quote = char;
        started = true;
      } else if (char === '\\' && line[i + 1] === "'") {
        current += "'";
        i++;
      } else if (/\s/.test(char)) {
        if (started || current !== '') out.push(current);
        current = '';
        started = false;
      } else {
        current += char;
      }
    }
    if (started || current !== '') out.push(current);
    return out;
  }

  async function calls() {
    const prompt = await buildPrompt('start', {
      ...BASE,
      kind: 'revise',
      round: 1,
      review: true,
      generated: GENERATED,
    });
    return [...prompt.matchAll(/`(node "([^"]+)" (\w+) ([^`]*))`/g)].map((match) => {
      const script = match[2] as string;
      const command = match[3] as string;
      // Placeholders in <angle brackets> become a value; optional [parts] and the ellipsis go.
      const text = (match[1] as string)
        .replace(/\[[^\]]*\]/g, '')
        .replace(/<[^>]*>/g, 'X')
        .replace(/…/g, '');
      return { script, command, argv: words(text).slice(3) };
    });
  }

  it('are there: the booking, the save, the void, and the three voice calls', async () => {
    const found = await calls();
    expect(found.map((call) => `${call.script.split('/').pop()} ${call.command}`)).toEqual([
      'make-shots.mjs book',
      'make-shots.mjs save',
      'make-shots.mjs void',
      'make-voice.mjs line',
      'make-voice.mjs check',
      'make-voice.mjs assemble',
    ]);
  });

  it('the voice script’s own parser accepts every voice call', async () => {
    const voice = (await calls()).filter((call) => call.script.endsWith('make-voice.mjs'));
    expect(voice).toHaveLength(3);
    for (const call of voice) {
      const parsed = parseVoiceArgs([call.command, ...call.argv]);
      expect(parsed.command).toBe(call.command);
      expect(parsed.editDir).toBe(GENERATED.editDir);
    }
  });

  it('the re-assemble passes --lead, an option the voice script has', async () => {
    const assemble = (await calls()).find((call) => call.command === 'assemble');
    const parsed = parseVoiceArgs(['assemble', ...(assemble?.argv ?? [])]);
    expect(parsed.options.has('lead')).toBe(true);
    expect(parsed.options.has('order')).toBe(true);
    expect(parsed.options.has('pauses')).toBe(true);
  });

  it('every shots call names the edit folder, uses only flags the script reads and has the ones it needs', async () => {
    const shots = (await calls()).filter((call) => call.script.endsWith('make-shots.mjs'));
    expect(shots).toHaveLength(3);
    for (const call of shots) {
      expect(call.argv[0]).toBe(GENERATED.editDir);
      const flags = call.argv.filter((word) => word.startsWith('--')).map((word) => word.slice(2));
      for (const flag of flags) expect(SHOTS_FLAGS[call.command]).toContain(flag);
      for (const flag of REQUIRED[call.command] ?? []) expect(flags).toContain(flag);
    }
  });
});

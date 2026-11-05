import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { generatePlanSchema, generateShotsSchema } from '@studio/shared';
import { afterEach, describe, expect, it } from 'vitest';
import {
  parseLead,
  parseOrder,
  parsePauses,
  parseArgs as parseVoiceArgs,
} from '../../assets/generate/make-voice.mjs';
import { generateAllowedTools } from './claude-command.js';
import { budgetNumber, buildGeneratePrompt, formatsText } from './generate-prompt.js';
import { generateFailure } from './generate-step.js';
import { PROMPTS_DIR } from './prompts.js';

// The Generate run's prompt (Generated videos: GN5 gave the engine's hooks, GN12 wrote the prompt).
// A Sonnet run follows this text unattended for an hour, with money on every call, so the tests pin
// what it must say: the order of the steps, the exact command lines of the two scripts (checked
// against the scripts' own flags and the run's Bash allow-list), the shapes of the two files the
// engine reads (the contract's schemas parse the examples), the ladder, and how it stops.

const temps: string[] = [];
afterEach(() => {
  for (const dir of temps.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const VARS = {
  client: 'Acme Bakery',
  job: 'Sourdough Ad',
  voiceScript: '/repo/apps/server/assets/generate/make-voice.mjs',
  shotsScript: '/repo/apps/server/assets/generate/make-shots.mjs',
  editDir: '/inbox/Acme Bakery/Sourdough Ad/edit',
  budgetUsd: 3,
  spentUsd: 0,
  formats: ['1080x1920', '1080x1080'],
};

const SHOTS_SOURCE = readFileSync(
  new URL('../../assets/generate/make-shots.mjs', import.meta.url),
  'utf8',
);

// --- reading the prompt like the run's Bash would ------------------------------------------------

/** The words of a command line as the shell reads them: quotes group and are dropped. */
function shellWords(line: string): string[] {
  const words: string[] = [];
  let current = '';
  let quote: '"' | "'" | null = null;
  let started = false;
  for (const ch of line) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
      started = true;
    } else if (/\s/.test(ch)) {
      if (started) words.push(current);
      current = '';
      started = false;
    } else {
      current += ch;
      started = true;
    }
  }
  if (started) words.push(current);
  return words;
}

/** What is left of a command line once everything in quotes is taken out: where a shell would see operators. */
function outsideQuotes(line: string): string {
  return line.replace(/"[^"]*"|'[^']*'/g, '');
}

const COMMAND_LINE =
  /^ {4,}(node "|ffmpeg |ffprobe |ls |mkdir -p |~\/Developer\/video-use\/\.venv\/bin\/python )/;

/** Every line of the prompt that is a command to run: indented four spaces or more, starting with a tool. */
function commandLines(prompt: string): string[] {
  return prompt
    .split('\n')
    .filter((line) => COMMAND_LINE.test(line))
    .map((line) => line.trim());
}

/** Whether a Bash allow rule (`Bash(node "x" *)`, `Bash(ls)`) lets a command through, as Claude Code reads it. */
function allowed(command: string, rules: readonly string[]): boolean {
  return rules.some((rule) => {
    const match = /^Bash\((.*)\)$/.exec(rule);
    if (match === null) return false;
    const pattern = match[1] as string;
    if (pattern.endsWith('*')) return command.startsWith(pattern.slice(0, -1));
    return command === pattern;
  });
}

/** The flags a function of `make-shots.mjs` reads, taken from its own source so a change there is noticed. */
function flagsReadBy(name: string): string[] {
  const start = SHOTS_SOURCE.indexOf(`function ${name}(`);
  expect(start, `${name} in make-shots.mjs`).toBeGreaterThan(-1);
  const rest = SHOTS_SOURCE.slice(start + 1);
  const end = rest.search(/\n(?:async )?function /);
  const body = rest.slice(0, end === -1 ? undefined : end);
  return [...body.matchAll(/(?:flag|all)\('([a-z-]+)'\)/g)].map((m) => m[1] as string);
}

/** The flags a `make-shots.mjs` command reads: its own, and for book, save and void the kind, id and take of `targetOf`. */
function shotsFlags(command: 'book' | 'save' | 'void' | 'put'): Set<string> {
  const own = flagsReadBy(`cmd${command[0]?.toUpperCase()}${command.slice(1)}`);
  return new Set(command === 'put' ? own : [...own, ...flagsReadBy('targetOf')]);
}

/** The words of a script call after `node "<script>"`: [command, edit dir, …]. */
function scriptCall(line: string, script: string): string[] | null {
  const words = shellWords(line);
  return words[0] === 'node' && words[1] === script ? words.slice(2) : null;
}

const flagsOf = (words: readonly string[]): string[] =>
  words.filter((word) => word.startsWith('--')).map((word) => word.slice(2));

describe('the Generate prompt as the engine fills it', () => {
  it('names the job, the money, the formats and both scripts with their paths', async () => {
    const prompt = await buildGeneratePrompt(VARS);

    expect(prompt).toMatch(/^Make the footage for this video\./);
    expect(prompt).toContain('Job: client "Acme Bakery", job "Sourdough Ad".');
    expect(prompt).toContain('The budget for this whole video is $3, about 53 credits');
    expect(prompt).toContain('(a credit is worth $0.056)');
    expect(prompt).toContain('$0 is spent, $3 (about 53 credits) is left');
    expect(prompt).toContain('--budget 3');
    expect(prompt).toContain('Formats: 9:16 and 1:1.');
    for (const command of ['line', 'check', 'assemble', 'sfx']) {
      expect(prompt, command).toContain(`node "${VARS.voiceScript}" ${command} "${VARS.editDir}"`);
    }
    for (const command of ['book', 'save', 'void', 'put']) {
      expect(prompt, command).toContain(`node "${VARS.shotsScript}" ${command} "${VARS.editDir}"`);
    }
    // Nothing is left to fill in; no empty slot; a first try has no part about earlier work.
    expect(prompt).not.toMatch(/\{\{|\}\}/);
    expect(prompt).not.toContain('An earlier try');
    expect(prompt).not.toMatch(/ +$/m);
    expect(prompt).not.toContain('\n\n\n');
    expect(prompt.endsWith('\n')).toBe(true);
  });

  it('says what an earlier try made, in place of its own line', async () => {
    const prompt = await buildGeneratePrompt({
      ...VARS,
      spentUsd: 1.65,
      existing: 'An earlier try of this stage already made part of it.\n- Looks made: baker.',
    });
    expect(prompt).toContain('- Looks made: baker.');
    expect(prompt).toContain('$1.65 is spent, $1.35 (about 24 credits) is left');
    // The sentence sits right under the job line, and no blank slot is left.
    expect(prompt).not.toContain('\n\n\n');
  });

  it('never reads a template out of a name or a text it is given', async () => {
    const prompt = await buildGeneratePrompt({
      ...VARS,
      client: 'Acme {{> unknown}}',
      job: 'A {{budget}} job',
      existing: 'Look: {{editDir}}',
    });
    expect(prompt).toContain('Job: client "Acme > unknown", job "A budget job".');
    expect(prompt).toContain('Look: {{editDir}}');
  });

  it('is written for any brief: nothing of a client or a first job is in the template', async () => {
    const files = ['generate.md', 'generate-checks.md', 'generate-connector.md', 'generate-use.md'];
    const text = files.map((name) => readFileSync(join(PROMPTS_DIR, name), 'utf8')).join('\n');
    expect(text).not.toMatch(/pinewood|\bskylights?\b|\bsqueegee|gutter|\$97|ninety|dirty window/i);
  });
});

describe('the steps, in the order the run must follow', () => {
  it('reads, watches the reference, plans in words, makes the voice first, then prices, books and makes the scenes', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const at = (text: string): number => {
      const index = prompt.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const steps = [
      '\n1. Read. ',
      '\n2. The reference video: ',
      '\n3. Plan, in words first. ',
      '\n4. Voice first. ',
      '\n5. Windows, price, ladder.',
      '\n6. The client’s logo on the uniform. ',
      '\n7. Scenes. ',
      '\n8. Sound effects. ',
      '\n9. Hand off.',
    ].map(at);
    expect(steps).toEqual([...steps].sort((a, b) => a - b));

    // The story is told in words before the plan is written, and both come before anything is spent.
    expect(at(`${VARS.editDir}/generate/story.md`)).toBeLessThan(at('    {"voice":'));
    // The first thing that spends is after the voice is assembled, and a price (get_cost) comes before it.
    const firstBook = at(`node "${VARS.shotsScript}" book`);
    expect(at(`node "${VARS.voiceScript}" assemble`)).toBeLessThan(at('get_cost'));
    expect(at('get_cost')).toBeLessThan(firstBook);
    // The logo is sent before the scenes that use it; the scenes are checked, then joined; the effects come last.
    expect(at(`node "${VARS.shotsScript}" put`)).toBeLessThan(at('\n7. Scenes. '));
    expect(at('\n7. Scenes. ')).toBeLessThan(at('freezedetect'));
    expect(at('freezedetect')).toBeLessThan(at('concat=n=2'));
    expect(at('concat=n=2')).toBeLessThan(at(`node "${VARS.voiceScript}" sfx`));
  });

  it('makes timecoded Kling 4.0 text-to-video scenes of up to 30 s with hard cuts, and no pictures (the test that worked)', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    // Scenes, not many short clips; the shape that worked: two clips of about 15 s joined.
    expect(prompt).toContain('One scene is ONE clip of up to 30 seconds');
    expect(prompt).toContain('A video of 30 to 35 seconds is two scenes of about 15 seconds');
    expect(prompt).toContain(
      'model kling4_0, mode text-to-video (reference-to-video for a scene with the logo, step 6), resolution 720p',
    );
    // The prompt is timecoded on the scene’s own clock, with hard cuts.
    expect(prompt).toContain('0:00-0:04: Close view');
    expect(prompt).toContain('0:04-0:09: Hard cut.');
    expect(prompt).toContain('One continuous camera move, no cut');
    expect(prompt).toContain('Kling 4.0 puts a soundtrack in every clip whatever you ask');
    // 720p only: 1080p costs double.
    expect(prompt).toContain('never 1080p');
    // No pictures: no looks, keyframes, elements or start frames; the plan says so.
    expect(prompt).toContain('You make video scenes and nothing else');
    expect(prompt).toContain('cast is always empty and start and end are always null');
    expect(prompt).not.toMatch(
      /generate_image|manage_reference_elements|kling_element_ids"|start_image as|look still|keyframes\//,
    );
    // The joined footage is made and looked at, as in the test.
    expect(prompt).toContain('footage.mp4');
    expect(prompt).toContain('concat=n=<the number of scenes>');
    // Plan credits: paid, never free or unlimited, no project or folder.
    expect(prompt).toContain('use_unlim false');
    expect(prompt).toContain('no folder_id');
    expect(prompt).toContain('Never open a project, folder, website');
    // The old models and the API are gone.
    expect(prompt).not.toMatch(/Wan 3\.0|Kling 2\.5|Kling 3\.0|kling3_0|--tier|estimate "/);
  });

  it('puts the client’s logo on the uniform through one reference picture, and only that', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('The client’s logo on the uniform.');
    expect(prompt).toContain('the client’s own file, never one you make');
    expect(prompt).toContain('mode reference-to-video and the logo as image_references');
    expect(prompt).toContain(
      'printed directly on the fabric, sharp, upright and undistorted, with no black box or background behind it, on the left chest of his uniform shirt and large across the upper back',
    );
    expect(prompt).toContain(
      'A scene that shows no one in the uniform stays text-to-video with no picture.',
    );
    // The logo is checked in every take.
    expect(prompt).toContain(
      'the client’s logo on the uniform: the right letters in the right place',
    );
  });

  it('books the exact credits the connector prices, and declines the presets it suggests (the first real check, 27 Oct)', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    // The price is credits_exact (a 0.12-credit picture came back rounded to 1 in `credits`).
    expect(prompt).toContain('credits_exact in the answer is the price');
    expect(prompt).toContain('book that number, not a rounded one');
    // A prompt that looks like a preset made generate_video answer with a suggestion and no price.
    expect(prompt).toContain('preset_recommendation');
    expect(prompt).toContain('never use the preset');
    expect(prompt).toContain('declined_preset_id set to the preset id in the notice');
  });

  it('names only connector tools the run is allowed to call, and loads them with ToolSearch', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const rules = generateAllowedTools('/Users/owner', {
      voice: VARS.voiceScript,
      shots: VARS.shotsScript,
    });
    const named = [...new Set(prompt.match(/mcp__claude_ai_Higgsfield__[a-z_]+/g) ?? [])];
    expect(named.length).toBeGreaterThan(5);
    for (const tool of named) expect(rules, tool).toContain(tool);
    expect(prompt).toContain('load them first with ToolSearch');
    // The tools it relies on in the steps are among them.
    for (const tool of ['generate_video', 'jobs_wait', 'media_upload', 'media_confirm']) {
      expect(named, tool).toContain(`mcp__claude_ai_Higgsfield__${tool}`);
    }
    // No picture is made: the image tools and the reference elements are not named, nor allowed.
    expect(prompt).not.toContain('generate_image');
    expect(rules.join(' ')).not.toMatch(/generate_image|manage_reference_elements/);
  });

  it('puts an opening before the first word inside voice.mp3, as a lead given to assemble', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    // One timeline: the voice is time 0, and the opening is silence at its start.
    expect(prompt).toContain('time 0 of voice.mp3 is time 0 of the video');
    expect(prompt).toContain('that opening is silence at the start of voice.mp3');
    expect(prompt).toContain('take the time of the first spoken word from reference.md');
    expect(prompt).toContain(
      'round it to 100 ms, cap it at 6000 and pass it as --lead in step 4’s assemble',
    );
    expect(prompt).toContain('The opening scene then covers 0 to the first word');
    expect(prompt).toContain('With no such opening there is no --lead');
    // The old rule (no way to open before the first word) is gone.
    expect(prompt).not.toContain('the edit cannot move the voice');
    expect(prompt).not.toContain('So the opening shot’s first window starts at 0');
    expect(prompt).not.toContain('0 is the first word');

    // The lead is passed in step 4, after the plain assemble, and step 5 reads the windows with it.
    const at = (text: string): number => {
      const index = prompt.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    };
    const leadCall = at(
      `assemble "${VARS.editDir}" --order L1:2,L2:1,L3:1 --pauses 'L1>L2:500,L2>L3:350' --lead `,
    );
    expect(leadCall).toBeGreaterThan(at('\n4. Voice first. '));
    expect(leadCall).toBeLessThan(at('\n5. Windows, price, ladder.'));
    expect(
      at(`assemble "${VARS.editDir}" --order L1:2,L2:1,L3:1 --pauses 'L1>L2:500,L2>L3:350'\n`),
    ).toBeLessThan(leadCall);
    expect(prompt).toContain('voice-words.json records leadMs');
    expect(prompt).toContain(
      'With a lead (step 4) the opening scene’s first window runs from 0 to where the first spoken beat starts',
    );
    expect(prompt).toContain(
      'An alert that plays before the first word is no longer than the lead',
    );
  });

  it('keeps the lead on a retry: an assembled voice is only assembled again with the same --lead', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('Assemble again only when the pick of a line changed');
    expect(prompt).toContain('with the same --lead that voice-words.json records as leadMs');
  });

  it('writes the plan before anything is spent and the hand-off last', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt.indexOf('plan.json')).toBeLessThan(prompt.indexOf('assemble'));
    expect(prompt.indexOf('reference.md')).toBeLessThan(prompt.indexOf('plan.json'));
    expect(prompt.lastIndexOf('shots.json')).toBeGreaterThan(prompt.indexOf('9. Hand off.'));
    expect(prompt).toContain('./edit/project.md');
    expect(prompt).toContain('checks.md');
    expect(prompt).toContain('You are done when shots.json is valid');
  });

  it('keeps the helpers out of the places they default to (next to the video, edit/transcripts)', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const lines = commandLines(prompt);
    const transcribe = lines.filter((line) => line.includes('transcribe.py'));
    const view = lines.filter((line) => line.includes('timeline_view.py'));
    expect(transcribe).toHaveLength(1);
    expect(transcribe[0]).toContain('--edit-dir "./edit/generate/ref"');
    expect(view).toHaveLength(1);
    expect(view[0]).toContain(' -o "');
    expect(view[0]).toContain('--transcript "./edit/generate/ref/transcripts/');
    expect(prompt).not.toContain('edit/transcripts/');
  });
});

describe('the command lines', () => {
  it('stay inside what the run’s Bash allows, with no shell operators outside quotes', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const rules = generateAllowedTools('/Users/owner', {
      voice: VARS.voiceScript,
      shots: VARS.shotsScript,
    });
    const lines = commandLines(prompt);
    expect(lines.length).toBeGreaterThan(15);
    // The shots script’s own forms are among them: book, the same book with the job id, save, void and put.
    expect(
      lines.filter((line) => line.startsWith(`node "${VARS.shotsScript}"`)).length,
    ).toBeGreaterThanOrEqual(5);
    for (const line of lines) {
      expect(allowed(line, rules), line).toBe(true);
      expect(outsideQuotes(line), line).not.toMatch(/[|;&<>$`\\]/);
      expect(line, line).not.toMatch(/\bcurl\b|\bnode -e\b|\bcp |\bmv |\brm |\bsed |\bcat |\.env/);
    }
    // The inline forms the prose names.
    for (const inline of ['mkdir -p "./edit/generate/ref"', 'mkdir -p "./edit/generate/checks"']) {
      expect(prompt).toContain(inline);
      expect(allowed(inline, rules), inline).toBe(true);
    }
    expect(allowed('mkdir -p "./edit/generate/clips/C"', rules)).toBe(true);
  });

  it('call make-voice.mjs with options it has, and values it can read', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const calls = commandLines(prompt)
      .map((line) => scriptCall(line, VARS.voiceScript))
      .filter((words): words is string[] => words !== null);
    // The assemble is shown twice: as it is for a video that starts on its first word, and with a lead.
    expect(calls.map((words) => words[0]).sort()).toEqual([
      'assemble',
      'assemble',
      'check',
      'line',
      'sfx',
    ]);
    for (const words of calls) {
      const args = parseVoiceArgs(words);
      expect(args.editDir).toBe(VARS.editDir);
      const need = {
        line: ['id', 'text', 'direction'],
        check: ['file', 'text'],
        assemble: ['order', 'pauses'],
        sfx: ['id', 'prompt', 'seconds'],
      }[args.command];
      for (const option of need)
        expect(args.options.has(option), `${args.command} ${option}`).toBe(true);
      if (args.options.has('order')) {
        expect(parseOrder(args.options.get('order')).length).toBeGreaterThan(1);
      }
      if (args.options.has('pauses')) {
        expect(parsePauses(args.options.get('pauses')).size).toBeGreaterThan(0);
      }
    }
    // One of the two assembles carries --lead, with a value the script accepts (whole ms, 0 to 6000).
    const withLead = calls
      .filter((words) => words[0] === 'assemble')
      .map((words) => parseVoiceArgs(words))
      .filter((args) => args.options.has('lead'));
    expect(withLead).toHaveLength(1);
    const lead = parseLead(withLead[0]?.options.get('lead'));
    expect(lead).toBeGreaterThan(0);
    expect(lead % 100).toBe(0);
  });

  it('call make-shots.mjs with flags its commands read and the ones they require', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const calls = commandLines(prompt)
      .map((line) => scriptCall(line, VARS.shotsScript))
      .filter((words): words is string[] => words !== null);
    const kinds = new Set(calls.map((words) => words[0]));
    expect(kinds).toEqual(new Set(['book', 'save', 'void', 'put']));

    const required: Record<string, string[]> = {
      book: ['kind', 'model', 'credits', 'budget'],
      save: ['kind', 'url'],
      void: ['kind', 'reason'],
      put: ['file', 'url'],
    };
    for (const words of calls) {
      const command = words[0] as 'book' | 'save' | 'void' | 'put';
      expect(words[1]).toBe(VARS.editDir);
      const known = shotsFlags(command);
      const used = flagsOf(words);
      for (const flag of used) expect(known.has(flag), `${command} --${flag}`).toBe(true);
      for (const flag of required[command] ?? []) {
        expect(used, `${command} needs --${flag}`).toContain(flag);
      }
      // Every booking takes the job's whole budget as a number.
      if (command === 'book') expect(words[words.indexOf('--budget') + 1]).toBe('3');
      // The kinds are ones the script knows.
      if (command !== 'put') {
        expect(['look', 'keyframe', 'clip']).toContain(words[words.indexOf('--kind') + 1]);
      }
    }

    // A booking is shown twice: before the request is sent, and again with the job id it was given.
    const books = calls.filter((words) => words[0] === 'book');
    expect(books).toHaveLength(2);
    expect(books.filter((words) => flagsOf(words).includes('job'))).toHaveLength(1);
    // The model the example books is the one the prompt makes scenes with.
    expect(books[0]?.[books[0].indexOf('--model') + 1]).toBe('kling4_0');
  });

  it('put every text in single quotes, never in double ones (a $ would be read there)', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    for (const line of commandLines(prompt)) {
      for (const flag of ['--text', '--direction', '--prompt', '--reason', '--url']) {
        const at = line.indexOf(`${flag} `);
        if (at === -1) continue;
        expect(line.slice(at + flag.length + 1)[0], `${flag} in ${line}`).toBe("'");
      }
    }
    expect(prompt).toContain('Never put a text in double quotes');
  });
});

describe('the two files the engine reads', () => {
  it('shows a plan.json the contract accepts', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const example = prompt.split('\n').find((line) => line.trim().startsWith('{"voice":'));
    expect(example).toBeDefined();
    const plan = generatePlanSchema.parse(JSON.parse(example as string));
    expect(plan.clips[0]?.tier).toBe('people');
    // No pictures are made (U31): no cast, and no start or end frame.
    expect(plan.cast).toEqual([]);
    expect(plan.clips[0]?.start).toBeNull();
    expect(plan.clips[0]?.end).toBeNull();
    expect(plan.clips[0]?.references).toEqual([]);
    // A scene of up to 30 s with a text-to-video plan is accepted.
    expect(
      generatePlanSchema.safeParse({
        ...plan,
        clips: [{ ...plan.clips[0], seconds: 30 }],
      }).success,
    ).toBe(true);
  });

  it('tells the run to write every text of the plan in full, because the engine ignores a plan with an empty one', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('the engine ignores a plan that has an empty text');
    expect(
      generatePlanSchema.safeParse({
        voice: [{ id: 'L1', text: 'x', direction: null }],
        cast: [],
        clips: [
          {
            id: 'A',
            covers: [{ beat: 'b', startSec: 0, endSec: 1 }],
            shows: 's',
            tier: 'easy',
            seconds: 5,
            start: { prompt: '', file: null },
            end: null,
            references: [],
            prompt: 'p',
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('shows a shots.json the contract accepts, with the fields Review and the edit read', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const example = prompt.split('\n').find((line) => line.trim().startsWith('{"shots":'));
    expect(example).toBeDefined();
    const shots = generateShotsSchema.parse(JSON.parse(example as string));
    expect(shots.shots[0]?.belowBar).toBe(false);
    // belowBar is explained: what it means, and that Review says so.
    expect(prompt).toContain('belowBar is true for a scene whose best take still fails its check');
    expect(prompt).toContain('the engine copies it to shots/<id>.mp4');
    // What the edit run (generated.md) relies on: one timeline from the voice, and a model that is Kling 4.0.
    expect(prompt).toContain('time 0 of voice.mp3 is time 0 of the video');
    expect(shots.shots[0]?.model).toBe('kling4_0');
  });

  it('keeps the brief’s lines as they are in the plan and spells numbers only in the calls', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('Never respell them here');
    expect(prompt).toContain('numbers, prices, symbols and years written out in words');
  });
});

describe('the budget ladder and the ways the run stops', () => {
  it('goes through the three steps in the decided order, then the Blocked line', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    const steps = [
      '1. Every scene at 720p, never 1080p.',
      '2. Every scene cut to the fewest seconds the cut uses',
      '3. No retakes',
      'Blocked: this video needs about $N; the budget is $M',
    ].map((text) => {
      const index = prompt.indexOf(text);
      expect(index, text).toBeGreaterThan(-1);
      return index;
    });
    expect(steps).toEqual([...steps].sort((a, b) => a - b));
    // It is priced before it is made, with the free get_cost.
    expect(prompt.indexOf('get_cost')).toBeLessThan(prompt.indexOf('1. Every scene at 720p'));
  });

  it('writes the over-budget stop in the words the engine turns into a budget error', () => {
    const failure = generateFailure({
      blocked: 'this video needs about $3.42; the budget is $3',
      fallback: 'fallback',
    });
    expect(failure.refusal).toMatchObject({ code: 'over_budget', needUsd: 3.42, budgetUsd: 3 });
  });

  it('says running out of money part-way is not a blocker, and when Blocked is the answer', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('that is not a blocker');
    expect(prompt).toContain('exit 2, over_budget (book): not a blocker');
    expect(prompt).toContain('A last line that starts with Blocked: stops the job');
    for (const code of ['unavailable', 'balance_empty', 'key_rejected', 'bad_request']) {
      expect(prompt, code).toContain(code);
    }
    expect(prompt).toContain('and its message word for word');
    // The plan’s credits running out and a connector that cannot be reached are blockers, in plain words.
    expect(prompt).toContain(
      'Blocked: Higgsfield plan credits are used up: wait for the plan to renew or add credits at higgsfield.ai, then Retry',
    );
    expect(prompt).toContain(
      'Blocked: Claude cannot reach Higgsfield: reconnect the Higgsfield connector',
    );
  });

  it('keeps what exists: a retry reads the folder and the checks and makes only what is missing', async () => {
    const prompt = await buildGeneratePrompt(VARS);
    expect(prompt).toContain('./edit/generate/ is your memory');
    expect(prompt).toContain('never make a voice take or a scene take again that is there');
    expect(prompt).toContain('book answers reused: true with state completed');
    expect(prompt).toContain('A take with no verdict in checks.md is checked now');
    // Every take's verdict is kept too, so a retry does not judge or remake it.
    expect(prompt).toContain('A take 1: pass');
    // A run ends with a hand-off or with a Blocked line, never with neither.
    expect(prompt).toContain('Never end with neither');
    expect(prompt).toContain('a broken service');
  });
});

describe('what a template can use', () => {
  function promptsDir(files: Record<string, string>): string {
    const dir = mkdtempSync(join(tmpdir(), 'studio-generate-prompts-'));
    temps.push(dir);
    mkdirSync(dir, { recursive: true });
    for (const [name, text] of Object.entries(files)) writeFileSync(join(dir, name), text);
    return dir;
  }

  it('fills the variables of the contract', async () => {
    const dir = promptsDir({
      'generate.md':
        'c={{client}} j={{job}} v={{voiceScript}} s={{shotsScript}} e={{editDir}} b={{budget}} n={{budgetNumber}} sp={{spent}} l={{left}} cr={{creditRate}} bc={{budgetCredits}} lc={{leftCredits}} f={{formats}}\n',
    });
    expect(await buildGeneratePrompt({ ...VARS, budgetUsd: 4.5, spentUsd: 0.5 }, dir)).toBe(
      `c=Acme Bakery j=Sourdough Ad v=${VARS.voiceScript} s=${VARS.shotsScript} e=${VARS.editDir} b=$4.50 n=4.5 sp=$0.50 l=$4 cr=0.056 bc=80 lc=71 f=9:16 and 1:1\n`,
    );
    // The engine’s own rate is used when it passes one.
    expect(
      await buildGeneratePrompt({ ...VARS, budgetUsd: 5, spentUsd: 0, usdPerCredit: 0.05 }, dir),
    ).toContain('cr=0.05 bc=100 lc=100');
  });

  it('loads every generate-<name>.md beside it as the partial {{> generate-<name>}}', async () => {
    const dir = promptsDir({
      'generate.md': 'Start.\n{{> generate-checks}}\n{{> generate-use}}\nEnd {{budget}}.\n',
      'generate-checks.md': 'Check every take for {{client}}.\n',
      'generate-use.md': '',
      'unrelated.md': 'not a partial',
    });
    expect(await buildGeneratePrompt(VARS, dir)).toBe(
      'Start.\nCheck every take for Acme Bakery.\nEnd $3.\n',
    );
  });

  it('reads the real folder’s partials, and no file there shadows the engine’s generate-existing', async () => {
    const prompt = await buildGeneratePrompt(
      { ...VARS, existing: 'Earlier: looks made.' },
      PROMPTS_DIR,
    );
    expect(prompt).toContain('Earlier: looks made.');
    // generate-checks.md and generate-use.md are in it.
    expect(prompt).toContain('freezedetect');
    expect(prompt).toContain('What is already there, and what goes wrong.');
  });
});

describe('the small texts', () => {
  it('names the sizes asked for, "9:16" for none or one that is the default', () => {
    expect(formatsText(['1080x1920', '1080x1080'])).toBe('9:16 and 1:1');
    expect(formatsText(['1080x1920', '1080x1080', '1920x1080'])).toBe('9:16, 1:1 and 16:9');
    expect(formatsText(['1080x1080'])).toBe('1:1');
    expect(formatsText(null)).toBe('9:16');
    expect(formatsText([])).toBe('9:16');
  });

  it('writes a budget as the number --budget takes', () => {
    expect(budgetNumber(3)).toBe('3');
    expect(budgetNumber(4.5)).toBe('4.5');
    expect(budgetNumber(12.254)).toBe('12.25');
  });
});

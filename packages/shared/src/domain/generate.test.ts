import { describe, expect, expectTypeOf, it } from 'vitest';
import {
  budgetLeftUsd,
  budgetUsdText,
  clipTakeFile,
  DEFAULT_GENERATE_BUDGET_USD,
  DEFAULT_GENERATE_VOICE_ID,
  formatRatioText,
  GENERATE_CAST_KINDS,
  GENERATE_ERROR_CODES,
  GENERATE_EXIT_CODES,
  GENERATE_FILES,
  GENERATE_MESSAGES,
  GENERATE_PHASES,
  GENERATE_SERVICES,
  GENERATE_SPEND_KINDS,
  GENERATE_TIERS,
  GENERATE_VOICE_LEAD_MAX_MS,
  type GenerateHistoryEvent,
  type GeneratePlan,
  type GenerateState,
  generateBudgetFor,
  generateErrorCodeSchema,
  generateErrorHelp,
  generateErrorLine,
  generateErrorMessage,
  generateErrorTitle,
  generateExitCode,
  generateHistoryEventSchema,
  generateHistoryResponseSchema,
  generateHistoryText,
  generateHistoryTone,
  generateNowText,
  generatePlanSchema,
  generateProgressLabel,
  generateRowError,
  generateRowText,
  generateSheetRows,
  generateShotsSchema,
  generateSpendSchema,
  generateSpendText,
  generateStateSchema,
  generateStepText,
  generateStoppedText,
  generateStopReason,
  generateVoiceWordsSchema,
  initialGenerateState,
  LADDER_STEPS,
  ladderStep,
  MAKE_SHOTS_COMMANDS,
  MAKE_VOICE_COMMANDS,
  makeShotsLineSchema,
  makeVoiceLineSchema,
  parseGenerateErrorMessage,
  parseGenerateScriptLine,
  shotFile,
  spendTotal,
  spendUsdText,
  voiceTakeFile,
} from './generate.ts';
import { makeGenerateState } from './test-fixtures.ts';

// Generated videos, GN0: the contract the two scripts, the engine and the page share. The texts are
// the ones on boards GNJobs, GNStates and GNSheet (and plan.md section 2.7), word for word.

const state = (overrides: Partial<GenerateState> = {}) => makeGenerateState(overrides);

/** A state in the voice phase: 3 of 7 lines, the plan's 6 clips known. */
const voicing = state({
  phase: 'voice',
  counts: {
    voice: { done: 3, total: 7 },
    looks: { done: 0, total: 0 },
    keyframes: { done: 0, total: 0 },
    clips: { done: 0, total: 6 },
    belowBar: 0,
  },
  spendUsd: 0,
});

describe('the files', () => {
  it('lay out edit/generate/ as the plan says', () => {
    expect(GENERATE_FILES).toEqual({
      dir: 'generate',
      reference: 'generate/reference.md',
      plan: 'generate/plan.json',
      voiceDir: 'generate/voice',
      voice: 'generate/voice.mp3',
      voiceWords: 'generate/voice-words.json',
      looksDir: 'generate/looks',
      keyframesDir: 'generate/keyframes',
      clipsDir: 'generate/clips',
      shotsDir: 'generate/shots',
      sfxDir: 'generate/sfx',
      uploads: 'generate/uploads.json',
      spend: 'generate/spend.json',
      shots: 'generate/shots.json',
      history: 'generate/history.jsonl',
    });
  });

  it('name a voice take, a clip take and a kept shot', () => {
    expect(voiceTakeFile('L1', 2)).toBe('voice/L1-take2.mp3');
    expect(clipTakeFile('B', 1)).toBe('clips/B/take-1.mp4');
    expect(shotFile('A')).toBe('shots/A.mp4');
  });
});

describe('the voice', () => {
  it("is Kal Jones, from ElevenLabs' voice library, unless the config names another", () => {
    expect(DEFAULT_GENERATE_VOICE_ID).toBe('68RUZBDjLe2YBQvv8zFx');
  });

  it('may open with at most 6 s of silence before the first word (assemble --lead)', () => {
    expect(GENERATE_VOICE_LEAD_MAX_MS).toBe(6000);
  });
});

describe('the budget', () => {
  it('is $5 by default, and a note in the brief raises it for one job', () => {
    expect(DEFAULT_GENERATE_BUDGET_USD).toBe(5);
    expect(generateBudgetFor(null, 3)).toBe(3);
    expect(generateBudgetFor(5, 3)).toBe(5);
    expect(generateBudgetFor(1.5, 3)).toBe(1.5);
    expect(generateBudgetFor(0, 3)).toBe(3);
  });

  it('writes money the way the boards do', () => {
    expect(spendUsdText(0)).toBe('$0');
    expect(spendUsdText(1.65)).toBe('$1.65');
    expect(spendUsdText(3)).toBe('$3.00');
    expect(spendUsdText(4.1)).toBe('$4.10');
    expect(spendUsdText(0.1 + 0.2)).toBe('$0.30');
    expect(budgetUsdText(3)).toBe('$3');
    expect(budgetUsdText(5)).toBe('$5');
    expect(budgetUsdText(5.5)).toBe('$5.50');
    expect(budgetLeftUsd({ spendUsd: 2.33, budgetUsd: 3 })).toBe(0.67);
    expect(budgetLeftUsd({ spendUsd: 3.2, budgetUsd: 3 })).toBe(0);
  });
});

describe('generatePlanSchema (plan.json)', () => {
  const plan: GeneratePlan = {
    voice: [
      { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
      { id: 'L2', text: 'BUT it gets worse.', direction: 'a clear stop after BUT' },
    ],
    cast: [
      {
        id: 'technician',
        kind: 'person',
        name: 'the technician',
        look: 'a man in a navy polo with the PINEWOOD logo on the chest',
        prompt: 'a technician in a navy polo, the logo on his chest, friendly',
        references: ['refs/logo.png'],
      },
      {
        id: 'hero-skylight',
        kind: 'prop',
        name: 'the hero skylight',
        look: 'a white skylight with grey dust',
        prompt: 'a white skylight covered in dust',
        references: [],
      },
    ],
    clips: [
      {
        id: 'A',
        covers: [
          { beat: 'the alert', startSec: 0, endSec: 3 },
          { beat: 'the airflow', startSec: 12, endSec: 16 },
        ],
        shows: 'the hero skylight, pushing in',
        tier: 'easy',
        seconds: 10,
        start: { prompt: 'the hero skylight, close, night', file: 'keyframes/A-start.png' },
        end: null,
        references: ['hero-skylight'],
        prompt: 'slow push in; dust drifts toward the camera',
      },
      {
        id: 'B',
        covers: [{ beat: 'the pour and the tilt up', startSec: 3, endSec: 8 }],
        shows: 'the homeowner pours water, then the camera tilts up to the skylight',
        tier: 'tilt',
        seconds: 6,
        start: { prompt: 'a kitchen, a woman with a jug', file: null },
        end: { prompt: 'the skylight on the kitchen ceiling', file: null },
        references: ['hero-skylight'],
        prompt: 'one continuous tilt up',
      },
    ],
  };

  it('accepts a plan with the voice, the cast and the clips', () => {
    expect(generatePlanSchema.parse(plan)).toEqual(plan);
  });

  it('knows the tiers and the kinds of cast', () => {
    expect([...GENERATE_TIERS]).toEqual(['easy', 'people', 'tilt']);
    expect([...GENERATE_CAST_KINDS]).toEqual(['person', 'prop']);
  });

  it('wants at least one voice line and one clip, and a cast that may be empty', () => {
    expect(generatePlanSchema.safeParse({ ...plan, voice: [] }).success).toBe(false);
    expect(generatePlanSchema.safeParse({ ...plan, clips: [] }).success).toBe(false);
    expect(generatePlanSchema.safeParse({ ...plan, cast: [] }).success).toBe(true);
  });

  it.each([
    ['a line id that is not L1, L2 …', { voice: [{ id: 'one', text: 'x', direction: null }] }],
    ['a line without text', { voice: [{ id: 'L1', text: '', direction: null }] }],
    ['a line without a direction key', { voice: [{ id: 'L1', text: 'x' }] }],
  ])('rejects %s', (_label, change) => {
    expect(generatePlanSchema.safeParse({ ...plan, ...change }).success).toBe(false);
  });

  it.each([
    ['an id that is a path', { id: '../A' }],
    ['an empty id', { id: '' }],
    ['no covers', { covers: [] }],
    ['an unknown tier', { tier: 'cheap' }],
    ['zero seconds', { seconds: 0 }],
    ['a start without a file key', { start: { prompt: 'x' } }],
    ['no prompt', { prompt: '' }],
  ])('rejects a clip with %s', (_label, change) => {
    const clips = [{ ...plan.clips[0], ...change }];
    expect(generatePlanSchema.safeParse({ ...plan, clips }).success).toBe(false);
  });

  it('rejects cast with an id that is not a lower-case word, or a kind that is not person or prop', () => {
    const cast = plan.cast[0];
    expect(
      generatePlanSchema.safeParse({ ...plan, cast: [{ ...cast, id: 'The Tech' }] }).success,
    ).toBe(false);
    expect(
      generatePlanSchema.safeParse({ ...plan, cast: [{ ...cast, kind: 'animal' }] }).success,
    ).toBe(false);
  });
});

describe('generateShotsSchema (shots.json)', () => {
  const shots = {
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
        shows: 'the hero skylight',
        model: 'kling-video/v2.5-turbo/standard/image-to-video',
        usd: 0.357,
        belowBar: false,
      },
      {
        id: 'B',
        file: 'clips/B/take-2.mp4',
        take: 2,
        windows: [{ startSec: 3, endSec: 8 }],
        seconds: 6,
        shows: 'the pour and the tilt up',
        model: 'alibaba/wan-3.0/image-to-video',
        usd: 0.51,
        belowBar: true,
      },
    ],
  };

  it('accepts the kept take of each clip with its windows, model, price and belowBar flag', () => {
    expect(generateShotsSchema.parse(shots)).toEqual(shots);
    expect(generateShotsSchema.parse({ shots: [] })).toEqual({ shots: [] });
  });

  it.each([
    ['a clip with no window', { windows: [] }],
    ['a window that ends before it starts', { windows: [{ startSec: 5, endSec: 2 }] }],
    ['no belowBar flag', { belowBar: undefined }],
    ['a take of 0', { take: 0 }],
    ['a negative price', { usd: -1 }],
  ])('rejects %s', (_label, change) => {
    const [first] = shots.shots;
    expect(generateShotsSchema.safeParse({ shots: [{ ...first, ...change }] }).success).toBe(false);
  });
});

describe('generateSpendSchema (spend.json)', () => {
  const entry = {
    at: '2026-10-25T14:15:00.000Z',
    kind: 'clip' as const,
    slug: 'kling-video/v2.5-turbo/standard/image-to-video',
    usd: 0.179,
    requestId: 'req-1',
    refunded: false,
  };

  it('accepts entries and a total', () => {
    const spend = { entries: [entry, { ...entry, requestId: null, refunded: true }], total: 0.179 };
    expect(generateSpendSchema.parse(spend)).toEqual(spend);
    expect([...GENERATE_SPEND_KINDS]).toEqual(['look', 'keyframe', 'clip', 'reframe']);
  });

  it.each([
    ['an unknown kind', { kind: 'upscale' }],
    ['a time that is not ISO', { at: 'yesterday' }],
    ['a negative price', { usd: -0.1 }],
    ['no refunded flag', { refunded: undefined }],
  ])('rejects %s', (_label, change) => {
    expect(
      generateSpendSchema.safeParse({ entries: [{ ...entry, ...change }], total: 0 }).success,
    ).toBe(false);
  });

  it('adds up the entries that were not refunded, without float noise', () => {
    expect(spendTotal([])).toBe(0);
    expect(
      spendTotal([
        { usd: 0.1, refunded: false },
        { usd: 0.2, refunded: false },
        { usd: 5, refunded: true },
      ]),
    ).toBe(0.3);
  });
});

describe('generateVoiceWordsSchema (voice-words.json)', () => {
  it('lists the words with their line and time', () => {
    const words = {
      words: [
        { line: 'L1', text: 'Do', startSec: 0, endSec: 0.2 },
        { line: 'L1', text: 'you', startSec: 0.2, endSec: 0.4 },
      ],
    };
    expect(generateVoiceWordsSchema.parse(words)).toEqual(words);
    expect(
      generateVoiceWordsSchema.safeParse({
        words: [{ line: 'L1', text: 'Do', startSec: 1, endSec: 0.5 }],
      }).success,
    ).toBe(false);
  });

  it('may say how long voice.mp3 opens with silence (leadMs); missing means none', () => {
    const word = { line: 'L1', text: 'Do', startSec: 2.9, endSec: 3.1 } as const;
    expect(generateVoiceWordsSchema.parse({ words: [word] }).leadMs).toBeUndefined();
    expect(generateVoiceWordsSchema.parse({ leadMs: 0, words: [word] }).leadMs).toBe(0);
    expect(generateVoiceWordsSchema.parse({ leadMs: 2800, words: [word] }).leadMs).toBe(2800);
    // What the real script writes: the total, the lead and the lines come with the words.
    const written = { ms: 5200, leadMs: 2800, lines: [], words: [word] };
    expect(generateVoiceWordsSchema.parse(written)).toEqual({ leadMs: 2800, words: [word] });
    for (const leadMs of [-1, 1.5, '2800']) {
      expect(
        generateVoiceWordsSchema.safeParse({ leadMs, words: [word] }).success,
        `${leadMs}`,
      ).toBe(false);
    }
  });
});

describe('GenerateState', () => {
  it('has the seven phases, in order', () => {
    expect([...GENERATE_PHASES]).toEqual([
      'plan',
      'voice',
      'looks',
      'keyframes',
      'clips',
      'sound',
      'done',
    ]);
  });

  it('starts planning with nothing made and nothing spent', () => {
    expect(initialGenerateState(3)).toEqual({
      phase: 'plan',
      counts: {
        voice: { done: 0, total: 0 },
        looks: { done: 0, total: 0 },
        keyframes: { done: 0, total: 0 },
        clips: { done: 0, total: 0 },
        belowBar: 0,
      },
      spendUsd: 0,
      budgetUsd: 3,
    });
    expect(generateStateSchema.safeParse(initialGenerateState(3)).success).toBe(true);
  });

  it('is a phase, the counts, what was spent and the budget', () => {
    expect(generateStateSchema.parse(state())).toEqual(state());
    expectTypeOf<GenerateState['spendUsd']>().toEqualTypeOf<number>();
    expectTypeOf<GenerateState['phase']>().toEqualTypeOf<
      'plan' | 'voice' | 'looks' | 'keyframes' | 'clips' | 'sound' | 'done'
    >();
  });

  it.each([
    ['an unknown phase', { phase: 'dreaming' }],
    ['money spent below zero', { spendUsd: -1 }],
    ['a budget of nothing', { budgetUsd: 0 }],
    ['a count with a fraction', { counts: { ...state().counts, belowBar: 0.5 } }],
  ])('rejects %s', (_label, change) => {
    expect(generateStateSchema.safeParse({ ...state(), ...change }).success).toBe(false);
  });

  it('says what the route answers when there is no Generate stage', () => {
    expect(GENERATE_MESSAGES.notGenerated).toBe('This job is not a generated video.');
    expect(GENERATE_MESSAGES.off).toBe('Generated videos are off.');
  });
});

describe('the row and the sheet’s words (boards GNJobs, GNStates, GNSheet)', () => {
  const at = (phase: GenerateState['phase'], counts: Partial<GenerateState['counts']>) =>
    state({ phase, counts: { ...state().counts, ...counts } });

  it('writes the Jobs row for every part Generate makes', () => {
    expect(generateRowText(voicing)).toBe('Generate · voice 3/7');
    expect(generateRowText(at('looks', { looks: { done: 2, total: 3 } }))).toBe(
      'Generate · looks 2/3',
    );
    expect(generateRowText(at('keyframes', { keyframes: { done: 5, total: 7 } }))).toBe(
      'Generate · keyframes 5/7',
    );
    expect(generateRowText(state())).toBe('Generate · clips 4/6 · $1.65');
  });

  it('adds the money only in the clips phase, and writes the label without it', () => {
    expect(generateProgressLabel(state())).toBe('Generate · clips 4/6');
    expect(generateRowText(voicing)).not.toContain('$');
  });

  it('has words for planning, the sound effects and a finished run, and drops an unknown count', () => {
    expect(generateRowText(initialGenerateState(3))).toBe('Generate · planning the shots');
    expect(generateRowText(state({ phase: 'sound' }))).toBe('Generate · sound effects');
    expect(generateRowText(state({ phase: 'done' }))).toBe('Generate · done');
    expect(
      generateRowText(
        state({ phase: 'voice', counts: { ...state().counts, voice: { done: 0, total: 0 } } }),
      ),
    ).toBe('Generate · voice');
  });

  it('writes the spend as the progress bar’s right side', () => {
    expect(generateSpendText(state())).toBe('$1.65 of $3');
    expect(generateSpendText(state({ spendUsd: 0 }))).toBe('$0 of $3');
    expect(generateSpendText(state({ spendUsd: 3 }))).toBe('$3.00 of $3');
    expect(generateSpendText(state({ spendUsd: 2.84 }))).toBe('$2.84 of $3');
    expect(generateSpendText(state({ spendUsd: 1, budgetUsd: 5.5 }))).toBe('$1.00 of $5.50');
  });

  it('writes the Steps row’s text', () => {
    expect(generateStepText(voicing)).toBe('now · voice 3/7');
    expect(generateStepText(state(), 18)).toBe('now · 18 min so far');
    expect(generateStepText(state())).toBe('now');
    expect(generateStepText(initialGenerateState(3))).toBe('now');
  });

  it('writes the sentence under the title', () => {
    expect(generateNowText(voicing)).toBe(
      'Generating the video. The voice comes first: line 3 of 7. Every take is checked word by word against the script.',
    );
    expect(generateNowText(state())).toBe(
      'Generating the clips in Higgsfield: 4 of 6 done. One take each, checked frame by frame; a retake only when the check fails.',
    );
    expect(generateNowText(initialGenerateState(3))).toContain('plans the shots');
    expect(generateNowText(state({ phase: 'looks' }))).toContain('looks');
    expect(generateNowText(state({ phase: 'keyframes' }))).toContain('keyframes');
    expect(generateNowText(state({ phase: 'sound' }))).toContain('sound effects');
    expect(generateNowText(state({ phase: 'done' }))).toContain('shots are made');
    // Before the first line is made, it is on line 1.
    expect(
      generateNowText(
        state({ phase: 'voice', counts: { ...state().counts, voice: { done: 0, total: 7 } } }),
      ),
    ).toContain('line 1 of 7');
  });

  describe('the Generated section', () => {
    it('is dashes and the prepaid-balance line while the plan is being made', () => {
      expect(generateSheetRows(initialGenerateState(3))).toEqual([
        { key: 'Voice', value: '—', tone: 'muted' },
        { key: 'Looks', value: '—', tone: 'muted' },
        { key: 'Keyframes', value: '—', tone: 'muted' },
        { key: 'Clips', value: '—', tone: 'muted' },
        {
          key: 'Spend',
          value: '$0 of $3',
          tone: 'normal',
          sub: 'On Higgsfield’s prepaid balance, which is separate from your plan.',
        },
      ]);
    });

    it('shows the voice at 3 of 7 lines with a bar, and says the voice costs nothing on Higgsfield', () => {
      expect(generateSheetRows(voicing)).toEqual([
        { key: 'Voice', value: '3 of 7 lines', tone: 'normal', barPercent: 43 },
        { key: 'Looks', value: '—', tone: 'muted' },
        { key: 'Keyframes', value: '—', tone: 'muted' },
        { key: 'Clips', value: '0 of 6', tone: 'muted' },
        {
          key: 'Spend',
          value: '$0 of $3',
          tone: 'normal',
          sub: 'The voice is ElevenLabs, so it costs nothing on Higgsfield.',
        },
      ]);
    });

    it('shows four of six clips and $1.65 of $3 with bars', () => {
      expect(generateSheetRows(state(), { voiceSec: 31 })).toEqual([
        { key: 'Voice', value: '7 lines · 0:31', tone: 'normal' },
        { key: 'Looks', value: '3 stills', tone: 'normal' },
        { key: 'Keyframes', value: '7 for 6 clips', tone: 'normal' },
        { key: 'Clips', value: '4 of 6', tone: 'normal', barPercent: 67, barTone: 'normal' },
        { key: 'Spend', value: '$1.65 of $3', tone: 'normal', barPercent: 55, barTone: 'normal' },
      ]);
    });

    it('says "—" for a part not begun even when the plan knows its total (GN9)', () => {
      const planned = state({
        phase: 'voice',
        counts: {
          voice: { done: 3, total: 7 },
          looks: { done: 0, total: 3 },
          keyframes: { done: 0, total: 7 },
          clips: { done: 0, total: 6 },
          belowBar: 0,
        },
        spendUsd: 0,
      });
      expect(generateSheetRows(planned).map((row) => row.value)).toEqual([
        '3 of 7 lines',
        '—',
        '—',
        '0 of 6',
        '$0 of $3',
      ]);
      // At the looks, with none made yet, the bar is there ("0 of 3 stills"); a run that stopped
      // there did not begin them: "—" (board GNSheet, Over the budget).
      const atLooks = state({ ...planned, phase: 'looks' });
      expect(generateSheetRows(atLooks)[1]).toMatchObject({
        value: '0 of 3 stills',
        barPercent: 0,
      });
      expect(generateSheetRows(atLooks, { stopped: true })[1]).toEqual({
        key: 'Looks',
        value: '—',
        tone: 'muted',
      });
      const atKeyframes = state({ ...planned, phase: 'keyframes' });
      expect(generateSheetRows(atKeyframes)[2]).toMatchObject({ value: '0 of 7', barPercent: 0 });
      expect(generateSheetRows(atKeyframes, { stopped: true })[2]?.value).toBe('—');
    });

    it('does not say "kept" for a stopped run that made no clip', () => {
      const none = state({ counts: { ...state().counts, clips: { done: 0, total: 6 } } });
      expect(generateSheetRows(none, { stopped: true })[3]?.value).toBe('0 of 6');
    });

    it('keeps what a stopped run made, with grey bars', () => {
      const rows = generateSheetRows(state(), { voiceSec: 31, stopped: true });
      expect(rows[3]).toEqual({
        key: 'Clips',
        value: '4 of 6 · kept',
        tone: 'normal',
        barPercent: 67,
        barTone: 'muted',
      });
      expect(rows[4]).toMatchObject({ value: '$1.65 of $3', barTone: 'muted' });
    });

    it('turns the spend red when one take of every clip is over the budget', () => {
      const stopped = state({
        phase: 'voice',
        counts: {
          voice: { done: 7, total: 7 },
          looks: { done: 0, total: 0 },
          keyframes: { done: 0, total: 0 },
          clips: { done: 0, total: 6 },
          belowBar: 0,
        },
        spendUsd: 0,
      });
      const rows = generateSheetRows(stopped, { voiceSec: 31, overBudgetNeedUsd: 4.1 });
      expect(rows.map((row) => row.value)).toEqual([
        '7 lines · 0:31',
        '—',
        '—',
        '0 of 6',
        '$0 of $3',
      ]);
      expect(rows[4]).toEqual({
        key: 'Spend',
        value: '$0 of $3',
        tone: 'error',
        sub: 'The estimate for one take of every clip is $4.10.',
      });
    });

    it('names the clip below the bar when the budget ran out, and says nothing is left', () => {
      const ranOut = state({
        phase: 'done',
        spendUsd: 3,
        counts: { ...state().counts, clips: { done: 6, total: 6 }, belowBar: 1 },
      });
      const rows = generateSheetRows(ranOut, {
        voiceSec: 31,
        belowBarNote: 'Clip B: the pour and the tilt up, 0:03 to 0:08.',
      });
      expect(rows[3]).toEqual({
        key: 'Clips',
        value: '6 of 6 · 1 below the bar',
        tone: 'warn',
        sub: 'Clip B: the pour and the tilt up, 0:03 to 0:08.',
      });
      expect(rows[4]).toEqual({
        key: 'Spend',
        value: '$3.00 of $3',
        tone: 'normal',
        barPercent: 100,
        barTone: 'warn',
        sub: 'Nothing is left for retakes. A note like “budget $5” makes another take possible.',
      });
    });

    it('says what is left for retakes once all the clips are made', () => {
      const done = state({
        phase: 'done',
        spendUsd: 2.33,
        counts: { ...state().counts, clips: { done: 6, total: 6 } },
      });
      const rows = generateSheetRows(done, { voiceSec: 31 });
      expect(rows[3]).toEqual({ key: 'Clips', value: '6 of 6', tone: 'normal' });
      expect(rows[4]).toEqual({
        key: 'Spend',
        value: '$2.33 of $3',
        tone: 'normal',
        barPercent: 78,
        barTone: 'normal',
        sub: '$0.67 left for retakes and review rounds.',
      });
    });

    it('says one line, not 1 lines', () => {
      const one = state({
        phase: 'clips',
        counts: { ...state().counts, voice: { done: 1, total: 1 } },
      });
      expect(generateSheetRows(one)[0]?.value).toBe('1 line');
    });
  });
});

describe('the error codes and their words', () => {
  it('are the six of the contract', () => {
    expect([...GENERATE_ERROR_CODES]).toEqual([
      'balance_empty',
      'key_rejected',
      'over_budget',
      'bad_request',
      'unavailable',
      'generation_failed',
    ]);
    for (const code of GENERATE_ERROR_CODES) {
      expect(generateErrorCodeSchema.safeParse(code).success).toBe(true);
    }
    expect([...GENERATE_SERVICES]).toEqual(['higgsfield', 'elevenlabs']);
  });

  it('say the Higgsfield balance, key and budget exactly as plan.md section 2.7 does', () => {
    expect(generateErrorMessage('balance_empty')).toBe(
      'Higgsfield balance is empty: add funds in the Higgsfield console, then Retry (clips already made are kept).',
    );
    expect(generateErrorMessage('key_rejected')).toBe(
      'Higgsfield key not accepted: check HIGGSFIELD_API_KEY in .env',
    );
    expect(generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 })).toBe(
      "This video needs about $4.10, over the budget of $3: add a note like 'budget $5' and Retry.",
    );
    expect(generateErrorMessage('over_budget', { needUsd: 6, budgetUsd: 5.5 })).toBe(
      "This video needs about $6.00, over the budget of $5.50: add a note like 'budget $5' and Retry.",
    );
  });

  it('say the same things for ElevenLabs where they apply', () => {
    const service = { service: 'elevenlabs' } as const;
    expect(generateErrorMessage('key_rejected', service)).toBe(
      'ElevenLabs key not accepted: check ELEVENLABS_API_KEY in ~/Developer/video-use/.env',
    );
    expect(generateErrorMessage('balance_empty', service)).toBe(
      'ElevenLabs credits are used up: add credits in ElevenLabs, then Retry (what was already made is kept).',
    );
    expect(generateErrorMessage('unavailable', service)).toContain('ElevenLabs is not answering');
  });

  it('say the other three plainly, and never mention a key’s value', () => {
    expect(generateErrorMessage('bad_request')).toBe(
      'Higgsfield did not accept a request: the details are in the job’s log. Retry once; if it stops again, the engine needs a fix.',
    );
    expect(generateErrorMessage('unavailable')).toBe(
      'Higgsfield is not answering right now: wait a few minutes, then Retry (what was already made is kept).',
    );
    expect(generateErrorMessage('generation_failed')).toBe(
      'Higgsfield could not make a shot, even after retakes: Retry, or say in a note what to change.',
    );
    for (const code of GENERATE_ERROR_CODES) {
      for (const service of GENERATE_SERVICES) {
        const text = [
          generateErrorMessage(code, { service, needUsd: 4.1, budgetUsd: 3 }),
          generateErrorTitle(code, { service }),
          generateErrorLine(code, { service, needUsd: 4.1, budgetUsd: 3 }),
          generateErrorHelp(code, { service }),
        ].join('\n');
        expect(text).not.toMatch(/sk_|:[0-9a-f]{20}/);
      }
    }
  });

  it('give the sheet’s error box its title, code line and help (board GNSheet)', () => {
    expect(generateErrorTitle('balance_empty')).toBe('Higgsfield balance is empty');
    expect(generateErrorLine('balance_empty')).toBe('HTTP 403 · Insufficient balance');
    expect(generateErrorHelp('balance_empty')).toBe(
      'Add funds in the Higgsfield console (console.higgsfield.ai), then press Retry. The request that stopped wasn’t charged.',
    );
    const over = { needUsd: 4.1, budgetUsd: 3 };
    expect(generateErrorTitle('over_budget')).toBe('Over the budget');
    expect(generateErrorLine('over_budget', over)).toBe('Needs about $4.10 · budget $3');
    expect(generateErrorHelp('over_budget')).toBe(
      'Add a note like “budget $5” in Note for the editor, then press Retry. The voice is kept.',
    );
    expect(generateErrorTitle('key_rejected')).toBe('Higgsfield key not accepted');
    expect(generateErrorLine('key_rejected')).toBe('HTTP 401 · key not accepted');
    expect(generateErrorHelp('key_rejected')).toBe(
      'Check HIGGSFIELD_API_KEY in .env, then press Retry.',
    );
  });

  it('give the Jobs row its detail (boards GNStates and GNPhone)', () => {
    expect(generateRowError('balance_empty')).toBe('Higgsfield balance is empty');
    expect(generateRowError('over_budget', { needUsd: 4.1, budgetUsd: 3 })).toBe(
      'Needs about $4.10, the budget is $3',
    );
    expect(generateRowError('key_rejected')).toBe('Higgsfield key not accepted');
  });

  it('write the sentence of a stopped job (board GNSheet)', () => {
    expect(generateStoppedText('balance_empty', { at: '14:21', clipsKept: 4, clipsTotal: 6 })).toBe(
      'Stopped at 14:21: the Higgsfield balance is empty. The 4 clips already made are kept, so Retry only makes the other 2.',
    );
    expect(generateStoppedText('over_budget', { needUsd: 4.1, budgetUsd: 3 })).toBe(
      'Stopped before any clip: one take of every clip needs about $4.10, over the budget of $3, even with the cheaper models.',
    );
    expect(generateStoppedText('key_rejected')).toBe(
      'Stopped: the Higgsfield key was not accepted.',
    );
    expect(generateStopReason('unavailable', { service: 'elevenlabs' })).toBe(
      'ElevenLabs is not answering',
    );
  });

  it('map to the exit codes: 2 refused, 3 down, 1 failed', () => {
    expect(GENERATE_EXIT_CODES).toEqual({ ok: 0, failed: 1, refused: 2, down: 3 });
    expect(generateExitCode('balance_empty')).toBe(2);
    expect(generateExitCode('key_rejected')).toBe(2);
    expect(generateExitCode('over_budget')).toBe(2);
    expect(generateExitCode('unavailable')).toBe(3);
    expect(generateExitCode('bad_request')).toBe(1);
    expect(generateExitCode('generation_failed')).toBe(1);
  });
});

describe('ladderStep (plan.md section 2.3)', () => {
  it('lists the four steps in the plan’s order', () => {
    expect([...LADDER_STEPS]).toEqual([
      'cheaper_model',
      'trim_clips',
      'still_instead_of_clip',
      'no_retakes',
    ]);
  });

  it('lets a pass that fits go, with what is left', () => {
    expect(ladderStep(2.33, 3)).toEqual({ kind: 'fits', leftUsd: 0.67 });
    expect(ladderStep(0, 3)).toEqual({ kind: 'fits', leftUsd: 3 });
  });

  it('lets a pass that costs exactly the budget go, to the cent', () => {
    expect(ladderStep(3, 3)).toEqual({ kind: 'fits', leftUsd: 0 });
    expect(ladderStep(3.004, 3)).toEqual({ kind: 'fits', leftUsd: 0 });
    expect(ladderStep(0.1 + 0.2, 0.3)).toEqual({ kind: 'fits', leftUsd: 0 });
  });

  it('asks for the cheaper model first when the pass is over', () => {
    expect(ladderStep(4.1, 3)).toEqual({ kind: 'apply', step: 'cheaper_model' });
  });

  it('goes down the ladder one step at a time, and ends blocked with the numbers', () => {
    const applied: Parameters<typeof ladderStep>[2] & unknown[] = [];
    const steps: string[] = [];
    for (;;) {
      const result = ladderStep(4.1, 3, applied);
      if (result.kind === 'blocked') {
        expect(result).toEqual({ kind: 'blocked', needUsd: 4.1, budgetUsd: 3 });
        break;
      }
      expect(result.kind).toBe('apply');
      if (result.kind === 'apply') {
        steps.push(result.step);
        applied.push(result.step);
      }
    }
    expect(steps).toEqual([...LADDER_STEPS]);
  });

  it('stops going down as soon as the new estimate fits', () => {
    expect(ladderStep(3.05, 3, ['cheaper_model'])).toEqual({ kind: 'apply', step: 'trim_clips' });
    expect(ladderStep(2.71, 3, ['cheaper_model', 'trim_clips', 'still_instead_of_clip'])).toEqual({
      kind: 'fits',
      leftUsd: 0.29,
    });
  });

  it('takes the next step that has not been applied, whatever order they were applied in', () => {
    expect(ladderStep(4, 3, ['trim_clips'])).toEqual({ kind: 'apply', step: 'cheaper_model' });
    expect(ladderStep(4, 3, ['cheaper_model', 'still_instead_of_clip'])).toEqual({
      kind: 'apply',
      step: 'trim_clips',
    });
  });

  it('is blocked at once with every step applied, and rounds the need to the cent', () => {
    expect(ladderStep(4.1049, 3, [...LADDER_STEPS])).toEqual({
      kind: 'blocked',
      needUsd: 4.1,
      budgetUsd: 3,
    });
  });
});

describe('the scripts’ lines', () => {
  it('lists the commands of both scripts', () => {
    expect([...MAKE_VOICE_COMMANDS]).toEqual(['line', 'check', 'assemble', 'sfx']);
    expect([...MAKE_SHOTS_COMMANDS]).toEqual([
      'estimate',
      'upload',
      'still',
      'clip',
      'reframe',
      'book',
      'save',
      'void',
      'put',
    ]);
  });

  it('accepts what make-shots.mjs prints for the plan-credit commands (U27)', () => {
    const lines = [
      {
        ok: true,
        command: 'book',
        kind: 'clip',
        id: 'A',
        take: 1,
        model: 'kling3_0',
        credits: 22.5,
        usd: 1.26,
        reused: false,
        spentUsd: 1.26,
        budgetUsd: 5,
        leftUsd: 3.74,
      },
      {
        ok: true,
        command: 'save',
        kind: 'clip',
        id: 'A',
        take: 1,
        file: 'clips/A/take-1.mp4',
        model: 'kling3_0',
        credits: 22.5,
        usd: 1.26,
        seconds: 15,
        requestId: null,
        fps: 24,
        durationSec: 15.04,
        width: 720,
        height: 1280,
        reused: false,
        spentUsd: 1.26,
      },
      {
        ok: true,
        command: 'void',
        kind: 'clip',
        id: 'A',
        take: 1,
        usd: 1.26,
        refunded: true,
        spentUsd: 0,
      },
      { ok: true, command: 'put', file: 'client/logo.png', bytes: 4096, contentType: 'image/png' },
    ];
    for (const line of lines) {
      const parsed = makeShotsLineSchema.safeParse(line);
      expect(parsed.success, JSON.stringify(line)).toBe(true);
      expect(parsed.data).toEqual(line);
    }
  });

  it('accepts what make-voice.mjs prints for each command', () => {
    for (const line of [
      {
        ok: true,
        command: 'line',
        id: 'L1',
        take: 1,
        file: 'voice/L1-take1.mp3',
        durationSec: 3.2,
        chars: 58,
      },
      {
        ok: true,
        command: 'assemble',
        file: 'voice.mp3',
        wordsFile: 'voice-words.json',
        durationSec: 31.1,
        lines: [{ id: 'L1', take: 1, startSec: 0, endSec: 3.2 }],
      },
      { ok: true, command: 'sfx', name: 'alert', file: 'sfx/alert.mp3', durationSec: 1 },
      // The real script (GN2) says more: the length in ms, the model and voice, the check's result.
      {
        ok: true,
        command: 'line',
        id: 'L3',
        take: 2,
        file: 'voice/L3-take2.mp3',
        ms: 3180,
        durationSec: 3.18,
        characters: 58,
        chars: 58,
        model: 'eleven_v3',
        voice: DEFAULT_GENERATE_VOICE_ID,
        directionApplied: true,
      },
      {
        ok: true,
        command: 'check',
        id: 'L3',
        take: 2,
        file: 'voice/L3-take2.mp3',
        match: false,
        missing: ['But'],
        extra: [],
        heard: 'it gets worse',
        words: [{ text: 'it', startMs: 0, endMs: 120 }],
      },
      {
        ok: true,
        command: 'assemble',
        file: 'voice.mp3',
        wordsFile: 'voice-words.json',
        ms: 31100,
        durationSec: 31.1,
        lufs: -16,
        lines: [
          { id: 'L1', take: 2, startMs: 0, endMs: 3200, startSec: 0, endSec: 3.2, match: true },
        ],
      },
      {
        ok: true,
        command: 'sfx',
        id: 'alert',
        name: 'alert',
        file: 'sfx/alert.mp3',
        ms: 1020,
        durationSec: 1.02,
        characters: null,
      },
      {
        ok: false,
        code: 'key_rejected',
        message: generateErrorMessage('key_rejected', { service: 'elevenlabs' }),
      },
    ]) {
      expect(makeVoiceLineSchema.safeParse(line).success, JSON.stringify(line)).toBe(true);
    }
  });

  it('keeps the lead that assemble --lead says, as whole milliseconds', () => {
    const line = {
      ok: true,
      command: 'assemble',
      file: 'voice.mp3',
      wordsFile: 'voice-words.json',
      ms: 5200,
      leadMs: 2800,
      durationSec: 5.2,
      lufs: -16,
      lines: [
        { id: 'L1', take: 1, startMs: 2800, endMs: 4200, startSec: 2.8, endSec: 4.2, match: true },
      ],
    };
    expect(makeVoiceLineSchema.parse(line)).toMatchObject({ command: 'assemble', leadMs: 2800 });
    expect(makeVoiceLineSchema.safeParse({ ...line, leadMs: -1 }).success).toBe(false);
    expect(makeVoiceLineSchema.safeParse({ ...line, leadMs: 2.5 }).success).toBe(false);
    // An answer with no opening has no leadMs at all.
    const { leadMs: _leadMs, ...plain } = line;
    expect(makeVoiceLineSchema.parse(plain)).not.toHaveProperty('leadMs');
  });

  it('accepts what make-shots.mjs prints for each command, and the budget refusal with its numbers', () => {
    for (const line of [
      { ok: true, command: 'estimate', usd: 0.18 },
      {
        ok: true,
        command: 'still',
        id: 'homeowner',
        file: 'looks/homeowner.png',
        usd: 0.004,
        requestId: 'r1',
      },
      {
        ok: true,
        command: 'clip',
        id: 'A',
        take: 1,
        file: 'clips/A/take-1.mp4',
        seconds: 5,
        usd: 0.18,
        requestId: null,
      },
      {
        ok: true,
        command: 'reframe',
        id: 'A',
        take: 1,
        file: 'clips/A/take-1-1x1.mp4',
        usd: 0.18,
        requestId: 'r2',
      },
      {
        ok: false,
        code: 'over_budget',
        message: generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }),
        needUsd: 4.1,
        budgetUsd: 3,
      },
    ]) {
      expect(makeShotsLineSchema.safeParse(line).success, JSON.stringify(line)).toBe(true);
    }
  });

  it('rejects an unknown command, an unknown code and a line with no words', () => {
    expect(makeVoiceLineSchema.safeParse({ ok: true, command: 'clip' }).success).toBe(false);
    expect(makeShotsLineSchema.safeParse({ ok: true, command: 'line', id: 'L1' }).success).toBe(
      false,
    );
    expect(makeShotsLineSchema.safeParse({ ok: false, code: 'weird', message: 'x' }).success).toBe(
      false,
    );
    expect(
      makeShotsLineSchema.safeParse({ ok: false, code: 'unavailable', message: '' }).success,
    ).toBe(false);
  });

  it('finds the answer in the last valid line, and gives null for none', () => {
    const answer = { ok: true, command: 'estimate', usd: 0.18 };
    const stdout = `warming up\n{"not":"an answer"}\n${JSON.stringify(answer)}\n`;
    expect(parseGenerateScriptLine(makeShotsLineSchema, stdout)).toEqual(answer);
    expect(parseGenerateScriptLine(makeShotsLineSchema, 'crashed\n')).toBeNull();
    expect(parseGenerateScriptLine(makeShotsLineSchema, '{broken json\n')).toBeNull();
    expect(parseGenerateScriptLine(makeShotsLineSchema, '')).toBeNull();
  });
});

describe('History (board GNSheet)', () => {
  const T = '2026-10-25T14:03:00.000Z';
  const event = (extra: Record<string, unknown>) =>
    generateHistoryEventSchema.parse({ at: T, ...extra }) as GenerateHistoryEvent;

  it('writes every line exactly as the board does', () => {
    const lines = [
      [
        { kind: 'decided', formats: ['9:16', '1:1'] },
        'The brief found no footage and a script, so the video is generated. 9:16 and 1:1 asked for.',
      ],
      [
        {
          kind: 'unpacked',
          count: 7,
          what: 'logo, equipment, ladder, an older ad, a skylight clip',
        },
        'Unpacked the zip: 7 references (logo, equipment, ladder, an older ad, a skylight clip)',
      ],
      [
        { kind: 'voice', lines: 7, seconds: 31 },
        'Voice made: 7 lines, 0:31 of speech. Every word checked against the script',
      ],
      [
        {
          kind: 'looks',
          names: ['the homeowner', 'the technician with the logo', 'the hero skylight'],
        },
        'Looks: the homeowner, the technician with the logo, the hero skylight',
      ],
      [{ kind: 'keyframes', clips: 6 }, 'Keyframes for 6 clips'],
      [
        { kind: 'clip', id: 'A', shows: 'the hero skylight', take: 1 },
        'Clip A, the hero skylight: take 1 kept',
      ],
      [
        { kind: 'clip', id: 'D', shows: 'the squeegee press', take: 1 },
        'Clip D, the squeegee press: take 1 kept',
      ],
      [{ kind: 'clips_done', count: 6 }, 'All 6 clips kept'],
      [{ kind: 'budget', id: 'B' }, 'Budget reached: clip B kept its best take, below the bar'],
      [{ kind: 'stopped', code: 'balance_empty' }, 'Stopped: the Higgsfield balance is empty'],
      [
        { kind: 'stopped', code: 'over_budget', needUsd: 4.1, budgetUsd: 3 },
        'Stopped: needs about $4.10, the budget is $3',
      ],
    ] as const;
    for (const [fields, text] of lines) {
      expect(generateHistoryText(event(fields))).toBe(text);
    }
  });

  it('says a single format without the asked-for part', () => {
    expect(generateHistoryText(event({ kind: 'decided', formats: null }))).toBe(
      'The brief found no footage and a script, so the video is generated.',
    );
    expect(generateHistoryText(event({ kind: 'decided', formats: ['9:16'] }))).toBe(
      'The brief found no footage and a script, so the video is generated.',
    );
    expect(
      generateHistoryText(event({ kind: 'decided', formats: ['9:16', '1:1', '4:5'] })),
    ).toContain('9:16, 1:1 and 4:5 asked for.');
    expect(generateHistoryText(event({ kind: 'unpacked', count: 2, what: '' }))).toBe(
      'Unpacked the zip: 2 references',
    );
    expect(generateHistoryText(event({ kind: 'voice', lines: 1, seconds: 3 }))).toContain(
      '1 line,',
    );
  });

  it('colours a stop red and the budget running out amber', () => {
    expect(generateHistoryTone(event({ kind: 'stopped', code: 'unavailable' }))).toBe('failure');
    expect(generateHistoryTone(event({ kind: 'budget', id: 'B' }))).toBe('warn');
    expect(generateHistoryTone(event({ kind: 'keyframes', clips: 6 }))).toBe('normal');
  });

  it('rejects an event with an unknown kind, a bad clip id or a time that is not ISO', () => {
    expect(generateHistoryEventSchema.safeParse({ at: T, kind: 'dance' }).success).toBe(false);
    expect(
      generateHistoryEventSchema.safeParse({ at: T, kind: 'clip', id: 'a/b', shows: 'x', take: 1 })
        .success,
    ).toBe(false);
    expect(
      generateHistoryEventSchema.safeParse({ at: 'noon', kind: 'keyframes', clips: 1 }).success,
    ).toBe(false);
  });

  it('names a canvas by its ratio', () => {
    expect(formatRatioText('1080x1920')).toBe('9:16');
    expect(formatRatioText('1080x1080')).toBe('1:1');
    expect(formatRatioText('1920x1080')).toBe('16:9');
    expect(formatRatioText('1080x1350')).toBe('4:5');
    expect(formatRatioText('640x480')).toBe('640x480');
  });
});

describe('the History response (GN5)', () => {
  const T = '2026-10-25T14:03:00.000Z';

  it('is the events of the stage, oldest first', () => {
    const events = [
      { at: T, kind: 'decided', formats: null },
      { at: T, kind: 'keyframes', clips: 6 },
    ];
    expect(generateHistoryResponseSchema.parse({ events }).events).toHaveLength(2);
    expect(generateHistoryResponseSchema.safeParse({ events: [{ kind: 'dance' }] }).success).toBe(
      false,
    );
    expect(generateHistoryResponseSchema.parse({ events: [] })).toEqual({ events: [] });
  });
});

describe('parseGenerateErrorMessage', () => {
  it('reads back every sentence the engine stores, for each service', () => {
    for (const service of GENERATE_SERVICES) {
      for (const code of GENERATE_ERROR_CODES) {
        if (code === 'over_budget') continue;
        expect(parseGenerateErrorMessage(generateErrorMessage(code, { service }))).toEqual({
          code,
          service,
        });
      }
    }
  });

  it('reads the dollars of the budget stop', () => {
    expect(
      parseGenerateErrorMessage(
        generateErrorMessage('over_budget', { needUsd: 4.1, budgetUsd: 3 }),
      ),
    ).toEqual({ code: 'over_budget', service: 'higgsfield', needUsd: 4.1, budgetUsd: 3 });
    expect(
      parseGenerateErrorMessage(
        generateErrorMessage('over_budget', { needUsd: 12, budgetUsd: 5.5 }),
      ),
    ).toMatchObject({ needUsd: 12, budgetUsd: 5.5 });
  });

  it('answers null for any other sentence, and for no error', () => {
    expect(parseGenerateErrorMessage(null)).toBeNull();
    expect(parseGenerateErrorMessage('')).toBeNull();
    expect(parseGenerateErrorMessage('Generate stopped: ffmpeg is not installed.')).toBeNull();
    expect(parseGenerateErrorMessage('Timed out after 90 min')).toBeNull();
  });
});

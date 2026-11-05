import { describe, expect, it } from 'vitest';
import {
  buildSeriesLearnPrompt,
  roundSections,
  seriesDoneFiles,
  seriesNotesText,
  seriesStep5,
  seriesStep5Kit,
} from './series-prompt.js';

// The series prompts of the Series plan §3, rendered from apps/server/prompts.

const SERIES_DIR = '/Inbox/עו״ד דוד לוי/_Series/מיתוס או אמת';
const STYLE_DIR = '/Inbox/עו״ד דוד לוי/_Style';

const BASE = {
  client: 'עו״ד דוד לוי',
  series: 'מיתוס או אמת',
  job: 'מיתוס או אמת 5',
  date: '2026-10-22',
  seriesDir: SERIES_DIR,
  styleDir: STYLE_DIR,
};

const SHAPE = `# Series: מיתוס או אמת
<the line saying where the format came from>. Anything not listed here comes from the client style.
## Flow
- <time> · <beat>: what is on screen and what is heard
## Same in every episode
- <graphic or sound>: font, weight, size, colour, position and timing, exactly
- <library graphic>: the library’s <name> (edit/graphics/<id>/), when it plays; if it is gone or off for edits (no such folder in edit/graphics/), build that moment in the look of the other graphics here
## New in each episode
- <part>: where it comes from (the brief, the footage, the speech)
## Kit
- The composition of <episode>, with <the parts that change> left open
## Notes
- <a rule added from a review note>

Leave out any section or line you have nothing for. Short plain lines in English; quotes and names word for word; file names exactly as they are.`;

/** The paragraph on graphics of the Graphics library (C30), word for word. */
const LIBRARY_GRAPHICS =
  'Library graphics. A graphic mounted in index.html from compositions/lib-<id>.html (<id> is 12 hex characters) is from the owner’s Graphics library, not the format’s own. Its files are not in the kit, and each episode takes the library’s current version from its own edit/graphics/<id>/. Never describe its look, whatever the frames show. Under “Same in every episode” write one line for it, in the library graphic form of the shape: its name, its folder and when it plays (the mount’s data-start). Its text fields are new in each episode, so list them under “New in each episode” with where each comes from. Its name is the name in the episode’s edit/graphics/<id>/about.json, or the one in the Graphics library section of edit/brief.md; if neither has it, write <id>.';

describe('the series-learn prompt', () => {
  it('starts a series from an episode and takes what only it does out of the style.md', async () => {
    const prompt = await buildSeriesLearnPrompt({
      ...BASE,
      writesStyle: true,
      styleKit: {
        kind: 'restore',
        names: ['composition'],
        job: 'שאלות נפוצות 5',
        section: '- composition: the WhatsApp question card (wa-message.html)\n- Captions: rising',
      },
    });

    expect(
      prompt,
    ).toBe(`Write the format of a series from this finished episode, so the next episodes are rebuilt from it. Don’t edit any video.

Client "עו״ד דוד לוי", series "מיתוס או אמת", episode "מיתוס או אמת 5". The current working directory is the episode’s folder. Every file in it is read-only. Write only ${SERIES_DIR}/series.md.new and ${STYLE_DIR}/style.md.new.

Bash here runs only these commands, one per call, with no pipes, \`;\`, \`&&\`, loops, \`$( )\` or redirects: \`ls -la "<folder>"\`, \`ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4\` and \`ffmpeg -v error -y -ss <seconds> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg\` (one frame per call). Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms. Read files with the Read, Glob and Grep tools.

1. Read edit/project.md (the editor’s plan) and edit/brief.md if it exists.
2. Read the composition copied into ${SERIES_DIR}/kit/: index.html and every compositions/*.html. Note each graphic’s font, weight, size, colour, position and timing, and every music and sound cue. A graphic mounted from compositions/lib-<id>.html is not in the kit (see Library graphics below).
3. Look at four frames of edit/final.mp4 (ffmpeg -ss <10%, 30%, 60% and 90% of its duration> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg) and check them against what you read.
4. Write ${SERIES_DIR}/series.md.new in this shape, with “Format from מיתוס או אמת 5 (2026-10-22).” as the line under the title:

${SHAPE}
5. Read ${STYLE_DIR}/style.md, the client’s style. It may hold things only this series does. Write ${STYLE_DIR}/style.md.new: the same style without them, since they are in series.md now. Keep what every video of this client shares (colours, fonts, captions, logo, Do and Don’t that are not about this show). Keep the line under the title and add “Moved what only מיתוס או אמת does into the series (2026-10-22).” The graphics in ${STYLE_DIR}/kit/ go to the series, and the client’s kit from before them comes back in their place: kit/composition, from שאלות נפוצות 5. Write ## Kit for that kit, as the style it came with did:
## Kit
- composition: the WhatsApp question card (wa-message.html)
- Captions: rising

Only what the episode and its files show. Under “New in each episode” list every part of the video that must change from one episode to the next (on-screen text from the brief, the footage, captions from the speech) and say where each one comes from.

${LIBRARY_GRAPHICS}

This run is unattended: never ask questions. You are done when ${SERIES_DIR}/series.md.new and ${STYLE_DIR}/style.md.new exist.
`);
  });

  it('asks for series.md.new alone when the style is left as it is (replace, or no style.md)', async () => {
    const prompt = await buildSeriesLearnPrompt({
      ...BASE,
      job: 'מיתוס או אמת 7',
      writesStyle: false,
    });

    expect(prompt).toContain(`Write only ${SERIES_DIR}/series.md.new.\n`);
    expect(prompt).toContain('“Format from מיתוס או אמת 7 (2026-10-22).”');
    expect(prompt).not.toContain('style.md');
    expect(prompt).not.toContain('5. Read');
    // The empty step leaves no gap of its own.
    expect(prompt).toContain(
      'file names exactly as they are.\n\nOnly what the episode and its files show.',
    );
    expect(prompt).not.toMatch(/\n{3,}/);
    expect(prompt.endsWith(`You are done when ${SERIES_DIR}/series.md.new exist.\n`)).toBe(true);
  });

  // C30: a graphic of the Graphics library is the library's, so the series names it and never
  // keeps or describes it (the kit leaves it out: style-kit.ts).
  it('treats a mount of compositions/lib-<id>.html as a library graphic: named and placed, never described or kept', async () => {
    for (const writesStyle of [true, false]) {
      const prompt = await buildSeriesLearnPrompt({ ...BASE, writesStyle });

      const paragraph =
        prompt.split('\n').find((line) => line.startsWith('Library graphics. ')) ?? '';
      expect(paragraph, `writesStyle ${writesStyle}`).toBe(LIBRARY_GRAPHICS);
      expect(paragraph).toContain('Its files are not in the kit');
      expect(paragraph).toContain('Never describe its look');
      expect(paragraph).toContain('edit/graphics/<id>/about.json');
      expect(paragraph).toContain('if neither has it, write <id>');
      // Step 2 points at it.
      expect(prompt).toContain('is not in the kit (see Library graphics below).');
      // The shape gives the line a form, and what to do when the library no longer has the graphic.
      expect(prompt).toContain(
        '- <library graphic>: the library’s <name> (edit/graphics/<id>/), when it plays; if it is gone or off for edits (no such folder in edit/graphics/), build that moment in the look of the other graphics here',
      );
    }
  });

  it('keeps names on one line and never reads a {{ in them as a variable', async () => {
    const prompt = await buildSeriesLearnPrompt({
      ...BASE,
      series: 'Weekly {{date}}',
      job: 'Weekly\n6',
      writesStyle: false,
    });

    expect(prompt).toContain('series "Weekly date", episode "Weekly 6"');
  });
});

describe('seriesStep5 and seriesDoneFiles', () => {
  it('fill in the style folder, the series and the date', () => {
    const step5 = seriesStep5({ styleDir: '/s', series: 'Weekly', date: '2026-10-22' });
    expect(step5).toContain('Write /s/style.md.new: the same style without them');
    // Without a kit given, the style is left with none.
    expect(step5.endsWith(seriesStep5Kit('/s', { kind: 'none' }))).toBe(true);
    expect(seriesDoneFiles({ seriesDir: '/x', styleDir: '/s', writesStyle: true })).toBe(
      '/x/series.md.new and /s/style.md.new',
    );
    expect(seriesDoneFiles({ seriesDir: '/x', styleDir: '/s', writesStyle: false })).toBe(
      '/x/series.md.new',
    );
  });
});

describe('seriesStep5Kit (C23)', () => {
  it('keeps ## Kit when the kit stays the client’s', () => {
    expect(seriesStep5Kit('/s', { kind: 'keep' })).toBe(
      'Keep ## Kit as it is: the graphics in /s/kit/ stay the client’s.',
    );
  });

  it('removes ## Kit when the kit goes to the series and nothing comes back', () => {
    expect(seriesStep5Kit('/s', { kind: 'none' })).toBe(
      'Remove the ## Kit section: the graphics in /s/kit/ go to the series, and the client has no other kit.',
    );
  });

  it('names the kit that comes back, without its job or ## Kit lines when they are not known', () => {
    expect(
      seriesStep5Kit('/s', {
        kind: 'restore',
        names: ['slot_end', 'slot_title'],
        job: null,
        section: null,
      }),
    ).toBe(
      'The graphics in /s/kit/ go to the series, and the client’s kit from before them comes back in their place: kit/slot_end and kit/slot_title. Write ## Kit for that kit, naming it.',
    );
  });

  it('keeps the job’s name on one line', () => {
    expect(
      seriesStep5Kit('/s', {
        kind: 'restore',
        names: ['composition'],
        job: 'FAQ\n{{date}}',
        section: null,
      }),
    ).toContain('kit/composition, from FAQ date.');
  });
});

/** The episode's Round 1, as the revise run of the reported case wrote it (CVP-187), shortened. */
const ROUND_1 = `## Round 1

- 0:03.6 "stamp a beat later": I moved the red "מיתוס" stamp and its stamp sound together 0.5 s later. In scripts/build_preview.py STAMP_DELAY = 0.5, so the stamp clip now runs 4.107 → 5.007.`;

const NOTES_FILE = { name: 'Review notes – מיתוס או אמת 6 – round 1.md', size: 412 };

describe('the series-learn prompt of an approved episode with Series notes (C26)', () => {
  it('makes the episode the format and writes each note as a rule with its exact value', async () => {
    const prompt = await buildSeriesLearnPrompt({
      ...BASE,
      job: 'מיתוס או אמת 6',
      writesStyle: false,
      notes: { files: [NOTES_FILE], rounds: ROUND_1 },
    });

    expect(
      prompt,
    ).toBe(`Write the format of a series from this finished episode, so the next episodes are rebuilt from it. Don’t edit any video.

Client "עו״ד דוד לוי", series "מיתוס או אמת", episode "מיתוס או אמת 6". The current working directory is the episode’s folder. Every file in it is read-only. Write only ${SERIES_DIR}/series.md.new.

Bash here runs only these commands, one per call, with no pipes, \`;\`, \`&&\`, loops, \`$( )\` or redirects: \`ls -la "<folder>"\`, \`ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4\` and \`ffmpeg -v error -y -ss <seconds> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg\` (one frame per call). Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms. Read files with the Read, Glob and Grep tools.

1. Read edit/project.md (the editor’s plan) and edit/brief.md if it exists.
2. Read the composition copied into ${SERIES_DIR}/kit/: index.html and every compositions/*.html. Note each graphic’s font, weight, size, colour, position and timing, and every music and sound cue. A graphic mounted from compositions/lib-<id>.html is not in the kit (see Library graphics below).
3. Look at four frames of edit/final.mp4 (ffmpeg -ss <10%, 30%, 60% and 90% of its duration> -i edit/final.mp4 -frames:v 1 /tmp/series-<n>.jpg) and check them against what you read.
4. Write ${SERIES_DIR}/series.md.new in this shape, with “Format from מיתוס או אמת 6 (2026-10-22).” as the line under the title:

${SHAPE}

The owner approved this episode after review notes they marked for the series, so it is the series’ new format. The notes are in these files (read each one):
- ${SERIES_DIR}/Review notes – מיתוס או אמת 6 – round 1.md (412 bytes)

The episode’s revise runs applied them. What the editor did for each note is in these sections of edit/project.md:

${ROUND_1}

Under ## Notes write each note as a rule with the exact value this episode has, never the note’s own loose words: “Stamp: 0.5 s after the cut”, not “a beat later”. The lines above must say the same. Read ${SERIES_DIR}/series.md, the format this episode was rebuilt from, and keep the rules under its ## Notes unless a note changes them.

Only what the episode and its files show. Under “New in each episode” list every part of the video that must change from one episode to the next (on-screen text from the brief, the footage, captions from the speech) and say where each one comes from.

${LIBRARY_GRAPHICS}

This run is unattended: never ask questions. You are done when ${SERIES_DIR}/series.md.new exist.
`);
  });

  it('takes the values from the kit and the frames when project.md has no Round section', () => {
    const text = seriesNotesText({
      seriesDir: '/x',
      notes: {
        files: [NOTES_FILE, { name: 'Review notes – Ep 6 – round 2.md', size: 2_048 }],
        rounds: null,
      },
    });
    expect(text).toContain(
      '- /x/Review notes – מיתוס או אמת 6 – round 1.md (412 bytes)\n- /x/Review notes – Ep 6 – round 2.md (2 KB)',
    );
    expect(text).toContain(
      'The episode’s revise runs applied them. edit/project.md has no ## Round section saying what the editor did for them, so take each value from the composition in the kit and the frames.',
    );
    expect(text).toContain('Read /x/series.md, the format this episode was rebuilt from');
  });

  it('has no notes paragraph without notes', async () => {
    const prompt = await buildSeriesLearnPrompt({ ...BASE, writesStyle: false });
    expect(prompt).not.toContain('The owner approved');
    expect(prompt).not.toContain('## Round');
  });
});

describe('roundSections (C26)', () => {
  const PROJECT = `# Project: מיתוס או אמת 6

## Session 1 — 2026-10-22

- Cut the opening claim.

## Round 1

- 0:03.6 "stamp a beat later": STAMP_DELAY = 0.5.

### Checks

- lint 0 errors

## Round 2

- 0:12 "louder music": +2 dB.

## Session 2 — 2026-10-23

- Rendered again.
`;

  it('keeps every ## Round N section, up to the next heading of its level, with what is under it', () => {
    expect(roundSections(PROJECT)).toBe(`## Round 1

- 0:03.6 "stamp a beat later": STAMP_DELAY = 0.5.

### Checks

- lint 0 errors

## Round 2

- 0:12 "louder music": +2 dB.`);
  });

  it('is null for a project.md with no Round section, or an empty one', () => {
    expect(roundSections('# Project\n\n## Session 1\n\n- Cut.\n')).toBeNull();
    expect(roundSections('')).toBeNull();
  });

  it('reads Windows line ends, and a Round section that ends the file', () => {
    expect(roundSections('# P\r\n## Round 3\r\n- 0.5 s\r\n')).toBe('## Round 3\n- 0.5 s');
  });

  it('does not take a heading that only starts like one', () => {
    expect(roundSections('## Rounds of drinks\n- no\n## Round 1x\n- no')).toBeNull();
  });
});

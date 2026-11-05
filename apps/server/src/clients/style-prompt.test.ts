import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { styleLearnAllowedTools, styleReadAllowedTools } from './style-command.js';
import type { LearnMode, ReadMode, StyleFile } from './style-pass.js';
import {
  buildStyleLearnPrompt,
  buildStyleReadPrompt,
  formatStyleFiles,
  joinFileNames,
  kitNames,
  learnStep5,
  localDate,
  readModeText,
} from './style-prompt.js';

const FILES: StyleFile[] = [
  { name: 'logo.png', size: 12_345 },
  { name: 'notes.txt', size: 480 },
  { name: 'Brand book.pdf', size: 2_400_000 },
];

const prompt = (mode: 'create' | 'add' | 'replace', files = FILES) =>
  buildStyleReadPrompt({ client: 'Kova Coffee', mode, files, date: '2026-10-21' });

describe('the Read prompt (style-read.md with style-shape.md)', () => {
  it('is the plan’s text, word for word, with the client, the files and the create mode filled in', async () => {
    expect(
      await prompt('create'),
    ).toBe(`Write this client’s style. Don’t edit any video: the client’s next edits read what you write.

Client: "Kova Coffee". The current working directory is the client’s style folder. Every file in it is read-only. Write only style.md.new.

There is no style yet. Write it from the new files. The line under the title is “From your files: logo.png, notes.txt and Brand book.pdf.”

New files:
- logo.png (12 KB)
- notes.txt (480 bytes)
- Brand book.pdf (2.4 MB)

Bash here runs only these commands, one per call, with no pipes, \`;\`, \`&&\`, loops, \`$( )\` or redirects: \`ls -la\`, \`ffprobe -v error -show_entries format=duration -of csv=p=0 "<file>"\`, \`ffmpeg -v error -y -ss <seconds> -i "<file>" -frames:v 1 /tmp/ref-<n>.jpg\` (one frame per call) and \`textutil -convert txt -stdout "<file>"\`. Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms.

1. Read every new file:
- Text (.txt .md .rtf) as it is. PDFs with the Read tool. .docx and .doc with textutil -convert txt -stdout "<file>".
- Images: look at each one. A logo: note its file name and its colours. A screenshot or a frame from another video: read its look (colours, fonts, how titles and captions are styled).
- Fonts (.ttf .otf .woff .woff2): the family and weight from the file name, with the file name.
- Video: a reference clip. Don’t transcribe it. Get its duration with ffprobe, then make three frames spread across it (the ffmpeg form above, one call per frame, /tmp/ref-1.jpg, /tmp/ref-2.jpg, /tmp/ref-3.jpg; keep counting up if there is more than one clip), look at each with the Read tool and write what to match: title size and position, caption style, pacing, colour.
2. Write style.md.new in this shape:

# Style: Kova Coffee
<the line saying where the style came from>
## Look
- Colours: <name> <hex> (<role>), …
- Fonts: <family weight> for <use> (<file>), …
- Titles: …
- Lower thirds: …
- Captions: …
- Logo: <file>, <where it goes>
## Editing
- Format: <width×height>, <length>
- Pacing: …
- Graphics: minimal, light or rich, and which ones
- Music: …
- Sound effects: …
- Reels niche: <2 to 4 #hashtags, and @accounts if the files name them, that Reels like these are posted under; only if the files or the video show what they are about> (a guess; edit it if it is wrong)
## Do
- <one rule per line>
## Don’t
- <one rule per line>
## Kit
<which graphics are in kit/>
## Reference
- <file>: <what to match>

Leave out any section or line you have nothing for. Short plain lines in English; quotes and names word for word; file names exactly as they are.

Only what the files say or show. Don’t invent brand facts; a colour sampled from a logo is fine, written as “(from the logo)”.

This run is unattended: never ask questions. If a file can’t be read, leave it out and end style.md.new with “Couldn’t read: <file> (<why>)”. You are done when style.md.new exists.
`);
  });

  it('asks an add pass to merge, with the date, and a replace pass to start over without the kit', async () => {
    expect(await prompt('add')).toContain(
      '\n\nstyle.md is the current style. Merge the new files into it: keep everything they don’t contradict, and where they disagree, the new files win. Keep the line under the title and add “Plus logo.png, notes.txt and Brand book.pdf (2026-10-21).” Keep ## Kit as it is.\n\nNew files:\n',
    );
    expect(await prompt('replace')).toContain(
      '\n\nWrite a new style from the new files only and ignore style.md. The line under the title is “From your files: logo.png, notes.txt and Brand book.pdf.” Leave out ## Kit: the client’s old graphics go to history with the old style, so the new style has no kit.\n\nNew files:\n',
    );
  });

  // C17: Replace really replaces, so the old kit is moved away and the new style.md has no ## Kit.
  it('asks a replace pass to leave ## Kit out, and an add pass to keep it', async () => {
    const files = [{ name: 'notes.txt', size: 480 }];
    const modeText = (mode: ReadMode) => readModeText(mode, files, '2026-10-21');
    expect(modeText('replace')).not.toMatch(/Keep ## Kit/);
    expect(modeText('replace')).toContain('Leave out ## Kit');
    expect(modeText('add')).toContain('Keep ## Kit as it is.');
    // Create has no style.md to take a kit from, so it says nothing about one.
    expect(modeText('create')).not.toContain('## Kit');
  });

  it('keeps a client or file name that looks like a template variable as it is', async () => {
    const text = await buildStyleReadPrompt({
      client: 'Odd {{files}} Co',
      mode: 'create',
      files: [{ name: '{{modeText}}.png', size: 1 }],
      date: '2026-10-21',
    });
    expect(text).toContain('Client: "Odd files Co".');
    expect(text).toContain('- {{modeText}}.png (1 bytes)');
    expect(text).toContain('“From your files: {{modeText}}.png.”');
  });

  it('reads the templates on every run, from the folder it is given', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'studio-style-prompts-'));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    writeFileSync(
      join(dir, 'style-read.md'),
      '{{client}}|{{modeText}}|{{files}}|{{> style-shape}}\n',
    );
    writeFileSync(join(dir, 'style-shape.md'), '# Style: {{client}}\n\n');
    const text = await buildStyleReadPrompt(
      { client: 'Kova', mode: 'create', files: [FILES[1] as StyleFile], date: '2026-10-21' },
      dir,
    );
    expect(text).toBe(
      'Kova|There is no style yet. Write it from the new files. The line under the title is “From your files: notes.txt.”|- notes.txt (480 bytes)|# Style: Kova\n',
    );
  });
});

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

describe('the Learn prompt (style-learn.md with style-shape.md)', () => {
  const STYLE_DIR = '/Users/owner/Studio Inbox/עו״ד דוד לוי/_Style';
  const learnPrompt = (kit: readonly string[], mode: LearnMode = 'create') =>
    buildStyleLearnPrompt({
      client: 'עו״ד דוד לוי',
      mode,
      job: 'מיתוס או אמת 5',
      date: '2026-10-21',
      styleDir: STYLE_DIR,
      kit,
    });

  it('is the plan’s text, word for word, with the client, the job, the style folder and the kit filled in', async () => {
    expect(
      await learnPrompt(['slot_captions', 'slot_title']),
    ).toBe(`Write the style of this finished video, so the client’s next videos match it. Don’t edit any video.

Client "עו״ד דוד לוי", job "מיתוס או אמת 5". The current working directory is the job folder. Every file in it is read-only. Write only ${STYLE_DIR}/style.md.new.

Bash here runs only these commands, one per call, with no pipes, \`;\`, \`&&\`, loops, \`$( )\` or redirects: \`ls -la "<folder>"\`, \`ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4\` and \`ffmpeg -v error -y -ss <seconds> -i edit/final.mp4 -frames:v 1 /tmp/learn-<n>.jpg\` (one frame per call). Anything else is denied. A denial means the form was wrong, not that Bash is off: run it again in one of these forms. Read files with the Read, Glob and Grep tools.

1. Read edit/project.md (the editor’s plan and the look it chose), and edit/brief.md if it exists.
2. Read the graphics the edit used: every edit/animations/slot_*/index.html and compositions/*.html, except the library graphics (see Library graphics below). Note the fonts, weights, colours, sizes and positions.
3. Look at four frames of edit/final.mp4: get its duration with ffprobe, work out 10%, 30%, 60% and 90% of it, make one frame at each time (the ffmpeg form above, one call per frame, /tmp/learn-1.jpg to /tmp/learn-4.jpg), look at each with the Read tool and check the titles, lower thirds and captions against what you read.
4. These graphics were copied into ${STYLE_DIR}/kit/: slot_captions and slot_title. Name each one under ## Kit (title card, lower third, captions, end card, …). Library graphics are not in kit/, so none is named there.
5. Write ${STYLE_DIR}/style.md.new in this shape, with “Learned from מיתוס או אמת 5 (2026-10-21).” as the line under the title. Describe what this video does, as rules for the next one:

# Style: עו״ד דוד לוי
<the line saying where the style came from>
## Look
- Colours: <name> <hex> (<role>), …
- Fonts: <family weight> for <use> (<file>), …
- Titles: …
- Lower thirds: …
- Captions: …
- Logo: <file>, <where it goes>
## Editing
- Format: <width×height>, <length>
- Pacing: …
- Graphics: minimal, light or rich, and which ones
- Music: …
- Sound effects: …
- Reels niche: <2 to 4 #hashtags, and @accounts if the files name them, that Reels like these are posted under; only if the files or the video show what they are about> (a guess; edit it if it is wrong)
## Do
- <one rule per line>
## Don’t
- <one rule per line>
## Kit
<which graphics are in kit/>
## Reference
- <file>: <what to match>

Leave out any section or line you have nothing for. Short plain lines in English; quotes and names word for word; file names exactly as they are.

Only what the video and its files show. Do and Don’t come only from edit/brief.md, never from your own taste.

Library graphics. A compositions/lib-<id>.html (<id> is 12 hex characters, with a lib/<id>/ folder) is a graphic from the owner’s Graphics library, not the client’s own. It is not in kit/, and the next job takes its current version from the library. Never describe its look, whatever its files and the frames show. Write one line for it under ## Look, on the line of its kind (Lower thirds, Titles, …; add a line when the kind has none), naming it and when it played in this video, for example “Lower thirds: the library’s Name on a white pill, the first time a person is named”. Its name is the name in edit/graphics/<id>/about.json, or the one in the Graphics library section of edit/brief.md; if neither has it, write <id>. When it played comes from its mount in index.html (data-start) and what is said then.

This run is unattended: never ask questions. You are done when ${STYLE_DIR}/style.md.new exists.
`);
  });

  // C30: a graphic of the Graphics library is the library's, so the style names it and never keeps
  // or describes it (the kit leaves it out: style-kit.ts).
  it('treats a compositions/lib-<id>.html as a library graphic: named and placed, never described or kept', async () => {
    const text = await learnPrompt(['composition']);
    const paragraph = text.split('\n').find((line) => line.startsWith('Library graphics. ')) ?? '';

    expect(paragraph).toContain('compositions/lib-<id>.html');
    expect(paragraph).toContain(
      'a graphic from the owner’s Graphics library, not the client’s own',
    );
    expect(paragraph).toContain('It is not in kit/');
    expect(paragraph).toContain('Never describe its look');
    expect(paragraph).toContain(
      '“Lower thirds: the library’s Name on a white pill, the first time a person is named”',
    );
    // The name: about.json, else the id (the brief's library section stands in between).
    expect(paragraph).toContain('edit/graphics/<id>/about.json');
    expect(paragraph).toContain('if neither has it, write <id>');
    // The steps point at it: step 2 skips the library graphics, step 4 keeps them out of ## Kit.
    expect(text).toContain(
      'compositions/*.html, except the library graphics (see Library graphics below).',
    );
    expect(text).toContain('Library graphics are not in kit/, so none is named there.');
  });

  it('has the library graphics paragraph in every mode, whatever the kit', async () => {
    for (const mode of ['create', 'replace', 'merge'] as const) {
      for (const kit of [[], ['slot_title'], ['composition']]) {
        expect(await learnPrompt(kit, mode), `${mode} ${kit.join()}`).toContain(
          '\nLibrary graphics. A compositions/lib-<id>.html',
        );
      }
    }
  });

  it('says "none" when no graphics were copied', async () => {
    expect(await learnPrompt([])).toContain(`copied into ${STYLE_DIR}/kit/: none. Name each one`);
  });

  /** The prompt's step 5, alone on its line. */
  const step5 = (prompt: string) => prompt.split('\n').find((line) => line.startsWith('5. '));

  it('has the same step 5 for create and replace: the style is written from this video', async () => {
    const create = await learnPrompt(['slot_title'], 'create');
    expect(step5(create)).toBe(
      `5. Write ${STYLE_DIR}/style.md.new in this shape, with “Learned from מיתוס או אמת 5 (2026-10-21).” as the line under the title. Describe what this video does, as rules for the next one:`,
    );
    expect(await learnPrompt(['slot_title'], 'replace')).toBe(create);
  });

  it('merges this video’s look into the current style.md in merge mode, word for word', async () => {
    const create = await learnPrompt(['slot_title'], 'create');
    const merge = await learnPrompt(['slot_title'], 'merge');
    expect(step5(merge)).toBe(
      `5. Merge this video’s look into ${STYLE_DIR}/style.md, the client’s current style, and write the result to ${STYLE_DIR}/style.md.new in the same shape. Keep everything this video doesn’t contradict; where they disagree, this video wins, since it is the newest one the owner approved. Keep the line under the title and add “Plus מיתוס או אמת 5 (2026-10-21).” Keep Do, Don’t and Reference, adding only rules from this video’s edit/brief.md. Write ## Kit for the graphics now in kit/:`,
    );
    // Only step 5 differs.
    expect(merge.replace(step5(merge) ?? '', '')).toBe(create.replace(step5(create) ?? '', ''));
  });

  it('keeps a job name with a line break or braces on one line in step 5 too', async () => {
    const prompt = await buildStyleLearnPrompt({
      client: 'Kova Coffee',
      mode: 'merge',
      job: 'Spring\n{{menu}}',
      date: '2026-10-21',
      styleDir: '/inbox/Kova Coffee/_Style',
      kit: [],
    });
    expect(step5(prompt)).toContain('add “Plus Spring menu (2026-10-21).”');
    expect(learnStep5('merge', { job: 'Menu', date: '2026-10-21', styleDir: '/s' })).toMatch(
      /^5\. Merge this video’s look into \/s\/style\.md,/,
    );
  });

  it('names one, two or more slots the way the sentence reads', () => {
    expect(kitNames([])).toBe('none');
    expect(kitNames(['slot_title'])).toBe('slot_title');
    expect(kitNames(['slot_a', 'slot_b', 'slot_c'])).toBe('slot_a, slot_b and slot_c');
  });

  it('says where the composition of a composition-only edit comes from (C14)', async () => {
    const text = kitNames(['composition']);
    expect(text).toMatch(
      /^composition \(the edit’s one composition, copied from edit\/preview\/ or edit\/composition\//,
    );
    expect(await learnPrompt(['composition'])).toContain(
      `4. These graphics were copied into ${STYLE_DIR}/kit/: ${text}. Name each one under ## Kit`,
    );
  });
});

describe('the computed parts', () => {
  it('lists the files one per line, a name with a line break still on one line', () => {
    expect(formatStyleFiles([{ name: 'a\nb.txt', size: 1_000 }, FILES[0] as StyleFile])).toBe(
      '- a b.txt (1 KB)\n- logo.png (12 KB)',
    );
  });

  it('joins names the way the line under the title reads', () => {
    expect(joinFileNames([])).toBe('');
    expect(joinFileNames(FILES.slice(0, 1))).toBe('logo.png');
    expect(joinFileNames(FILES.slice(0, 2))).toBe('logo.png and notes.txt');
    expect(joinFileNames(FILES)).toBe('logo.png, notes.txt and Brand book.pdf');
  });

  it('has a text for every mode', () => {
    for (const mode of ['create', 'add', 'replace'] as const) {
      expect(readModeText(mode, FILES, '2026-10-21')).toContain('logo.png, notes.txt and Brand');
    }
  });

  it('dates in the local time zone, as YYYY-MM-DD', () => {
    expect(localDate(new Date(2026, 0, 5, 23, 59))).toBe('2026-01-05');
  });
});

describe('the Bash forms the prompts name (C16)', () => {
  const STYLE_DIR = '/inbox/Kova Coffee/_Style';
  const learnPrompt = () =>
    buildStyleLearnPrompt({
      client: 'Kova Coffee',
      mode: 'merge',
      job: 'Spring menu',
      date: '2026-10-21',
      styleDir: STYLE_DIR,
      kit: ['slot_title'],
    });

  /** Does any `Bash(...)` rule allow this command? `*` matches any run of characters. */
  const allowed = (rules: readonly string[], command: string): boolean =>
    rules
      .filter((rule) => rule.startsWith('Bash(') && rule.endsWith(')'))
      .map((rule) => rule.slice('Bash('.length, -1))
      .some((pattern) =>
        new RegExp(`^${pattern.split('*').map(escapeRegExp).join('.*')}$`).test(command),
      );
  const escapeRegExp = (text: string) => text.replace(/[.+?^${}()|[\]\\]/g, '\\$&');

  /** The commands a prompt puts in backticks, placeholders filled in: what the run would type. */
  const forms = (prompt: string): string[] =>
    [...prompt.matchAll(/`([^`]+)`/g)]
      .map((match) => match[1] as string)
      .filter((form) => /^(ls|ffprobe|ffmpeg|textutil) /.test(form))
      .map((form) =>
        form
          .replace('<seconds>', '12.5')
          .replace('<n>', '2')
          .replace('<file>', 'reference.mp4')
          .replace('<folder>', 'edit'),
      );

  it('are all ones the Read pass’s allowed tools take, each a single plain command', async () => {
    const found = forms(await prompt('add'));
    expect(found).toEqual([
      'ls -la',
      'ffprobe -v error -show_entries format=duration -of csv=p=0 "reference.mp4"',
      'ffmpeg -v error -y -ss 12.5 -i "reference.mp4" -frames:v 1 /tmp/ref-2.jpg',
      'textutil -convert txt -stdout "reference.mp4"',
    ]);
    for (const form of found) {
      expect(allowed(styleReadAllowedTools(), form), form).toBe(true);
      expect(form).not.toMatch(/[|;&<>]|\$\(/);
    }
  });

  it('are all ones the Learn pass’s allowed tools take, each a single plain command', async () => {
    const found = forms(await learnPrompt());
    expect(found).toEqual([
      'ls -la "edit"',
      'ffprobe -v error -show_entries format=duration -of csv=p=0 edit/final.mp4',
      'ffmpeg -v error -y -ss 12.5 -i edit/final.mp4 -frames:v 1 /tmp/learn-2.jpg',
    ]);
    for (const form of found) {
      expect(allowed(styleLearnAllowedTools(STYLE_DIR, 'merge'), form), form).toBe(true);
      expect(form).not.toMatch(/[|;&<>]|\$\(/);
    }
  });

  it('tell both runs that a denial means the form was wrong, so they run it again', async () => {
    for (const text of [await prompt('create'), await learnPrompt()]) {
      expect(text).toContain('one per call');
      expect(text).toContain(
        'A denial means the form was wrong, not that Bash is off: run it again in one of these forms.',
      );
    }
  });
});

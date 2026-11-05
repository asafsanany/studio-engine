// Renders a brief as edit/brief.md, the file the edit run reads first.
//
// Pure: the same brief, client, job, note and style always give the same text, with no clock, no
// locale lookups and no file access. The rules are the "Rendering rules" of the Phase 1
// architecture page, and the output for the bakery fixture is pinned byte for byte by a golden
// test (fixtures/bakery-brief.md, made by the reference renderer ref_render.py, which this
// mirrors). The "Client style" section at the end is Phase 2 (§6 of its plan), pinned by
// fixtures/bakery-brief-with-style.md. An episode's "Series" section (Series plan §4) goes before
// it; a brief without a series is rendered exactly as before. The "Graphics library" section
// (Graphics plan, build 2, GR8) is the last of all and is there only when the engine hands it
// graphics; a brief rendered without them is exactly what it was. The "Generated video" section
// (Generated videos, GN0) goes right after "Decisions" and is there only for a brief that says
// `production: generate` or has a voiceover; a brief with none of the new keys is rendered exactly
// as before. The music lines (U21) are the last addition to "Decisions": "Music: asked for, made by
// the editor" for a brief that asks for music, and, only while the music switch is on (the engine
// says so with `music: true`), "Music: not asked for" for one that does not; a brief rendered
// without the switch and without `music.wanted` is exactly what it was. The "Client shared files"
// section (the client's `_Shared` folder, next to the job's) goes right after "Files" and is there
// only when the engine hands it files.
//
// Like the reference, "has a value" means truthy: an empty string or a 0 is treated as not given.

import { budgetUsdText } from '../domain/generate.ts';
import { GRAPHIC_KIND_LABELS, type GraphicKind } from '../domain/graphics.ts';
import type { BriefDraft } from './schema.ts';

export interface BriefRenderContext {
  readonly client: string;
  readonly job: string;
  /** The owner's note for the job. Trimmed; the section is left out when it is empty. */
  readonly note?: string | null | undefined;
  /**
   * The files in the client's `_Shared` folder, next to the job's, as paths inside it. They give the
   * "## Client shared files" section after "## Files"; without any there is none.
   */
  readonly shared?: readonly string[] | null | undefined;
  /**
   * The shared fonts copied into edit/fonts/ (CVP-201), as paths inside it. Without any there is
   * no "Fonts" section.
   */
  readonly fonts?: readonly string[] | null | undefined;
  /** The job's frozen copy of the client's style (edit/style/). Without it there is no style section. */
  readonly style?: BriefStyle | null | undefined;
  /**
   * An episode's frozen copy of its series (edit/series/). It gives the "## Series" section before
   * "## Client style" and points the style section's graphics sentence at the series kit.
   */
  readonly series?: BriefSeries | null | undefined;
  /**
   * The Graphics library copied into edit/graphics/ (Graphics plan, GR8). It gives the "##
   * Graphics library" section after "## Fonts". Without any (and while the graphicsInEdits switch
   * is off the engine hands none) there is no section.
   */
  readonly graphics?: readonly BriefGraphic[] | null | undefined;
  /**
   * The music switch is on (U21): the Decisions say "Music: not asked for" when the instructions
   * asked for no music, so the editor can tell a brief that was asked about music from one that
   * was not. Left out, a brief with no music in it has no music line (as before).
   */
  readonly music?: boolean | undefined;
}

/** One graphic of the library as the "## Graphics library" section lists it. */
export interface BriefGraphic {
  /** 12 hex characters: the folder's name in edit/graphics/ and the id in `lib-<id>`. */
  readonly id: string;
  readonly name: string;
  /** From its about.json; `null` is told as a plain "graphic". */
  readonly kind: GraphicKind | null;
  readonly lengthSec: number;
  /** "When edits use it". The owner may have left it blank. */
  readonly when: string;
  /** Its text fields, in the order the graphic declares them. */
  readonly variables: readonly { readonly id: string; readonly label: string }[];
}

/** What the "## Client style" section is made of (Phase 2 plan §6). */
export interface BriefStyle {
  /** edit/style/style.md, as it is. */
  readonly markdown: string;
  /**
   * The names at the top of edit/style/, a folder's with a trailing "/" (so "kit/"). The section
   * lists the files without style.md, then "kit/" when there is one; any other folder is left out.
   */
  readonly files: readonly string[];
}

/** What the "## Series" section of an episode is made of (Series plan §4). */
export interface BriefSeries {
  /** The series' name, as its folder in `_Series` is called. */
  readonly name: string;
  /** The job's episode number; `null` when its name has none. */
  readonly episode: number | null;
  /** edit/series/series.md, as it is. */
  readonly markdown: string;
}

/** English names for the language codes the studio works in. Any other code is shown as it is. */
const LANGUAGE_NAMES: ReadonlyMap<string, string> = new Map([
  ['he', 'Hebrew'],
  ['en', 'English'],
  ['ar', 'Arabic'],
  ['ru', 'Russian'],
  ['fr', 'French'],
  ['es', 'Spanish'],
  ['de', 'German'],
]);

/**
 * Footage lists longer than this are shortened: each run of clips that sit next to each other by
 * name (no file of another role between them) collapses to "first – last (N clips)".
 */
const MAX_LISTED_FOOTAGE = 3;

/** A run shorter than this is listed file by file instead of as a range. */
const MIN_COLLAPSED_RUN = 3;

/** Section order in "## Files", with the label each role gets. */
const FILE_GROUPS = [
  ['footage', 'Footage'],
  ['music', 'Music'],
  ['logo', 'Logo'],
  ['reference', 'Reference'],
  ['instructions', 'Instructions, never in the video'],
  ['ignore', 'Ignored'],
] as const;

const ASSUMED = ' (assumed)';

export function renderBriefMd(brief: BriefDraft, context: BriefRenderContext): string {
  const assumed = new Set(brief.assumed);
  const mark = (path: string): string => (assumed.has(path) ? ASSUMED : '');

  // Each section is a list of lines; sections are joined by one blank line.
  const sections: string[][] = [[`# Brief: ${context.job} (${context.client})`, '', brief.summary]];
  const add = (heading: string, lines: string[]): void => {
    if (lines.length > 0) sections.push([heading, ...lines]);
  };

  const note = (context.note ?? '').trim();
  if (note) add('## the owner’s note (word for word; it wins)', [note]);

  add(
    '## Decisions (these override the defaults)',
    decisionLines(brief, mark, context.music === true),
  );

  add('## Generated video', generatedLines(brief, mark));

  add(
    '## Must include',
    brief.mustInclude.map((item) => {
      // A quote or a file part continues the line, so the sentence's own full stop is dropped.
      let line = `- ${item.quote || item.file ? withoutFinalStop(item.what) : item.what}`;
      if (item.quote) line += `: "${item.quote}"`;
      if (item.file) line += ` (${item.file}${item.at ? `, ${item.at}` : ''})`;
      return line;
    }),
  );

  add(
    '## Must avoid',
    brief.mustAvoid.map((item) =>
      item.file ? `- ${withoutFinalStop(item.what)} (${item.file})` : `- ${item.what}`,
    ),
  );

  const text = brief.onScreenText;
  const textLines: string[] = [];
  if (text.title) textLines.push(`- Title: ${text.title}`);
  for (const third of text.lowerThirds) {
    textLines.push(`- Lower third: ${third.name}${third.role ? ` · ${third.role}` : ''}`);
  }
  if (text.cta) textLines.push(`- Call to action: ${text.cta}`);
  if (text.endCard) textLines.push(`- End card: ${text.endCard}`);
  add('## On-screen text (word for word)', textLines);

  add(
    '## References (style to match, never in the video)',
    brief.references.map((reference) => `- ${reference.file}: ${reference.takeaway}`),
  );

  add('## Files', fileLines(brief));

  if (context.shared) add('## Client shared files', sharedLines(context.shared));

  add(
    '## Assumptions',
    brief.assumptions.map((assumption) => `- ${assumption}`),
  );

  const series = context.series ? seriesLines(context.series) : [];
  add('## Series', series);

  if (context.style) add('## Client style', styleLines(context.style, series.length > 0));

  if (context.fonts) add('## Fonts', fontLines(context.fonts));

  if (context.graphics) add('## Graphics library', graphicLines(context.graphics));

  return `${sections.map((lines) => lines.join('\n')).join('\n\n')}\n`;
}

/**
 * The lines under "## Fonts" (CVP-201): the shared fonts in edit/fonts/ and how to use them, the
 * way the skill uses its own fonts. None when there are none.
 *
 * A library of hundreds of files would be thousands of characters as a list of paths, so (U14) the
 * files are listed one folder to a line, the files at the top of edit/fonts/ first, and each
 * folder's names are folded around what they all start and end with (Heebo-{Bold,Thin}.ttf).
 */
function fontLines(fonts: readonly string[]): string[] {
  if (fonts.length === 0) return [];

  const { folders, list, folded } = listByFolder(fonts);
  const englishOnly = folders.some((folder) => /english only/i.test(folder));

  return [
    `Fonts every client can use are in edit/fonts/, one line per folder in it${folded ? ' (a{1,2}.ttf means a1.ttf and a2.ttf)' : ''}:`,
    ...list,
    ...(englishOnly
      ? [
          'A font whose folder path says “English only” has no Hebrew letters: never use it for Hebrew text.',
        ]
      : []),
    'Where the brief or the client’s style names one of these fonts, use its file from here. Where nothing names a font, you may pick one of these that fits the look.',
    'Copy each font you use into the assets/fonts/ folder with the other fonts and load it with @font-face. Check that it has the letters of the video’s language first.',
  ];
}

/**
 * Paths listed one folder to a line, the files at the top first, each folder's names folded around
 * what they all start and end with ({@link foldNames}). `folders` are the folders ('' for the top,
 * else the path with a trailing '/'), and `folded` says whether any line was folded. The Brief
 * prompt lists a client's shared files with it too, the way brief.md does.
 */
export function listByFolder(paths: readonly string[]): {
  folders: string[];
  list: string[];
  folded: boolean;
} {
  const names = new Map<string, string[]>();
  for (const path of [...paths].sort(byCodePoint)) {
    const slash = path.lastIndexOf('/');
    const folder = path.slice(0, slash + 1);
    const inFolder = names.get(folder) ?? [];
    inFolder.push(path.slice(slash + 1));
    names.set(folder, inFolder);
  }

  let folded = false;
  const folders = [...names.keys()].sort(byCodePoint);
  const list = folders.map((folder) => {
    const inFolder = names.get(folder) ?? [];
    const listed = foldNames(inFolder);
    folded ||= listed !== inFolder.join(', ');
    return `- ${folder || 'At the top'}: ${listed}`;
  });
  return { folders, list, folded };
}

/**
 * The lines under "## Client shared files": what the client keeps in its `_Shared` folder for all
 * of its videos, when to use it, and how: the run copies only the files it uses into edit/shared/
 * and works from those. None when there are none. They are not this job's footage, so the run
 * picks from them rather than cutting them all.
 */
function sharedLines(shared: readonly string[]): string[] {
  if (shared.length === 0) return [];

  const { list, folded } = listByFolder(shared);
  return [
    `The client keeps files for all of its videos in its _Shared folder, next to this job’s folder (../_Shared/ from the job folder), one line per folder in it${folded ? ' (a{1,2}.mp4 means a1.mp4 and a2.mp4)' : ''}:`,
    ...list,
    'They are not this job’s footage, and not all of them are for this video. Use one where the brief, the owner’s note or the client’s style asks for it (the logo, a product shot, an intro or an outro), or as b-roll where it tells this story better than the job’s own footage. Where the job’s folder has its own (its own logo, say), the job’s file wins.',
    'Look only at the ones that may fit (by name, a few frames, the length), and transcribe one only when you will use its sound.',
    'Copy each one you use into edit/shared/ at the same path inside it, as a clone (mkdir -p "edit/shared/broll" && cp -c "../_Shared/broll/a.mp4" "edit/shared/broll/a.mp4"; plain cp if -c fails), and use it from there. Copy only what you use, and never change, move or delete anything in ../_Shared/: it belongs to all of the client’s videos.',
  ];
}

/** A graphic's wording on one line: line breaks and runs of spaces become one space. */
function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').trim();
}

/** A sentence as the list tells it: it ends with a full stop unless it ends with some mark already. */
function asSentence(text: string): string {
  return /[.!?…]$/.test(text) ? text : `${text}.`;
}

/**
 * The lines under "## Graphics library" (Graphics plan, GR8): one line per graphic, how to mount
 * one, and who wins when a library graphic and the series or the client's style meet. None for no
 * graphics. The graphics are listed by name, so the order never depends on which one was changed
 * last.
 */
function graphicLines(graphics: readonly BriefGraphic[]): string[] {
  if (graphics.length === 0) return [];

  const list = [...graphics]
    .sort((a, b) => byCodePoint(a.name, b.name) || byCodePoint(a.id, b.id))
    .map((graphic) => {
      const kind = graphic.kind === null ? 'graphic' : GRAPHIC_KIND_LABELS[graphic.kind];
      const when = oneLine(graphic.when);
      const fields = graphic.variables.map(
        (variable) => `${oneLine(variable.id)} (${oneLine(variable.label)})`,
      );
      return `- ${oneLine(graphic.name)} (edit/graphics/${graphic.id}/): ${kind.toLowerCase()}, ${seconds(graphic.lengthSec)} s. When: ${
        when === '' ? 'only where the brief or the owner’s note names it.' : asSentence(when)
      } Text: ${fields.length > 0 ? `${fields.join(', ')}.` : 'none.'}`;
    });

  return [
    'Ready-made graphics are in edit/graphics/, one folder per graphic. Each line gives its folder, its kind and length, when it fits, and its text fields as id (label):',
    ...list,
    'A graphic’s When is the owner’s own rule for their videos: wherever it fits a moment of this video, use that graphic there, even when the brief doesn’t mention a graphic at that moment. Use one too where the brief or the owner’s note names it, instead of building a new one for that moment. The Series and Client style sections come first: where they set a graphic for that moment, or say to add none, theirs wins.',
    'To use one (<id> is its folder’s name in edit/graphics/):',
    '- Copy edit/graphics/<id>/compositions/lib-<id>.html to compositions/lib-<id>.html and edit/graphics/<id>/lib/<id>/ to lib/<id>/ in the project that holds the composition, at its root: edit/preview/, or a slot’s folder in edit/animations/. Leave its vendor/ behind: the project has GSAP already.',
    '- Mount it inside the composition’s root with a host div: <div data-composition-id="lib-<id>" data-composition-src="compositions/lib-<id>.html" data-variable-values=\'{"name":"…"}\' data-start="…" data-duration="…" style="position:absolute; inset:0"></div>',
    '- Fill data-variable-values with one JSON entry per text field, keyed by the field’s id, with the words of this video (Hebrew works). Set data-start to the moment it plays and data-duration to its length.',
    '- A field with no words in this video gets an empty value ("") and the graphic hides it.',
    '- Never put data-width or data-height on the mount: the graphic is sized by CSS and fits a video of any size.',
    '- Keep its look and timing: don’t edit its files and don’t change its length.',
    '- Place it where it covers no face or text.',
    '- The same graphic may be mounted twice in one video, each mount with its own values.',
  ];
}

/** A letter or a digit: a fold never starts or ends inside a word. */
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

/**
 * One folder's file names, sorted, as one list. Names that all start the same way are folded around
 * that start and what they all end with, when each keeps a part of its own (Heebo-{Bold,Thin}.ttf);
 * any others are listed as they are. The fold is cut back to a word's edge, so it is
 * Heebo-{Black,Bold}.ttf and never Heebo-B{lack,old}.ttf. A name with a brace or a comma in it is
 * never folded.
 */
function foldNames(names: readonly string[]): string {
  const plain = names.join(', ');
  if (names.length < 2 || names.some((name) => /[{},]/.test(name))) return plain;

  // Characters, not UTF-16 units, so a fold never splits one in two.
  const first = [...(names[0] ?? '')];
  let head = sharedStart(names.map((name) => [...name]));
  while (head > 0 && WORD_CHARACTER.test(first[head - 1] ?? '')) head--;

  // The ends are the starts of the rests read backwards.
  const rests = names.map((name) => [...name].slice(head).reverse());
  let tail = sharedStart(rests);
  while (tail > 0 && WORD_CHARACTER.test(rests[0]?.[tail - 1] ?? '')) tail--;

  const middles = rests.map((rest) => rest.slice(tail).reverse().join(''));
  if (head === 0 || middles.includes('')) return plain;
  return `${first.slice(0, head).join('')}{${middles.join(',')}}${first.slice(first.length - tail).join('')}`;
}

/** How many characters every one of `texts` starts with in common. */
function sharedStart(texts: readonly (readonly string[])[]): number {
  const [first = [], ...others] = texts;
  let i = 0;
  while (i < first.length && others.every((text) => text[i] === first[i])) i++;
  return i;
}

/** The folder of ready-made graphics: the one folder of edit/style/ the section names. */
const KIT = 'kit/';

/** The style document itself, which the section pastes in and so leaves out of the file list. */
const STYLE_FILE = 'style.md';

/**
 * The sentence after the file list that says what to do about graphics. A style made only from
 * uploaded files has no kit/ until its first video is learned, so it must not point to one. An
 * episode is built from the series' kit, so it is never pointed at the style's.
 */
function graphicsSentence(hasKit: boolean, episode: boolean): string {
  if (episode) return 'Use the series kit in edit/series/kit/, not edit/style/kit/.';
  return hasKit
    ? `Reuse the graphics in edit/style/${KIT} with this job’s text, and build new ones only for what the kit doesn’t cover, in the same look.`
    : 'Build the graphics in this look.';
}

/** style.md or series.md as the sections paste it in: line ends as \n, no blank lines around. */
function tidyMarkdown(markdown: string): string {
  return markdown.replace(/\r\n?/g, '\n').replace(/^\n+/, '').trimEnd();
}

/**
 * The lines under "## Series" (Series plan §4): the sentence that says what to do, a blank line,
 * then series.md. None for a series.md with nothing in it, which has nothing to follow.
 */
function seriesLines(series: BriefSeries): string[] {
  const markdown = tidyMarkdown(series.markdown);
  if (markdown === '') return [];

  const which = series.episode === null ? 'an episode' : `episode ${series.episode}`;
  return [
    `This job is ${which} of the series “${series.name}”. Rebuild it from the series’ composition in edit/series/kit/: keep every beat, timing, graphic, font, colour, music cue and sound exactly as they are (the music and sound files are in edit/series/kit/assets/audio/), and don’t add or redesign graphics. Cut this job’s footage, fill each part under “New in each episode” from the sections above (or from the footage where they say nothing), and make the captions from the speech. The series wins over the Client style below; the sections above win over both. Where the kit mounts compositions/lib-<id>.html, that is a graphic from the Graphics library: take its files from edit/graphics/<id>/ as the Graphics library section says; if edit/graphics/ has no folder for it, build that moment in the look of the series’ other graphics.`,
    '',
    demoteHeadings(markdown),
  ];
}

/**
 * The lines under "## Client style": the two fixed lines, a blank one, then style.md. None for a
 * style.md with nothing in it, which has nothing to follow. `episode`: the brief has a Series
 * section, so the graphics sentence is about the series kit.
 */
function styleLines(style: BriefStyle, episode: boolean): string[] {
  const markdown = tidyMarkdown(style.markdown);
  if (markdown === '') return [];

  const hasKit = style.files.includes(KIT);
  const names = style.files.filter((name) => name !== STYLE_FILE && !name.endsWith('/'));
  names.sort(byCodePoint);
  if (hasKit) names.push(KIT);
  const list = names.length > 0 ? names.join(', ') : `none besides ${STYLE_FILE}`;

  return [
    'This is the client’s house style. Follow it wherever the sections above say nothing.',
    `Its files are in edit/style/: ${list}. ${graphicsSentence(hasKit, episode)}`,
    '',
    demoteHeadings(markdown),
  ];
}

/** A code fence: up to three spaces, three or more ` or ~, then the rest of the line. */
const CODE_FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/** An ATX heading: up to three spaces, one to six #, then a space, a tab or the end of the line. */
const ATX_HEADING = /^( {0,3})(#{1,6})(?=[ \t]|$)/;

/** Markdown has six heading levels, so a heading that would go deeper stays at six. */
const MAX_HEADING_LEVEL = 6;

/**
 * Moves every heading two levels deeper ("# Style" → "### Style", "## Look" → "#### Look"), so
 * style.md (and series.md) sits below the brief's own "## Client style" ("## Series"). Only `#`
 * headings are moved, as both are written with them, and not the lines inside a fenced code block.
 */
function demoteHeadings(markdown: string): string {
  let fence: string | null = null;
  return markdown
    .split('\n')
    .map((line) => {
      const [, run, rest] = CODE_FENCE.exec(line) ?? [];
      if (fence !== null) {
        // A fence closes on the same character, at least as long, with nothing after it.
        if (
          run !== undefined &&
          run[0] === fence[0] &&
          run.length >= fence.length &&
          !rest?.trim()
        ) {
          fence = null;
        }
        return line;
      }
      if (run !== undefined) {
        fence = run;
        return line;
      }
      return line.replace(ATX_HEADING, (_match, indent: string, hashes: string) => {
        return `${indent}${'#'.repeat(Math.min(hashes.length + 2, MAX_HEADING_LEVEL))}`;
      });
    })
    .join('\n');
}

/** One line per field that has a value, in the fixed order of the "Decisions" section. */
function decisionLines(
  brief: BriefDraft,
  mark: (path: string) => string,
  musicOn: boolean,
): string[] {
  const lines: string[] = [];

  if (brief.goal) lines.push(`- Goal: ${lowerFirst(brief.goal)}${mark('goal')}`);
  if (brief.audience) lines.push(`- Audience: ${lowerFirst(brief.audience)}${mark('audience')}`);
  if (brief.platform.length > 0) {
    lines.push(`- Platform: ${brief.platform.join(', ')}${mark('platform')}`);
  }
  if (brief.canvas) lines.push(`- Canvas: ${brief.canvas}${mark('canvas')}`);
  // A video cut from footage that is asked for in more than one size; a generated one says so in
  // its own section.
  if (brief.formats && !isGenerated(brief)) {
    lines.push(`- Formats: ${brief.formats.join(', ')}${mark('formats')}`);
  }

  const length = lengthText(brief.length);
  if (length) lines.push(`- Length: ${length}${mark('length')}`);

  if (brief.language) {
    const code = brief.language;
    const name = LANGUAGE_NAMES.get(code) ?? code;
    lines.push(`- Language: ${name} (transcribe with --language ${code})${mark('language')}`);
  }
  if (brief.captions) lines.push(`- Captions: ${brief.captions}${mark('captions')}`);
  if (brief.tone) lines.push(`- Tone: ${lowerFirst(brief.tone)}${mark('tone')}`);
  if (brief.pacing) lines.push(`- Pacing: ${lowerFirst(brief.pacing)}${mark('pacing')}`);

  const hook = brief.hook;
  if (hook) {
    const what = lowerFirst(hook.what);
    if (hook.file) {
      const where = ` (${hook.file}${hook.at ? `, ${hook.at}` : ''})`;
      lines.push(`- Hook: ${withoutFinalStop(what)}${where}${mark('hook')}`);
    } else {
      lines.push(`- Hook: ${what}${mark('hook')}`);
    }
  }

  const music = brief.music;
  const musicText = music ? musicLines(music, mark) : [];
  // The music switch is on and nothing in the instructions is about music: the editor is told so.
  if (musicText.length === 0 && musicOn) musicText.push('- Music: not asked for');
  lines.push(...musicText);

  const look = brief.look;
  const parts: string[] = [];
  if (look.logo) parts.push(`logo ${look.logo}${mark('look.logo')}`);
  if (look.colors.length > 0) parts.push(`colours ${look.colors.join(', ')}${mark('look.colors')}`);
  if (look.fonts.length > 0) {
    const label = look.fonts.length === 1 ? 'font' : 'fonts';
    parts.push(`${label} ${look.fonts.join(', ')}${mark('look.fonts')}`);
  }
  if (parts.length > 0) lines.push(`- Look: ${parts.join('; ')}`);

  return lines;
}

/** Whether the video is made, not cut: the brief says so, or gives a voiceover script to make. */
function isGenerated(brief: BriefDraft): boolean {
  return brief.production === 'generate' || brief.voiceover !== null;
}

/**
 * The lines under "## Generated video" (Generated videos, GN0): that there is no footage, the
 * voiceover line by line with how each is said, the formats and the budget. None for a video cut
 * from footage.
 */
function generatedLines(brief: BriefDraft, mark: (path: string) => string): string[] {
  if (!isGenerated(brief)) return [];
  const lines = [
    `- Production: generate. There is no footage; the video is made from the script and the references.${mark('production')}`,
  ];
  if (brief.voiceover) {
    lines.push(`- Voiceover, word for word, in this order${mark('voiceover')}:`);
    for (const line of brief.voiceover.lines) {
      const direction = line.direction ? ` (say it: ${line.direction})` : '';
      lines.push(`  - ${line.id}: "${line.text}"${direction}`);
    }
  }
  if (brief.formats) {
    lines.push(`- Formats: ${brief.formats.join(', ')}, one video of each${mark('formats')}`);
  }
  if (brief.budgetUsd) {
    lines.push(`- Budget: ${budgetUsdText(brief.budgetUsd)} for this video${mark('budgetUsd')}`);
  }
  return lines;
}

/**
 * The Decisions lines for the brief's music (Songs, SG0). A music file keeps its line exactly as
 * before ("- Music: file (note)"). The song asked for gets a "- Song:" line, word for word from the
 * client's request: "Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG", or "Song: a
 * trending one, picked by the editor", or, when the screenshot only says "Original audio", the
 * account and that there is no song to look up. A music object with none of these but a note keeps
 * the note ("- Music: note"). Without a song, an original-audio label or a trending ask, a
 * brief is rendered exactly as it was before Songs. A music object whose `wanted` is true (U21: the
 * instructions ask for music to be made or added, with no file and no song) says "- Music: asked for,
 * made by the editor", with the note after it when there is one ("(intense, with drops)").
 */
function musicLines(
  music: NonNullable<BriefDraft['music']>,
  mark: (path: string) => string,
): string[] {
  const lines: string[] = [];
  const assumed = mark('music');
  const note = music.note ? ` (${music.note})` : '';

  if (music.file) lines.push(`- Music: ${music.file}${note}${assumed}`);

  const song = music.song;
  if (song) {
    const what =
      song.title && song.artist
        ? `${song.title} by ${song.artist}`
        : song.title || song.artist || 'the song in the link';
    const version = song.version ? ` (${song.version})` : '';
    const from = song.fromFile ? `, from ${song.fromFile}` : '';
    const link = song.link ? `, link ${song.link}` : '';
    const extra = music.file ? '' : note;
    lines.push(`- Song: ${what}${version}${from}${link}${extra}${assumed}`);
  } else if (music.original) {
    const extra = music.file ? '' : note;
    lines.push(
      `- Song: none to look up, the screenshot says “Original audio” by ${music.original.by}${extra}${assumed}`,
    );
  } else if (music.wantsTrending) {
    const extra = music.file ? '' : note;
    lines.push(`- Song: a trending one, picked by the editor${extra}${assumed}`);
  } else if (music.wanted && !music.file) {
    // U21: the instructions ask for music to be made, and name no file and no song.
    lines.push(`- Music: asked for, made by the editor${note}${assumed}`);
  } else if (!music.file && music.note) {
    lines.push(`- Music: ${music.note}${assumed}`);
  }
  return lines;
}

/** "N s at most", "about N s", or "about T s, M s at most"; null when there is no length. */
function lengthText(length: BriefDraft['length']): string | null {
  if (!length) return null;
  const { targetSec, maxSec } = length;
  if (targetSec && maxSec) return `about ${seconds(targetSec)} s, ${seconds(maxSec)} s at most`;
  if (targetSec) return `about ${seconds(targetSec)} s`;
  if (maxSec) return `${seconds(maxSec)} s at most`;
  return null;
}

/**
 * 30 → "30", 22.5 → "22.5". Six significant digits, like Python's `:g`, so float noise is gone
 * (0.1 + 0.2 → "0.3"). Differs from `:g` only from a million seconds up, where `:g` switches to
 * exponent form.
 */
function seconds(value: number): string {
  return String(Number(value.toPrecision(6)));
}

/**
 * Drops one trailing "." from a sentence that a "(file…)" or a quote is about to follow, so the
 * line reads "…Friday (clip-01.mp4)" and not "…Friday. (clip-01.mp4)". An ellipsis ("...") is left
 * alone, and so is any other ending ("…", "!", "?").
 */
function withoutFinalStop(text: string): string {
  return text.endsWith('.') && !text.endsWith('..') ? text.slice(0, -1) : text;
}

/**
 * Starts a sentence fragment in lower case ("Bring people in" → "bring people in"), unless the first
 * two letters are both upper case ("WhatsApp" stays, "UGC clip" stays). Compared by code point,
 * as in the reference renderer.
 */
function lowerFirst(text: string): string {
  const [first, second] = text;
  if (first === undefined || second === undefined) return text;
  if (isUpperCase(first) && !isUpperCase(second))
    return first.toLowerCase() + text.slice(first.length);
  return text;
}

function isUpperCase(char: string): boolean {
  return char !== char.toLowerCase() && char === char.toUpperCase();
}

/**
 * Orders strings by Unicode code point, as the reference renderer's `sorted()` does. The default
 * `Array.sort` compares UTF-16 units, which puts an emoji before U+E000–U+FFFF characters.
 */
function byCodePoint(a: string, b: string): number {
  const left = Array.from(a);
  const right = Array.from(b);
  const point = (char: string | undefined): number => char?.codePointAt(0) ?? -1;
  for (let i = 0; i < Math.max(left.length, right.length); i++) {
    const difference = point(left[i]) - point(right[i]);
    if (difference !== 0) return difference;
  }
  return 0;
}

/**
 * Footage names, sorted by code point, in runs that are unbroken by any file of another role: a
 * range "first – last" must never cover an ignored, reference or other file that sorts inside it,
 * or it reads as if that file were footage too.
 */
function footageRuns(brief: BriefDraft): string[][] {
  const ordered = [...brief.files].sort((a, b) => byCodePoint(a.path, b.path));
  const runs: string[][] = [];
  let run: string[] = [];
  for (const file of ordered) {
    if (file.role === 'footage') {
      run.push(file.path);
    } else if (run.length > 0) {
      runs.push(run);
      run = [];
    }
  }
  if (run.length > 0) runs.push(run);
  return runs;
}

/** One run of footage: "a – c (3 clips)" from three clips up, else the names one by one. */
function footageRunText(run: string[]): string {
  const first = run[0];
  const last = run[run.length - 1];
  if (run.length < MIN_COLLAPSED_RUN || first === undefined || last === undefined)
    return run.join(', ');
  return `${first} – ${last} (${run.length} clips)`;
}

/** The "## Files" lines: one per role that has files, in the fixed role order. */
function fileLines(brief: BriefDraft): string[] {
  const lines: string[] = [];
  for (const [role, label] of FILE_GROUPS) {
    const paths = brief.files.filter((file) => file.role === role).map((file) => file.path);
    if (paths.length === 0) continue;
    if (role === 'footage' && paths.length > MAX_LISTED_FOOTAGE) {
      lines.push(`- ${label}: ${footageRuns(brief).map(footageRunText).join(', ')}`);
    } else {
      lines.push(`- ${label}: ${paths.join(', ')}`);
    }
  }
  return lines;
}

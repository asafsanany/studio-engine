/**
 * Reads every font under a folder with the font reader (apps/server/src/fonts/font-reader.ts) and
 * prints what it says: family, weight and Hebrew per file, then one line per family. Read-only: it
 * never writes, renames or moves a file.
 *
 *   pnpm --filter @studio/server exec tsx ../../scripts/fonts-check.ts [folder] [options]
 *
 *   folder              default ~/Studio Inbox/_Fonts
 *   --summary           print only the per-family lines and the verdict
 *   --expected <file>   the list of families to compare with (fonts.json: name, hebrew, weights);
 *                       default ~/.studio-engine/handoff/fonts-design/fonts.json when it exists
 *
 * It checks, and exits 1 on any failure:
 *   - every font file passes the static check and the reader (no file left unread);
 *   - Hebrew agrees with the folders: a file under "Hebrew + English" has the Hebrew letters, a file
 *     under "English only" does not;
 *   - no two files of a family are the same face (weight + italic);
 *   - with an expected list: the same families, each with the same weights and the same script.
 *
 * It needs tsx (the server package has it) because the reader imports the shared package.
 */
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { checkFontFile, readFont } from '../apps/server/src/fonts/font-reader.ts';
import {
  FONT_EXTENSIONS,
  FONT_SCRIPT_LABELS,
  faceName,
  fontFormatOf,
} from '../packages/shared/src/domain/fonts.ts';

interface FileRead {
  path: string;
  family: string;
  weight: number;
  italic: boolean;
  he: boolean;
  variable: boolean;
  /** Which of the owner's two folders the file sits under, if either. */
  folder: 'hebrew' | 'english' | null;
}

interface Expected {
  name: string;
  hebrew: boolean;
  weights: number[];
}

function fontFiles(root: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.name.startsWith('.')) continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (fontFormatOf(entry.name) !== null) found.push(path);
    }
  };
  walk(root);
  return found.sort((a, b) => a.localeCompare(b));
}

function folderOf(relativePath: string): FileRead['folder'] {
  const parts = relativePath.split('/');
  if (parts.includes(FONT_SCRIPT_LABELS.hebrew)) return 'hebrew';
  if (parts.includes(FONT_SCRIPT_LABELS.english)) return 'english';
  return null;
}

function main(argv: string[]): number {
  const args = [...argv];
  const summaryOnly = args.includes('--summary');
  let expectedPath: string | null = null;
  const expectedAt = args.indexOf('--expected');
  if (expectedAt >= 0) expectedPath = resolve(args[expectedAt + 1] ?? '');
  const positional = args.filter(
    (arg, i) => !arg.startsWith('--') && (expectedAt < 0 || i !== expectedAt + 1),
  );
  const root = resolve(positional[0] ?? join(homedir(), 'Studio Inbox', '_Fonts'));
  if (!existsSync(root) || !statSync(root).isDirectory()) {
    console.error(`No such folder: ${root}`);
    return 1;
  }
  expectedPath ??= join(homedir(), '.studio-engine', 'handoff', 'fonts-design', 'fonts.json');

  const problems: string[] = [];
  const reads: FileRead[] = [];
  const files = fontFiles(root);
  console.log(`${files.length} font files under ${root}`);
  if (!summaryOnly)
    console.log('\nFile                                           Family              Wt   Hebrew');

  for (const path of files) {
    const shown = relative(root, path);
    const bytes = readFileSync(path);
    const check = checkFontFile(path, bytes);
    if (!check.ok) {
      problems.push(`${shown}: ${check.error}`);
      console.log(`  ${shown}  NOT READ: ${check.error}`);
      continue;
    }
    const font = readFont(bytes);
    if (!font.ok) {
      problems.push(`${shown}: ${font.error}`);
      console.log(`  ${shown}  NOT READ: ${font.error}`);
      continue;
    }
    const folder = folderOf(shown);
    reads.push({
      path: shown,
      family: font.family,
      weight: font.weight,
      italic: font.italic,
      he: font.he,
      variable: font.variable,
      folder,
    });
    if (!summaryOnly) {
      const label = `${shown}`.padEnd(46).slice(0, 46);
      const wanted = folder === null ? null : folder === 'hebrew';
      const flag = wanted !== null && wanted !== font.he ? '   <-- disagrees with its folder' : '';
      console.log(
        `${label} ${font.family.padEnd(19).slice(0, 19)} ${String(font.weight).padEnd(4)} ${
          font.he ? 'yes' : 'no'
        }${font.italic ? '  italic' : ''}${font.variable ? '  variable' : ''}${flag}`,
      );
    }
    if (folder !== null && (folder === 'hebrew') !== font.he) {
      problems.push(
        `${shown}: ${font.he ? 'has' : 'has no'} Hebrew letters but sits under "${
          folder === 'hebrew' ? FONT_SCRIPT_LABELS.hebrew : FONT_SCRIPT_LABELS.english
        }"`,
      );
    }
  }

  // One line per family.
  const families = new Map<string, FileRead[]>();
  for (const read of reads) {
    const key = read.family.toLowerCase();
    families.set(key, [...(families.get(key) ?? []), read]);
  }
  console.log(`\n${families.size} families from ${reads.length} readable files\n`);
  console.log('Family                  Script             Files  Weights');
  const summary = new Map<string, { name: string; hebrew: boolean; weights: number[] }>();
  for (const [key, list] of [...families].sort((a, b) => a[0].localeCompare(b[0]))) {
    const name = list[0]?.family ?? key;
    const hebrew = list.every((read) => read.he);
    const mixed = list.some((read) => read.he) && !hebrew;
    const weights = [...new Set(list.map((read) => read.weight))].sort((a, b) => a - b);
    summary.set(key, { name, hebrew, weights });
    const faces = new Map<string, string>();
    for (const read of list) {
      const face = faceName(read.family, read.weight, read.italic);
      const known = faces.get(face);
      if (known) problems.push(`${read.family}: ${known} and ${read.path} are both "${face}"`);
      faces.set(face, read.path);
    }
    if (mixed) problems.push(`${name}: some files have Hebrew and some do not`);
    console.log(
      `${name.padEnd(23).slice(0, 23)} ${(hebrew ? FONT_SCRIPT_LABELS.hebrew : FONT_SCRIPT_LABELS.english).padEnd(18)} ${String(list.length).padEnd(6)} ${weights.join(' ')}${mixed ? '   (mixed)' : ''}`,
    );
  }

  // Compare with the list of families the page was designed on.
  if (existsSync(expectedPath)) {
    const parsed = JSON.parse(readFileSync(expectedPath, 'utf8')) as { families?: Expected[] };
    const expected = parsed.families ?? [];
    console.log(`\nCompared with ${expectedPath} (${expected.length} families)`);
    for (const want of expected) {
      const got = summary.get(want.name.toLowerCase());
      if (!got) {
        problems.push(`${want.name}: expected but not found`);
        continue;
      }
      if (got.weights.join() !== want.weights.join()) {
        problems.push(
          `${want.name}: weights ${got.weights.join(' ')} but expected ${want.weights.join(' ')}`,
        );
      }
      if (got.hebrew !== want.hebrew) {
        problems.push(`${want.name}: Hebrew ${got.hebrew} but expected ${want.hebrew}`);
      }
    }
    const wanted = new Set(expected.map((want) => want.name.toLowerCase()));
    for (const [key, got] of summary) {
      if (!wanted.has(key)) problems.push(`${got.name}: found but not expected`);
    }
  } else {
    console.log(`\nNo list of expected families at ${expectedPath}: nothing to compare with.`);
  }

  console.log(
    `\nExtensions read: ${FONT_EXTENSIONS.join(' ')}. Files read: ${reads.length} of ${files.length}.`,
  );
  if (problems.length === 0) {
    console.log('OK: every file reads, and the families agree.');
    return 0;
  }
  console.log(`\n${problems.length} problem${problems.length === 1 ? '' : 's'}:`);
  for (const problem of problems) console.log(`  - ${problem}`);
  return 1;
}

process.exitCode = main(process.argv.slice(2));

import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { MAX_SCANNED_FILE_BYTES, SKIPPED_IN_EDIT, scanJobFonts } from './font-scan.js';

// The scan of a finished edit's compositions for the library's font families (FN17): strings only,
// real files in a temp job folder.

/** A slice of the owner's library: Hebrew + English and English only, one family with a longer sibling. */
const LIBRARY = [
  'Heebo',
  'Rubik',
  'Rubik Spray Paint',
  'Secular One',
  'Assistant',
  'Akrobat',
  'Outfit',
  'Frank Ruhl Libre',
] as const;

let root: string;
const warn = vi.fn();
const logger = { info: vi.fn(), warn, error: vi.fn() };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'studio-font-scan-'));
  warn.mockClear();
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const jobDir = (name = 'Spring') => join(root, 'Acme', name);

/** Writes a file at a path inside the job's folder. */
async function put(path: string, text: string, job = jobDir()): Promise<string> {
  const file = join(job, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, text);
  return file;
}

const scan = (job = jobDir()) => scanJobFonts(job, LIBRARY, logger);

/** A composition whose only font statement is the one given. */
const withStyle = (css: string) => `<style>${css}</style><div id="root"></div>`;

describe('what it finds in a composition', () => {
  it('Heebo in a caption style', async () => {
    await put(
      'edit/preview/compositions/captions.html',
      withStyle(`.caption { font-family: 'Heebo', sans-serif; font-size: 64px; color: #fff; }`),
    );

    expect(await scan()).toEqual(['Heebo']);
  });

  it('Rubik 800 in a title, written as font-weight and as the font shorthand', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(`.title { font-family: Rubik; font-weight: 800; }`),
    );
    expect(await scan()).toEqual(['Rubik']);

    await put('edit/preview/index.html', withStyle(`.title { font: 800 72px/1.1 "Rubik"; }`));
    expect(await scan()).toEqual(['Rubik']);
  });

  it('ignores a family that is not in the library', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(`.a { font-family: "Gotham", Arial, sans-serif } .b { font: 700 40px Futura }`),
    );

    expect(await scan()).toEqual([]);
  });

  it('splits a font list: "Secular One", Heebo, sans-serif gives both', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(`.title { font-family: "Secular One", Heebo, sans-serif; }`),
    );

    expect(await scan()).toEqual(['Heebo', 'Secular One']);
  });

  it('reads plain names with spaces, single or double quotes and !important', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(
        `.a { font-family: Secular One, serif } .b { font-family: 'Frank Ruhl Libre' !important }`,
      ),
    );

    expect(await scan()).toEqual(['Frank Ruhl Libre', 'Secular One']);
  });

  it('counts an @font-face with nothing using it', async () => {
    await put(
      'edit/preview/compositions/titles.html',
      withStyle(`@font-face { font-family: "Outfit"; src: url("../assets/fonts/x.woff2"); }`),
    );

    expect(await scan()).toEqual(['Outfit']);
  });

  it('reads a CSS variable set to a family list', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(
        `:root { --title-font: "Secular One", Heebo, sans-serif; --caption: 'Assistant'; --gap: 12px; }`,
      ),
    );

    expect(await scan()).toEqual(['Assistant', 'Heebo', 'Secular One']);
  });

  it('reads the font shorthand with a weight, a size and a line height', async () => {
    await put(
      'edit/preview/compositions/captions.html',
      `<div style="font: 600 64px/1.26 'Akrobat', 'HeeboCap', sans-serif">x</div>`,
    );

    expect(await scan()).toEqual(['Akrobat']);
  });

  it('reads inline styles, with the names quoted as entities too', async () => {
    await put(
      'edit/preview/index.html',
      `<p style="font-family: &quot;Outfit&quot;, sans-serif">a</p>
       <p style='font-family:"Assistant"'>b</p>
       <p style="font-family:Heebo">c</p>`,
    );

    expect(await scan()).toEqual(['Assistant', 'Heebo', 'Outfit']);
  });

  it('reads the font-family attribute of an inline SVG', async () => {
    await put(
      'edit/preview/compositions/titles.html',
      `<svg><text font-family="'Secular One', sans-serif">א</text><text font-family=Rubik>b</text>
       <text data-font-family="Outfit">c</text></svg>`,
    );

    expect(await scan()).toEqual(['Rubik', 'Secular One']);
  });

  it('reads a stylesheet', async () => {
    await put('edit/preview/assets/fonts/fonts.css', `h1 { font-family: "Rubik"; }`);

    expect(await scan()).toEqual(['Rubik']);
  });

  it('matches without regard to case, and answers the library’s own spelling', async () => {
    await put('edit/preview/index.html', withStyle(`.a { font-family: HEEBO, "secular one" }`));

    expect(await scan()).toEqual(['Heebo', 'Secular One']);
  });

  it('answers each family once however often it is named, across files', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(`.a { font-family: Heebo } .b { font: 20px Heebo }`),
    );
    await put('edit/preview/compositions/a.html', withStyle(`.c { font-family: heebo }`));

    expect(await scan()).toEqual(['Heebo']);
  });

  it('leaves out what a comment says', async () => {
    await put(
      'edit/preview/index.html',
      `<!-- font-family: Rubik -->
       <style>/* font-family: Outfit; */ .a { font-family: Heebo; /* Assistant */ }</style>`,
    );

    expect(await scan()).toEqual(['Heebo']);
  });

  it('does not take a name from anything but a declaration', async () => {
    await put(
      'edit/preview/index.html',
      `<div class="Heebo">Rubik</div><script>el.style.fontFamily = "Outfit"; // Assistant</script>
       <style>.a { font-family: var(--font-body); } .b { font: var(--shorthand); }</style>`,
    );

    expect(await scan()).toEqual([]);
  });

  it('reads files that hold Hebrew', async () => {
    await put(
      'edit/preview/compositions/captions.html',
      `<div class="c">כתוביות</div><style>.c { font-family: Heebo; } /* כותרת */</style>`,
    );

    expect(await scan()).toEqual(['Heebo']);
  });
});

describe('@font-face sources', () => {
  const face = (family: string, src: string) =>
    withStyle(`@font-face { font-family: "${family}"; font-weight: 500; src: ${src}; }`);

  it('finds a family by the file an alias points at', async () => {
    await put(
      'edit/preview/assets/fonts/heebo.css',
      face('HeeboCap', 'url("heebo-latin-500-normal.woff2") format("woff2")'),
    );

    expect(await scan()).toEqual(['Heebo']);
  });

  it('reads the file name of a path, a query, percent signs and a variable font', async () => {
    await put(
      'edit/preview/a.html',
      face('A', 'url("../fonts/Hebrew%20%2B%20English/Heebo/Heebo-Bold.ttf?v=3")'),
    );
    await put('edit/preview/b.html', face('B', "url('assets/Assistant[wght].ttf')"));
    await put('edit/preview/c.html', face('C', 'url(assets/secular-one-latin-400-normal.woff2)'));

    expect(await scan()).toEqual(['Assistant', 'Heebo', 'Secular One']);
  });

  it('takes the longest family that fits: Rubik Spray Paint is not Rubik', async () => {
    await put('edit/preview/index.html', face('Spray', 'url("RubikSprayPaint-Regular.ttf")'));

    expect(await scan()).toEqual(['Rubik Spray Paint']);
  });

  it('falls back to the shorter family when the longer one is not in the library', async () => {
    await put('edit/preview/index.html', face('Mono', 'url("Rubik-Mono-One-Regular.ttf")'));

    expect(await scan()).toEqual(['Rubik']);
  });

  it('reads a local() name', async () => {
    await put(
      'edit/preview/index.html',
      face('X', 'local("Outfit Bold"), local(Frank-Ruhl-Libre)'),
    );

    expect(await scan()).toEqual(['Frank Ruhl Libre', 'Outfit']);
  });

  it('ignores inline data and files that are no library family', async () => {
    await put(
      'edit/preview/index.html',
      face('Data', 'url("data:font/woff2;base64,AAAAHeebo=="), url("assets/Gotham-Bold.otf")'),
    );

    expect(await scan()).toEqual([]);
  });

  it('counts a source only inside an @font-face', async () => {
    await put(
      'edit/preview/index.html',
      withStyle(`.logo { background: url("assets/Heebo-Bold.png") } .a { src: url(Rubik.ttf) }`),
    );

    expect(await scan()).toEqual([]);
  });
});

describe('where it looks', () => {
  const HEEBO = withStyle(`.a { font-family: Heebo }`);

  it('skips node_modules and vendor at any depth, and anything hidden', async () => {
    await put('edit/preview/node_modules/pkg/index.html', HEEBO);
    await put('edit/preview/vendor/lib.css', HEEBO);
    await put('edit/preview/compositions/vendor/lib.html', HEEBO);
    await put('edit/preview/.hyperframes/state.html', HEEBO);
    await put('edit/.cache/index.html', HEEBO);
    await put('edit/preview/index.html', withStyle(`.a { font-family: Rubik }`));

    expect(await scan()).toEqual(['Rubik']);
  });

  it.each([...SKIPPED_IN_EDIT])('skips edit/%s/', async (folder) => {
    await put(`edit/${folder}/deep/index.html`, HEEBO);
    await put(`edit/${folder}/sheet.css`, HEEBO);

    expect(await scan()).toEqual([]);
  });

  it('skips fonts, review, style, graphics and work only directly inside edit/', async () => {
    expect([...SKIPPED_IN_EDIT].sort()).toEqual(['fonts', 'graphics', 'review', 'style', 'work']);
    await put('edit/preview/assets/fonts/heebo.css', HEEBO);
    await put('edit/preview/review/index.html', withStyle(`.a { font-family: Outfit }`));
    await put('edit/animations/slot_1/work/index.html', withStyle(`.a { font-family: Rubik }`));

    expect(await scan()).toEqual(['Heebo', 'Outfit', 'Rubik']);
  });

  it('reads the preview, the animations and a composition at the top of edit/', async () => {
    await put('edit/preview/index.html', withStyle(`.a { font-family: Heebo }`));
    await put('edit/animations/slot_1/index.html', withStyle(`.a { font-family: Outfit }`));
    await put('edit/index.html', withStyle(`.a { font-family: Rubik }`));

    expect(await scan()).toEqual(['Heebo', 'Outfit', 'Rubik']);
  });

  it('reads only .html and .css files, and nothing outside edit/', async () => {
    await put('edit/preview/notes.md', HEEBO);
    await put('edit/preview/app.js', `el.style.cssText = "font-family: Heebo"`);
    await put('edit/preview/logo.svg', HEEBO);
    await put('edit/preview/data.json', `{"font-family": "Heebo"}`);
    await put('brief.html', HEEBO);
    await put('Footage.html', HEEBO);

    expect(await scan()).toEqual([]);
  });

  it('does not follow a symlink out of the project', async () => {
    const outside = join(root, 'elsewhere');
    await mkdir(outside, { recursive: true });
    await writeFile(join(outside, 'index.html'), HEEBO);
    await mkdir(join(jobDir(), 'edit', 'preview'), { recursive: true });
    await symlink(outside, join(jobDir(), 'edit', 'preview', 'linked'));
    await symlink(join(outside, 'index.html'), join(jobDir(), 'edit', 'preview', 'link.html'));

    expect(await scan()).toEqual([]);
  });

  it('is empty for a job with no edit folder, an empty one, or a folder that is gone', async () => {
    await put('Footage.mp4', 'x');
    expect(await scan()).toEqual([]);
    await mkdir(join(jobDir(), 'edit'), { recursive: true });
    expect(await scan()).toEqual([]);
    expect(await scan(join(root, 'Nobody', 'Nothing'))).toEqual([]);
  });

  it('is empty, and reads nothing, for a library with no families', async () => {
    await put('edit/preview/index.html', HEEBO);

    expect(await scanJobFonts(jobDir(), [])).toEqual([]);
  });
});

describe('the size cap', () => {
  const HEEBO = `<style>.a { font-family: Heebo }</style>`;

  it('leaves out a file over 2 MB and reads one of exactly 2 MB', async () => {
    expect(MAX_SCANNED_FILE_BYTES).toBe(2 * 1024 * 1024);
    const padding = (bytes: number) => ' '.repeat(bytes - HEEBO.length);
    await put('edit/preview/big.html', HEEBO + padding(MAX_SCANNED_FILE_BYTES + 1));
    await put('edit/preview/huge.css', `.a { font-family: Outfit }${' '.repeat(3_000_000)}`);
    expect(await scan()).toEqual([]);

    await put('edit/preview/edge.html', HEEBO + padding(MAX_SCANNED_FILE_BYTES));
    expect(await scan()).toEqual(['Heebo']);
  });

  it('still reads the small files beside a big one', async () => {
    await put('edit/preview/big.html', HEEBO + ' '.repeat(MAX_SCANNED_FILE_BYTES));
    await put('edit/preview/index.html', `<style>.a { font-family: Rubik }</style>`);

    expect(await scan()).toEqual(['Rubik']);
  });
});

describe('a file it cannot read', () => {
  it.skipIf(process.getuid?.() === 0)('is left out and said, and the others are read', async () => {
    const locked = await put(
      'edit/preview/locked.html',
      `<style>.a { font-family: Heebo }</style>`,
    );
    await chmod(locked, 0o000);
    await put('edit/preview/index.html', `<style>.a { font-family: Rubik }</style>`);

    expect(await scan()).toEqual(['Rubik']);

    expect(warn).toHaveBeenCalledWith(
      expect.objectContaining({ file: locked }),
      'could not read a composition file for its fonts',
    );
    await chmod(locked, 0o644);
  });
});

describe('what it does to the job', () => {
  it('writes nothing', async () => {
    await put('edit/preview/index.html', `<style>.a { font-family: Heebo }</style>`);
    const before = await snapshot(jobDir());

    await scan();

    expect(await snapshot(jobDir())).toEqual(before);
  });
});

/** Every path under `dir` with its size and modified time. */
async function snapshot(dir: string): Promise<string[]> {
  const { readdir, stat } = await import('node:fs/promises');
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    const info = await stat(path);
    out.push(`${path} ${info.size} ${info.mtimeMs}`);
    if (entry.isDirectory()) out.push(...(await snapshot(path)));
  }
  return out.sort();
}

// The engine's check of a run's work (Graphics plan, "What a graphic is, on disk"). OWNER: GR1.
// Static, no browser. It runs after a run exits 0; if any part fails the message fails with the
// reason, and no version is made:
//
//   - about.json parses (graphicAboutSchema);
//   - compositions/lib-<id>.html has a <template>, the right composition id,
//     window.__timelines["lib-<id>"], and every variable id from about.json;
//   - no http(s):// and no absolute path in src/href/url();
//   - every relative file it names exists.
//
// The first problem found is answered as one plain sentence. The checks go in the order above, and
// the references of the composition in the order they are written. Paths are read as the plan says
// they are written: from the project root (a mounted sub-composition's markup is cloned into the
// host page), so `lib/<id>/fonts/Heebo.ttf` is `<work>/lib/<id>/fonts/Heebo.ttf`.

import { readFile, stat } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import { type GraphicAbout, graphicAboutSchema } from '@studio/shared';

export type GraphicCheckResult =
  | { ok: true; about: GraphicAbout }
  /** `error` is one plain sentence for the chat: what is wrong with the graphic. */
  | { ok: false; error: string };

/** `about.json`, in a version's folder and in work/. */
export const ABOUT_FILE = 'about.json';

/** The graphic's composition file, relative to the project: `compositions/lib-<id>.html`. */
export function graphicCompositionPath(graphicId: string): string {
  return `compositions/lib-${graphicId}.html`;
}

/** A sentence ends with a full stop. */
function sentence(text: string): string {
  const trimmed = text.trim();
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

/** Reads and checks `<dir>/about.json` (a work/ or a version's folder). */
export async function readGraphicAbout(dir: string): Promise<GraphicCheckResult> {
  let text: string;
  try {
    text = await readFile(join(dir, ABOUT_FILE), 'utf8');
  } catch {
    return { ok: false, error: 'The run finished without writing about.json.' };
  }
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: 'about.json is not valid JSON.' };
  }
  const parsed = graphicAboutSchema.safeParse(data);
  if (parsed.success) return { ok: true, about: parsed.data };
  const issue = parsed.error.issues[0];
  const field =
    issue === undefined || issue.path.length === 0 ? '' : ` at "${issue.path.join('.')}"`;
  return {
    ok: false,
    error: sentence(`about.json is not right${field}: ${issue?.message ?? 'it does not fit'}`),
  };
}

/** Takes HTML and CSS comments out, so an example in a comment is not taken for a reference. */
function withoutComments(text: string): string {
  return text.replace(/<!--[\s\S]*?-->/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

/** An attribute value or a url() argument as the text it means (entities for quotes and `&`). */
function unescapeValue(raw: string): string {
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&')
    .trim()
    .replace(/^["']|["']$/g, '')
    .trim();
}

/** What the composition names that the browser would fetch, in the order it is written. */
function referencesIn(html: string): string[] {
  const found: { at: number; value: string }[] = [];
  const add = (match: RegExpMatchArray, ...groups: (string | undefined)[]): void => {
    const value = groups.find((group) => group !== undefined);
    if (value !== undefined) found.push({ at: match.index ?? 0, value: unescapeValue(value) });
  };
  // src, href, poster and the composition mount; `data-var-src` holds a variable id, not a path.
  for (const match of html.matchAll(
    /(?<![\w-])(?:src|href|xlink:href|poster|data-composition-src)\s*=\s*(?:"([^"]*)"|'([^']*)')/gi,
  )) {
    add(match, match[1], match[2]);
  }
  for (const match of html.matchAll(/url\(\s*(?:"([^"]*)"|'([^']*)'|([^)'"\s][^)]*?))\s*\)/gi)) {
    add(match, match[1], match[2], match[3]);
  }
  for (const match of html.matchAll(/@import\s+["']([^"']+)["']/gi)) add(match, match[1]);
  return found.sort((a, b) => a.at - b.at).map((reference) => reference.value);
}

/** The first problem with one reference, or `null` when it is fine. */
async function problemWithReference(
  reference: string,
  workDir: string,
  file: string,
): Promise<string | null> {
  if (reference === '' || reference.startsWith('#')) return null;
  // Placeholders a script or a template fills in; nothing to look for on disk.
  if (reference.includes('${') || reference.includes('{{')) return null;
  if (/^(data|blob):/i.test(reference)) return null;
  if (/^(about|javascript):/i.test(reference)) return null;
  if (/^[a-z][a-z0-9+.-]*:/i.test(reference) && !/^[a-z]:[\\/]/i.test(reference)) {
    return `${file} loads ${reference} from the internet. A graphic can only use files inside its own folder.`;
  }
  if (reference.startsWith('//')) {
    return `${file} loads ${reference} from the internet. A graphic can only use files inside its own folder.`;
  }
  if (/^[/\\~]/.test(reference) || /^[a-z]:[\\/]/i.test(reference) || isAbsolute(reference)) {
    return `${file} uses the absolute path ${reference}. Paths must be relative to the graphic's folder.`;
  }
  const clean = reference.replace(/[?#].*$/, '');
  if (clean === '') return null;
  let decoded = clean;
  try {
    decoded = decodeURIComponent(clean);
  } catch {
    // not encoded: look for it as it is written
  }
  const target = resolve(workDir, decoded);
  const inside = relative(workDir, target);
  if (inside.startsWith('..') || isAbsolute(inside)) {
    return `${file} uses ${reference}, which is outside the graphic's folder.`;
  }
  try {
    await stat(target);
  } catch {
    return `${file} uses ${inside.split(sep).join('/')}, but that file is not there.`;
  }
  return null;
}

/** The ids declared in the composition's `data-composition-variables`, or why they cannot be read. */
function declaredVariables(html: string): { ids: Set<string> } | { error: string } {
  const ids = new Set<string>();
  for (const match of html.matchAll(/data-composition-variables\s*=\s*(?:"([^"]*)"|'([^']*)')/gi)) {
    const raw = unescapeValueKeepQuotes(match[1] ?? match[2] ?? '');
    try {
      const list: unknown = JSON.parse(raw);
      if (!Array.isArray(list)) throw new Error('not a list');
      for (const item of list) {
        const id = (item as { id?: unknown } | null)?.id;
        if (typeof id === 'string') ids.add(id);
      }
    } catch {
      return { error: 'The data-composition-variables of the graphic is not a valid JSON list.' };
    }
  }
  return { ids };
}

/** Entities in an attribute that holds JSON (its quotes may be written `&quot;`). */
function unescapeValueKeepQuotes(raw: string): string {
  return raw
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'")
    .replace(/&amp;/gi, '&');
}

/** Checks the run's work in `workDir` for the graphic `graphicId`. OWNER: GR1. */
export async function checkGraphicWork(
  workDir: string,
  graphicId: string,
): Promise<GraphicCheckResult> {
  const about = await readGraphicAbout(workDir);
  if (!about.ok) return about;

  const file = graphicCompositionPath(graphicId);
  const compositionId = `lib-${graphicId}`;
  let source: string;
  try {
    source = await readFile(join(workDir, file), 'utf8');
  } catch {
    return { ok: false, error: `The graphic file ${file} is missing.` };
  }
  const html = withoutComments(source);

  if (!/<template[\s>]/i.test(html)) {
    return { ok: false, error: `${file} has no <template>, so it cannot be mounted in a video.` };
  }

  const ids = [...html.matchAll(/data-composition-id\s*=\s*["']([^"']+)["']/gi)].map(
    (match) => match[1],
  );
  if (!ids.includes(compositionId)) {
    const found = ids[0];
    return {
      ok: false,
      error:
        found === undefined
          ? `${file} has no data-composition-id="${compositionId}".`
          : `${file} has the composition id "${found}" where it needs "${compositionId}".`,
    };
  }

  if (!new RegExp(`__timelines\\s*\\[\\s*["'\`]${compositionId}["'\`]\\s*\\]`).test(html)) {
    return {
      ok: false,
      error: `${file} does not register its timeline as window.__timelines["${compositionId}"].`,
    };
  }

  if (about.about.variables.length > 0) {
    const declared = declaredVariables(html);
    if ('error' in declared) return { ok: false, error: declared.error };
    const missing = about.about.variables.find((variable) => !declared.ids.has(variable.id));
    if (missing !== undefined) {
      return {
        ok: false,
        error: `${file} does not declare the text field "${missing.id}" from about.json in data-composition-variables.`,
      };
    }
  }

  for (const reference of referencesIn(html)) {
    const problem = await problemWithReference(reference, workDir, file);
    if (problem !== null) return { ok: false, error: problem };
  }
  return about;
}

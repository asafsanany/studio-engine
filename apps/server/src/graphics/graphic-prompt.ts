// The prompt of a graphic run (Graphics plan, "The run"). OWNER: GR2.
//
// apps/server/prompts/graphic-make.md (v1) and graphic-change.md (later versions), rendered with
// renderTemplate; both include the {{> graphic-rules}} partial: the graphic's rules, how to check
// it (the engine's check script: `npx hyperframes lint`, then snapshots at 9:16, 16:9 and 1:1 and
// after the end), the about.json shape, the unattended line, "You are done when about.json exists
// and the check passes", and the last line starting Blocked: on a real blocker.
//
// The engine computes every variable; text from the chat goes in as it is (renderTemplate reads
// a value once, so a `{{` in the owner's message is never taken for a variable):
//
//   {{asked}}         the owner's message, quoted ("> " lines)
//   {{conversation}}  the chat before it, oldest first, each message quoted the same way
//   {{refs}}          the files attached to their message, as ../refs/<name> lines
//   {{fonts}}         the shared fonts in ../fonts/, one line per folder
//   {{version}} {{id}}
//   {{checkScript}}   the absolute path of assets/graphics/check-graphic.mjs
//   {{nameRule}}      what about.json's `name` is: given on v1, left out on a change
//
// GR2's spike (CVP-266) set what the rules say: the graphic's root has no data-width/height, scripts
// read values with getVariables() (bindings are filled after the script runs), and a second size
// can only be snapshotted from a copy of the project with a host of that size, which is what
// check-graphic.mjs does.

import { join } from 'node:path';
import type { GraphicMessage } from '@studio/shared';
import { PROMPTS_DIR, readTemplate, renderTemplate } from '../pipeline/prompts.js';
import { GRAPHICS_ASSETS_DIR } from './graphic-assets.js';

/** The check a run does on its work: lint, then snapshots at the three sizes. */
export const GRAPHIC_CHECK_SCRIPT = join(GRAPHICS_ASSETS_DIR, 'check-graphic.mjs');

/** What the prompt is filled with. */
export interface GraphicPromptVars {
  /** The graphic's id (12 hex): its sub-composition is compositions/lib-<id>.html. */
  id: string;
  /** The version the run makes. */
  version: number;
  /** v1 (graphic-make.md) or a change (graphic-change.md). */
  first: boolean;
  /** {{asked}}: The owner's message this run answers. */
  asked: string;
  /** {{conversation}}: the earlier messages, oldest first, quoted as they are. */
  conversation: readonly GraphicMessage[];
  /** {{refs}}: the attached files' names inside refs/ (the prompt gives them as ../refs/<name>). */
  refs: readonly string[];
  /** {{fonts}}: the shared fonts' file names, as copied into the graphic's fonts/. */
  fonts: readonly string[];
}

/** A text as a Markdown quote: every line starts "> ". Empty lines stay quoted. */
export function quote(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .trim()
    .split('\n')
    .map((line) => (line.trim() === '' ? '>' : `> ${line}`))
    .join('\n');
}

/** A file name on one line: line breaks and other control characters become spaces. */
function flat(name: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: file names can hold them
  return name.replace(/[\u0000-\u001f\u007f]+/g, ' ');
}

/** `{{refs}}`: one `- ../refs/<name>` line per file, or "None." */
export function formatGraphicRefs(refs: readonly string[]): string {
  if (refs.length === 0) return 'None.';
  return refs.map((name) => `- ../refs/${flat(name)}`).join('\n');
}

/** `{{asked}}`: the message quoted, or a line saying it is only files. */
export function formatAsked(text: string): string {
  return text.trim() === '' ? '(No words: only the attached files.)' : quote(text);
}

/** Who said a message and how it ended, as the conversation names it. */
function speaker(message: GraphicMessage): string {
  if (message.role === 'you') return 'The owner';
  const version = message.version === null ? '' : ` v${message.version}`;
  switch (message.status) {
    case 'failed':
      return `Claude, making${version} (failed)`;
    case 'stopped':
      return `Claude, making${version} (stopped by the owner)`;
    case 'making':
      return `Claude, making${version}`;
    default:
      return `Claude${version}`;
  }
}

/** `{{conversation}}`: each earlier message as "Who:" and its text quoted, oldest first. */
export function formatConversation(messages: readonly GraphicMessage[]): string {
  if (messages.length === 0) return '(Nothing yet.)';
  return messages
    .map((message) => {
      const text = message.status === 'failed' && message.error ? message.error : message.text;
      const lines = [`${speaker(message)}:`];
      if (text.trim() !== '') lines.push(quote(text));
      if (message.refs.length > 0) {
        lines.push(`Attached: ${message.refs.map((name) => `../refs/${flat(name)}`).join(', ')}`);
      }
      return lines.join('\n');
    })
    .join('\n\n');
}

/** How many characters every one of `texts` starts with in common. */
function sharedStart(texts: readonly string[]): number {
  const [first = '', ...others] = texts;
  let i = 0;
  while (i < first.length && others.every((text) => text[i] === first[i])) i++;
  return i;
}

/**
 * One folder's font files as one list, folded around what they all start and end with where each
 * keeps a part of its own: Heebo-{Bold,Thin}.ttf. The start is cut back to its last "-" or "_",
 * so a fold never splits a word; otherwise the names are listed as they are.
 */
export function foldFontNames(names: readonly string[]): string {
  const plain = names.join(', ');
  if (names.length < 2 || names.some((name) => /[{},]/.test(name))) return plain;
  const start = sharedStart(names);
  const head =
    Math.max(
      names[0]?.lastIndexOf('-', start - 1) ?? -1,
      names[0]?.lastIndexOf('_', start - 1) ?? -1,
    ) + 1;
  const rests = names.map((name) => name.slice(head));
  const dot = rests.map((rest) => rest.lastIndexOf('.'));
  const extension = rests[0]?.slice(dot[0]) ?? '';
  if (
    head === 0 ||
    rests.some((rest, i) => (dot[i] ?? -1) <= 0 || rest.slice(dot[i]) !== extension)
  ) {
    return plain;
  }
  const middles = rests.map((rest, i) => rest.slice(0, dot[i]));
  return `${names[0]?.slice(0, head)}{${middles.join(',')}}${extension}`;
}

/** `{{fonts}}`: one `- <folder>/: <files>` line per folder of ../fonts/, or a line saying there are none. */
export function formatGraphicFonts(fonts: readonly string[]): string {
  if (fonts.length === 0) {
    return 'There are no shared fonts: use font-family: sans-serif, with no @font-face.';
  }
  const folders = new Map<string, string[]>();
  for (const font of [...fonts].sort()) {
    const slash = font.lastIndexOf('/');
    const folder = font.slice(0, slash + 1);
    folders.set(folder, [...(folders.get(folder) ?? []), flat(font.slice(slash + 1))]);
  }
  // The files at the top of fonts/ first (folder ''), then the folders in code point order.
  return [...folders]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([folder, names]) => `- ../fonts/${flat(folder)}: ${foldFontNames(names)}`)
    .join('\n');
}

/** `{{nameRule}}`: v1 names the graphic; a change keeps the name it has. */
export function nameRule(first: boolean): string {
  return first
    ? '`name`: what the graphic is called in the library, at most 60 characters, in plain words that say what it looks like ("Name on a white pill", "Big number that counts up").'
    : 'Leave `name` out: the graphic keeps the name it has.';
}

/** The whole prompt of a graphic run. Templates are read on every run, like the other prompts. */
export async function buildGraphicPrompt(
  vars: GraphicPromptVars,
  promptsDir: string = PROMPTS_DIR,
): Promise<string> {
  const values: Record<string, string> = {
    id: vars.id,
    version: String(vars.version),
    asked: formatAsked(vars.asked),
    conversation: formatConversation(vars.conversation),
    refs: formatGraphicRefs(vars.refs),
    fonts: formatGraphicFonts(vars.fonts),
    checkScript: GRAPHIC_CHECK_SCRIPT,
    nameRule: nameRule(vars.first),
  };
  const partials = { 'graphic-rules': await readTemplate(promptsDir, 'graphic-rules') };
  const template = await readTemplate(promptsDir, vars.first ? 'graphic-make' : 'graphic-change');
  return `${renderTemplate(template, values, partials).trim()}\n`;
}

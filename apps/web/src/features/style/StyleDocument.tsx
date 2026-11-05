import { createElement, type ElementType, type ReactNode } from 'react';
import Markdown, { type Components } from 'react-markdown';
import { cn } from '@/lib/utils';
import { PAGE_LINK_CLASS } from '@/pages/NotFoundPage';

/** The client's own words: each block picks its reading direction, and sits flush left. */
const TEXT = 'text-left [unicode-bidi:plaintext] text-pretty';

/**
 * A component for one Markdown element: `tag` with `className`, and `dir="auto"` when `bidi` (the
 * element holds text). react-markdown's own `node` prop is not passed on to the element.
 */
function element(tag: ElementType, className: string, bidi = false) {
  return ({ node: _node, ...props }: { node?: unknown; children?: ReactNode }) =>
    createElement(tag, { ...(bidi && { dir: 'auto' }), ...props, className });
}

const heading = (className: string) => cn(TEXT, 'font-semibold', className);

// The elements of a style.md, drawn as the Style board draws them. A style.md has a title, `##`
// sections, bullet lines and plain lines; the rest is here so that a hand-written file still reads.
const components: Components = {
  h1: element('h1', heading('my-1 text-2xl leading-tight tracking-[-0.02em]'), true),
  h2: element('h2', heading('pt-4 text-base leading-[1.4]'), true),
  h3: element('h3', heading('pt-2 text-sm'), true),
  h4: element('h4', heading('text-sm'), true),
  h5: element('h5', heading('text-sm'), true),
  h6: element('h6', heading('text-sm'), true),
  p: element('p', cn(TEXT, 'text-zinc-300'), true),
  // The bullets are drawn by the items, at the left whatever an item's direction: the browser's
  // own markers would go to the right of a Hebrew line. The dot sits where the board's disc
  // marker does: its right edge 12 px before the text (the glyph's own side bearing is 1.5 px).
  ul: element('ul', 'flex list-none flex-col gap-1 pl-5 text-zinc-300'),
  ol: element('ol', 'flex list-decimal flex-col gap-1 pl-5 text-zinc-300'),
  li: element(
    'li',
    cn(
      TEXT,
      "relative before:absolute before:-left-4.5 before:content-['•'] in-[ol]:before:hidden",
    ),
    true,
  ),
  a: ({ href, children }) => (
    <a href={href} target="_blank" rel="noreferrer noopener" className={PAGE_LINK_CLASS}>
      {children}
    </a>
  ),
  strong: element('strong', 'font-semibold text-foreground'),
  code: element('code', 'rounded bg-muted px-1 py-0.5 font-mono text-[13px]'),
  pre: element(
    'pre',
    'overflow-x-auto rounded-lg border bg-muted/30 p-3 font-mono text-[13px] [&_code]:bg-transparent [&_code]:p-0',
  ),
  blockquote: element('blockquote', 'border-l-2 pl-3 text-muted-foreground'),
  hr: element('hr', 'my-2 border-border'),
  // A picture in a style.md names a file in the style folder, not an address the page can load.
  img: () => null,
};

/**
 * A client's style.md, rendered. Plain Markdown and nothing else: no HTML (react-markdown shows it
 * as text), no pictures, and links open in a new tab. The caller sets the column (680 px).
 */
export function StyleDocument({ markdown }: { markdown: string }) {
  return (
    <div className="flex flex-col gap-3" data-slot="style-document">
      <Markdown components={components}>{markdown}</Markdown>
    </div>
  );
}

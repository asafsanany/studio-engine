import type { ComponentPropsWithoutRef, ElementType } from 'react';
import { cn } from '@/lib/utils';

/**
 * Text that may be Latin, Hebrew or mixed (job names, client names, search input).
 *
 * `dir="auto"` + the `.bidi` class (index.css: `unicode-bidi: plaintext`, left aligned,
 * ellipsis) let each string pick its own reading direction while every string in a column
 * keeps the same left edge. Use it for any user-authored text; the same two attributes can be
 * spread onto an `<input>` via `bidiProps`.
 */
export const bidiProps = { dir: 'auto', className: 'bidi' } as const;

type BidiProps<T extends ElementType> = { as?: T } & Omit<ComponentPropsWithoutRef<T>, 'as'>;

export function Bidi<T extends ElementType = 'span'>({
  as,
  className,
  ...rest
}: BidiProps<T>): React.JSX.Element {
  const Tag: ElementType = as ?? 'span';
  return <Tag dir="auto" className={cn(bidiProps.className, className)} {...rest} />;
}

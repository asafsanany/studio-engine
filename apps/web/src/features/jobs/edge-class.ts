import { cn } from '@/lib/utils';

/**
 * Horizontal padding of a table cell: the first and last cells of a row carry the 12 px row
 * padding, the others half of the 12 px gap between columns. Body rows and skeleton rows share it
 * so a skeleton sits exactly where the content will.
 */
export const edgeClass = (first: boolean, last: boolean) =>
  cn('px-1.5', first && 'pl-3', last && 'pr-3');

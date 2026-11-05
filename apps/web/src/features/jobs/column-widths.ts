// What is left of the Jobs table's column layout: the cell widths of a fixed-layout table with
// 12 px between its columns and 12 px of room at its two ends. The Jobs page is a list now; the
// Clients table, which is still a table, lays its columns out with these.

/** Space between two columns, in px. */
export const COLUMN_GAP = 12;
/** Space between the table's left and right edges and its first and last column, in px. */
export const EDGE_PADDING = 12;

/**
 * The width of a column's header and body cells, in px: the content plus half of each neighbouring
 * gap, and the row padding instead of a half gap at the table's two ends.
 */
export function cellWidth(content: number, index: number, count: number): number {
  const before = index === 0 ? EDGE_PADDING : COLUMN_GAP / 2;
  const after = index === count - 1 ? EDGE_PADDING : COLUMN_GAP / 2;
  return content + before + after;
}

/** The width of the whole table: every cell width added up. */
export function tableWidth(contentWidths: readonly number[]): number {
  return contentWidths.reduce(
    (sum, width, index) => sum + cellWidth(width, index, contentWidths.length),
    0,
  );
}

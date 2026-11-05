// Opening the first family an import added, as plain TypeScript so the rule is tested without a
// browser. The list opens its own first row whenever the address names a family that is not in what
// it shows (`?family=` empty, or a family that has not arrived yet), so asking for the new family
// at the moment the import answers can be undone by the list a moment later. The page therefore
// asks again until the address names it, as soon as the list has the family.

/** How many times the new family is asked for before giving up (a tab that hides it, say). */
export const OPEN_IMPORTED_TRIES = 3;

export type OpenImportedStep =
  /** Nothing is waiting to be opened. */
  | 'idle'
  /** The address names the family (or the tries are used up): stop asking. */
  | 'done'
  /** The list does not have the family yet: wait for it. */
  | 'wait'
  /** The list has it and the address does not name it: set the address. */
  | 'open';

export function openImportedStep({
  wanted,
  selected,
  slugs,
  tries,
}: {
  /** The slug the import asked for, or `null`. */
  wanted: string | null;
  /** What the address names now. */
  selected: string | null;
  /** The families the list has, or `undefined` before its first answer. */
  slugs: readonly string[] | undefined;
  /** How many times the address was already set for `wanted`. */
  tries: number;
}): OpenImportedStep {
  if (wanted === null) return 'idle';
  if (selected === wanted || tries >= OPEN_IMPORTED_TRIES) return 'done';
  return slugs?.includes(wanted) ? 'open' : 'wait';
}

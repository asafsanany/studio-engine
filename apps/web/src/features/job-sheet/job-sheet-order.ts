// Where the open job is in the list: the page the list turns to when a job opens.

/** The zero-based page of the list a job is on, or `null` when the list does not show it. */
export function pageOfJob(shown: readonly string[], id: string, pageSize: number): number | null {
  const at = shown.indexOf(id);
  return at < 0 ? null : Math.floor(at / pageSize);
}

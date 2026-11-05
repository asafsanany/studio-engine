// The Delete… dialog's one effectful step, kept apart from the page so it can be driven in a test
// with plain functions (the page has no DOM test, and this is what a mistake here would break).

/** The graphic the dialog is asking about. */
export interface DeleteTarget {
  id: string;
  name: string;
}

/** What the dialog does while the engine works and when it is done. */
export interface DeleteDialogUi {
  /** Both buttons wait while the delete is on its way. */
  setPending(pending: boolean): void;
  /** Closes the dialog. */
  close(): void;
}

/**
 * Delete was pressed: the dialog waits (spinner, "Deleting…") until the engine has answered, then
 * closes whatever the answer was. A refusal is said by the action itself (a toast), and the
 * graphic stays in the list.
 */
export async function runDelete(
  target: DeleteTarget,
  remove: (id: string, name: string) => Promise<boolean>,
  ui: DeleteDialogUi,
): Promise<boolean> {
  ui.setPending(true);
  try {
    return await remove(target.id, target.name);
  } finally {
    ui.setPending(false);
    ui.close();
  }
}

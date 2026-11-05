import { Link } from '@tanstack/react-router';
import { type ReactNode, useId, useState } from 'react';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { assignableEditors, displayName, useSetAssignees, useTeam } from '@/data';
import { Bidi } from '@/lib/bidi';
import { cn } from '@/lib/utils';
import { teamErrorText } from '../../team/team-text';
import type { AssignTarget } from './assign-dialog';
import { editorsToSend, tickedAfter } from './assign-selection';
import { ASSIGN_TEXT } from './assign-text';

/**
 * The body of "Assign to…": a checkbox per editor (an admin sees every client, so admins are not
 * listed), ticked for the editors the client is assigned to now. Save sends the new list (it
 * replaces the old one) and refreshes the team and the client list; a refusal is said under the
 * list. Used in the Mac's dialog and in the phone's sheet (`phone` sets the roomier rows).
 */
export function AssignToForm({
  client,
  onDone,
  phone = false,
  footer: Footer = DefaultFooter,
}: {
  client: AssignTarget;
  /** Called after a successful save, and by Cancel. */
  onDone: () => void;
  phone?: boolean;
  footer?: (props: AssignFooterProps) => ReactNode;
}) {
  const { data: team, isError } = useTeam();
  const save = useSetAssignees();
  const id = useId();
  const [picked, setPicked] = useState<ReadonlySet<string> | null>(null);

  const editors = assignableEditors(team);
  const saved = team?.assignments[client.clientId]?.editors ?? [];
  const ticked = picked ?? new Set(saved);

  function toggle(email: string, on: boolean) {
    setPicked(tickedAfter(ticked, email, on));
    save.reset();
  }

  function submit() {
    if (save.isPending) return;
    save.mutate(
      { clientId: client.clientId, editors: editorsToSend(editors, ticked) },
      { onSuccess: onDone },
    );
  }

  return (
    <form
      className="flex flex-col gap-4"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      {team === undefined ? (
        <p role={isError ? 'alert' : 'status'} className="text-sm text-muted-foreground">
          {isError ? ASSIGN_TEXT.cantLoad : ASSIGN_TEXT.loading}
        </p>
      ) : editors.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          {ASSIGN_TEXT.noEditors}{' '}
          <Link
            to="/settings/team"
            onClick={onDone}
            className="text-foreground underline underline-offset-3"
          >
            {ASSIGN_TEXT.addOne}
          </Link>
          .
        </p>
      ) : (
        <ul aria-label="Editors" className="flex flex-col">
          {editors.map((user, index) => (
            <li key={user.email}>
              <label
                htmlFor={`${id}-${index}`}
                className={cn(
                  'flex cursor-pointer items-center gap-3 rounded-md px-2 hover:bg-muted/50',
                  phone ? 'min-h-12' : 'min-h-10',
                )}
              >
                <Checkbox
                  id={`${id}-${index}`}
                  checked={ticked.has(user.email)}
                  onCheckedChange={(checked) => toggle(user.email, checked === true)}
                />
                <span className="min-w-0 flex-1 truncate font-medium">
                  <Bidi>{displayName(user)}</Bidi>
                </span>
                <span className="truncate text-sm text-muted-foreground">{user.email}</span>
              </label>
            </li>
          ))}
        </ul>
      )}

      {save.isError && (
        <p role="alert" className="text-sm text-destructive">
          {teamErrorText(save.error, ASSIGN_TEXT.failed)}
        </p>
      )}

      <Footer
        saving={save.isPending}
        canSave={team !== undefined && editors.length > 0}
        onCancel={onDone}
      />
    </form>
  );
}

/** What a footer of the form is given. */
export interface AssignFooterProps {
  saving: boolean;
  canSave: boolean;
  onCancel: () => void;
}

/** Cancel and Save, the dialog's footer. */
function DefaultFooter({ saving, canSave, onCancel }: AssignFooterProps) {
  return (
    <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
      <Button type="button" variant="outline" onClick={onCancel}>
        {ASSIGN_TEXT.cancel}
      </Button>
      <Button type="submit" disabled={saving || !canSave}>
        {saving ? ASSIGN_TEXT.saving : ASSIGN_TEXT.save}
      </Button>
    </div>
  );
}

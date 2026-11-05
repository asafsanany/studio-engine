import type { TeamResponse, TeamUser } from '@studio/shared';
import { Loader2, ShieldCheck, Trash2, UserRound } from 'lucide-react';
import { useState } from 'react';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from '@/components/ui/table';
import {
  clientsOfPerson,
  displayName,
  roleLabel,
  useRemoveTeamUser,
  useUpdateTeamUser,
} from '@/data';
import { Bidi } from '@/lib/bidi';
import { SKELETON_DELAY_MS, useDelayedFlag } from '../jobs/delayed-flag';
import { MENU_WIDTH, RowMenuItemView } from '../jobs/JobRow';
import { UnreachableRow } from '../jobs/JobsTableStates';
import { isContextMenuKey, openMenuFromKeyboard } from '../jobs/row-menu-key';
import {
  changeRoleLabel,
  REMOVE_WARNING,
  removeTitle,
  TEAM_TEXT,
  teamErrorText,
} from './team-text';

const COLUMNS = ['Name', 'Login', 'Role', 'Clients'] as const;

export interface TeamTableProps {
  /** The team from `useTeam()`: `undefined` until the first answer. */
  team: TeamResponse | undefined;
  /** The first load failed. Read only while `team` is `undefined`. */
  failed?: boolean;
  onRetry?: () => void;
  /** How long the first load may take before skeleton rows appear. */
  skeletonDelayMs?: number;
}

/** What the Clients column says for a person: every client for an admin, the assigned ones for an editor. */
function ClientsCell({ user, team }: { user: TeamUser; team: TeamResponse }) {
  if (user.role === 'admin')
    return <span className="text-muted-foreground">{TEAM_TEXT.allClients}</span>;
  const clients = clientsOfPerson(team, user.email);
  if (clients.length === 0)
    return <span className="text-muted-foreground">{TEAM_TEXT.noClients}</span>;
  const names = clients.join(', ');
  return <Bidi title={names}>{names}</Bidi>;
}

function TeamRow({
  user,
  team,
  onRemove,
}: {
  user: TeamUser;
  team: TeamResponse;
  onRemove: (user: TeamUser) => void;
}) {
  const update = useUpdateTeamUser();
  const [refused, setRefused] = useState<string | null>(null);
  const nextRole = user.role === 'admin' ? 'editor' : 'admin';

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <TableRow
          data-team-email={user.email}
          tabIndex={0}
          aria-label={`${displayName(user)}, ${roleLabel(user.role)}`}
          className="h-[57px] outline-none data-[state=open]:bg-muted/50 focus-visible:bg-muted/50 focus-visible:outline-solid focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-foreground/30"
          onKeyDown={(event) => {
            if (!isContextMenuKey(event)) return;
            event.preventDefault();
            openMenuFromKeyboard(event.currentTarget, event.target as Element);
          }}
        >
          <TableCell className="py-0 pl-3 font-medium">
            <Bidi>{displayName(user)}</Bidi>
          </TableCell>
          <TableCell className="py-0 text-muted-foreground">{user.email}</TableCell>
          <TableCell className="py-0">
            {roleLabel(user.role)}
            {refused !== null && (
              <span role="alert" className="ml-2 text-sm text-destructive">
                {refused}
              </span>
            )}
          </TableCell>
          <TableCell className="max-w-0 py-0 pr-3">
            <ClientsCell user={user} team={team} />
          </TableCell>
        </TableRow>
      </ContextMenuTrigger>
      <ContextMenuContent className={MENU_WIDTH} aria-label={`Actions for ${displayName(user)}`}>
        <RowMenuItemView
          item={{
            type: 'item',
            id: 'role',
            label: changeRoleLabel(user.role),
            icon: nextRole === 'admin' ? ShieldCheck : UserRound,
            onSelect: () => {
              setRefused(null);
              update.mutate(
                { email: user.email, patch: { role: nextRole } },
                { onError: (error) => setRefused(teamErrorText(error, TEAM_TEXT.roleFailed)) },
              );
            },
          }}
        />
        <ContextMenuSeparator />
        <RowMenuItemView
          item={{
            type: 'item',
            id: 'remove',
            label: `${TEAM_TEXT.remove}…`,
            icon: Trash2,
            destructive: true,
            onSelect: () => onRemove(user),
          }}
        />
      </ContextMenuContent>
    </ContextMenu>
  );
}

/** "Remove Yael?": the confirm dialog of the row menu's Remove…. */
export function RemovePersonDialog({
  user,
  onClose,
}: {
  user: TeamUser | null;
  onClose: () => void;
}) {
  const remove = useRemoveTeamUser();
  const [error, setError] = useState<string | null>(null);
  const pending = remove.isPending;

  function close() {
    setError(null);
    remove.reset();
    onClose();
  }

  return (
    <AlertDialog
      open={user !== null}
      onOpenChange={(open) => {
        if (!open && !pending) close();
      }}
    >
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle className="leading-[1.43]">
            {error === null ? removeTitle(user ? displayName(user) : '') : TEAM_TEXT.removeFailed}
          </AlertDialogTitle>
          <AlertDialogDescription>{error ?? REMOVE_WARNING}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel variant="outline" disabled={pending}>
            {error === null ? TEAM_TEXT.removeKeep : 'OK'}
          </AlertDialogCancel>
          {error === null && (
            <AlertDialogAction
              variant="destructive"
              disabled={pending}
              aria-busy={pending}
              onClick={(event) => {
                // Radix would close the dialog now; it closes when the answer is in.
                event.preventDefault();
                if (user === null) return;
                remove.mutate(user.email, {
                  onSuccess: close,
                  onError: (err) => setError(teamErrorText(err, TEAM_TEXT.removeFailed)),
                });
              }}
            >
              {pending && <Loader2 aria-hidden="true" className="animate-spin" />}
              {pending ? TEAM_TEXT.removing : TEAM_TEXT.remove}
            </AlertDialogAction>
          )}
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function LoadingTeamRows() {
  return [0, 1].map((row) => (
    <TableRow key={row} data-skeleton-row="" className="h-[57px] hover:bg-transparent">
      {COLUMNS.map((name, i) => (
        <TableCell key={name} className="py-0 pl-3">
          {row === 0 && i === 0 && (
            <span role="status" className="sr-only">
              Loading the team…
            </span>
          )}
          <Skeleton className="h-4 w-28 motion-reduce:animate-none" />
        </TableCell>
      ))}
    </TableRow>
  ));
}

/**
 * The Team table: Name, Login, Role, Clients, in the Clients table's look (the shadcn Table in a
 * bordered frame). Right-click a row for Make admin / Make editor and Remove…. The body is one of:
 * skeleton rows (only once the first answer has taken a quarter of a second), "Can't load the team.",
 * "No one on the team yet." or the people.
 */
export function TeamTable({
  team,
  failed = false,
  onRetry,
  skeletonDelayMs = SKELETON_DELAY_MS,
}: TeamTableProps) {
  const [removing, setRemoving] = useState<TeamUser | null>(null);
  const loading = team === undefined && !failed;
  const showSkeleton = useDelayedFlag(loading, skeletonDelayMs);

  return (
    <>
      <div className="overflow-hidden rounded-md border">
        <Table aria-label="Team" className="w-full table-fixed" style={{ minWidth: 720 }}>
          <colgroup>
            <col style={{ width: '22%' }} />
            <col style={{ width: '28%' }} />
            <col style={{ width: '14%' }} />
            <col />
          </colgroup>
          <TableHeader>
            <TableRow className="hover:bg-transparent">
              {COLUMNS.map((name, i) => (
                <TableHead
                  key={name}
                  scope="col"
                  className={i === 0 ? 'pl-3 text-muted-foreground' : 'text-muted-foreground'}
                >
                  {name}
                </TableHead>
              ))}
            </TableRow>
          </TableHeader>
          <TableBody aria-busy={loading || undefined}>
            {loading && showSkeleton && <LoadingTeamRows />}
            {team === undefined && failed && (
              <UnreachableRow columnCount={COLUMNS.length} onRetry={() => onRetry?.()} />
            )}
            {team !== undefined && team.users.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={COLUMNS.length} className="p-0 whitespace-normal">
                  <div className="flex h-40 flex-col items-center justify-center gap-1 px-3 text-center">
                    <p className="font-medium">{TEAM_TEXT.empty}</p>
                    <p className="text-muted-foreground">{TEAM_TEXT.emptyHint}</p>
                  </div>
                </TableCell>
              </TableRow>
            )}
            {team?.users.map((user) => (
              <TeamRow key={user.email} user={user} team={team} onRemove={setRemoving} />
            ))}
          </TableBody>
        </Table>
      </div>
      <RemovePersonDialog user={removing} onClose={() => setRemoving(null)} />
    </>
  );
}

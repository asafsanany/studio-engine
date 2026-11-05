import { jobsUnreachable, useTeam } from '@/data';
import { AddPersonDialog } from '@/features/team/AddPersonDialog';
import { TeamTable } from '@/features/team/TeamTable';
import { TEAM_TEXT } from '@/features/team/team-text';

/**
 * The Team page (Settings › Team, the admin's only; Mac only): who can open the engine besides you
 * and which clients each editor sees. A title with a line under it, Add person at the right, and
 * the table of people. Assigning a client is done from the Clients list (right-click a client ›
 * Assign to…).
 */
export function TeamPage() {
  const { data: team, isError, failureCount, refetch } = useTeam();
  return (
    <>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            {TEAM_TEXT.title}
          </h1>
          <p className="text-muted-foreground">{TEAM_TEXT.intro}</p>
        </div>
        <AddPersonDialog />
      </div>
      <TeamTable
        team={team}
        failed={jobsUnreachable({ data: team, isError, failureCount })}
        onRetry={() => void refetch()}
      />
    </>
  );
}

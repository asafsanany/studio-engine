/** The words of a client page that has no job yet. */
export const NO_JOBS_TEXT = {
  title: 'No jobs yet.',
  drop: 'Drop a job folder into',
  setUp: 'You can set up the style first.',
} as const;

/**
 * What a client's page shows in place of the jobs table while the client has no job: a job folder
 * goes into the client's folder, and the style can be shaped before the first one arrives (the
 * Style button above stays). Drawn like the other empty states: a bordered box, centred.
 */
export function NoJobsYet() {
  return (
    <div
      data-slot="no-jobs-yet"
      className="flex h-40 flex-col items-center justify-center gap-1 rounded-md border px-3 text-center"
    >
      <p className="font-medium">{NO_JOBS_TEXT.title}</p>
      <p className="text-pretty text-muted-foreground">
        {NO_JOBS_TEXT.drop}{' '}
        <code className="font-mono text-[13px] text-foreground">
          Studio Inbox/&lt;client&gt;/&lt;job&gt;
        </code>
        . {NO_JOBS_TEXT.setUp}
      </p>
    </div>
  );
}

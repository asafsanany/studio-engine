import { Link } from '@tanstack/react-router';

/** The link style of the Jobs table's "Try again": the canvas's blue, underlined. */
export const PAGE_LINK_CLASS = 'text-blue-300 underline hover:text-blue-200';

/** An address that is none of the app's pages. */
export function NotFoundPage() {
  return (
    <div className="flex h-40 flex-col items-center justify-center gap-1 rounded-md border text-center">
      <p className="font-medium">No such page.</p>
      <Link to="/jobs" className={PAGE_LINK_CLASS}>
        Back to Jobs
      </Link>
    </div>
  );
}

import { useListedJobs } from '@/data';
import { JobsListSection } from '@/features/jobs/JobsListSection';
import { JobsToolbar } from '@/features/jobs/JobsToolbar';

/** The Jobs page: title, then the toolbar (status tabs and search) and the list of jobs. */
export function JobsPage() {
  const { data: jobs } = useListedJobs();
  return (
    <>
      <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">Jobs</h1>
      <JobsToolbar jobs={jobs} />
      <JobsListSection />
    </>
  );
}

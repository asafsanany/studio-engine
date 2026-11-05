import type { FontRequest } from '@studio/shared';
import { toast } from 'sonner';
import { useDismissFontRequest, useJobs } from '@/data';
import { messageOf } from './font-actions';
import { MissingFontBanner } from './MissingFontBanner';

/**
 * The bar for a font a note asked for, with the job list beside it: while the job that asked is
 * still editing the bar says the edit "is using" the closest font, and "used" once it has finished
 * or while the page does not know the job's state (C51). Its own component, so the jobs are only
 * asked for while a request is open, and never with the notes switch off (the Fonts page does not
 * mount it then). It also holds "Not a font" (C52): the engine dismisses the request, and the list
 * (the cache the page reads) takes it out, so the bar shows the next one or goes away. A refusal
 * is said in a toast in the engine's words.
 */
export function MissingFontBar({
  requests,
  offline,
  onImport,
}: {
  requests: readonly FontRequest[];
  offline: boolean;
  onImport: () => void;
}) {
  const jobs = useJobs();
  const { mutate: dismiss, isPending } = useDismissFontRequest();
  return (
    <MissingFontBanner
      requests={requests}
      offline={offline}
      jobs={jobs.data}
      onImport={onImport}
      dismissing={isPending}
      onDismiss={(request) =>
        dismiss(request.id, { onError: (error) => toast.error(messageOf(error)) })
      }
    />
  );
}

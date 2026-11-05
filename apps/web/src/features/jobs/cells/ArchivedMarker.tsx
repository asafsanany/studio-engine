import { Archive } from 'lucide-react';
import { archivedDay } from '../delivery-text';
import { HoverMarker } from './HoverMarker';

/**
 * The mark that says a job is archived (it only shows with Show archived on): a muted 14 px box
 * after the job's name and client. Its name is "Archived"; hovering or focusing it shows when, as
 * "Archived 21 Oct".
 */
export function ArchivedMarker({ archivedAt }: { archivedAt: string }) {
  return (
    <HoverMarker icon={Archive} label="Archived">
      {`Archived ${archivedDay(archivedAt)}`}
    </HoverMarker>
  );
}

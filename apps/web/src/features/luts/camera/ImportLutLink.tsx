import { Link } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { useLutsEnabled } from '@/data';
import { IMPORT_LUT_LABEL } from './camera-wait';

/**
 * The ghost "Import LUT" button of a job that waits for a camera LUT, in its row and in its sheet
 * (LU10): it opens the LUTs page with the import dialog for that job (`/luts?for=<job id>`). Nothing
 * while the LUTs page is off. A click here is its own: it never opens the sheet behind it.
 */
export function ImportLutLink({ jobId, className }: { jobId: string; className?: string }) {
  const enabled = useLutsEnabled();
  if (!enabled) return null;
  return (
    <Button asChild variant="ghost" size="xs" className={className} data-slot="import-lut">
      <Link to="/luts" search={{ for: jobId }}>
        {IMPORT_LUT_LABEL}
      </Link>
    </Button>
  );
}

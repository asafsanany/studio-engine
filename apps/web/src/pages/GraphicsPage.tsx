import { useNavigate } from '@tanstack/react-router';
import { Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { jobsUnreachable, useGraphics } from '@/data';
import { GraphicsList } from '@/features/graphics/list/GraphicsList';
import { OfflineGraphicsBanner } from '@/features/graphics/list/GraphicsListStates';
import { GRAPHICS_TEXT } from '@/features/graphics/list/graphic-list';
import { useEngineLastHeard, useEngineOffline } from '@/features/phone/use-engine-offline';

/**
 * The Graphics page (Graphics plan, "List"; boards GRLibrary and GRStates): the library, newest
 * change first. The heading with its one line and New graphic, then the toolbar and the list. It
 * only exists while the Graphics switch is on (the route shows Not found otherwise), and only on
 * the Mac.
 *
 * Live: the list follows the engine's `graphic.changed` and `graphic.removed` events (GR0's cache
 * handling), so a graphic that is being made spins, then shows its kind, with no refresh.
 *
 * When the engine can't be reached for more than a few seconds a bar says so above the page. The
 * list stays as it was, and New graphic waits until the engine answers (the same watch the phone's
 * "Can't reach your Mac" screen uses). If the list never arrived, the list's own "Can't reach the
 * engine." and "Try again" say it instead. What a row can't do (a name taken, a failed Show in
 * Finder) is said as a toast, drawn by the toaster the Graphics layout mounts (router.tsx).
 */
export function GraphicsPage({ skeletonDelayMs }: { skeletonDelayMs?: number }) {
  const { data, isError, failureCount, refetch } = useGraphics();
  const unreachable = jobsUnreachable({ data, isError, failureCount });
  const offline = useEngineOffline();
  const heardAt = useEngineLastHeard();
  const navigate = useNavigate();
  const canCreate = !offline && !unreachable;
  const newGraphic = () => void navigate({ to: '/graphics/new' });

  return (
    <div className="flex min-h-[calc(100svh-7.5rem)] flex-col gap-4">
      {offline && data !== undefined && <OfflineGraphicsBanner heardAt={heardAt} />}
      <div className="flex items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl leading-tight font-semibold tracking-[-0.02em]">
            {GRAPHICS_TEXT.title}
          </h1>
          <p className="text-muted-foreground">{GRAPHICS_TEXT.intro}</p>
        </div>
        <Button type="button" disabled={!canCreate} onClick={newGraphic} className="flex-none">
          <Plus aria-hidden="true" />
          {GRAPHICS_TEXT.newGraphic}
        </Button>
      </div>
      <GraphicsList
        graphics={data}
        failed={unreachable}
        onRetry={() => void refetch()}
        onNew={newGraphic}
        canCreate={canCreate}
        skeletonDelayMs={skeletonDelayMs}
      />
    </div>
  );
}

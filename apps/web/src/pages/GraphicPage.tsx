import { GraphicStudio } from '@/features/graphics/studio/GraphicStudio';

/**
 * One graphic's page (Graphics plan, "Studio"): its chat, its preview and what edits know of it.
 * `id` undefined is /graphics/new, the empty studio. It only exists while the Graphics switch is
 * on (the route shows Not found otherwise), and only on the Mac.
 */
export function GraphicPage({ id }: { id: string | undefined }) {
  return <GraphicStudio id={id} />;
}

import { renderToStaticMarkup } from 'react-dom/server';
import { TooltipProvider } from '@/components/ui/tooltip';

/** Server-render `node` inside the TooltipProvider every tooltip needs. */
export function render(node: React.ReactNode): string {
  return renderToStaticMarkup(<TooltipProvider>{node}</TooltipProvider>);
}

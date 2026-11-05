import { Link } from '@tanstack/react-router';
import { Fragment } from 'react';
import {
  Breadcrumb,
  BreadcrumbItem,
  BreadcrumbLink,
  BreadcrumbList,
  BreadcrumbPage,
  BreadcrumbSeparator,
} from '@/components/ui/breadcrumb';
import { cn } from '@/lib/utils';
import type { Crumb } from './breadcrumbs';

/** A client's name in the trail: flush left whatever its script, and cut short with an ellipsis. */
const BIDI_CRUMB = 'bidi max-w-48 sm:max-w-80';

/**
 * "Studio Engine › <crumbs>": the root is muted text (there is nowhere above it to go), every
 * crumb but the last links to its page, and the last is the page that is open. On a phone the root
 * and its chevron are dropped so the header stays on one line.
 */
export function AppBreadcrumb({ crumbs }: { crumbs: readonly Crumb[] }) {
  return (
    <Breadcrumb className="min-w-0">
      <BreadcrumbList className="flex-nowrap">
        <BreadcrumbItem className="shrink-0 whitespace-nowrap max-sm:hidden">
          Studio Engine
        </BreadcrumbItem>
        <BreadcrumbSeparator className="max-sm:hidden" />
        {crumbs.map((crumb, i) => {
          const last = i === crumbs.length - 1;
          return (
            <Fragment key={`${crumb.link?.to ?? 'page'}:${crumb.label}`}>
              {/* The last step and a client's name (cut short by its ellipsis) give way when the
                  header is tight; the other steps keep one line. */}
              <BreadcrumbItem
                className={cn(last || crumb.bidi ? 'min-w-0' : 'shrink-0 whitespace-nowrap')}
              >
                {last || !crumb.link ? (
                  <BreadcrumbPage
                    {...(crumb.bidi && { dir: 'auto' })}
                    className={cn(crumb.bidi && BIDI_CRUMB)}
                  >
                    {crumb.label}
                  </BreadcrumbPage>
                ) : (
                  <BreadcrumbLink
                    asChild
                    {...(crumb.bidi && { dir: 'auto' })}
                    className={cn(crumb.bidi && BIDI_CRUMB)}
                  >
                    {crumb.link.to === '/clients/$clientId' ? (
                      <Link to={crumb.link.to} params={crumb.link.params}>
                        {crumb.label}
                      </Link>
                    ) : (
                      <Link to={crumb.link.to}>{crumb.label}</Link>
                    )}
                  </BreadcrumbLink>
                )}
              </BreadcrumbItem>
              {!last && <BreadcrumbSeparator />}
            </Fragment>
          );
        })}
      </BreadcrumbList>
    </Breadcrumb>
  );
}

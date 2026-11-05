import { Link, useRouterState } from '@tanstack/react-router';
import { PanelLeft } from 'lucide-react';
import { Clapperboard } from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from '@/components/ui/sidebar';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import {
  useAnalyticsEnabled,
  useDmsEnabled,
  useFontsEnabled,
  useGraphicsEnabled,
  useIsAdmin,
  useLutsEnabled,
} from '@/data';
import { cn } from '@/lib/utils';
import {
  comingSoonLabel,
  comingSoonTooltip,
  type FutureNavItem,
  navItemForPath,
  navItemsFor,
  type PageNavItem,
} from './nav-items';
import { SidebarVersion } from './SidebarVersion';
import { SidebarViewer } from './SidebarViewer';

/** Logo mark and name. Collapsed to the icon rail, only the mark stays. */
function Brand() {
  return (
    <SidebarHeader className="h-14 flex-row items-center gap-2.5 overflow-hidden border-b border-sidebar-border px-4 py-0 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:px-0">
      <span
        aria-hidden="true"
        className="flex size-7 flex-none items-center justify-center rounded-md bg-primary text-primary-foreground"
      >
        <Clapperboard className="size-4" />
      </span>
      <span className="text-sm font-semibold whitespace-nowrap group-data-[collapsible=icon]:hidden">
        Studio Engine
      </span>
    </SidebarHeader>
  );
}

/**
 * A page that exists (Jobs, Clients, Money, Settings, and Analytics while its switch is on): a real link to it, with a tooltip only on the icon rail. The
 * one the open page belongs to is marked as the current page.
 */
function PageLink({ item, active }: { item: PageNavItem; active: boolean }) {
  return (
    <SidebarMenuItem className={cn(item.bottom && 'mt-auto')}>
      <SidebarMenuButton asChild isActive={active} tooltip={item.label}>
        <Link
          to={item.to}
          aria-current={active ? 'page' : undefined}
          // The router counts /settings/team as under /settings; Team is its own item, so Settings
          // is current only at /settings itself.
          activeOptions={item.to === '/settings' ? { exact: true } : undefined}
        >
          <item.icon />
          <span>{item.label}</span>
        </Link>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/**
 * A page that comes in a later phase. It is a button (not a link) with `aria-disabled`, so it
 * can't navigate but stays focusable and its tooltip is reachable by keyboard.
 */
function DisabledNavItem({ item, iconRail }: { item: FutureNavItem; iconRail: boolean }) {
  return (
    <SidebarMenuItem className={cn(item.bottom && 'mt-auto')}>
      <SidebarMenuButton
        type="button"
        aria-disabled="true"
        aria-label={comingSoonLabel(item.label)}
        // Always show the tooltip (the primitive hides it unless the sidebar is collapsed).
        tooltip={{ children: comingSoonTooltip(item.label, iconRail), hidden: false }}
        onClick={(event) => event.preventDefault()}
        // The primitive's aria-disabled style (pointer-events: none) would also kill the tooltip
        // and the not-allowed cursor, so it is replaced: 60% opacity, no hover/press highlight.
        className="cursor-not-allowed text-muted-foreground opacity-60 hover:bg-transparent hover:text-muted-foreground active:bg-transparent active:text-muted-foreground aria-disabled:pointer-events-auto aria-disabled:opacity-60"
      >
        <item.icon />
        <span>{item.label}</span>
      </SidebarMenuButton>
    </SidebarMenuItem>
  );
}

/** Collapse / expand toggle. Remembered per browser (cookie) and bound to Cmd/Ctrl+B. */
function SidebarToggle({ collapsed }: { collapsed: boolean }) {
  const { toggleSidebar } = useSidebar();
  const label = collapsed ? 'Expand sidebar' : 'Collapse sidebar';

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          aria-label={label}
          aria-expanded={!collapsed}
          // Canvas: muted icon, accent background on hover, label colour unchanged.
          className="rounded-sm text-muted-foreground hover:text-muted-foreground dark:hover:bg-accent"
          onClick={toggleSidebar}
        >
          <PanelLeft />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="right">{label}</TooltipContent>
    </Tooltip>
  );
}

/**
 * The app sidebar: 224 px expanded, 48 px icon rail collapsed; an off-canvas sheet below 768 px.
 */
export function AppSidebar() {
  const { state, isMobile } = useSidebar();
  const collapsed = state === 'collapsed';
  // The sheet always shows full labels, whatever the desktop state is.
  const iconRail = collapsed && !isMobile;
  const pathname = useRouterState({ select: (state) => state.location.pathname });
  // Analytics is a page while its switch is on; off, it stays the disabled "coming later" item.
  // Graphics comes after Clients only while its switch is on, and LUTs and Fonts after that likewise.
  // Money, Analytics, Graphics, LUTs, Fonts and Team are the admin's only: an editor's sidebar
  // leaves them out.
  const items = navItemsFor({
    analytics: useAnalyticsEnabled(),
    graphics: useGraphicsEnabled(),
    luts: useLutsEnabled(),
    fonts: useFontsEnabled(),
    dms: useDmsEnabled(),
    admin: useIsAdmin(),
  });
  const current = navItemForPath(pathname, items);

  return (
    <Sidebar collapsible="icon">
      <Brand />
      <SidebarContent>
        <nav aria-label="Main" className="flex flex-1 flex-col">
          <SidebarGroup className="flex-1">
            <SidebarGroupContent className="flex flex-1 flex-col">
              <SidebarMenu className="flex-1 gap-0.5">
                {items.map((item) =>
                  item.enabled ? (
                    <PageLink key={item.key} item={item} active={item === current} />
                  ) : (
                    <DisabledNavItem key={item.key} item={item} iconRail={iconRail} />
                  ),
                )}
              </SidebarMenu>
            </SidebarGroupContent>
          </SidebarGroup>
        </nav>
      </SidebarContent>
      <SidebarFooter className="flex-row items-center justify-between gap-2 border-t border-sidebar-border group-data-[collapsible=icon]:justify-center">
        <div className="flex min-w-0 items-center gap-1 group-data-[collapsible=icon]:hidden">
          <SidebarVersion />
          <SidebarViewer />
        </div>
        <SidebarToggle collapsed={iconRail} />
      </SidebarFooter>
    </Sidebar>
  );
}

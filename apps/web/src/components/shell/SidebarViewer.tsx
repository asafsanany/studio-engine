import { isAdmin, signedInAs, useMe } from '@/data';

/**
 * Who is signed in, in the sidebar footer beside the version ("Yael · Editor"), for an editor.
 * The owner, the admin, sees nothing here (the footer stays as it was), and nothing is said until the
 * engine has answered. Hidden on the icon rail, like the version.
 */
export function SidebarViewer() {
  const { data: me } = useMe();
  if (me === undefined || isAdmin(me)) return null;
  const text = signedInAs(me);
  return (
    <span
      data-slot="sidebar-viewer"
      title={`Signed in as ${text}`}
      className="min-w-0 truncate text-xs text-muted-foreground group-data-[collapsible=icon]:hidden"
    >
      {text}
    </span>
  );
}

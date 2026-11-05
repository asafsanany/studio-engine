/**
 * The pages that fill the window under the header: LUTs, Fonts and Graphics (the list and the
 * studio). Each is as tall as what is left of the screen and cancels the content area's padding
 * (`-mx-6 -mt-6 -mb-10`, or `min-h-[calc(100svh-7.5rem)]` inside it), so nothing may sit under it.
 */
const FILL_PAGES = ['/luts', '/fonts', '/graphics'] as const;

/**
 * Whether the page at `pathname` fills the window. The shell then drops the gap between the
 * content area's children: such a page is the only real child, and the empty toaster next to it
 * (its message list is fixed to the corner, so it has no height) would otherwise push the document
 * 16 px past the window.
 */
export function fillsWindow(pathname: string): boolean {
  return FILL_PAGES.some((page) => pathname === page || pathname.startsWith(`${page}/`));
}

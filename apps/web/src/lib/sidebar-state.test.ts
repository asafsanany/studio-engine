import { describe, expect, it } from 'vitest';
import { parseSidebarOpen } from './sidebar-state';

describe('parseSidebarOpen', () => {
  it('is open when there is no cookie at all', () => {
    expect(parseSidebarOpen('')).toBe(true);
  });

  it('is open when the sidebar cookie is missing', () => {
    expect(parseSidebarOpen('theme=dark; other=1')).toBe(true);
  });

  it('is collapsed only when the cookie says false', () => {
    expect(parseSidebarOpen('sidebar_state=false')).toBe(false);
    expect(parseSidebarOpen('a=1; sidebar_state=false; b=2')).toBe(false);
  });

  it('is open when the cookie says true or anything unexpected', () => {
    expect(parseSidebarOpen('sidebar_state=true')).toBe(true);
    expect(parseSidebarOpen('sidebar_state=')).toBe(true);
    expect(parseSidebarOpen('sidebar_state=banana')).toBe(true);
  });

  it('does not match cookies whose name merely contains the sidebar cookie name', () => {
    expect(parseSidebarOpen('my_sidebar_state=false')).toBe(true);
  });
});

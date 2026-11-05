import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { LutsOfflineBanner, lutsOfflineText } from './LutsOfflineBanner';

describe('the LUTs offline banner', () => {
  it('says when the list was last right, and that importing waits', () => {
    const heard = new Date(2026, 9, 24, 10, 42).getTime();
    expect(lutsOfflineText(heard)).toBe(
      'Can’t reach the engine on your Mac. This is the list as it was at 10:42. Importing waits until it’s back.',
    );
  });

  it('leaves the time out when the engine never answered', () => {
    expect(lutsOfflineText(null)).toBe(
      'Can’t reach the engine on your Mac. Importing waits until it’s back.',
    );
  });

  it('is a status line with the words in it', () => {
    const html = renderToStaticMarkup(<LutsOfflineBanner heardAt={null} />);
    expect(html).toContain('role="status"');
    expect(html).toContain('Importing waits until it’s back.');
  });
});

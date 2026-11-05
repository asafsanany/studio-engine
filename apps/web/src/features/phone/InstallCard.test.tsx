import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { InstallCard, InstallCardView } from './InstallCard';

describe('<InstallCardView>', () => {
  const html = renderToStaticMarkup(<InstallCardView onDismiss={() => {}} />);

  it('says what it is for, then the three steps of the board', () => {
    expect(html).toContain('Put Studio Engine on your Home Screen');
    expect(html).toContain('It opens like an app, without Safari around it');
    const steps = [...html.matchAll(/<li[^>]*>(.*?)<\/li>/g)].map((m) =>
      (m[1] ?? '')
        .replace(/<[^>]+>/g, ' ')
        .replace(/\s+/g, ' ')
        .trim(),
    );
    expect(steps).toEqual([
      '1 Tap Share in Safari',
      '2 Tap Add to Home Screen',
      '3 Open Studio Engine from its icon',
    ]);
    expect(html).toContain('aria-label="the Share icon"');
  });

  it('has Not now and Got it, each a 44 px button', () => {
    for (const label of ['Not now', 'Got it']) {
      expect(html).toMatch(
        new RegExp(`<button[^>]*class="[^"]*\\bh-11\\b[^"]*"[^>]*>${label}</button>`),
      );
    }
  });

  it('is a named region', () => {
    expect(html).toContain('data-slot="install-card"');
    expect(html).toContain('aria-labelledby="install-card-title"');
    expect(html).toContain('id="install-card-title"');
  });
});

describe('<InstallCard>', () => {
  it('draws nothing where there is no browser window (it decides from the window)', () => {
    expect(renderToStaticMarkup(<InstallCard />)).toBe('');
  });
});

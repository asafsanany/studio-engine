import { describe, expect, it } from 'vitest';
import { IconAction, ROW_ACTION_ICONS } from './IconAction';
import { render } from './test-helpers';

describe('<IconAction>', () => {
  it.each([
    ['start', 'Start now', 'lucide-play'],
    ['hold', 'Hold', 'lucide-pause'],
    ['release', 'Release', 'lucide-play'],
    ['resume', 'Resume', 'lucide-play'],
    ['cancel', 'Cancel…', 'lucide-square'],
    ['retry', 'Retry from Render', 'lucide-rotate-ccw'],
    ['deliver', 'Mark delivered', 'lucide-send'],
    ['pay', 'Mark paid…', 'lucide-banknote'],
  ] as const)('%s: a ghost icon-sm button named "%s" with the %s icon', (action, label, icon) => {
    const html = render(<IconAction action={action} label={label} />);
    expect(html).toMatch(/^<button /);
    expect(html).toContain('type="button"');
    expect(html).toContain(`aria-label="${label}"`);
    expect(html).toContain('data-variant="ghost"');
    expect(html).toContain('data-size="icon-sm"');
    expect(html).toContain(icon);
    // The icon is decoration; the button's name is the label.
    expect(html).toContain('aria-hidden="true"');
  });

  it('has no fill, outline or shadow: the hover background is all there is', () => {
    const html = render(<IconAction action="start" label="Start now" />);
    expect(html).toContain('hover:bg-accent');
    // The full accent in the dark theme, not the ghost button's half-strength one.
    expect(html).toContain('dark:hover:bg-accent');
    expect(html).not.toContain('dark:hover:bg-accent/50');
    expect(html).not.toMatch(/shadow|border |bg-primary|bg-background|bg-input/);
  });

  it('eases the hover background in and out, and keeps the Button focus ring neutral and keyboard-only', () => {
    const html = render(<IconAction action="release" label="Release" />);
    // transition-all: Tailwind's 150 ms with its ease-in-out curve.
    expect(html).toContain('transition-all');
    expect(html).toContain('focus-visible:ring-ring/35');
    expect(html).not.toMatch(/blue|ring-primary|outline-ring/);
  });

  it('draws Download the same way, as a link when it has an address', () => {
    const link = render(
      <IconAction action="download" label="Download MP4" href="/api/jobs/1/download" />,
    );
    expect(link).toMatch(/^<a href="\/api\/jobs\/1\/download" download=""/);
    expect(link).toContain('aria-label="Download MP4"');
    expect(link).toContain('data-variant="ghost"');
    expect(link).toContain('data-size="icon-sm"');
    expect(link).toContain('lucide-download');

    const button = render(<IconAction action="download" label="Download MP4" />);
    expect(button).toMatch(/^<button /);
    expect(button).toContain('data-variant="ghost"');
  });

  it('renders a disabled download as a disabled button, never a live link', () => {
    const html = render(<IconAction action="download" label="Download MP4" href="/x" disabled />);
    expect(html).toMatch(/^<button /);
    expect(html).toContain('disabled=""');
    expect(html).not.toContain('href=');
  });

  it('has one icon per row action, for the buttons and the menu items', () => {
    expect(Object.keys(ROW_ACTION_ICONS).sort()).toEqual([
      'approve',
      'cancel',
      'copy',
      'deliver',
      'download',
      'hold',
      'pay',
      'reel',
      'release',
      'resume',
      'retry',
      'review',
      'start',
      'unapprove',
      'undeliver',
      'unpay',
    ]);
  });
});

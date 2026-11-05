import type { HealthResponse, MusicView } from '@studio/shared';
import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import { createTestQueryClient, makeMusicVersion, makeMusicView } from '@/data/test-utils';
import { renderReview, tagWith } from '../test-helpers';
import { MusicButton } from './MusicButton';
import { PhoneMusicSheet } from './PhoneMusicSheet';

// The two Music buttons (Mac header, phone top bar) as they show before the list is opened: what
// they say, and when they are not there at all.

const JOB = 'r1';

const health = (music: boolean): HealthResponse => ({
  ok: true,
  version: '0.0.0',
  settleMs: 60_000,
  series: false,
  jobSheet: true,
  analytics: false,
  phone: true,
  graphics: false,
  graphicsInEdits: false,
  music,
  luts: false,
  lutsInEdits: false,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
});

/** A client that knows whether Soundtrack is on and what the job's music is (`undefined`: not answered yet). */
function client(music: MusicView | null | undefined, on = true): QueryClient {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, health(on));
  if (music !== undefined) queryClient.setQueryData(musicKey(JOB), music);
  return queryClient;
}

const text = (markup: string) =>
  markup
    .replace(/<[^>]*>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

const two = makeMusicView({
  picked: 'v2',
  versions: [makeMusicVersion(1), makeMusicVersion(2)],
});

const mac = (music: MusicView | null | undefined, on = true) =>
  renderReview(<MusicButton jobId={JOB} />, client(music, on));
const phone = (music: MusicView | null | undefined, on = true) =>
  renderReview(<PhoneMusicSheet jobId={JOB} />, client(music, on));

describe('<MusicButton>', () => {
  it('is an outline button: the note, "Music", the version in muted text, a chevron', () => {
    const html = mac(two);
    const button = tagWith(html, 'data-slot="music-button"');
    expect(button).toContain('data-variant="outline"');
    expect(button).toContain('data-size="sm"');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('aria-expanded="false"');
    expect(text(html)).toBe('Music v2');
    expect(html).toContain('lucide-music');
    expect(html).toContain('lucide-chevron-down');
    expect(html).toContain('text-muted-foreground">v2<');
  });

  it('says what the preview plays: from the folder, off, series', () => {
    expect(text(mac(makeMusicView({ source: 'supplied', picked: 'file' })))).toBe(
      'Music from the folder',
    );
    expect(text(mac(makeMusicView({ ...two, picked: 'off' })))).toBe('Music off');
    expect(text(mac(makeMusicView({ source: 'none', picked: null })))).toBe('Music off');
    expect(text(mac(makeMusicView({ source: 'series', picked: 'series' })))).toBe('Music series');
  });

  it('shows no list until it is opened', () => {
    expect(mac(two)).not.toContain('data-slot="music-list"');
  });

  it('is not there while Soundtrack is off', () => {
    expect(mac(two, false)).toBe('');
  });

  it('is not there for a job with no music.json, or before the answer', () => {
    expect(mac(null)).toBe('');
    expect(mac(undefined)).toBe('');
  });
});

describe('<PhoneMusicSheet>', () => {
  it('is a 36 px outlined button with the note and the version, named "Music, v2"', () => {
    const html = phone(two);
    const button = tagWith(html, 'data-slot="phone-music-button"');
    expect(button).toContain('aria-label="Music, v2"');
    expect(button).toContain('aria-haspopup="dialog"');
    expect(button).toContain('h-9');
    // 44 px of touch target: the pseudo-element reaches 5 px past the padding box, 4 px past the border.
    expect(button).toContain('before:-inset-[5px]');
    expect(text(html)).toBe('v2');
    expect(html).toContain('lucide-music');
  });

  it('is named by what the preview plays: Music, off', () => {
    expect(
      tagWith(phone(makeMusicView({ ...two, picked: 'off' })), 'data-slot="phone-music-button"'),
    ).toContain('aria-label="Music, off"');
    expect(
      tagWith(
        phone(makeMusicView({ source: 'supplied', picked: 'file' })),
        'data-slot="phone-music-button"',
      ),
    ).toContain('aria-label="Music, from the folder"');
  });

  it('shows no sheet until it is opened', () => {
    expect(phone(two)).not.toContain('data-slot="music-list"');
  });

  it('is not there while Soundtrack is off, for a job with no music.json, or before the answer', () => {
    expect(phone(two, false)).toBe('');
    expect(phone(null)).toBe('');
    expect(phone(undefined)).toBe('');
  });
});

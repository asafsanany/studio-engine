import type { Job } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { clientSeriesKey } from '@/data';
import { HEALTH_KEY } from '@/data/health-query';
import { musicKey } from '@/data/music-query';
import {
  makeMusicVersion,
  makeMusicView,
  makeReviewNote,
  makeSeriesSummary,
  SERIES_CLIENT,
} from '@/data/test-utils';
import { REVIEW_ROW_JOBS } from '@/features/jobs/test-jobs';
import { clientWithNotes, renderReview, sampleNotes, tagWith } from './test-helpers';

// Radix renders a dialog in a portal, which does not exist on a server. Swap the dialog pieces for
// plain elements that keep the props this test cares about (the size, the classes, the marker).
vi.mock('@/components/ui/dialog', async () => {
  const { createElement: h } = await import('react');
  type Props = Record<string, unknown> & { children?: React.ReactNode };
  return {
    Dialog: ({ open, children }: Props) => (open ? h('div', { 'data-open': '' }, children) : null),
    DialogContent: ({ children, className, style, tabIndex, ...rest }: Props) =>
      h(
        'div',
        {
          role: 'dialog',
          class: className,
          style,
          tabIndex,
          'data-review-dialog': rest['data-review-dialog'],
          'data-close-button': String(rest.showCloseButton),
        },
        children,
      ),
    DialogTitle: ({ children }: Props) => h('h2', null, children),
    DialogDescription: ({ children, className }: Props) =>
      h('p', { class: className, 'data-role': 'description' }, children),
    DialogClose: ({ children }: Props) => children,
  };
});

// A server render shows a lazy component's fallback, so the lazy player is the real one here.
vi.mock('./LazyPreviewPlayer', async () => ({
  LazyPreviewPlayer: (await import('./PreviewPlayer')).PreviewPlayer,
}));

const { ReviewDialog } = await import('./ReviewDialog');
const { createReviewDialogStore } = await import('./review-dialog');

const r1 = REVIEW_ROW_JOBS.find((job) => job.id === 'r1');
if (!r1) throw new Error('no r1 in the fixtures');

const dialog = (
  job = r1,
  props: Partial<React.ComponentProps<typeof ReviewDialog>> = {},
  queryClient = clientWithNotes(job.id, []),
) => renderReview(<ReviewDialog job={job} open onOpenChange={() => {}} {...props} />, queryClient);

describe('<ReviewDialog>', () => {
  it('shows nothing while it is closed', () => {
    expect(dialog(r1, { open: false })).toBe('');
  });

  it('is exactly 737 × 868 for a 9:16 video in a 1440 × 900 window', () => {
    const content = tagWith(dialog(), 'data-review-dialog');
    expect(content).toContain('width:737px;height:868px');
    expect(content).toContain('data-close-button="false"');
  });

  it('is 1408 × 790 for a 16:9 video', () => {
    const wide = { ...r1, preview: { durationSec: 28.4, width: 1920, height: 1080 } };
    expect(tagWith(dialog(wide), 'data-review-dialog')).toContain('width:1408px;height:790px');
  });

  it('overrides the stock width, padding and grid, and keeps the focus on the dialog itself', () => {
    const content = tagWith(dialog(), 'data-review-dialog');
    expect(content).toContain(
      'flex max-w-none flex-col gap-0 overflow-hidden p-0 leading-normal sm:max-w-none',
    );
    expect(content).toContain('tabindex="-1"');
  });

  it('plays the job’s live preview at the round it is on, in a column as wide as the video', () => {
    const html = dialog();
    const column = tagWith(html, 'data-slot="preview-player"');
    expect(column).toContain('data-status="loading"');
    expect(column).toContain('style="width:375px"');
    expect(tagWith(html, '<hyperframes-player')).toContain(
      'src="/api/jobs/r1/preview/index.html?r=0"',
    );
    expect(tagWith(html, '<hyperframes-player')).toContain('width:375px;height:666px');
  });

  it('asks for the preview of the round the job is on', () => {
    const html = dialog({ ...r1, round: 2 });
    expect(tagWith(html, '<hyperframes-player')).toContain(
      'src="/api/jobs/r1/preview/index.html?r=2"',
    );
  });

  it('loads another composition when it is given a src (the dev gallery)', () => {
    const html = dialog(r1, { src: '/__dev/preview-sample/index.html' });
    expect(tagWith(html, '<hyperframes-player')).toContain(
      'src="/__dev/preview-sample/index.html"',
    );
  });

  it('shows the length of the preview before the player is ready', () => {
    const html = dialog();
    expect(html.slice(html.indexOf('data-slot="player-controls"'))).toContain('>0:28</span>');
  });

  it('has the 360 px Notes panel, with the count 0, the empty text and the composer', () => {
    const html = dialog();
    const panel = tagWith(html, 'data-slot="review-notes"');
    expect(panel).toContain('w-[360px]');
    expect(html).toMatch(/<h3[^>]*>Notes<\/h3><span[^>]*>0<\/span>/);
    expect(html).toContain(
      'No notes yet. Pause where something should change, then write or record a note below.',
    );
    expect(html).toContain('data-slot="review-composer"');
    expect(html.indexOf('data-slot="review-notes"')).toBeGreaterThan(
      html.indexOf('data-slot="preview-player"'),
    );
  });

  it('has a 64 px footer under the player and the panel, saying where Approve is when there are no notes', () => {
    const html = dialog();
    expect(tagWith(html, 'data-slot="review-footer"')).toContain('h-16');
    expect(html.indexOf('data-slot="review-footer"')).toBeGreaterThan(
      html.indexOf('data-slot="review-notes"'),
    );
    const footer = html.slice(html.indexOf('data-slot="review-footer"'));
    expect(footer).toContain(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    // Approve is never inside the job (the owner, 31 Oct): the footer has no button for it.
    expect(footer).not.toContain('data-action="approve"');
    expect(footer).not.toContain('data-action="send_notes"');
  });

  it('lists the notes by time, counts them, and offers Send N notes', () => {
    const html = dialog(r1, {}, clientWithNotes('r1', sampleNotes('r1')));
    expect(html).toMatch(/<h3[^>]*>Notes<\/h3><span[^>]*>3<\/span>/);
    const ids = [...html.matchAll(/data-slot="review-note" data-note-id="([^"]+)"/g)].map(
      (match) => match[1],
    );
    expect(ids).toEqual(['n1', 'n2', 'n3']);
    expect(html).not.toContain('No notes yet.');
    const footer = html.slice(html.indexOf('data-slot="review-footer"'));
    expect(footer).toContain('Your notes go to the editor together.');
    expect(footer).toContain('Send 3 notes');
    expect(footer).not.toContain('data-action="approve"');
  });

  it('shows the draft kept for the job in the composer', () => {
    const store = createReviewDialogStore({ jobId: 'r1', drafts: { r1: 'x' } });
    const html = dialog(r1, { store });
    const composer = html.slice(html.indexOf('data-slot="review-composer"'));
    expect(composer).toMatch(/<textarea[^>]*>x<\/textarea>/);
  });

  it('has no action in the footer until the notes have loaded', () => {
    const html = dialog(r1, {}, clientWithNotes('r1', undefined));
    const footer = html.slice(html.indexOf('data-slot="review-footer"'));
    expect(footer).not.toContain('data-action=');
  });

  it('puts a dot on the timeline for each note, from the length the job already knows', () => {
    const html = dialog(r1, {}, clientWithNotes('r1', sampleNotes('r1')));
    expect(html.match(/data-slot="note-dot"/g)).toHaveLength(3);
    expect(html.indexOf('data-slot="note-dot"')).toBeGreaterThan(
      html.indexOf('data-slot="player-controls"'),
    );
  });

  it('draws no dots when there are no notes', () => {
    expect(dialog()).not.toContain('data-slot="note-dot"');
  });

  it('has Record on, now that the dialog can record', () => {
    const composer = dialog().slice(dialog().indexOf('data-slot="review-composer"'));
    const at = composer.indexOf('Record</button>');
    expect(at).toBeGreaterThan(-1);
    const button = composer.slice(composer.lastIndexOf('<button', at), at);
    expect(button).not.toContain('disabled=""');
  });

  it('shows the composer, not the recording box, while the recorder is idle', () => {
    const html = dialog();
    expect(html).toContain('data-slot="review-composer"');
    expect(html).not.toContain('data-slot="recording-box"');
    expect(html).not.toContain('data-slot="recording-pin"');
  });

  it('shows a voice note’s player and transcript in its card', () => {
    const html = dialog(r1, {}, clientWithNotes('r1', sampleNotes('r1')));
    const start = html.indexOf('data-slot="review-note" data-note-id="n2"');
    const card = html.slice(start, html.indexOf('data-slot="review-note" data-note-id="n3"'));
    expect(card).toContain('data-slot="voice-note"');
    expect(card).toContain('aria-label="Play voice note"');
    expect(card).toContain('>0:09</span>');
  });

  it('turns Send off while a voice note waits for its transcript, with the reason as its tooltip', () => {
    const pending = makeReviewNote({
      id: 'n4',
      jobId: 'r1',
      kind: 'voice',
      text: null,
      audioFile: 'edit/review/voice/n4.webm',
      audioSec: 3,
      transcriptStatus: 'pending',
    });
    const html = dialog(r1, {}, clientWithNotes('r1', [...sampleNotes('r1'), pending]));
    expect(tagWith(html, 'data-action="send_notes"')).toContain('disabled=""');
    expect(html).toContain('Transcribing…</p>');
    expect(html.slice(html.indexOf('data-slot="review-footer"'))).toContain('tabindex="0"');
  });

  it('keeps Send on when every transcript has landed', () => {
    const html = dialog(r1, {}, clientWithNotes('r1', sampleNotes('r1')));
    expect(tagWith(html, 'data-action="send_notes"')).not.toContain('disabled=""');
  });

  it('has the header with the job and the client, and a description for screen readers', () => {
    const html = dialog();
    expect(html.indexOf('data-slot="review-header"')).toBeLessThan(
      html.indexOf('data-slot="preview-player"'),
    );
    expect(html).toContain('>פרומו לסוף השבוע</span>');
    expect(html).toContain('>מאפיית הצפון</span>');
    const description = tagWith(html, 'data-role="description"');
    expect(description).toContain('sr-only');
  });

  it('still renders a job without a preview, as a 9:16 frame', () => {
    const html = dialog({ ...r1, preview: null });
    expect(tagWith(html, 'data-review-dialog')).toContain('width:737px;height:868px');
    expect(tagWith(html, 'data-slot="preview-player"')).toContain('style="width:375px"');
  });

  describe('on an episode of a series', () => {
    const episode: Job = { ...r1, ...SERIES_CLIENT, seriesId: makeSeriesSummary().id, episode: 6 };
    const SERIES_ON = { ok: true, version: '0.0.0', settleMs: 60_000, series: true };

    /** The dialog for `job`, over the notes and the data the server would have sent. */
    function seriesDialog(job = episode, { on = true, listed = true } = {}) {
      const queryClient = clientWithNotes(job.id, sampleNotes(job.id));
      queryClient.setQueryData(HEALTH_KEY, { ...SERIES_ON, series: on });
      if (listed) queryClient.setQueryData(clientSeriesKey(job.clientId), [makeSeriesSummary()]);
      return dialog(job, {}, queryClient);
    }

    it('gives every note the Series and Style toggles, and names the series', () => {
      const html = seriesDialog();
      expect(html.match(/data-slot="review-note"/g)).toHaveLength(3);
      expect(html.match(/Series<\/button>|In series<\/button>/g)).toHaveLength(3);
      expect(html.match(/(Style|In style)<\/button>/g)).toHaveLength(3);
      expect(html).not.toContain('Add to style');
    });

    it('keeps the one "Add to style" toggle of a job in no series', () => {
      const html = seriesDialog({ ...episode, seriesId: null, episode: null });
      expect(html).not.toContain('lucide-layers-2');
      expect(html.match(/Add to style<\/button>|In style<\/button>/g)).toHaveLength(3);
    });

    it('keeps the one "Add to style" toggle while series are off', () => {
      const html = seriesDialog(episode, { on: false });
      expect(html).not.toContain('lucide-layers-2');
      expect(html.match(/Add to style<\/button>|In style<\/button>/g)).toHaveLength(3);
    });

    it('keeps the one "Add to style" toggle until the client’s series are loaded', () => {
      const html = seriesDialog(episode, { listed: false });
      expect(html).not.toContain('lucide-layers-2');
      expect(html).toContain('Add to style</button>');
    });
  });

  describe('with music (Soundtrack)', () => {
    const MUSIC_ON = {
      ok: true,
      version: '0.0.0',
      settleMs: 60_000,
      series: false,
      jobSheet: true,
      analytics: false,
      phone: false,
      graphics: false,
      graphicsInEdits: false,
    };
    const v2 = makeMusicView({
      picked: 'v2',
      versions: [makeMusicVersion(1), makeMusicVersion(2)],
      rev: 1_792_700_000_123,
    });

    /** The dialog over a client that knows the music switch and the job's music (`undefined`: not answered yet). */
    function musicDialog(music: typeof v2 | null | undefined, { on = true } = {}) {
      const queryClient = clientWithNotes('r1', []);
      queryClient.setQueryData(HEALTH_KEY, { ...MUSIC_ON, music: on });
      if (music !== undefined) queryClient.setQueryData(musicKey('r1'), music);
      return dialog(r1, {}, queryClient);
    }

    it('puts the music’s rev in the preview’s address, so the player follows it', () => {
      expect(tagWith(musicDialog(v2), '<hyperframes-player')).toContain(
        'src="/api/jobs/r1/preview/index.html?r=0&amp;m=1792700000123"',
      );
    });

    it('asks for the preview as before for a job without music, and while Soundtrack is off', () => {
      for (const html of [musicDialog(null), musicDialog(v2, { on: false })]) {
        expect(tagWith(html, '<hyperframes-player')).toContain(
          'src="/api/jobs/r1/preview/index.html?r=0"',
        );
      }
    });

    it('keeps the sample it is given, whatever the music says', () => {
      const queryClient = clientWithNotes('r1', []);
      queryClient.setQueryData(HEALTH_KEY, { ...MUSIC_ON, music: true });
      queryClient.setQueryData(musicKey('r1'), v2);
      const html = dialog(r1, { src: '/__dev/preview-sample/index.html' }, queryClient);
      expect(tagWith(html, '<hyperframes-player')).toContain(
        'src="/__dev/preview-sample/index.html"',
      );
    });

    it('says in the footer what Approve will render: with music v2', () => {
      const footer = musicDialog(v2).slice(musicDialog(v2).indexOf('data-slot="review-footer"'));
      expect(footer).toContain(
        'Happy with it? Approve it from the job’s right-click menu to render the final video, with music v2.',
      );
    });

    it('says without music when No music is picked', () => {
      const footer = musicDialog({ ...v2, picked: 'off' });
      expect(footer).toContain(
        'Happy with it? Approve it from the job’s right-click menu to render the final video, without music.',
      );
    });

    it('keeps today’s footer for a job with no music', () => {
      const plain =
        'Happy with it? Approve it from the job’s right-click menu to render the final video.';
      expect(musicDialog(null)).toContain(plain);
      expect(musicDialog(undefined)).toContain(plain);
    });

    it('says Approve waits while a version is being made', () => {
      const making = {
        ...v2,
        making: { id: 'v3', ask: null, startedAt: '2026-10-23T09:29:00.000Z' },
      };
      const html = musicDialog(making);
      expect(html).not.toContain('data-action="approve"');
      expect(html).toContain('Music v3 is still being made. Approve when it is ready.');
    });

    it('says what plays at the right of the player’s controls, as a status', () => {
      const html = musicDialog(v2);
      const controls = html.slice(html.indexOf('data-slot="player-controls"'));
      const tag = tagWith(controls, 'data-slot="music-now"');
      expect(tag).toContain('role="status"');
      expect(controls.slice(controls.indexOf('data-slot="music-now"'))).toContain(
        '>Music v2</span>',
      );
      // Before full screen.
      expect(controls.indexOf('data-slot="music-now"')).toBeLessThan(
        controls.indexOf('aria-label="Full screen"'),
      );
      expect(musicDialog({ ...v2, picked: 'off' })).toContain('>No music</span>');
    });

    it('says nothing there for a job without music', () => {
      expect(musicDialog(null)).not.toContain('data-slot="music-now"');
    });

    it('has the Music button in the header, saying what plays', () => {
      const html = musicDialog(v2);
      expect(html).toContain('data-slot="music-button"');
      expect(html.slice(html.indexOf('data-slot="music-button"'))).toContain('>v2</span>');
    });

    it('has no Music button for a job without music, or while Soundtrack is off', () => {
      expect(musicDialog(null)).not.toContain('data-slot="music-button"');
      expect(musicDialog(v2, { on: false })).not.toContain('data-slot="music-button"');
    });
  });
});

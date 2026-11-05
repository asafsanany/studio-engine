import type { ReviewNote } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { renderReview, tagWith } from './test-helpers';
import { VoiceNoteBody } from './VoiceNoteBody';
import { createVoicePlaybackStore } from './voice-playback';

const hebrew = 'כאן הכתוביות מכסות את הידיים של יוסי.';

function voiceNote(overrides: Partial<ReviewNote> = {}): ReviewNote {
  return makeReviewNote({
    id: 'n2',
    jobId: 'r1',
    atSec: 7.8,
    kind: 'voice',
    text: hebrew,
    audioFile: 'edit/review/voice/n2.webm',
    audioSec: 9.4,
    transcriptStatus: 'done',
    ...overrides,
  });
}

function body(
  note: ReviewNote = voiceNote(),
  props: Partial<React.ComponentProps<typeof VoiceNoteBody>> = {},
): string {
  return renderReview(
    <VoiceNoteBody
      note={note}
      jobId="r1"
      onPlay={() => {}}
      playback={createVoicePlaybackStore()}
      {...props}
    />,
  );
}

describe('<VoiceNoteBody>', () => {
  it('is the voice note block of the card', () => {
    const tag = tagWith(body(), 'data-slot="voice-note"');
    expect(tag).toContain('flex-col');
    expect(tag).toContain('gap-1.5');
    expect(tag).toContain('pr-1');
  });

  it('has a round 28 px Play button, filled in the foreground colour', () => {
    const html = body();
    const button = tagWith(html, 'aria-label="Play voice note"');
    expect(button).toContain('type="button"');
    expect(button).toContain('size-7');
    expect(button).toContain('rounded-full');
    expect(button).toContain('bg-foreground');
    expect(button).toContain('text-background');
    expect(html).toContain('lucide-play');
    expect(html).not.toContain('lucide-pause');
    expect(tagWith(html, 'lucide-play')).toContain('size-3');
    expect(tagWith(html, 'lucide-play')).toContain('fill-current');
  });

  it('shows Pause, and lights the bars up, for the note that is playing', () => {
    const html = body(voiceNote(), { playback: createVoicePlaybackStore({ playingNoteId: 'n2' }) });
    expect(html).toContain('aria-label="Pause voice note"');
    expect(html).not.toContain('aria-label="Play voice note"');
    expect(html).toContain('lucide-pause');
    expect(html).not.toContain('lucide-play');
    const bars = html.match(/<span class="[^"]*w-\[3px\][^"]*"/g) ?? [];
    expect(bars).toHaveLength(28);
    for (const bar of bars) {
      expect(bar).toContain('bg-foreground');
      expect(bar).not.toContain('bg-zinc-500');
    }
  });

  it('stays Play when another note is the one playing', () => {
    const html = body(voiceNote(), { playback: createVoicePlaybackStore({ playingNoteId: 'n9' }) });
    expect(html).toContain('aria-label="Play voice note"');
  });

  it('has 28 flat, grey 3 px bars while nothing is decoded', () => {
    const html = body();
    const bars = html.match(/<span class="[^"]*w-\[3px\][^"]*" style="[^"]*"/g) ?? [];
    expect(bars).toHaveLength(28);
    for (const bar of bars) {
      expect(bar).toContain('style="height:4px"');
      expect(bar).toContain('bg-zinc-500');
      expect(bar).toContain('shrink-0');
      expect(bar).toContain('rounded-[2px]');
      expect(bar).toContain('transition-colors');
      expect(bar).toContain('ease-in-out');
    }
    const row = tagWith(html, 'flex h-6 flex-1');
    expect(row).toContain('aria-hidden="true"');
    expect(row).toContain('gap-0.5');
  });

  it('shows the recorded length, not the element’s', () => {
    expect(body()).toContain('>0:09</span>');
    expect(body(voiceNote({ audioSec: 65.2 }))).toContain('>1:05</span>');
    expect(body(voiceNote({ audioSec: null }))).toContain('>0:00</span>');
  });

  it('shows the transcript, in its own direction', () => {
    const html = body();
    const tag = tagWith(html, 'dir="auto"');
    expect(tag).toContain('[unicode-bidi:plaintext]');
    expect(tag).toContain('text-[13px]');
    expect(tag).toContain('text-muted-foreground');
    expect(html).toContain(`${hebrew}</p>`);
  });

  it('says "Transcribing…" while the transcript is on its way', () => {
    expect(body(voiceNote({ text: null, transcriptStatus: 'pending' }))).toContain(
      'Transcribing…</p>',
    );
  });

  it('says the editor will listen to it when the transcript failed', () => {
    expect(body(voiceNote({ text: null, transcriptStatus: 'failed' }))).toContain(
      'Couldn&#x27;t transcribe. The editor will listen to it.</p>',
    );
  });

  it('plays from the note’s audio, loaded only when played', () => {
    const tag = tagWith(body(), '<audio');
    expect(tag).toContain('src="/api/jobs/r1/notes/n2/audio"');
    expect(tag).toContain('preload="none"');
  });

  it('has no title attributes', () => {
    expect(body()).not.toContain('title=');
  });
});

describe('<VoiceNoteBody> on the phone', () => {
  it('has a 36 px play button and a 14 px transcript', () => {
    const html = body(voiceNote(), { variant: 'phone' });
    expect(tagWith(html, 'aria-label="Play voice note"')).toContain('size-9');
    expect(tagWith(html, 'dir="auto"')).toContain('text-sm');
  });

  it('is the Mac’s 28 px button by default', () => {
    expect(tagWith(body(), 'aria-label="Play voice note"')).toContain('size-7');
  });
});

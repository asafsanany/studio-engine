import type { Effort } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeReviewNote } from '@/data/test-utils';
import { type FooterView, reviewFooter, sendBlockedByTranscripts } from './notes-logic';
import { ReviewFooterActions } from './ReviewFooterActions';
import { FOOTER_TEXT, VOICE_TEXT } from './review-text';
import { renderReview, tagWith } from './test-helpers';

const SEND: FooterView = {
  action: 'send_notes',
  text: 'Your notes go to the editor together.',
  label: 'Send 2 notes',
  disabled: false,
  busy: false,
  disabledReason: null,
};

const APPROVE: FooterView = {
  action: 'approve',
  text: FOOTER_TEXT.withoutNotes,
  label: 'Approve',
  disabled: false,
  busy: false,
  disabledReason: null,
};

function actions(
  view: FooterView,
  error: string | null = null,
  effort?: { value: Effort | null; onChange: (effort: Effort | null) => void; auto?: boolean },
): string {
  return renderReview(
    <ReviewFooterActions view={view} error={error} onSend={() => {}} effort={effort} />,
  );
}

describe('<ReviewFooterActions>', () => {
  it('with notes: the line and "Send N notes" with a send icon, and no Approve', () => {
    const html = actions(SEND);
    expect(html).toContain('Your notes go to the editor together.');
    const button = tagWith(html, 'data-action="send_notes"');
    expect(button).toContain('type="button"');
    expect(html).toContain('Send 2 notes</button>');
    expect(html).toContain('lucide-send');
    expect(html).not.toContain('Approve');
    expect(html).not.toContain('data-action="approve"');
  });

  it('without notes: only the line, which says Approve is in the job’s right-click menu (no button)', () => {
    const html = actions(APPROVE);
    expect(html).toContain(
      'Happy with it? Approve it from the job’s right-click menu to render the final video.',
    );
    expect(html).not.toContain('<button');
    expect(html).not.toContain('data-action');
    expect(html).not.toContain('lucide-check');
    expect(html).not.toContain('lucide-send');
  });

  it('is 36 px tall with 16 px at the sides, also with an icon', () => {
    const button = tagWith(actions(SEND), 'data-action');
    expect(button).toContain('h-9');
    expect(button).toContain('has-[&gt;svg]:px-4');
    expect(button).not.toContain('has-[&gt;svg]:px-3');
  });

  it('is the primary button', () => {
    expect(tagWith(actions(SEND), 'data-action')).toContain('data-variant="default"');
  });

  it('can be off', () => {
    expect(tagWith(actions({ ...SEND, disabled: true }), 'data-action')).toContain('disabled=""');
    expect(tagWith(actions(SEND), 'data-action')).not.toContain('disabled=""');
  });

  it('shows a spinner instead of the icon while its action is on its way', () => {
    const html = actions({ ...SEND, busy: true, disabled: true });
    expect(tagWith(html, 'data-action')).toContain('aria-busy="true"');
    expect(html).toContain('lucide-loader-circle');
    expect(html).not.toContain('lucide-send');
    expect(html).toContain('Send 2 notes</button>');
  });

  it('puts the server’s reason in place of the line, as an alert', () => {
    const html = actions(APPROVE, 'Send or delete your notes first.');
    expect(tagWith(html, 'role="alert"')).toContain('text-destructive');
    expect(html).toContain('Send or delete your notes first.</p>');
    expect(html).not.toContain('Happy with it?');
  });

  it('shows no alert normally', () => {
    expect(actions(SEND)).not.toContain('role="alert"');
  });

  it('wraps a button that is off for a reason in a focusable span, for its tooltip', () => {
    const html = actions({
      ...SEND,
      disabled: true,
      disabledReason: 'Waiting for the voice notes',
    });
    const wrapper = tagWith(html, 'tabindex="0"');
    expect(wrapper).toContain('<span');
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf('data-action="send_notes"'));
  });

  it('turns Send off while a voice note is transcribed, in a focusable span for its tooltip', () => {
    const notes = [makeReviewNote({ kind: 'voice', transcriptStatus: 'pending', text: null })];
    const view = reviewFooter({
      notes,
      writing: false,
      submitting: null,
      sendDisabledReason: sendBlockedByTranscripts(notes),
    });
    expect(view.disabledReason).toBe(VOICE_TEXT.waitingForTranscripts);
    const html = actions(view);
    expect(tagWith(html, 'data-action="send_notes"')).toContain('disabled=""');
    expect(tagWith(html, 'tabindex="0"')).toContain('<span');
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf('data-action="send_notes"'));
    expect(html).toContain('Send 1 note</button>');
  });

  it('has no wrapper when there is no reason', () => {
    expect(actions(SEND)).not.toContain('tabindex');
  });
});

describe('<ReviewFooterActions>: the Effort button (CVP-200)', () => {
  const EFFORT = { value: 'xhigh' as Effort | null, onChange: () => {} };

  it('sits before "Send N notes" when notes wait, and says the level', () => {
    const html = actions(SEND, null, EFFORT);
    const at = html.indexOf('data-slot="review-effort"');
    expect(at).toBeGreaterThan(-1);
    expect(html).toContain('Effort: Extra high');
    expect(at).toBeLessThan(html.indexOf('data-action="send_notes"'));
  });

  it('is not there with no notes: the render run takes no level', () => {
    const html = actions(APPROVE, null, EFFORT);
    expect(html).not.toContain('review-effort');
    expect(html).not.toContain('Effort:');
  });

  it('is left out when the footer is given no effort', () => {
    expect(actions(SEND)).not.toContain('review-effort');
  });

  it('is off while Send is on its way, and stays beside a disabled Send', () => {
    const busy = actions({ ...SEND, busy: true, disabled: true }, null, EFFORT);
    expect(tagWith(busy, 'data-slot="review-effort"')).toContain('disabled=""');
    const waiting = actions(
      { ...SEND, disabled: true, disabledReason: VOICE_TEXT.waitingForTranscripts },
      null,
      EFFORT,
    );
    expect(tagWith(waiting, 'data-slot="review-effort"')).not.toContain('disabled=""');
  });

  it('keeps the error where the text was, with the button still there', () => {
    const html = actions(SEND, 'Cannot send the notes of a job that is queued.', EFFORT);
    expect(html).toContain('role="alert"');
    expect(html).toContain('review-effort');
  });
});

describe('<ReviewFooterActions>: the Effort button with Quick fixes on', () => {
  const AUTO = { value: null as Effort | null, onChange: () => {}, auto: true };

  it('sits before "Send N notes" and says Auto, with sparkles, for a job on Auto', () => {
    const html = actions(SEND, null, AUTO);
    const at = html.indexOf('data-slot="review-effort"');
    expect(at).toBeGreaterThan(-1);
    expect(html).toContain('Effort: Auto');
    expect(html).toContain('lucide-sparkles');
    expect(at).toBeLessThan(html.indexOf('data-action="send_notes"'));
  });

  it('is also there with no notes: Auto decides what happens to the next note', () => {
    const html = actions(APPROVE, null, AUTO);
    const at = html.indexOf('data-slot="review-effort"');
    expect(at).toBeGreaterThan(-1);
    expect(html).toContain('Effort: Auto');
    expect(at).toBeGreaterThan(html.indexOf(FOOTER_TEXT.withoutNotes));
    expect(html).not.toContain('data-action');
  });

  it('says a chosen level with its gauge, with notes and without', () => {
    for (const view of [SEND, APPROVE]) {
      const html = actions(view, null, { ...AUTO, value: 'high' });
      expect(html).toContain('Effort: High');
      expect(html).toContain('lucide-gauge');
      expect(html).not.toContain('lucide-sparkles');
    }
  });

  it('is still left out when the footer is given no effort', () => {
    expect(actions(APPROVE)).not.toContain('review-effort');
  });
});

describe('<ReviewFooterActions> with a note being read or a fix under way (Quick fixes)', () => {
  const AUTO = { value: null as Effort | null, onChange: () => {}, auto: true };
  const WAIT = {
    disabled: true,
    disabledReason: 'Wait for the fix to finish',
    effortDisabled: true,
    quickFix: 'busy',
  } as const;

  it('holds Send, in a focusable span for its tooltip, with the line before it', () => {
    const html = actions(
      { ...SEND, ...WAIT, text: 'Fixing it here. Send waits for it.', label: 'Send 1 note' },
      null,
      AUTO,
    );
    expect(html).toContain('Fixing it here. Send waits for it.');
    expect(tagWith(html, 'data-action="send_notes"')).toContain('disabled=""');
    expect(tagWith(html, 'tabindex="0"')).toContain('<span');
    expect(html.indexOf('tabindex="0"')).toBeLessThan(html.indexOf('data-action="send_notes"'));
  });

  it('with no notes says Approve waits, with no button to hold', () => {
    const html = actions(
      { ...APPROVE, ...WAIT, text: 'Reading the note. Approve waits for it.' },
      null,
      AUTO,
    );
    expect(html).toContain('Reading the note. Approve waits for it.');
    expect(html).not.toContain('data-action');
  });

  it('holds the Effort button too, with notes and without', () => {
    for (const view of [SEND, APPROVE]) {
      const html = actions({ ...view, ...WAIT }, null, AUTO);
      expect(tagWith(html, 'data-slot="review-effort"')).toContain('disabled=""');
    }
  });

  it('leaves the Effort button on for notes that wait, and for fixed notes', () => {
    for (const view of [
      { ...SEND, quickFix: 'auto' } as const,
      { ...APPROVE, quickFix: 'fixed' } as const,
    ]) {
      const html = actions(view, null, AUTO);
      expect(tagWith(html, 'data-slot="review-effort"')).not.toContain('disabled=""');
    }
    expect(
      tagWith(actions({ ...SEND, quickFix: 'auto' }, null, AUTO), 'data-action'),
    ).not.toContain('disabled=""');
  });
});

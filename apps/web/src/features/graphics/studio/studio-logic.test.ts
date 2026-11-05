import { DEFAULT_EFFORT, GRAPHIC_LIMITS, GRAPHIC_MESSAGES } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { makeGraphicDetail, makeGraphicMessage } from '@/data/test-utils';
import {
  addAttachments,
  appendVoiceText,
  chatRows,
  chatSignature,
  composerWords,
  detailRows,
  EFFORT_CHOICES,
  effortToSend,
  headStatus,
  isAttachable,
  leftText,
  lengthText,
  makingVersionOf,
  micLabel,
  nameAction,
  pinAfterPick,
  renameBlockedReason,
  resolveValues,
  sendState,
  shownVersion,
  stepViews,
  stoppedLine,
  tookText,
  unchangedLine,
  usedInText,
  voiceLine,
} from './studio-logic';

const file = (name: string, type = '', size = 10, lastModified = 1) => {
  const made = new File([new Uint8Array(size)], name, { type, lastModified });
  return made;
};

describe('headStatus', () => {
  const base = {
    status: 'ready',
    version: 2,
    makingVersion: null,
    failedVersion: null,
    uses: true,
  } as const;

  it('says the version, and "off for edits" when the switch is off', () => {
    expect(headStatus(base)).toEqual({ text: 'v2', tone: 'muted' });
    expect(headStatus({ ...base, uses: false })).toEqual({
      text: 'v2 · off for edits',
      tone: 'muted',
    });
  });

  it('says "Making v1…" in blue while the first version is made', () => {
    expect(headStatus({ ...base, status: 'making', version: null, makingVersion: 1 })).toEqual({
      text: 'Making v1…',
      tone: 'making',
    });
  });

  it('keeps the version while a later one is made (the chip over the preview says the rest)', () => {
    expect(headStatus({ ...base, status: 'making', makingVersion: 3 })).toEqual({
      text: 'v2',
      tone: 'muted',
    });
  });

  it('says what could not be finished, in red', () => {
    expect(headStatus({ ...base, status: 'failed', failedVersion: 3 })).toEqual({
      text: 'v2 · couldn’t finish v3',
      tone: 'failed',
    });
    expect(headStatus({ ...base, status: 'failed', version: null, failedVersion: 1 })).toEqual({
      text: 'Couldn’t finish v1',
      tone: 'failed',
    });
  });

  it('says "Not made yet" for a graphic with nothing, and for the new one', () => {
    expect(headStatus({ ...base, status: 'empty', version: null })).toEqual({
      text: 'Not made yet',
      tone: 'muted',
    });
    expect(headStatus(undefined)).toEqual({ text: 'Not made yet', tone: 'muted' });
  });
});

describe('nameAction and renameBlockedReason', () => {
  it('saves the cleaned draft, and closes for an empty or unchanged one', () => {
    expect(nameAction('  Dark pill  ', 'Name')).toEqual({ kind: 'save', name: 'Dark pill' });
    expect(nameAction('a/b: c', 'Name')).toEqual({ kind: 'save', name: 'a–b– c' });
    expect(nameAction('Name', 'Name')).toEqual({ kind: 'close' });
    expect(nameAction('   ', 'Name')).toEqual({ kind: 'close' });
  });

  it('refuses a rename while a version is made, in the engine’s words', () => {
    const making = {
      status: 'making',
      version: 1,
      makingVersion: 2,
      failedVersion: null,
      uses: true,
    } as const;
    expect(renameBlockedReason(making)).toBe('Wait until v2 is made, then rename it.');
    expect(renameBlockedReason({ ...making, status: 'ready', makingVersion: null })).toBeNull();
    expect(renameBlockedReason(undefined)).toBeNull();
  });
});

describe('the making box', () => {
  it('draws the steps as done, working and waiting, with the words of the version', () => {
    expect(stepViews(1, 1)).toEqual([
      { label: 'Reading your request', state: 'done' },
      { label: 'Building the graphic', state: 'running' },
      { label: 'Checking it at 9:16, 16:9 and 1:1', state: 'waiting' },
    ]);
    expect(stepViews(3, 0).map((step) => step.label)).toEqual([
      'Reading your note',
      'Changing the graphic',
      'Checking it at 9:16, 16:9 and 1:1',
    ]);
    expect(stepViews(2, 2).map((step) => step.state)).toEqual(['done', 'done', 'running']);
    expect(stepViews(1, null).map((step) => step.state)).toEqual(['running', 'waiting', 'waiting']);
  });

  it('says about 2 minutes for v1 and about 1 minute for a change', () => {
    expect(leftText(1)).toBe('About 2 min');
    expect(leftText(2)).toBe('About 1 min');
  });
});

describe('tookText', () => {
  const at = (sec: number) => new Date(Date.UTC(2026, 9, 22, 10, 0, sec)).toISOString();

  it('says seconds, or minutes and seconds', () => {
    expect(tookText(at(0), at(58))).toBe('58 s');
    expect(tookText(at(0), at(112))).toBe('1 min 52 s');
    expect(tookText(at(0), at(120))).toBe('2 min');
  });

  it('says nothing without both times, or when it took under a second', () => {
    expect(tookText(null, at(5))).toBe('');
    expect(tookText(at(5), null)).toBe('');
    expect(tookText(at(5), at(5))).toBe('');
    expect(tookText('nonsense', at(5))).toBe('');
  });
});

describe('chatRows', () => {
  const you = (id: string, text: string, refs: string[] = []) =>
    makeGraphicMessage({
      id,
      role: 'you',
      text,
      refs,
      version: null,
      status: null,
      startedAt: null,
      endedAt: null,
    });

  it('keeps the owner’s text and files', () => {
    expect(chatRows([you('a', 'Hi', ['pill.png'])])).toEqual([
      { kind: 'you', id: 'a', text: 'Hi', refs: ['pill.png'] },
    ]);
  });

  it('turns a run that is making into the box with its steps', () => {
    const rows = chatRows([
      makeGraphicMessage({ id: 'c', version: 1, status: 'making', step: 1, text: '' }),
    ]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'making', id: 'c', version: 1, left: 'About 2 min' });
    expect((rows[0] as { steps: { state: string }[] }).steps.map((step) => step.state)).toEqual([
      'done',
      'running',
      'waiting',
    ]);
  });

  it('turns a made version into the reply with its time', () => {
    const rows = chatRows([
      makeGraphicMessage({
        id: 'c',
        version: 2,
        status: 'done',
        text: 'Made v2.',
        startedAt: '2026-10-22T10:00:00.000Z',
        endedAt: '2026-10-22T10:00:58.000Z',
      }),
    ]);
    expect(rows).toEqual([{ kind: 'done', id: 'c', version: 2, text: 'Made v2.', took: '58 s' }]);
  });

  it('shows a version brought back by "Use vN again" like any other, with no time', () => {
    const rows = chatRows([
      makeGraphicMessage({
        id: 'r',
        version: 3,
        status: 'done',
        text: 'v1 is back, as v3.',
        startedAt: '2026-10-22T10:00:00.000Z',
        endedAt: '2026-10-22T10:00:00.000Z',
      }),
    ]);
    expect(rows[0]).toMatchObject({ kind: 'done', version: 3, took: '' });
  });

  it('turns a failed run into the box: the reply if there is one, else the reason; the reason is what is copied', () => {
    const withText = chatRows([
      makeGraphicMessage({
        id: 'f',
        version: 3,
        status: 'failed',
        text: 'The logo pushed it out.',
        error: 'x=1968',
      }),
    ]);
    expect(withText[0]).toEqual({
      kind: 'failed',
      id: 'f',
      version: 3,
      text: 'The logo pushed it out.',
      error: 'x=1968',
      unchanged: null,
    });
    const withoutText = chatRows([
      makeGraphicMessage({
        id: 'f',
        version: 3,
        status: 'failed',
        text: '',
        error: 'It took longer than 20 minutes.',
      }),
    ]);
    expect(withoutText[0]).toMatchObject({
      text: 'It took longer than 20 minutes.',
      error: 'It took longer than 20 minutes.',
    });
  });

  it('says which version a failed run left as it was, once there is one, and not twice', () => {
    const failed = (text: string) =>
      makeGraphicMessage({ id: 'f', version: 3, status: 'failed', text, error: 'Why.' });
    const rows = chatRows([
      makeGraphicMessage({ id: 'd1', version: 1, status: 'done' }),
      makeGraphicMessage({ id: 'd2', version: 2, status: 'done' }),
      failed(''),
    ]);
    expect(rows[2]).toMatchObject({
      text: 'Why.',
      unchanged: 'v2 is unchanged, and edits keep using it.',
    });
    expect(unchangedLine(2)).toBe('v2 is unchanged, and edits keep using it.');
    // a reply that says it already is left as it is
    const said = chatRows([
      makeGraphicMessage({ id: 'd2', version: 2, status: 'done' }),
      failed('The logo pushed it out. v2 is unchanged, and edits keep using it.'),
    ]);
    expect(said[1]).toMatchObject({ unchanged: null });
    // nothing was made yet: nothing is unchanged
    expect(chatRows([failed('')])[0]).toMatchObject({ unchanged: null });
  });

  it('says which version a stopped run left unchanged: the newest made before it', () => {
    const rows = chatRows([
      makeGraphicMessage({ id: 'd1', version: 1, status: 'done' }),
      makeGraphicMessage({ id: 'd2', version: 2, status: 'done' }),
      makeGraphicMessage({ id: 's', version: 3, status: 'stopped', text: '' }),
    ]);
    expect(rows[2]).toEqual({ kind: 'stopped', id: 's', version: 3, note: 'v2 is unchanged.' });
    expect(stoppedLine('v2 is unchanged.')).toBe('Stopped. v2 is unchanged.');
  });

  it('says "Nothing was made yet." for a stopped first run', () => {
    const rows = chatRows([
      makeGraphicMessage({ id: 's', version: 1, status: 'stopped', text: '' }),
    ]);
    expect(rows[0]).toMatchObject({ kind: 'stopped', note: 'Nothing was made yet.' });
  });

  it('changes its signature when a row is added or a run moves to the next step', () => {
    const making = (step: 0 | 1 | 2) => [makeGraphicMessage({ id: 'c', status: 'making', step })];
    expect(chatSignature(making(0))).not.toBe(chatSignature(making(1)));
    expect(chatSignature(making(1))).toBe(chatSignature(making(1)));
    expect(chatSignature([])).not.toBe(chatSignature(making(0)));
  });
});

describe('the version shown', () => {
  it('is the newest unless an older one is pinned', () => {
    expect(shownVersion(null, 3)).toBe(3);
    expect(shownVersion({ version: 1, newest: 3 }, 3)).toBe(1);
    expect(shownVersion(null, null)).toBeNull();
  });

  it('follows the newest again when a newer version arrives (a run finished, or "Use v1 again")', () => {
    expect(shownVersion({ version: 1, newest: 2 }, 3)).toBe(3);
  });

  it('pins an older version and lets go for the newest', () => {
    expect(pinAfterPick(1, 3)).toEqual({ version: 1, newest: 3 });
    expect(pinAfterPick(3, 3)).toBeNull();
    expect(pinAfterPick(1, null)).toBeNull();
  });
});

describe('resolveValues', () => {
  const variables = [
    { id: 'name', label: 'Name', default: 'דנה לוי' },
    { id: 'role', label: 'Role', default: 'מייסדת' },
  ];

  it('uses what was typed and the graphic’s own text for the rest', () => {
    expect(resolveValues(variables, { name: 'Dana' })).toEqual({ name: 'Dana', role: 'מייסדת' });
  });

  it('keeps a field that was cleared empty, and drops text typed for a field that is gone', () => {
    expect(resolveValues(variables, { name: '', gone: 'x' })).toEqual({ name: '', role: 'מייסדת' });
  });
});

describe('makingVersionOf', () => {
  const graphic = { status: 'ready', makingVersion: null, version: 2 } as const;

  it('is the version being made while a run is making', () => {
    expect(makingVersionOf({ ...graphic, status: 'making', makingVersion: 3 })).toBe(3);
    expect(makingVersionOf({ status: 'making', makingVersion: null, version: 2 })).toBe(3);
  });

  it('is none for a graphic that is ready, failed or empty, so Send is not held up by it', () => {
    expect(makingVersionOf(graphic)).toBeNull();
    expect(makingVersionOf({ ...graphic, status: 'failed' })).toBeNull();
    expect(makingVersionOf({ ...graphic, status: 'empty' })).toBeNull();
    expect(makingVersionOf(undefined)).toBeNull();
  });
});

describe('Send', () => {
  const ready = {
    draft: 'Make it dark',
    files: [],
    makingVersion: null,
    offline: false,
    sending: false,
    recorderBusy: false,
  };

  it('works with text', () => {
    expect(sendState(ready)).toEqual({ enabled: true, reason: null });
  });

  it('works with only an attached file', () => {
    expect(sendState({ ...ready, draft: '', files: [file('pill.png', 'image/png')] })).toEqual({
      enabled: true,
      reason: null,
    });
  });

  it('waits when there is nothing to send, with no reason (it is plain)', () => {
    expect(sendState({ ...ready, draft: '   ' })).toEqual({ enabled: false, reason: null });
  });

  it('waits while a version is being made, and says so in the engine’s words', () => {
    expect(sendState({ ...ready, makingVersion: 3 })).toEqual({
      enabled: false,
      reason: 'Wait until v3 is made, then send your next message.',
    });
  });

  it('waits while the engine is out of reach and while a voice note is not yet text', () => {
    expect(sendState({ ...ready, offline: true }).enabled).toBe(false);
    expect(sendState({ ...ready, offline: true }).reason).toBe('Waiting for the engine…');
    expect(sendState({ ...ready, recorderBusy: true })).toEqual({
      enabled: false,
      reason: 'Finish or cancel the recording first',
    });
  });

  it('waits while the message is on its way', () => {
    expect(sendState({ ...ready, sending: true })).toEqual({ enabled: false, reason: null });
  });
});

describe('effort', () => {
  it('offers Medium, High and Extra high, Extra high being the default', () => {
    expect(EFFORT_CHOICES.map((choice) => choice.label)).toEqual(['Medium', 'High', 'Extra high']);
    expect(DEFAULT_EFFORT).toBe('xhigh');
  });

  it('sends no level for the default, so the engine’s own applies', () => {
    expect(effortToSend('xhigh')).toBeNull();
    expect(effortToSend('high')).toBe('high');
    expect(effortToSend('medium')).toBe('medium');
  });
});

describe('attached files', () => {
  it('takes images, videos, fonts and PDFs', () => {
    for (const [name, type] of [
      ['a.png', 'image/png'],
      ['a.mov', 'video/quicktime'],
      ['a.pdf', 'application/pdf'],
      ['a.woff2', ''],
      ['A.OTF', ''],
      ['a.ttf', 'font/ttf'],
    ] as const) {
      expect(isAttachable(file(name, type)), name).toBe(true);
    }
    expect(isAttachable(file('notes.txt', 'text/plain'))).toBe(false);
    expect(isAttachable(file('a.zip', 'application/zip'))).toBe(false);
  });

  it('adds files and keeps the ones already there', () => {
    const first = file('a.png', 'image/png');
    const added = addAttachments([first], [file('b.png', 'image/png')]);
    expect(added.files.map((f) => f.name)).toEqual(['a.png', 'b.png']);
    expect(added.error).toBeNull();
  });

  it('does not add the same file twice', () => {
    const first = file('a.png', 'image/png');
    expect(addAttachments([first], [file('a.png', 'image/png')]).files).toHaveLength(1);
  });

  it('leaves out a file of another kind and says so in the engine’s words, keeping the others', () => {
    const added = addAttachments([], [file('a.png', 'image/png'), file('notes.txt', 'text/plain')]);
    expect(added.files.map((f) => f.name)).toEqual(['a.png']);
    expect(added.error).toBe(GRAPHIC_MESSAGES.badUploadType);
  });

  it('takes at most five files to a message', () => {
    const six = Array.from({ length: 6 }, (_, i) => file(`f${i}.png`, 'image/png'));
    const added = addAttachments([], six);
    expect(added.files).toHaveLength(GRAPHIC_LIMITS.refsMaxFiles);
    expect(added.error).toBe(GRAPHIC_MESSAGES.tooManyFiles);
  });

  it('takes at most 500 MB together', () => {
    const big = {
      name: 'big.mov',
      type: 'video/quicktime',
      size: GRAPHIC_LIMITS.refsMaxBytes - 5,
      lastModified: 1,
    };
    const small = file('small.png', 'image/png', 10);
    const added = addAttachments([big as unknown as File], [small]);
    expect(added.files).toHaveLength(1);
    expect(added.error).toBe(GRAPHIC_MESSAGES.tooLarge);
  });
});

describe('the voice note', () => {
  it('adds what was said after the draft, or in place of a blank one', () => {
    expect(appendVoiceText('Make it dark', 'and bigger')).toBe('Make it dark and bigger');
    expect(appendVoiceText('Make it dark ', 'and bigger')).toBe('Make it dark and bigger');
    expect(appendVoiceText('Make it dark\n', 'and bigger')).toBe('Make it dark\nand bigger');
    expect(appendVoiceText('', 'שלום')).toBe('שלום');
    expect(appendVoiceText('   ', '  שלום ')).toBe('שלום');
    expect(appendVoiceText('keep', '   ')).toBe('keep');
  });

  it('names the mic button for what it does next', () => {
    expect(micLabel({ phase: 'idle' })).toBe('Record a voice note');
    expect(micLabel({ phase: 'recording' })).toBe('Stop recording');
  });

  it('says what is going on above the textarea', () => {
    expect(voiceLine({ phase: 'idle', error: null })).toBeNull();
    expect(voiceLine({ phase: 'starting', error: null })).toEqual({
      text: 'Waiting for the microphone…',
      tone: 'info',
    });
    expect(voiceLine({ phase: 'recording', error: null })).toEqual({
      text: 'Recording · press the mic again to stop',
      tone: 'recording',
    });
    expect(voiceLine({ phase: 'saving', error: null })?.tone).toBe('info');
    expect(voiceLine({ phase: 'failed', error: 'Nope' })).toEqual({ text: 'Nope', tone: 'error' });
    expect(voiceLine({ phase: 'idle', error: 'Microphone access is off.' })).toEqual({
      text: 'Microphone access is off.',
      tone: 'error',
    });
  });
});

describe('the composer’s words', () => {
  it('describes the graphic first, and asks for a change after', () => {
    expect(composerWords(false)).toEqual({
      label: 'Describe the graphic you need',
      placeholder: 'Describe the graphic you need…',
    });
    expect(composerWords(true)).toEqual({
      label: 'Ask for a change',
      placeholder: 'Ask for a change…',
    });
  });
});

describe('Details', () => {
  const now = new Date(2026, 9, 22, 12, 0);

  it('lists Kind, Sizes, Length, Versions, Made and Folder, and Used in only when the engine counts', () => {
    const detail = makeGraphicDetail({
      createdAt: new Date(2026, 9, 22, 10, 4).toISOString(),
      usedIn: null,
    });
    expect(detailRows(detail, now)).toEqual([
      { label: 'Kind', value: 'Lower third' },
      { label: 'Sizes', value: '9:16, 16:9, 1:1' },
      { label: 'Length', value: '3 s' },
      { label: 'Versions', value: '2' },
      { label: 'Made', value: 'Today, 10:04' },
      { label: 'Folder', value: '_Graphics/Name on a white pill' },
    ]);
  });

  it('adds "Used in" before the folder when the edits switch is on', () => {
    const rows = detailRows(makeGraphicDetail({ usedIn: 4 }), now);
    expect(rows.map((row) => row.label)).toEqual([
      'Kind',
      'Sizes',
      'Length',
      'Versions',
      'Made',
      'Used in',
      'Folder',
    ]);
    expect(rows.find((row) => row.label === 'Used in')?.value).toBe('4 videos');
  });

  it('says "No videos yet" and "1 video"', () => {
    expect(usedInText(0)).toBe('No videos yet');
    expect(usedInText(1)).toBe('1 video');
    expect(usedInText(12)).toBe('12 videos');
  });

  it('writes a length with at most one decimal', () => {
    expect(lengthText(3)).toBe('3 s');
    expect(lengthText(2.5)).toBe('2.5 s');
    expect(lengthText(3.04)).toBe('3 s');
    expect(lengthText(null)).toBe('');
  });
});

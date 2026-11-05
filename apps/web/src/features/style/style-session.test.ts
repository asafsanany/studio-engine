import { type ClientStyle, noClientStyle } from '@studio/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, type StyleUpload } from '@/data/api';
import { BASE_URL, deferred } from '@/data/test-utils';
import { FakeXhr } from '@/data/test-xhr';
import { filesPicked } from './AddFilesButton';
import { createDropTarget } from './drop-target';
import {
  createStyleSession,
  doneText,
  NOTICE_MS,
  type SessionStyle,
  STILL_WORKING_TEXT,
  UPLOAD_FAILED_TEXT,
} from './style-session';

const CLIENT_ID = '4d337086919d';
const file = (name: string) => new File(['x'], name);
const logo = file('logo.png');
const notes = file('notes.txt');

const analysing = (version = 1): ClientStyle => ({
  ...noClientStyle(CLIENT_ID, 'Kova Coffee'),
  state: 'analysing',
  version,
  pass: { kind: 'read', mode: 'add', fileCount: 2, jobId: null, job: null },
});

/** A session over a style the test changes (`cache`) and an upload it answers when it says go. */
function setup(cached: Partial<SessionStyle> = {}) {
  const cache: SessionStyle = {
    state: 'ready',
    version: 1,
    markdown: '# Style: Kova Coffee\n',
    ...cached,
  };
  const answer = deferred<ClientStyle>();
  const uploads: Pick<StyleUpload, 'files' | 'mode'>[] = [];
  let report: ((percent: number) => void) | undefined;
  const onUploaded = vi.fn();
  const session = createStyleSession({
    getStyle: () => cache,
    upload: ({ files, mode, onProgress }) => {
      uploads.push({ files, mode });
      report = onProgress;
      return answer.promise;
    },
    onUploaded,
  });
  return {
    session,
    cache,
    uploads,
    onUploaded,
    progress: (percent: number) => report?.(percent),
    accept: async (style: ClientStyle = analysing()) => {
      answer.resolve(style);
      await vi.waitFor(() => expect(session.getState().upload).toBeNull());
    },
  };
}

/** A session whose upload is turned down with `error`. */
function refusing(error: unknown, cached: Partial<SessionStyle> = {}) {
  const cache: SessionStyle = { state: 'ready', version: 1, markdown: null, ...cached };
  const session = createStyleSession({
    getStyle: () => cache,
    upload: () => Promise.reject(error),
  });
  return session;
}

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

describe('a client with a style.md', () => {
  it('asks first: the dialog opens with the files and Add chosen, and nothing is sent', () => {
    const { session, uploads } = setup();
    session.take([logo, notes]);

    expect(session.getState().dialog).toEqual({ files: [logo, notes], mode: 'add' });
    expect(session.getState().upload).toBeNull();
    expect(uploads).toEqual([]);
  });

  it('sends the files with mode add when confirmed as it opened', () => {
    const { session, uploads } = setup();
    session.take([logo, notes]);
    session.confirm();

    expect(uploads).toEqual([{ files: [logo, notes], mode: 'add' }]);
    expect(session.getState().dialog).toBeNull();
    expect(session.getState().upload).toMatchObject({
      names: ['logo.png', 'notes.txt'],
      percent: 0,
    });
  });

  it('sends mode replace when Replace the style was chosen', () => {
    const { session, uploads } = setup();
    session.take([logo]);
    session.chooseMode('replace');
    expect(session.getState().dialog?.mode).toBe('replace');
    session.confirm();

    expect(uploads).toEqual([{ files: [logo], mode: 'replace' }]);
  });

  it('can be changed back to Add before confirming', () => {
    const { session, uploads } = setup();
    session.take([logo]);
    session.chooseMode('replace');
    session.chooseMode('add');
    session.confirm();
    expect(uploads[0]?.mode).toBe('add');
  });

  it('sends nothing when the dialog is cancelled, and the next pick starts from Add again', () => {
    const { session, uploads } = setup();
    session.take([logo]);
    session.chooseMode('replace');
    session.cancel();

    expect(session.getState().dialog).toBeNull();
    expect(uploads).toEqual([]);
    session.take([notes]);
    expect(session.getState().dialog).toEqual({ files: [notes], mode: 'add' });
  });

  it('has nothing to confirm or choose while the dialog is closed', () => {
    const { session, uploads } = setup();
    session.confirm();
    session.chooseMode('replace');
    expect(uploads).toEqual([]);
    expect(session.getState().dialog).toBeNull();
  });
});

describe('a client with no style.md', () => {
  it('sends the files at once, with no dialog', () => {
    const { session, uploads } = setup({ markdown: null, state: 'none', version: 0 });
    session.take([logo, notes]);

    expect(session.getState().dialog).toBeNull();
    expect(uploads).toEqual([{ files: [logo, notes], mode: 'add' }]);
    expect(session.getState().upload).toMatchObject({ names: ['logo.png', 'notes.txt'] });
  });

  it('treats a style that has not loaded as no style.md', () => {
    const uploads: unknown[] = [];
    const session = createStyleSession({
      getStyle: () => undefined,
      upload: (upload) => {
        uploads.push(upload);
        return new Promise(() => {});
      },
    });
    session.take([logo]);
    expect(uploads).toHaveLength(1);
  });
});

describe('what is taken', () => {
  it('ignores a pick of no files', () => {
    const { session, uploads } = setup({ markdown: null });
    session.take([]);
    expect(uploads).toEqual([]);
    expect(session.getState().upload).toBeNull();
  });

  it('ignores files chosen while the dialog is asking about others', () => {
    const { session } = setup();
    session.take([logo]);
    session.take([notes]);
    expect(session.getState().dialog?.files).toEqual([logo]);
  });

  it('ignores files chosen while others are on their way', () => {
    const { session, uploads } = setup({ markdown: null });
    session.take([logo]);
    session.take([notes]);
    expect(uploads).toHaveLength(1);
    expect(session.getState().dialog).toBeNull();
  });
});

describe('an upload', () => {
  it('reports its progress, once for each new percent', () => {
    const { session, progress } = setup({ markdown: null });
    const listener = vi.fn();
    session.take([logo]);
    session.subscribe(listener);

    progress(40);
    progress(40);
    progress(41);
    expect(session.getState().upload?.percent).toBe(41);
    expect(listener).toHaveBeenCalledTimes(2);
  });

  it('hands the style the server answered with to onUploaded, and remembers what was sent', async () => {
    const { session, accept, onUploaded } = setup();
    session.take([logo, notes]);
    session.chooseMode('replace');
    session.confirm();
    await accept(analysing(4));

    expect(onUploaded).toHaveBeenCalledWith(analysing(4));
    expect(session.getState()).toMatchObject({
      upload: null,
      dialog: null,
      notice: null,
      started: {
        fromVersion: 4,
        names: ['logo.png', 'notes.txt'],
        mode: 'replace',
        hadStyle: true,
      },
    });
  });

  it('remembers that the files made the first style.md when there was none', async () => {
    const { session, accept } = setup({ markdown: null });
    session.take([logo]);
    await accept(analysing(0));
    expect(session.getState().started).toMatchObject({ hadStyle: false, fromVersion: 0 });
  });

  it('does not tell a progress that comes after the answer', async () => {
    const { session, accept, progress } = setup({ markdown: null });
    session.take([logo]);
    await accept();
    progress(99);
    expect(session.getState().upload).toBeNull();
  });
});

describe('the end of the run', () => {
  async function started(
    options: { mode?: 'add' | 'replace'; hadStyle?: boolean; files?: File[] } = {},
  ) {
    const { mode = 'add', hadStyle = true, files = [logo, notes] } = options;
    const harness = setup(hadStyle ? {} : { markdown: null, state: 'none', version: 0 });
    harness.session.take(files);
    if (hadStyle) {
      harness.session.chooseMode(mode);
      harness.session.confirm();
    }
    await harness.accept(analysing(harness.cache.version));
    return harness;
  }

  it('says the files were added when the style is ready again with a newer version', async () => {
    const { session, cache } = await started();
    Object.assign(cache, { state: 'ready', version: 2 });
    session.observe();

    expect(session.getState().notice).toEqual({
      tone: 'done',
      text: 'Added 2 files to the style.',
    });
    expect(session.getState().started).toBeNull();
  });

  it('says the style was replaced, and that the old one is in history', async () => {
    const { session, cache } = await started({ mode: 'replace', files: [logo] });
    Object.assign(cache, { state: 'ready', version: 2 });
    session.observe();

    expect(session.getState().notice?.text).toBe(
      'Replaced the style with 1 file. The old style.md is in history.',
    );
  });

  it('says style.md was written when the files made the first one', async () => {
    const { session, cache } = await started({ hadStyle: false });
    Object.assign(cache, { state: 'ready', version: 1 });
    session.observe();

    expect(session.getState().notice?.text).toBe('Wrote style.md from 2 files.');
  });

  it('waits while the style is still analysing, or ready with the version it had', async () => {
    const { session, cache } = await started();
    Object.assign(cache, { state: 'analysing', version: 1 });
    session.observe();
    Object.assign(cache, { state: 'ready', version: 1 });
    session.observe();

    expect(session.getState().notice).toBeNull();
    expect(session.getState().started).not.toBeNull();
  });

  it('keeps waiting through a failed run: Retry may still end it with the files added', async () => {
    const { session, cache } = await started();
    Object.assign(cache, { state: 'failed', version: 1 });
    session.observe();
    expect(session.getState().started).not.toBeNull();
    expect(session.getState().notice).toBeNull();

    Object.assign(cache, { state: 'ready', version: 2 });
    session.observe();
    expect(session.getState().notice?.text).toBe('Added 2 files to the style.');
  });

  it('says nothing for a run this page did not start', () => {
    const { session, cache } = setup();
    Object.assign(cache, { state: 'ready', version: 5 });
    session.observe();
    expect(session.getState().notice).toBeNull();
  });

  it('says nothing before the style has loaded', async () => {
    const answer = deferred<ClientStyle>();
    let cached: SessionStyle | undefined = { state: 'ready', version: 1, markdown: null };
    const session = createStyleSession({ getStyle: () => cached, upload: () => answer.promise });
    session.take([logo]);
    answer.resolve(analysing());
    await vi.waitFor(() => expect(session.getState().started).not.toBeNull());
    cached = undefined;
    session.observe();
    expect(session.getState().notice).toBeNull();
  });

  it('takes the notice down after 10 seconds, and not before', async () => {
    const { session, cache } = await started();
    Object.assign(cache, { state: 'ready', version: 2 });
    session.observe();

    vi.advanceTimersByTime(NOTICE_MS - 1);
    expect(session.getState().notice).not.toBeNull();
    vi.advanceTimersByTime(1);
    expect(session.getState().notice).toBeNull();
    expect(NOTICE_MS).toBe(10_000);
  });

  it('clears the notice when the next files go up', async () => {
    const { session, cache } = await started();
    Object.assign(cache, { state: 'ready', version: 2 });
    session.observe();
    expect(session.getState().notice).not.toBeNull();

    session.take([file('more.txt')]);
    session.confirm();
    expect(session.getState().notice).toBeNull();
  });
});

describe('doneText', () => {
  const base = { fromVersion: 1, names: ['a.png'], mode: 'add' as const, hadStyle: true };

  it('says "1 file" for one and "N files" for more', () => {
    expect(doneText(base)).toBe('Added 1 file to the style.');
    expect(doneText({ ...base, names: ['a', 'b', 'c'] })).toBe('Added 3 files to the style.');
  });
});

describe('a refused upload', () => {
  it('says "Still working on the last files." for a 409, for 10 seconds', async () => {
    const session = refusing(new ApiError(409, 'The style is being analysed.'));
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().notice).not.toBeNull());

    expect(session.getState().notice).toEqual({ tone: 'info', text: STILL_WORKING_TEXT });
    expect(STILL_WORKING_TEXT).toBe('Still working on the last files.');
    expect(session.getState().upload).toBeNull();
    expect(session.getState().started).toBeNull();
    vi.advanceTimersByTime(NOTICE_MS);
    expect(session.getState().notice).toBeNull();
  });

  it('shows the server’s words for any other refusal, until the next upload', async () => {
    const message = 'The files are larger than 2 GB together. Send fewer at a time.';
    const session = refusing(new ApiError(413, message));
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().notice).not.toBeNull());

    expect(session.getState().notice).toEqual({ tone: 'error', text: message });
    vi.advanceTimersByTime(NOTICE_MS * 6);
    expect(session.getState().notice).toEqual({ tone: 'error', text: message });
  });

  it('says it could not send the files for a failure that is not the server’s answer', async () => {
    const session = refusing(new TypeError('boom'));
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().notice).not.toBeNull());
    expect(session.getState().notice?.text).toBe(UPLOAD_FAILED_TEXT);
  });

  it('says nothing for an upload that was cancelled', async () => {
    const session = refusing(new DOMException('cancelled', 'AbortError'));
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().upload).toBeNull());
    expect(session.getState().notice).toBeNull();
  });

  it('lets the files be chosen again after a refusal', async () => {
    const session = refusing(new ApiError(409, 'busy'));
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().notice).not.toBeNull());
    session.take([logo]);
    expect(session.getState().upload).not.toBeNull();
    expect(session.getState().notice).toBeNull();
  });
});

describe('subscribing', () => {
  it('tells listeners about every change until they unsubscribe', () => {
    const { session } = setup();
    const listener = vi.fn();
    const unsubscribe = session.subscribe(listener);
    session.take([logo]);
    expect(listener).toHaveBeenCalledTimes(1);
    unsubscribe();
    session.cancel();
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('stops the notice’s timer on dispose', async () => {
    const session = refusing(new ApiError(409, 'busy'));
    const listener = vi.fn();
    session.take([logo]);
    await vi.waitFor(() => expect(session.getState().notice).not.toBeNull());
    session.subscribe(listener);
    session.dispose();
    vi.advanceTimersByTime(NOTICE_MS);
    expect(listener).not.toHaveBeenCalled();
  });
});

describe('the picker and a drop', () => {
  /** What the server would receive, as far as the test can tell. */
  async function sent(styled: boolean, choose: (take: (files: File[]) => void) => void) {
    const requests: FakeXhr[] = [];
    const api = createApi({
      baseUrl: BASE_URL,
      createXhr: () => {
        const xhr = new FakeXhr();
        requests.push(xhr);
        return xhr;
      },
    });
    const session = createStyleSession({
      getStyle: () => ({ state: 'ready', version: 1, markdown: styled ? '# Style: Kova\n' : null }),
      upload: (upload) => api.uploadStyleFiles(CLIENT_ID, upload),
    });
    choose(session.take);
    // With a style.md the dialog has opened: confirm it as it stands.
    if (styled) session.confirm();
    const [request] = requests;
    return {
      dialog: session.getState().dialog,
      method: request?.method,
      url: request?.url,
      mode: request?.body?.get('mode'),
      files: (request?.body?.getAll('files[]') as File[] | undefined)?.map((f) => f.name),
    };
  }

  const pick = (take: (files: File[]) => void) =>
    filesPicked(take)({
      currentTarget: { files: [logo, notes] as unknown as FileList, value: 'C:\\x' },
    });
  const drop = (take: (files: File[]) => void) =>
    createDropTarget({ onFiles: take, onDragging: () => {} }).drop({
      dataTransfer: { types: ['Files'], files: [logo, notes] },
      preventDefault: () => {},
    });

  it('send the same request for a client with a style.md', async () => {
    const picked = await sent(true, pick);
    const dropped = await sent(true, drop);

    expect(picked).toEqual({
      dialog: null,
      method: 'POST',
      url: `${BASE_URL}/api/clients/${CLIENT_ID}/style/files`,
      mode: 'add',
      files: ['logo.png', 'notes.txt'],
    });
    expect(dropped).toEqual(picked);
  });

  it('send the same request for a client with none', async () => {
    const picked = await sent(false, pick);
    const dropped = await sent(false, drop);

    expect(picked.files).toEqual(['logo.png', 'notes.txt']);
    expect(dropped).toEqual(picked);
  });

  it('open the same dialog for a client with a style.md', async () => {
    const dialogs = [];
    for (const choose of [pick, drop]) {
      const session = createStyleSession({
        getStyle: () => ({ state: 'ready', version: 1, markdown: '# Style: Kova\n' }),
        upload: () => new Promise(() => {}),
      });
      choose(session.take);
      dialogs.push(session.getState().dialog);
    }
    expect(dialogs[0]).toEqual({ files: [logo, notes], mode: 'add' });
    expect(dialogs[1]).toEqual(dialogs[0]);
  });
});

import { orphanAsJob } from '@studio/shared';
import { describe, expect, it, vi } from 'vitest';
import { makeJob, makeJobDelivery, makeOrphanDelivery } from '@/data/test-utils';
import { jobSheetJobs } from '@/features/job-sheet/test-fixtures';
import {
  canShareFile,
  fileNameOf,
  fileOf,
  gettingLabel,
  getVideo,
  probeFile,
  SHARE_IDLE,
  type ShareEvent,
  type ShareFlow,
  type ShareNavigator,
  type ShareTarget,
  sentItLine,
  shareFile,
  shareFlow,
  shareTargetFor,
} from './share-video';

const approved = jobSheetJobs.approved;
const TARGET: ShareTarget = {
  url: '/api/jobs/1e62273e8dba/download',
  fileName: 'טורניר בחירות שש בש.mp4',
  sizeBytes: 27_000_000,
};

const mp4 = (bytes = 3) =>
  new File([new Uint8Array(bytes)], 'טורניר בחירות שש בש.mp4', { type: 'video/mp4' });

/** The flow after each of `events`, from idle. */
function run(...events: ShareEvent[]): ShareFlow {
  return events.reduce(shareFlow, SHARE_IDLE);
}

/** A navigator that can share files, with `share` doing what `answer` says. */
function sharer(answer: () => Promise<void> = () => Promise.resolve()) {
  const share = vi.fn((_data: ShareData) => answer());
  const canShare = vi.fn((data: ShareData) => (data.files ?? []).length > 0);
  return { share, canShare } satisfies ShareNavigator;
}

const abortError = () => Object.assign(new Error('Share canceled'), { name: 'AbortError' });

describe('shareTargetFor: what the phone fetches and shares', () => {
  it('export: the Mac download of an approved job: its address, `<name>.mp4` and its size', () => {
    expect(shareTargetFor(approved, 'export')).toEqual({
      url: `/api/jobs/${approved.id}/download`,
      fileName: 'טורניר בחירות שש בש.mp4',
      sizeBytes: approved.output?.sizeBytes,
    });
  });

  it('export: the same for a delivered or a paid job, each under its own name', () => {
    for (const stage of ['delivered', 'paid'] as const) {
      const job = jobSheetJobs[stage];
      expect(shareTargetFor(job, 'export'), stage).toEqual({
        url: `/api/jobs/${job.id}/download`,
        fileName: `${job.name}.mp4`,
        sizeBytes: job.output?.sizeBytes,
      });
    }
  });

  it('export: none for a job that is not ready, has no MP4, or has no folder', () => {
    for (const state of ['editing', 'review', 'queued'] as const) {
      expect(shareTargetFor(jobSheetJobs[state], 'export'), state).toBeNull();
    }
    expect(shareTargetFor({ ...approved, output: null }, 'export')).toBeNull();
    expect(shareTargetFor(orphanAsJob(makeOrphanDelivery()), 'export')).toBeNull();
    expect(
      shareTargetFor(
        makeJob({ state: 'ready', delivery: makeJobDelivery(), output: null }),
        'export',
      ),
    ).toBeNull();
  });

  it('preview: the preview MP4 of the round and music, named `<job> (preview).mp4`, size unknown', () => {
    expect(shareTargetFor(approved, 'preview', { round: 2, musicRev: 3 })).toEqual({
      url: `/api/jobs/${approved.id}/preview-video.mp4?r=2&m=3`,
      fileName: 'טורניר בחירות שש בש (preview).mp4',
      sizeBytes: null,
    });
    // Not the `download=1` address: that one names the file itself.
    expect(shareTargetFor(approved, 'preview', { round: 1 }).url).toBe(
      `/api/jobs/${approved.id}/preview-video.mp4?r=1`,
    );
  });

  it('preview: the MP4 of the quick fixes’ rev too, so a fix that landed is the video that is shared', () => {
    expect(shareTargetFor(approved, 'preview', { round: 2, musicRev: 3, fixRev: 9 }).url).toBe(
      `/api/jobs/${approved.id}/preview-video.mp4?r=2&m=3&f=9`,
    );
  });
});

describe('shareFlow: the states', () => {
  const file = mp4();

  it('getting: from idle, with the size it expects, then the bytes so far', () => {
    expect(run({ type: 'start', total: 27_000_000 })).toEqual({
      phase: 'getting',
      loaded: 0,
      total: 27_000_000,
    });
    expect(
      run(
        { type: 'start', total: 27_000_000 },
        { type: 'progress', loaded: 12_000_000, total: 27_100_000 },
      ),
    ).toEqual({ phase: 'getting', loaded: 12_000_000, total: 27_100_000 });
  });

  it('ready: the video in hand, when the browser can share it', () => {
    const ready = run({ type: 'start', total: 3 }, { type: 'got', file, shareable: true });
    expect(ready).toEqual({ phase: 'ready', file });
    expect(fileOf(ready)).toBe(file);
  });

  it('unsupported: the browser can’t share it (before fetching, or once it is here)', () => {
    expect(run({ type: 'unsupported' })).toEqual({ phase: 'unsupported' });
    const got = run({ type: 'start', total: 3 }, { type: 'got', file, shareable: false });
    expect(got).toEqual({ phase: 'unsupported' });
    // The video it can't share is let go of at once.
    expect(fileOf(got)).toBeNull();
  });

  it('failed: the fetch did not bring the video, with why', () => {
    expect(run({ type: 'start', total: 3 }, { type: 'failed', message: 'Offline' })).toEqual({
      phase: 'failed',
      message: 'Offline',
    });
  });

  it('shared, then asked: the share sheet closed with the video sent', () => {
    const ready = run({ type: 'start', total: 3 }, { type: 'got', file, shareable: true });
    const sharing = shareFlow(ready, { type: 'share' });
    expect(sharing).toEqual({ phase: 'sharing', file });
    expect(shareFlow(sharing, { type: 'shared' })).toEqual({ phase: 'asking', file });
  });

  it('shared, not asking (a Delivered or Paid job, the preview): straight back to Share video', () => {
    const sharing = run(
      { type: 'start', total: null },
      { type: 'got', file, shareable: true },
      { type: 'share' },
    );
    expect(shareFlow(sharing, { type: 'shared', ask: false })).toEqual({ phase: 'ready', file });
  });

  it('cancelled: the share sheet closed without sending goes back to Share video', () => {
    const sharing = run(
      { type: 'start', total: 3 },
      { type: 'got', file, shareable: true },
      { type: 'share' },
    );
    expect(shareFlow(sharing, { type: 'cancelled' })).toEqual({ phase: 'ready', file });
    expect(shareFlow(sharing, { type: 'refused' })).toEqual({ phase: 'ready', file });
  });

  it('Not yet, or the job delivered: the question goes, Share video comes back with the file', () => {
    const asking = run(
      { type: 'start', total: 3 },
      { type: 'got', file, shareable: true },
      { type: 'share' },
      { type: 'shared' },
    );
    expect(shareFlow(asking, { type: 'not-yet' })).toEqual({ phase: 'ready', file });
    expect(shareFlow(asking, { type: 'left' })).toEqual({ phase: 'ready', file });
  });

  it('ignores what does not apply: a second tap while sharing, an answer with no share open', () => {
    const ready = run({ type: 'start', total: 3 }, { type: 'got', file, shareable: true });
    const sharing = shareFlow(ready, { type: 'share' });
    expect(shareFlow(sharing, { type: 'share' })).toBe(sharing);
    expect(shareFlow(ready, { type: 'shared' })).toBe(ready);
    expect(shareFlow(ready, { type: 'progress', loaded: 1, total: 3 })).toBe(ready);
    expect(shareFlow(SHARE_IDLE, { type: 'share' })).toBe(SHARE_IDLE);
    expect(shareFlow(SHARE_IDLE, { type: 'left' })).toBe(SHARE_IDLE);
    expect(shareFlow(ready, { type: 'got', file: mp4(5), shareable: true })).toBe(ready);
  });

  it('starts over when the fetch starts again (the job came back to Approved)', () => {
    const failed = run({ type: 'start', total: 3 }, { type: 'failed', message: 'Offline' });
    expect(shareFlow(failed, { type: 'start', total: 3 })).toEqual({
      phase: 'getting',
      loaded: 0,
      total: 3,
    });
  });
});

describe('a share, start to end, with navigator.share mocked', () => {
  /** Runs the flow as the sheet does: the tap dispatches `share`, then calls `shareFile`. */
  async function tap(flow: ShareFlow, nav: ShareNavigator): Promise<ShareFlow> {
    if (flow.phase !== 'ready') return flow;
    const sharing = shareFlow(flow, { type: 'share' });
    const { outcome } = await shareFile(nav, flow.file);
    return shareFlow(sharing, { type: outcome });
  }

  const ready = (file: File) =>
    run({ type: 'start', total: file.size }, { type: 'got', file, shareable: true });

  it('shares the MP4 alone, then asks "Sent it to …?"', async () => {
    const nav = sharer();
    const file = mp4();

    const after = await tap(ready(file), nav);

    expect(nav.share).toHaveBeenCalledWith({ files: [file] });
    expect(after.phase).toBe('asking');
  });

  it('calls navigator.share inside the tap: before anything is awaited', () => {
    const nav = sharer(() => new Promise(() => {}));
    void shareFile(nav, mp4());
    // Synchronously, in the same task as the tap.
    expect(nav.share).toHaveBeenCalledTimes(1);
  });

  it('a cancel (AbortError) goes back to Share video, and asks nothing', async () => {
    const nav = sharer(() => Promise.reject(abortError()));
    const file = mp4();

    expect(await shareFile(nav, file)).toEqual({ outcome: 'cancelled' });
    expect(await tap(ready(file), nav)).toEqual({ phase: 'ready', file });
  });

  it('a share sheet that does not open (NotAllowedError) is refused, with the error', async () => {
    const error = Object.assign(new Error('Must be handling a user gesture'), {
      name: 'NotAllowedError',
    });
    const nav = sharer(() => Promise.reject(error));

    expect(await shareFile(nav, mp4())).toEqual({ outcome: 'refused', error });
    expect((await tap(ready(mp4()), nav)).phase).toBe('ready');
  });

  it('is refused without a share function', async () => {
    const result = await shareFile({}, mp4());
    expect(result.outcome).toBe('refused');
  });

  it('shares the words with the MP4 when there are some (Songs: the line for Instagram)', async () => {
    const nav = sharer();
    const file = mp4();
    const line = 'Post “Demo 2 · no song.mp4”. In Instagram tap Add audio.';

    expect(await shareFile(nav, file, line)).toEqual({ outcome: 'shared' });

    expect(nav.share).toHaveBeenCalledWith({ files: [file], text: line });
  });

  it('shares the MP4 alone for no words, or empty ones', async () => {
    const nav = sharer();
    const file = mp4();
    await shareFile(nav, file, undefined);
    await shareFile(nav, file, '');
    expect(nav.share).toHaveBeenNthCalledWith(1, { files: [file] });
    expect(nav.share).toHaveBeenNthCalledWith(2, { files: [file] });
  });
});

describe('canShareFile and probeFile', () => {
  it('asks canShare about the file', () => {
    const nav = sharer();
    const file = mp4();
    expect(canShareFile(nav, file)).toBe(true);
    expect(nav.canShare).toHaveBeenCalledWith({ files: [file] });
  });

  it('is no without share or canShare, when canShare says no, or when it throws', () => {
    expect(canShareFile(undefined, mp4())).toBe(false);
    expect(canShareFile({}, mp4())).toBe(false);
    expect(canShareFile({ share: vi.fn() }, mp4())).toBe(false);
    expect(canShareFile({ share: vi.fn(), canShare: () => false }, mp4())).toBe(false);
    expect(
      canShareFile(
        {
          share: vi.fn(),
          canShare: () => {
            throw new TypeError('bad data');
          },
        },
        mp4(),
      ),
    ).toBe(false);
  });

  it('asks before fetching with a stand-in: no bytes, the MP4’s name and type', () => {
    const probe = probeFile(TARGET);
    expect(probe.size).toBe(0);
    expect(probe.name).toBe('טורניר בחירות שש בש.mp4');
    expect(probe.type).toBe('video/mp4');
  });
});

describe('gettingLabel: the button while the video comes in', () => {
  it('says how many megabytes of how many, and fills to the percent', () => {
    expect(gettingLabel(12_000_000, 27_000_000)).toEqual({
      label: 'Getting the video · 12 of 27 MB',
      pct: 44,
    });
    expect(gettingLabel(0, 27_000_000)).toEqual({
      label: 'Getting the video · 0 of 27 MB',
      pct: 0,
    });
    expect(gettingLabel(27_000_000, 27_000_000)).toEqual({
      label: 'Getting the video · 27 of 27 MB',
      pct: 100,
    });
  });

  it('rounds the size as the sheet’s "27 MB" does, and never counts past it', () => {
    expect(gettingLabel(26_600_000, 26_600_000).label).toBe('Getting the video · 27 of 27 MB');
    expect(gettingLabel(30_000_000, 27_000_000)).toEqual({
      label: 'Getting the video · 27 of 27 MB',
      pct: 100,
    });
  });

  it('has no numbers without a size, or under a megabyte', () => {
    expect(gettingLabel(5, null)).toEqual({ label: 'Getting the video…', pct: 0 });
    expect(gettingLabel(400_000, 800_000)).toEqual({ label: 'Getting the video…', pct: 50 });
  });

  it('says "Preparing" for a row that waited for the tap (a Delivered or Paid job)', () => {
    expect(gettingLabel(12_000_000, 27_000_000, 'Preparing')).toEqual({
      label: 'Preparing the video · 12 of 27 MB',
      pct: 44,
    });
    expect(gettingLabel(0, null, 'Preparing').label).toBe('Preparing the video…');
  });
});

describe('sentItLine: under "Sent it to <client>?"', () => {
  const NOW = new Date('2026-10-22T12:00:00.000Z');

  it('says the price Mark delivered would record and the month it counts in', () => {
    expect(sentItLine({ client: 'RGM', price: 40, currency: 'ILS', month: '2026-10' }, NOW)).toBe(
      'Mark it delivered, and ₪40 counts in October.',
    );
    expect(sentItLine({ client: 'RGM', price: 37.5, currency: 'USD', month: '2026-11' }, NOW)).toBe(
      'Mark it delivered, and $37.50 counts in November.',
    );
  });

  it('leaves the price out until it is known, with this month', () => {
    expect(sentItLine(undefined, NOW)).toBe('Mark it delivered, and it counts in October.');
  });
});

describe('fileNameOf: the Mac download’s name', () => {
  it('reads filename*, which keeps a Hebrew name', () => {
    const header = `attachment; filename="_ _.mp4"; filename*=UTF-8''${encodeURIComponent('טורניר בחירות שש בש.mp4')}`;
    expect(fileNameOf(header, 'fallback.mp4')).toBe('טורניר בחירות שש בש.mp4');
  });

  it('reads filename when there is no filename*, and falls back without either', () => {
    expect(fileNameOf('attachment; filename="Spring promo.mp4"', 'x.mp4')).toBe('Spring promo.mp4');
    expect(fileNameOf(null, 'Spring promo.mp4')).toBe('Spring promo.mp4');
    expect(fileNameOf('attachment', 'Spring promo.mp4')).toBe('Spring promo.mp4');
    expect(fileNameOf("attachment; filename*=UTF-8''%E0%A4%A", 'x.mp4')).toBe('x.mp4');
  });
});

describe('getVideo: the MP4 as a File, with progress', () => {
  /** A fetch answering with `chunks` as the body, and the headers given. */
  function fetchOf(chunks: Uint8Array[], headers: Record<string, string> = {}, status = 200) {
    return vi.fn(async (_url: RequestInfo | URL, _init?: RequestInit) => {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const chunk of chunks) controller.enqueue(chunk);
          controller.close();
        },
      });
      return new Response(body, { status, headers });
    });
  }

  it('reads the body chunk by chunk, telling the bytes so far of the Content-Length', async () => {
    const fetch = fetchOf([new Uint8Array(4), new Uint8Array(6)], {
      'Content-Length': '10',
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent('שש בש.mp4')}`,
    });
    const progress: [number, number | null][] = [];

    const file = await getVideo(TARGET, {
      fetch,
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });

    expect(fetch).toHaveBeenCalledWith(TARGET.url, { signal: undefined });
    expect(progress).toEqual([
      [4, 10],
      [10, 10],
    ]);
    expect(file.size).toBe(10);
    expect(file.name).toBe('שש בש.mp4');
    expect(file.type).toBe('video/mp4');
  });

  it('counts against the export’s size when the answer has no length, and names it `<name>.mp4`', async () => {
    const progress: [number, number | null][] = [];
    const file = await getVideo(TARGET, {
      fetch: fetchOf([new Uint8Array(2)]),
      onProgress: (loaded, total) => progress.push([loaded, total]),
    });
    expect(progress).toEqual([[2, 27_000_000]]);
    expect(file.name).toBe(TARGET.fileName);
  });

  it('passes the signal that stops it when the sheet closes', async () => {
    const controller = new AbortController();
    const fetch = fetchOf([new Uint8Array(1)]);
    await getVideo(TARGET, { fetch, signal: controller.signal });
    expect(fetch).toHaveBeenCalledWith(TARGET.url, { signal: controller.signal });
  });

  it('rejects with the server’s words when the answer is not the video', async () => {
    const fetch = vi.fn(async () =>
      Response.json({ error: 'The export file is missing.' }, { status: 404 }),
    );
    await expect(getVideo(TARGET, { fetch })).rejects.toThrow('The export file is missing.');
  });

  it('rejects with a plain reason when the server says nothing readable', async () => {
    const fetch = vi.fn(async () => new Response('<html>', { status: 502 }));
    await expect(getVideo(TARGET, { fetch })).rejects.toThrow(
      'The video could not be fetched (502).',
    );
  });
});

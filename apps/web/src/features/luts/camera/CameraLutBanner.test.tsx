import { cameraLutWaitSentence, type LutSummary } from '@studio/shared';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { makeJob } from '@/data/test-utils';
import { CameraLutBanner, type CameraLutBannerProps } from './CameraLutBanner';
import { type CameraWaitingJob, cameraWaitingJobs } from './camera-wait';

function lut(name: string): LutSummary {
  return {
    slug: name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
    name,
    kind: 'camera',
    size: 33,
    owner: 'yours',
    used: 0,
    usedLabel: 'Not used yet',
    addedAt: null,
    isNew: false,
  };
}

function waiting(
  jobs: { id: string; client: string; name: string; curve?: 'slog3' | null }[],
  luts: LutSummary[] = [],
): CameraWaitingJob[] {
  return cameraWaitingJobs(
    jobs.map((job, index) =>
      makeJob({
        id: job.id,
        client: job.client,
        name: job.name,
        state: 'failed',
        error: cameraLutWaitSentence({ curve: job.curve === undefined ? 'slog3' : job.curve }),
        updatedAt: `2026-10-25T10:0${index}:00.000Z`,
      }),
    ),
    luts,
  );
}

const OFEK = { id: 'j1', client: 'Ofek', name: 'FPV 3' };
const FALCON = { id: 'j2', client: 'Falcon', name: 'Reel' };

const noop = () => {};
function banner(props: Partial<CameraLutBannerProps> = {}): string {
  return renderToStaticMarkup(
    <CameraLutBanner
      waiting={[]}
      imported={false}
      resumed={[]}
      onImport={noop}
      onResume={noop}
      {...props}
    />,
  );
}

const text = (html: string) =>
  html
    .replace(/<[^>]*>/g, '')
    .replace(/\s+/g, ' ')
    .trim();

describe('the camera LUT banner', () => {
  it('waiting: an amber dot, the sentence of the board, and the button that opens Import', () => {
    const html = banner({ waiting: waiting([OFEK]) });

    expect(text(html)).toBe(
      'Ofek · FPV 3 is waiting for a camera LUT. Its clips are Sony S-Log3 and none of your LUTs match.Import a camera LUT',
    );
    expect(html).toContain('<b class="font-semibold">Ofek · FPV 3</b>');
    expect(html).toContain('role="status"');
    expect(html).toContain('data-state="waiting"');
    expect(html).toContain('bg-status-held');
    expect(html).toContain('Import a camera LUT');
    expect(html).not.toContain('Resume');
  });

  it('waiting for several jobs: the first one by name, the others counted', () => {
    const html = banner({ waiting: waiting([OFEK, FALCON]) });
    expect(text(html)).toContain(
      'Ofek · FPV 3 and 1 other job are waiting for a camera LUT. Its clips are Sony S-Log3',
    );
  });

  it('waiting, more than one LUT matches: says to name one', () => {
    const html = banner({
      waiting: waiting([OFEK], [lut('Sony S-Log3 to Rec709'), lut('S-Log3 Cine to Rec709')]),
    });
    expect(text(html)).toContain(
      'more than one of your camera LUTs match: name one in the job’s note.',
    );
    expect(html).toContain('data-state="waiting"');
    expect(html).toContain('Import a camera LUT');
  });

  it('waiting, the footage names no curve: says so', () => {
    const html = banner({ waiting: waiting([{ ...OFEK, curve: null }]) });
    expect(text(html)).toContain(
      'Its clips are log footage and the files do not say which camera.',
    );
  });

  it('imported: the library now has the LUT, and Resume is the button', () => {
    const html = banner({
      waiting: waiting([OFEK], [lut('Sony S-Log3 to Rec709')]),
      imported: true,
    });

    expect(text(html)).toBe('Imported. Resume Ofek · FPV 3 to use it.Resume');
    expect(html).toContain('data-state="ready"');
    expect(html).not.toContain('Import a camera LUT');
  });

  it('a matching LUT that was there before: names it', () => {
    const html = banner({ waiting: waiting([OFEK], [lut('Sony S-Log3 to Rec709')]) });
    expect(text(html)).toBe(
      '“Sony S-Log3 to Rec709” matches. Resume Ofek · FPV 3 to use it.Resume',
    );
  });

  it('imported while two jobs wait for it: both are resumed by the one button', () => {
    const html = banner({
      waiting: waiting([OFEK, FALCON], [lut('Sony S-Log3 to Rec709')]),
      imported: true,
    });
    expect(text(html)).toBe('Imported. Resume Ofek · FPV 3 and Falcon · Reel to use it.Resume');
  });

  it('imported for one job while another still has no LUT: the one that can go on is offered', () => {
    const vlog = { id: 'j3', client: 'Dana', name: 'Walk' };
    const jobs = [
      makeJob({
        ...{ id: vlog.id, client: vlog.client, name: vlog.name },
        state: 'failed',
        error: cameraLutWaitSentence({ curve: 'vlog' }),
        updatedAt: '2026-10-25T09:00:00.000Z',
      }),
      makeJob({
        id: 'j1',
        client: 'Ofek',
        name: 'FPV 3',
        state: 'failed',
        error: cameraLutWaitSentence({ curve: 'slog3' }),
        updatedAt: '2026-10-25T10:00:00.000Z',
      }),
    ];
    const html = banner({
      waiting: cameraWaitingJobs(jobs, [lut('Sony S-Log3 to Rec709')]),
      imported: true,
    });
    expect(text(html)).toBe('Imported. Resume Ofek · FPV 3 to use it.Resume');
  });

  it('resumed: says which job went on, with no button', () => {
    const html = banner({ resumed: ['Ofek · FPV 3'] });
    expect(text(html)).toBe('Resumed Ofek · FPV 3.');
    expect(html).toContain('data-state="resumed"');
    expect(html).not.toContain('<button');
  });

  it('hidden when no job waits and nothing was resumed', () => {
    expect(banner()).toBe('');
    expect(banner({ imported: true })).toBe('');
  });

  it('a job still waiting wins over a "Resumed" line', () => {
    const html = banner({ waiting: waiting([FALCON]), resumed: ['Ofek · FPV 3'] });
    expect(html).toContain('data-state="waiting"');
    expect(html).not.toContain('Resumed');
  });

  it('the buttons wait while the engine can’t be reached', () => {
    expect(banner({ waiting: waiting([OFEK]), offline: true })).toMatch(
      /<button[^>]*\sdisabled=""/,
    );
    expect(
      banner({ waiting: waiting([OFEK], [lut('Sony S-Log3 to Rec709')]), offline: true }),
    ).toMatch(/<button[^>]*\sdisabled=""/);
    expect(banner({ waiting: waiting([OFEK]) })).not.toMatch(/<button[^>]*\sdisabled=""/);
  });
});

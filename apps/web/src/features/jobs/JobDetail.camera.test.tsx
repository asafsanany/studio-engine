import { cameraLutWaitSentence, type HealthResponse, type Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient, makeJob } from '@/data/test-utils';
import { renderAt } from '@/lib/test-router';
import { textOf } from './cells/test-helpers';
import { JobDetail } from './JobDetail';

// LU10: a failed job whose error is "Waiting for a camera LUT: …" is not shown as a failure in red:
// its row says what it waits for, in the held amber, with a ghost Import LUT button.

const health: HealthResponse = {
  ok: true,
  version: '0.40.0',
  settleMs: 60_000,
  series: false,
  jobSheet: false,
  analytics: false,
  phone: false,
  graphics: false,
  graphicsInEdits: false,
  music: false,
  luts: true,
  lutsInEdits: true,
  fonts: false,
  fontsInNotes: false,
  quickFixes: false,
};

const waiting: Job = makeJob({
  id: 'ofek-fpv-3',
  client: 'Ofek',
  name: 'FPV 3',
  state: 'failed',
  failedAt: 5,
  error: cameraLutWaitSentence({ curve: 'slog3' }),
});

function render(job: Job, luts: boolean) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, luts });
  return renderAt('/jobs', <JobDetail job={job} />, queryClient);
}

describe('<JobDetail> for a job that waits for a camera LUT', () => {
  it('says "Waiting for a camera LUT", not "Failed at Cut", and offers Import LUT', async () => {
    const html = await render(waiting, true);

    expect(textOf(html)).toBe('Waiting for a camera LUT Import LUT');
    expect(html).not.toContain('Failed at');
    expect(html).toContain('data-camera-wait=""');
  });

  it('the text is amber, not the failure red, and is a button the tooltip hangs on', async () => {
    const html = await render(waiting, true);
    const className = html.match(/<button[^>]*class="([^"]*)"/)?.[1] ?? '';

    expect(className).toContain('text-status-held');
    expect(className).not.toContain('text-status-failed-foreground');
    expect(className).toContain('cursor-help');
  });

  it('Import LUT is a ghost link to the LUTs page for this job', async () => {
    const html = await render(waiting, true);
    const link = html.match(/<a[^>]*>/)?.[0] ?? '';

    expect(link).toContain('href="/luts?for=ofek-fpv-3"');
    expect(link).toContain('data-variant="ghost"');
    expect(link).toContain('data-slot="import-lut"');
  });

  it('without the LUTs page there is nothing to go to: the words stay, the button goes', async () => {
    const html = await render(waiting, false);

    expect(textOf(html)).toBe('Waiting for a camera LUT');
    expect(html).not.toContain('Import LUT');
    expect(html).not.toContain('<a ');
  });

  it('any other failure keeps its red text and has no button', async () => {
    const failed = makeJob({
      state: 'failed',
      failedAt: 8,
      error: 'Finished without a final video: ffmpeg is missing.',
    });
    const html = await render(failed, true);

    expect(textOf(html)).toBe('Failed at Render');
    expect(html).not.toContain('Import LUT');
    expect(html).not.toContain('data-camera-wait');
    expect(html).toContain('text-status-failed-foreground');
  });

  it('a failed job with no error text is a plain failure', async () => {
    const html = await render(makeJob({ state: 'failed', failedAt: 5, error: null }), true);
    expect(textOf(html)).toBe('Failed at Cut');
  });

  it('the sentence only counts on a failed job', async () => {
    const queued = makeJob({ state: 'queued', error: cameraLutWaitSentence({ curve: 'slog3' }) });
    const html = await render(queued, true);
    expect(html).not.toContain('Waiting for a camera LUT');
  });
});

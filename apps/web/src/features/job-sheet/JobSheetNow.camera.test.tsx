import { cameraLutWaitSentence, type HealthResponse, type Job } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { HEALTH_KEY } from '@/data/health-query';
import { createTestQueryClient } from '@/data/test-utils';
import { textOf } from '@/features/jobs/cells/test-helpers';
import { renderAt } from '@/lib/test-router';
import { NowError } from './JobSheetNow';
import { type SheetError, sheetError } from './sheet-now';
import { jobSheetJobs } from './test-fixtures';

// LU10: the failed job's box in the sheet, for a job that waits for a camera LUT.

const health: HealthResponse = {
  ok: true,
  version: '0.40.0',
  settleMs: 60_000,
  series: false,
  jobSheet: true,
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

const waitingJob: Job = {
  ...jobSheetJobs.failed,
  id: 'ofek-fpv-3',
  error: cameraLutWaitSentence({ curve: 'slog3' }),
};

function error(job: Job = waitingJob): SheetError {
  const found = sheetError(job, 'UTC');
  if (found === null) throw new Error('the job has an error');
  return found;
}

function render(box: SheetError, luts = true) {
  const queryClient = createTestQueryClient();
  queryClient.setQueryData(HEALTH_KEY, { ...health, luts });
  return renderAt('/jobs', <NowError error={box} />, queryClient);
}

describe('<NowError> for a job that waits for a camera LUT', () => {
  it('is amber, says what it waits for, keeps the whole sentence, and offers Import LUT and Copy', async () => {
    const html = await render(error());

    expect(html).toContain('data-camera-wait=""');
    expect(html).toContain('border-status-held/30');
    expect(html).not.toContain('border-status-failed');
    expect(textOf(html)).toBe(
      'Waiting for a camera LUT · 12:52 Import LUT Copy Waiting for a camera LUT: the clips are Sony S-Log3.',
    );
    expect(html).toContain('href="/luts?for=ofek-fpv-3"');
  });

  it('without the LUTs page there is no Import LUT, the rest stays', async () => {
    const html = await render(error(), false);

    expect(html).not.toContain('Import LUT');
    expect(html).toContain('Copy');
    expect(html).toContain('data-camera-wait=""');
  });

  it('any other failure stays red and has no Import LUT', async () => {
    const html = await render(error(jobSheetJobs.failed));

    expect(html).toContain('border-status-failed/30');
    expect(html).not.toContain('data-camera-wait');
    expect(html).not.toContain('Import LUT');
  });

  it('the phone’s box is as it was: plain text and Copy error', async () => {
    const queryClient = createTestQueryClient();
    queryClient.setQueryData(HEALTH_KEY, health);
    const html = await renderAt('/jobs', <NowError error={error()} variant="phone" />, queryClient);
    expect(html).toContain('Copy error');
    expect(html).not.toContain('Import LUT');
  });
});

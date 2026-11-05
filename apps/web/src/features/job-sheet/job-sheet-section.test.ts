import { afterEach, describe, expect, it } from 'vitest';
import {
  askForVersions,
  clearSectionRequest,
  pendingSectionRequest,
  SECTION_REQUEST_TTL_MS,
  takeSectionRequest,
} from './job-sheet-section';

afterEach(clearSectionRequest);

describe('askForVersions / takeSectionRequest', () => {
  it('holds the request until the part for that job takes it, once', () => {
    askForVersions('job-a', 1_000);
    expect(pendingSectionRequest(1_000)).toEqual({
      jobId: 'job-a',
      section: 'versions',
      at: 1_000,
    });

    expect(takeSectionRequest('job-b', 'versions', 1_100)).toBe(false);
    expect(takeSectionRequest('job-a', 'versions', 1_200)).toBe(true);
    expect(takeSectionRequest('job-a', 'versions', 1_300)).toBe(false);
    expect(pendingSectionRequest(1_300)).toBeNull();
  });

  it('lets a request nobody took go after a few seconds', () => {
    askForVersions('job-a', 1_000);
    expect(takeSectionRequest('job-a', 'versions', 1_000 + SECTION_REQUEST_TTL_MS + 1)).toBe(false);
    expect(pendingSectionRequest(1_000 + SECTION_REQUEST_TTL_MS + 1)).toBeNull();
  });

  it('keeps only the latest request', () => {
    askForVersions('job-a', 1_000);
    askForVersions('job-b', 1_050);
    expect(takeSectionRequest('job-a', 'versions', 1_100)).toBe(false);
    expect(takeSectionRequest('job-b', 'versions', 1_100)).toBe(true);
  });
});

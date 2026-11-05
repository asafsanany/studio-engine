import { NO_SONG_EXPORT_SUFFIX, noSongExportName } from '@studio/shared';
import { describe, expect, it } from 'vitest';
import { exportFileNamePart, exportRelPath } from './finalize.js';

// The second export of a job with a song (Songs, SG8) sits next to the normal one in
// _Exports/<Client>/. The shared helper that names it must treat a job's name exactly the way the
// normal export's name does (finalize.ts), so the two files never drift apart.
describe('noSongExportName next to the normal export', () => {
  it.each([
    'Demo 2',
    'הדגמה 2',
    'Re: spring/summer',
    'a\u0000b',
    'Café',
    'Café',
    'נתתי לך בית – גרסה ב׳',
    '2026-10-25 10:30',
    '  spaced  ',
  ])('is the normal export’s name part plus " · no song.mp4": %j', (name) => {
    expect(noSongExportName(name)).toBe(`${exportFileNamePart(name)}${NO_SONG_EXPORT_SUFFIX}.mp4`);
  });

  it('sits in the same folder with the same stem', () => {
    const job = { client: 'Falcon FPV', name: 'Demo 2' };
    const normal = exportRelPath(job);
    expect(normal).toBe('Falcon FPV/Demo 2.mp4');
    const second = `${normal.slice(0, normal.lastIndexOf('/') + 1)}${noSongExportName(job.name)}`;
    expect(second).toBe('Falcon FPV/Demo 2 · no song.mp4');
  });
});

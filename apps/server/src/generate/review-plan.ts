// What Review needs to hint at a note on a generated video (Generated videos, GN8): the clips of
// the cut with the stretch each fills and what its kept take cost (edit/generate/shots.json), and
// the voice lines with the stretch each is spoken over (edit/generate/voice-words.json). It is read
// as it is on disk each time, never kept: a revise round changes both files. The files stay
// agent-only; this is only the numbers a hint line needs.

import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GENERATE_FILES,
  type GenerateNotePlan,
  generateShotsSchema,
  generateVoiceWordsSchema,
} from '@studio/shared';

/** The JSON of a file under the job's edit/ folder, or null when it is missing or not valid. */
async function readEditJson(jobDir: string, relPath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(join(jobDir, 'edit', relPath), 'utf8'));
  } catch {
    return null;
  }
}

/**
 * The plan for the hints of a job folder, or null when the job has no hand-off yet (no valid
 * shots.json). A missing or broken voice-words.json only means no voice lines.
 */
export async function readReviewPlan(jobDir: string): Promise<GenerateNotePlan | null> {
  const shots = generateShotsSchema.safeParse(await readEditJson(jobDir, GENERATE_FILES.shots));
  if (!shots.success) return null;
  const words = generateVoiceWordsSchema.safeParse(
    await readEditJson(jobDir, GENERATE_FILES.voiceWords),
  );

  const lines = new Map<string, { id: string; startSec: number; endSec: number }>();
  if (words.success) {
    for (const word of words.data.words) {
      const line = lines.get(word.line);
      if (line === undefined) {
        lines.set(word.line, { id: word.line, startSec: word.startSec, endSec: word.endSec });
      } else {
        line.startSec = Math.min(line.startSec, word.startSec);
        line.endSec = Math.max(line.endSec, word.endSec);
      }
    }
  }

  return {
    clips: shots.data.shots.map((shot) => ({
      id: shot.id,
      usd: shot.usd,
      shows: shot.shows,
      belowBar: shot.belowBar,
      windows: shot.windows.map(({ startSec, endSec }) => ({ startSec, endSec })),
    })),
    lines: [...lines.values()],
  };
}

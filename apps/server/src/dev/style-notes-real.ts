// Dev check for Add to style (W7 · CVP-117): sends two review notes into a client's style with the
// real Read pass (one Sonnet run) and prints the style.md it made.
//   pnpm --filter @studio/server exec tsx src/dev/style-notes-real.ts
//   pnpm --filter @studio/server exec tsx src/dev/style-notes-real.ts --keep
//   pnpm --filter @studio/server exec tsx src/dev/style-notes-real.ts --fake
//
// What it does: makes a scratch inbox with the client "מאפיית הצפון" and a short hand-written
// _Style/style.md, opens a scratch database, builds the real style worker with the Claude style
// runner, and calls the style-notes hook (createStyleNotes) the way Send does, for the job
// "פרומו לסוף השבוע" at round 1 with two notes marked Add to style, one Hebrew and one English. It
// waits for the client to leave "analysing" and prints the state, the notes file and the new style.md.
//
// Options: --keep (leave the scratch folder, and print where it is: the run's log is in
// <scratch>/data/logs/clients/), --fake (the fake style runner: no Claude, no tokens, to try the
// script itself). A real run costs one short Sonnet session. It never touches ~/Studio Inbox or
// ~/.studio-engine: the inbox, the database, the history and the logs are all in the scratch folder
// (Claude Code itself still reads its login from the home folder and keeps its own session record
// there, as for any run). Set STUDIO_CLAUDE_BIN to use another claude executable. Ctrl+C stops the
// run. Dev-only: nothing imports it, and the build leaves it out.

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import type { ReviewNote } from '@studio/shared';
import { ClaudeStyleRunner } from '../clients/claude-style.js';
import { FakeStyleRunner } from '../clients/fake-style.js';
import { styleDirFor, styleFileFor } from '../clients/paths.js';
import { createStyleNotes } from '../clients/style-notes.js';
import type { StyleRunner } from '../clients/style-run.js';
import { StyleWorker } from '../clients/style-worker.js';
import { ClientStyleRepository, JobRepository, openDatabase } from '../db/index.js';
import { makeScan } from '../db/test-utils.js';
import type { RunnerLogger } from '../pipeline/claude-process.js';

const CLIENT = 'מאפיית הצפון';
const JOB = 'פרומו לסוף השבוע';
const SENT_AT = '2026-10-21T10:00:00.000Z';

const START_STYLE = `# Style: ${CLIENT}
From your files: notes.txt.

## Look
- Colours: warm cream #F6EEDC for backgrounds, dark brown #3B2A20 for text
- Fonts: a rounded sans-serif for titles, the same family regular for captions
`;

const logger: RunnerLogger = {
  info: (obj, msg) => console.error(`[info] ${msg}`, JSON.stringify(obj)),
  warn: (obj, msg) => console.error(`[warn] ${msg}`, JSON.stringify(obj)),
  error: (obj, msg) => console.error(`[error] ${msg}`, JSON.stringify(obj)),
};

function note(overrides: Partial<ReviewNote>): ReviewNote {
  return {
    id: `note-${overrides.atSec}`,
    jobId: 'job',
    round: 1,
    atSec: 0,
    kind: 'text',
    text: null,
    audioFile: null,
    audioSec: null,
    transcriptStatus: null,
    addToStyle: true,
    addToSeries: false,
    createdAt: SENT_AT,
    sentAt: SENT_AT,
    routeStatus: null,
    route: null,
    fixId: null,
    fixedAt: null,
    ...overrides,
  };
}

async function main(): Promise<number> {
  // `pnpm … -- --fake` reaches here as `-- --fake`: drop the separator.
  const { values, positionals } = parseArgs({
    args: process.argv.slice(2).filter((arg) => arg !== '--'),
    allowPositionals: true,
    options: { keep: { type: 'boolean' }, fake: { type: 'boolean' } },
  });
  if (positionals.length > 0) {
    console.error('Usage: tsx src/dev/style-notes-real.ts [--keep] [--fake]');
    return 2;
  }

  const scratch = await mkdtemp(join(tmpdir(), 'studio-style-notes-real-'));
  const inboxPath = join(scratch, 'inbox');
  const dataDir = join(scratch, 'data');
  const logsDir = join(dataDir, 'logs');
  const db = openDatabase(join(dataDir, 'engine.db'));
  let worker: StyleWorker | null = null;
  try {
    await mkdir(join(inboxPath, CLIENT, JOB), { recursive: true });
    await mkdir(styleDirFor(inboxPath, CLIENT), { recursive: true });
    await writeFile(styleFileFor(inboxPath, CLIENT), START_STYLE);

    const claudeBin = process.env.STUDIO_CLAUDE_BIN || 'claude';
    const runner: StyleRunner = values.fake
      ? new FakeStyleRunner({ speed: 20 })
      : new ClaudeStyleRunner({ config: { logsDir, dataDir, claudeBin }, logger });
    const clientStyles = new ClientStyleRepository(db);
    worker = new StyleWorker({ clientStyles, inboxPath, dataDir, runner, logger });
    worker.start();
    process.once('SIGINT', () => void worker?.stop());

    const job = {
      ...new JobRepository(db).upsertFromScan(makeScan(CLIENT, JOB)).job,
      round: 1,
    };
    const hook = createStyleNotes({
      styleFiles: { inboxPath, clientStyles, worker },
      logger,
    });
    const startedAt = Date.now();
    await hook.append(job, [
      note({ atSec: 2.43, text: 'הכותרת יורדת מהר מדי. להשאיר אותה עוד שנייה.' }),
      note({ atSec: 21, text: 'End card: keep the logo up for two seconds.' }),
    ]);
    console.log(`Queued after ${Date.now() - startedAt} ms; waiting for the Read pass…`);
    await worker.idle();

    const style = clientStyles.get(job.clientId);
    console.log(
      `\nState: ${style?.state} (version ${style?.version})${style?.error ? `, error: ${style.error}` : ''}`,
    );
    const files = (await readdir(styleDirFor(inboxPath, CLIENT))).sort();
    console.log(`_Style now holds: ${files.join(', ')}`);
    for (const name of files.filter((file) => file.startsWith('Review notes'))) {
      console.log(
        `\n----- ${name} -----\n${await readFile(join(styleDirFor(inboxPath, CLIENT), name), 'utf8')}`,
      );
    }
    console.log(`----- style.md -----\n${await readFile(styleFileFor(inboxPath, CLIENT), 'utf8')}`);
    if (values.keep) console.log(`Scratch folder kept: ${scratch}`);
    return style?.state === 'ready' ? 0 : 1;
  } finally {
    await worker?.stop();
    db.close();
    if (!values.keep) await rm(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().then(
    (code) => {
      process.exitCode = code;
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exitCode = 1;
    },
  );
}

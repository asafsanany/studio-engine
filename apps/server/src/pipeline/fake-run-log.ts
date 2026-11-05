// The fake runner's job log (Draft & chat, DR9): with the switch on, a stand-in run writes the
// lines a real run would, in the same stream-json shape, so the job chat fills while it goes on (in
// development and in the e2e). Its start and end markers, a line of its own at each step, the
// commands it "ran" with their plain descriptions, the files it wrote, and the check pictures it
// made, as the base64 images a real Read brings back. Nothing secret is in any of it.

import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { extname } from 'node:path';
import { JobLog, jobLogPath, type RunEndOutcome } from './job-log.js';

const MEDIA_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
};

export class FakeRunLog {
  private constructor(
    private readonly log: JobLog,
    private readonly startedAt: number,
  ) {}

  /** Opens the job's log and writes the run's start marker. */
  static async start(
    logsDir: string,
    jobId: string,
    fields: { mode: string; runKind: string; cwd: string },
  ): Promise<FakeRunLog> {
    const log = await JobLog.open(jobLogPath(logsDir, jobId));
    log.marker('start', { jobId, ...fields, fake: true });
    return new FakeRunLog(log, Date.now());
  }

  /** A line of Claude's. */
  say(text: string): void {
    this.assistant([{ type: 'text', text }]);
  }

  /** A command it ran, with its own words for it, and what came back. */
  command(description: string, command: string, output = ''): void {
    this.tool('Bash', { command, description }, output);
  }

  /** A file it wrote. */
  wrote(path: string): void {
    this.tool('Write', { file_path: path, content: '' }, `File created successfully at: ${path}`);
  }

  /** A picture it looked at: read back as the base64 image a real Read returns. */
  async looked(path: string): Promise<void> {
    const mediaType = MEDIA_TYPES[extname(path).toLowerCase()];
    if (mediaType === undefined) return;
    let data: string;
    try {
      data = (await readFile(path)).toString('base64');
    } catch {
      return;
    }
    const id = this.toolUse('Read', { file_path: path });
    this.user([
      {
        type: 'tool_result',
        tool_use_id: id,
        content: [{ type: 'image', source: { type: 'base64', data, media_type: mediaType } }],
      },
    ]);
  }

  /** The end marker, then the log is closed. */
  async end(outcome: RunEndOutcome, error?: string): Promise<void> {
    this.log.marker('end', {
      outcome,
      ...(error === undefined ? {} : { error }),
      exitCode: outcome === 'succeeded' ? 0 : 1,
      signal: null,
      durationMs: Date.now() - this.startedAt,
      sessionId: null,
    });
    await this.log.close();
  }

  private tool(name: string, input: Record<string, unknown>, output: string): void {
    const id = this.toolUse(name, input);
    this.user([{ type: 'tool_result', tool_use_id: id, content: output, is_error: false }]);
  }

  private toolUse(name: string, input: Record<string, unknown>): string {
    const id = `toolu_fake_${randomUUID()}`;
    this.assistant([{ type: 'tool_use', id, name, input }]);
    return id;
  }

  private assistant(content: unknown[]): void {
    this.log.line(JSON.stringify({ type: 'assistant', message: { role: 'assistant', content } }));
  }

  private user(content: unknown[]): void {
    this.log.line(JSON.stringify({ type: 'user', message: { role: 'user', content } }));
  }
}

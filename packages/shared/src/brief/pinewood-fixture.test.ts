import { describe, expect, it } from 'vitest';
import pinewood from './fixtures/pinewood-brief.json' with { type: 'json' };
import { renderBriefMd } from './render.ts';
import { BRIEF_GENERATED_KEYS, briefDraftSchema, briefPromptSchema } from './schema.ts';

// Generated videos (GN4): the brief.json the Brief run is expected to write for the PINEWOOD folder
// (the client's brief text, the references zip and the reference video, no footage), written by
// hand from `PINEWOOD brief.txt`. It pins the rules of apps/server/prompts/brief-generate.md to the
// brief contract (GN0): what the folder becomes in production, voiceover, formats and budgetUsd,
// and what the edit run's brief.md then says. The same folder is what the one real Brief run
// (CVP-413) was checked against.

const draft = briefDraftSchema.parse(pinewood.draft);

/** The script word for word, as the client wrote it in "COMPLETE VOICEOVER SCRIPT" (the quotes around the block left off). */
const SCRIPT = [
  'You always think about the paint on your walls and the floors you walk on…',
  'But what about the view you look at every day?',
  'Even while you relax?',
  'Dust, pollen, and rain spots can collect on your windows and screens.',
  'That’s why, for a limited time, PINEWOOD Home Services is offering window cleaning for only ninety-seven dollars, including a free screen inspection.',
  'And that’s not all—your basic gutter cleaning is included in the same ninety-seven-dollar special!',
  'Get it now and save. Tap below to request your appointment.',
];

describe('the expected brief.json of the PINEWOOD folder', () => {
  it('parses with the draft schema and keeps every value', () => {
    expect(draft).toEqual(pinewood.draft);
  });

  it('is a generated video', () => {
    expect(draft.production).toBe('generate');
  });

  it('has the seven lines of the script word for word, in order, as L1 to L7', () => {
    expect(draft.voiceover?.lines.map((line) => line.id)).toEqual([
      'L1',
      'L2',
      'L3',
      'L4',
      'L5',
      'L6',
      'L7',
    ]);
    expect(draft.voiceover?.lines.map((line) => line.text)).toEqual(SCRIPT);
  });

  it('gives the BUT line its direction, and the sleeping line its own', () => {
    const lines = draft.voiceover?.lines ?? [];
    expect(lines[1]?.direction).toBe(
      'stress BUT, with a short pause after it, and give the whole question weight',
    );
    expect(lines[2]?.direction).toBe(
      'slightly quieter, thought-provoking, then a brief natural pause',
    );
  });

  it('asks for both formats, the vertical one first and as the canvas, and names no budget', () => {
    expect(draft.formats).toEqual(['1080x1920', '1080x1080']);
    expect(draft.canvas).toBe(draft.formats?.[0]);
    expect(draft.budgetUsd).toBeNull();
  });

  it('puts every file of the folder in files with a role: the zip is ignored, no video is footage', () => {
    expect([...draft.files.map((file) => file.path)].sort()).toEqual([...pinewood.folder].sort());
    const role = (path: string) => draft.files.find((file) => file.path === path)?.role;
    expect(role('pinewood-references.zip')).toBe('ignore');
    expect(role('PINEWOOD brief.txt')).toBe('instructions');
    expect(role('reference/reference-video-35s.mp4')).toBe('reference');
    expect(draft.files.filter((file) => file.role === 'footage')).toEqual([]);
    // The videos inside the zip are references too.
    for (const file of draft.files.filter((entry) => entry.path.endsWith('.mp4'))) {
      expect(file.role).toBe('reference');
    }
  });

  it('puts the files unpacked from the zip under edit/brief/unzipped/<zip name>/', () => {
    const unpacked = pinewood.folder.filter((path) => path.startsWith('edit/'));
    expect(unpacked).toHaveLength(7);
    for (const path of unpacked) {
      expect(path.startsWith('edit/brief/unzipped/pinewood-references/')).toBe(true);
    }
  });

  it('is what brief.md tells the editor: no footage, the script by line with its directions, both formats', () => {
    const markdown = renderBriefMd(draft, {
      client: pinewood.client,
      job: pinewood.job,
      note: null,
    });
    const section =
      markdown.split('\n## ').find((part) => part.startsWith('Generated video')) ?? '';

    expect(section).toContain('Production: generate. There is no footage');
    for (const [index, text] of SCRIPT.entries())
      expect(section).toContain(`L${index + 1}: "${text}"`);
    expect(section).toContain(
      'L2: "But what about the view you look at every day?" (say it: stress BUT, with a short pause after it, and give the whole question weight)',
    );
    expect(section).toContain('Formats: 1080x1920, 1080x1080, one video of each');
    expect(section).not.toContain('Budget');
    // The decisions name the canvas of the main format.
    expect(markdown).toContain('1080x1920');
  });
});

describe('the Brief prompt’s schema with the Generate switch', () => {
  const properties = (generate: boolean) =>
    JSON.parse(briefPromptSchema({ songs: true, generate })) as {
      properties: Record<string, unknown>;
      required: string[];
    };

  it('lists production, voiceover, formats and budgetUsd as required, so a run answers each one', () => {
    const schema = properties(true);
    for (const key of BRIEF_GENERATED_KEYS) {
      expect(schema.properties, key).toHaveProperty(key);
      expect(schema.required, key).toContain(key);
    }
  });

  it('leaves the four keys out without the switch', () => {
    const schema = properties(false);
    for (const key of BRIEF_GENERATED_KEYS) {
      expect(schema.properties, key).not.toHaveProperty(key);
      expect(schema.required, key).not.toContain(key);
    }
  });
});

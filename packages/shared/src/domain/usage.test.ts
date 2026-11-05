import { describe, expect, it } from 'vitest';
import {
  APP_USAGE_TAGS,
  lastEntryAt,
  parseUsageLog,
  SESSION_USAGE_TAGS,
  sessionUsageTagSchema,
  USAGE_GROUPS,
  USAGE_TAG_INFO,
  USAGE_TAGS,
  type UsageEntry,
  usageEntrySchema,
  usageTagSchema,
} from './usage.ts';

function entry(overrides: Partial<UsageEntry> = {}): UsageEntry {
  return {
    at: '2026-10-22T10:00:00.000Z',
    from: null,
    source: 'session',
    tag: 'development',
    did: 'Built the usage log',
    session: 's1',
    usage: {
      'claude-opus-5-5': { requests: 2, input: 10, output: 200, cacheRead: 5000, cacheWrite: 300 },
    },
    ...overrides,
  };
}

describe('usage tags', () => {
  it('has every app tag and session tag once, bugfix folded into development', () => {
    expect(USAGE_TAGS).toEqual([...APP_USAGE_TAGS, ...SESSION_USAGE_TAGS]);
    expect(new Set(USAGE_TAGS).size).toBe(USAGE_TAGS.length);
    expect(USAGE_TAGS).not.toContain('bugfix');
  });

  it('gives every tag a group and a line', () => {
    for (const tag of USAGE_TAGS) {
      expect(USAGE_GROUPS).toContain(USAGE_TAG_INFO[tag].group);
      expect(USAGE_TAG_INFO[tag].means).not.toBe('');
    }
  });

  it('rolls client runs into Client work and design into its own group', () => {
    // The app's own housekeeping, grouping the review notes for Analytics, is not client work.
    for (const tag of APP_USAGE_TAGS) {
      expect(USAGE_TAG_INFO[tag].group).toBe(tag === 'note-topics' ? 'Other' : 'Client work');
    }
    expect(USAGE_TAG_INFO.graphic.group).toBe('Client work');
    expect(USAGE_TAG_INFO.music.group).toBe('Client work');
    expect(USAGE_TAG_INFO['fix-route'].group).toBe('Client work');
    expect(USAGE_TAG_INFO['quick-fix'].group).toBe('Client work');
    expect(USAGE_TAG_INFO.design.group).toBe('Design');
    expect(USAGE_TAG_INFO.development.group).toBe('Building the app');
    expect(USAGE_TAG_INFO.personal.group).toBe('Other');
  });

  it('has the two quick-fix app tags, which a session never uses', () => {
    expect(APP_USAGE_TAGS).toEqual(expect.arrayContaining(['fix-route', 'quick-fix']));
    expect(USAGE_TAG_INFO['fix-route'].means).toBe(
      'Sorting a review note with the difficulty index',
    );
    expect(USAGE_TAG_INFO['quick-fix'].means).toBe('Fixing a review note live in Review');
    expect(sessionUsageTagSchema.safeParse('fix-route').success).toBe(false);
    expect(sessionUsageTagSchema.safeParse('quick-fix').success).toBe(false);
  });

  it('has the generate app tag, which a session never uses', () => {
    expect(APP_USAGE_TAGS).toContain('generate');
    expect(USAGE_TAG_INFO.generate.group).toBe('Client work');
    expect(USAGE_TAG_INFO.generate.means).toBe(
      'Planning and making the shots of a video with no footage',
    );
    expect(usageTagSchema.safeParse('generate').success).toBe(true);
    expect(sessionUsageTagSchema.safeParse('generate').success).toBe(false);
  });

  it('lets a session use only session tags', () => {
    expect(sessionUsageTagSchema.safeParse('design').success).toBe(true);
    expect(sessionUsageTagSchema.safeParse('edit').success).toBe(false);
    expect(sessionUsageTagSchema.safeParse('bugfix').success).toBe(false);
  });
});

describe('usageEntrySchema', () => {
  it('accepts an app entry with its client and job, and a transcription with no session', () => {
    expect(
      usageEntrySchema.safeParse(
        entry({ source: 'app', tag: 'edit', client: 'RGM', job: { id: 'j1', name: 'Ep 3' } }),
      ).success,
    ).toBe(true);
    expect(
      usageEntrySchema.safeParse(
        entry({ source: 'app', tag: 'transcribe', session: null, usage: {} }),
      ).success,
    ).toBe(true);
  });

  it('refuses an unknown tag, an empty line or negative tokens', () => {
    expect(usageEntrySchema.safeParse({ ...entry(), tag: 'bugfix' }).success).toBe(false);
    expect(usageEntrySchema.safeParse(entry({ did: '' })).success).toBe(false);
    const usage = { m: { requests: 1, input: -1, output: 0, cacheRead: 0, cacheWrite: 0 } };
    expect(usageEntrySchema.safeParse(entry({ usage })).success).toBe(false);
  });
});

describe('parseUsageLog', () => {
  it('reads every valid line in order and skips torn or foreign ones', () => {
    const a = entry({ at: '2026-10-22T10:00:00.000Z' });
    const b = entry({ at: '2026-10-22T11:00:00.000Z', tag: 'design' });
    const text = [
      JSON.stringify(a),
      '{"at":',
      '',
      JSON.stringify({ hello: 1 }),
      JSON.stringify(b),
    ].join('\n');
    expect(parseUsageLog(text)).toEqual([a, b]);
  });

  it('reads nothing from an empty file', () => {
    expect(parseUsageLog('')).toEqual([]);
  });
});

describe('lastEntryAt', () => {
  it('is the latest entry of that session, null for a session with none', () => {
    const entries = [
      entry({ session: 's1', at: '2026-10-22T10:00:00.000Z' }),
      entry({ session: 's1', at: '2026-10-22T12:00:00.000Z' }),
      entry({ session: 's2', at: '2026-10-22T13:00:00.000Z' }),
      entry({ session: 's1', at: '2026-10-22T11:00:00.000Z' }),
    ];
    expect(lastEntryAt(entries, 's1')).toBe('2026-10-22T12:00:00.000Z');
    expect(lastEntryAt(entries, 's3')).toBeNull();
  });
});

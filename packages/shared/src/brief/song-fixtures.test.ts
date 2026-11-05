import { describe, expect, it } from 'vitest';
import songBriefs from './fixtures/song-briefs.json' with { type: 'json' };
import { renderBriefMd } from './render.ts';
import { briefDraftSchema, briefPromptSchema } from './schema.ts';

// Songs (SG4): the drafts the Brief run is expected to write for five requests, with the Songs switch
// on. They pin the rules of apps/server/prompts/brief-songs.md to the brief contract (SG0): what each
// request becomes in music, and what the editor's brief.md then says. The same five are what the
// real Brief run was checked against (CVP-388).

type Scenario = (typeof songBriefs)[number];

const MUSIC_KEYS = ['file', 'note', 'wanted', 'song', 'original', 'wantsTrending'];

/** The Decisions lines about the music: a "Music:" or a "Song:" line of brief.md (the Files section has its own). */
function musicLines(scenario: Scenario): string[] {
  const draft = briefDraftSchema.parse(scenario.draft);
  const markdown = renderBriefMd(draft, {
    client: scenario.client,
    job: scenario.job,
    note: scenario.note,
  });
  const decisions =
    markdown.split('\n## ').find((section) => section.startsWith('Decisions')) ?? '';
  return decisions.split('\n').filter((line) => /^- (Music|Song):/.test(line));
}

describe('the drafts of a Brief run with the Songs switch on', () => {
  it('are five requests', () => {
    expect(songBriefs.map((scenario) => scenario.name)).toEqual([
      'a screenshot of a reel names the song',
      'an Original audio label has no song',
      'a link to the song, the sped up version',
      'a trending song, none named',
      'a music file in the folder beats a screenshot',
    ]);
  });

  describe.each(songBriefs)('$name', (scenario) => {
    const draft = briefDraftSchema.parse(scenario.draft);

    it('parses, and spells out every key of music, as a run with the switch on must', () => {
      expect(Object.keys(scenario.draft.music ?? {})).toEqual(MUSIC_KEYS);
      expect(draft.music).toEqual(scenario.draft.music);
      // Every key is in the prompt's schema as required, so a run cannot leave one out.
      const prompt = JSON.parse(briefPromptSchema({ songs: true })) as {
        properties: { music: { anyOf: { required?: string[] }[] } };
      };
      const required = prompt.properties.music.anyOf.find((option) => option.required)?.required;
      expect(required).toEqual(MUSIC_KEYS);
    });

    it('answers the music one way: a file, a song, an Original audio label or a trending ask', () => {
      const music = draft.music;
      const answers = [music?.file, music?.song, music?.original, music?.wantsTrending || null];
      expect(answers.filter((answer) => answer)).toHaveLength(1);
    });

    it('gives every file of the folder a role, and never cuts a screenshot into the video', () => {
      expect(draft.files.map((file) => file.path).sort()).toEqual([...scenario.folder].sort());
      for (const file of draft.files) {
        if (file.path.endsWith('.PNG')) expect(file.role).toBe('instructions');
        if (file.path.endsWith('.mp3')) expect(file.role).toBe('music');
        if (file.path.endsWith('.mp4')) expect(file.role).toBe('footage');
      }
    });

    it('names a file only if it is in the folder, with the role it needs', () => {
      const role = (path: string | null | undefined) =>
        draft.files.find((file) => file.path === path)?.role;
      if (draft.music?.song?.fromFile) {
        expect(role(draft.music.song.fromFile)).toBe('instructions');
      }
      if (draft.music?.file) expect(role(draft.music.file)).toBe('music');
    });

    it('is in the editor’s brief.md as the Decisions line the edit run looks for', () => {
      expect(musicLines(scenario)).toEqual(scenario.decisions);
    });
  });

  it('a screenshot: the title and the artist are word for word, Hebrew as written', () => {
    const song = briefDraftSchema.parse(songBriefs[0]?.draft).music?.song;
    expect(song).toEqual({
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      version: null,
      link: null,
      fromFile: 'IMG_4412.PNG',
    });
  });

  it('Original audio: there is no song, only the account', () => {
    const music = briefDraftSchema.parse(songBriefs[1]?.draft).music;
    expect(music?.song).toBeNull();
    expect(music?.original).toEqual({ by: 'reels.creator' });
    expect(music?.wantsTrending).toBe(false);
  });

  it('a link: it is kept word for word, the version is read, and no name is invented', () => {
    const song = briefDraftSchema.parse(songBriefs[2]?.draft).music?.song;
    expect(song).toEqual({
      title: null,
      artist: null,
      version: 'sped up',
      link: 'https://music.youtube.com/watch?v=Zq3Rk1pXo9A',
      fromFile: null,
    });
  });

  it('a trending ask with no song named: wantsTrending and nothing else', () => {
    const music = briefDraftSchema.parse(songBriefs[3]?.draft).music;
    expect(music).toEqual({
      file: null,
      note: null,
      wanted: false,
      song: null,
      original: null,
      wantsTrending: true,
    });
  });

  it('a music file beats a screenshot: no song, and the conflict is in the assumptions', () => {
    const draft = briefDraftSchema.parse(songBriefs[4]?.draft);
    expect(draft.music).toEqual({
      file: 'track.mp3',
      note: null,
      wanted: false,
      song: null,
      original: null,
      wantsTrending: false,
    });
    const conflict = draft.assumptions.find((line) => line.includes('track.mp3'));
    expect(conflict).toContain('IMG_4412.PNG');
    expect(conflict).toContain('the file wins');
  });
});

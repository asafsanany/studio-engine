import { describe, expect, it } from 'vitest';
import { noInstructionsBrief } from './no-instructions.ts';
import { type BriefGraphic, renderBriefMd } from './render.ts';
import { type Brief, type BriefDraft, briefSchema } from './schema.ts';
import { bakery, bakeryStyle, context, makeDraft, makeMusic } from './test-fixtures.ts';

/** The "## Decisions" lines of a render, so a test can look at one field at a time. */
function decisions(markdown: string): string[] {
  const section = markdown
    .trimEnd()
    .split('\n\n')
    .find((s) => s.startsWith('## Decisions'));
  return section ? section.split('\n').slice(1) : [];
}

describe('renderBriefMd: golden', () => {
  it('reproduces the bakery brief.md byte for byte', () => {
    const out = renderBriefMd(bakery.draft, {
      client: bakery.client,
      job: bakery.job,
      note: bakery.note,
    });
    expect(out).toBe(bakery.markdown);
  });

  it('renders the unparsed fixture the same way (the schema loses nothing)', () => {
    const out = renderBriefMd(bakery.rawDraft as typeof bakery.draft, {
      client: bakery.client,
      job: bakery.job,
      note: bakery.note,
    });
    expect(out).toBe(bakery.markdown);
  });

  it('is pure: same input, same text, and the brief is not changed', () => {
    const before = JSON.parse(JSON.stringify(bakery.draft));
    const a = renderBriefMd(bakery.draft, context);
    const b = renderBriefMd(bakery.draft, context);
    expect(a).toBe(b);
    expect(bakery.draft).toEqual(before);
  });

  it('accepts a full brief (draft plus schema and fingerprint)', () => {
    const brief: Brief = briefSchema.parse({ schema: 1, fingerprint: 'sha1:abc', ...bakery.draft });
    const out = renderBriefMd(brief, {
      client: bakery.client,
      job: bakery.job,
      note: bakery.note,
    });
    expect(out).toBe(bakery.markdown);
  });

  it('ends with exactly one newline and never has two blank lines in a row', () => {
    const out = renderBriefMd(bakery.draft, { ...context, note: bakery.note });
    expect(out.endsWith('\n')).toBe(true);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
  });
});

describe('renderBriefMd: a generated video', () => {
  const lines = {
    lines: [
      { id: 'L1', text: 'Do you know what is in your windows?', direction: null },
      { id: 'L2', text: 'BUT it gets worse.', direction: 'a clear stop after BUT, weighty' },
    ],
  };
  const generated = (overrides: Partial<BriefDraft> = {}): BriefDraft =>
    makeDraft({
      production: 'generate',
      voiceover: lines,
      formats: ['1080x1920', '1080x1080'],
      budgetUsd: 5,
      ...overrides,
    });

  it('prints the Generated video section right after the decisions', () => {
    const out = renderBriefMd(generated({ canvas: '1080x1920' }), context);
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'A short reel.',
        '',
        '## Decisions (these override the defaults)',
        '- Canvas: 1080x1920',
        '',
        '## Generated video',
        '- Production: generate. There is no footage; the video is made from the script and the references.',
        '- Voiceover, word for word, in this order:',
        '  - L1: "Do you know what is in your windows?"',
        '  - L2: "BUT it gets worse." (say it: a clear stop after BUT, weighty)',
        '- Formats: 1080x1920, 1080x1080, one video of each',
        '- Budget: $5 for this video',
        '',
      ].join('\n'),
    );
  });

  it('leaves out what the brief does not say', () => {
    const out = renderBriefMd(generated({ formats: null, budgetUsd: null }), context);
    expect(out).toContain('## Generated video');
    expect(out).toContain('  - L2: ');
    expect(out).not.toContain('Formats');
    expect(out).not.toContain('Budget');
  });

  it('prints a voiceover even when production was not said', () => {
    const out = renderBriefMd(
      generated({ production: null, formats: null, budgetUsd: null }),
      context,
    );
    expect(out).toContain('## Generated video');
    expect(out).toContain('- Production: generate.');
  });

  it('marks an assumed production, voiceover, formats and budget', () => {
    const out = renderBriefMd(
      generated({ assumed: ['production', 'voiceover', 'formats', 'budgetUsd'] }),
      context,
    );
    expect(out).toContain('the references. (assumed)');
    expect(out).toContain('in this order (assumed):');
    expect(out).toContain('one video of each (assumed)');
    expect(out).toContain('for this video (assumed)');
  });

  it('puts the section before the must include list and the files', () => {
    const out = renderBriefMd(
      generated({
        mustInclude: [{ what: 'The skylight', file: null, at: null, quote: null }],
        files: [{ path: 'brief.txt', role: 'instructions', note: null }],
      }),
      context,
    );
    expect(out.indexOf('## Generated video')).toBeLessThan(out.indexOf('## Must include'));
    expect(out.indexOf('## Generated video')).toBeLessThan(out.indexOf('## Files'));
  });

  it('says the formats of a video cut from footage in its decisions, not in a section', () => {
    const out = renderBriefMd(
      makeDraft({ production: 'footage', formats: ['1080x1920', '1080x1080'] }),
      context,
    );
    expect(out).toContain('- Formats: 1080x1920, 1080x1080');
    expect(out).not.toContain('## Generated video');
    expect(out).not.toContain('one video of each');
    const bare = renderBriefMd(makeDraft({ formats: ['1080x1920', '1080x1080'] }), context);
    expect(bare).toContain('- Formats: 1080x1920, 1080x1080');
  });

  it('is exactly what it was for a brief with none of the new keys', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('Generated');
    expect(
      renderBriefMd(bakery.draft, { client: bakery.client, job: bakery.job, note: bakery.note }),
    ).toBe(bakery.markdown);
  });
});

describe('renderBriefMd: empty brief', () => {
  it('has only the header, the summary and the Files section', () => {
    const out = renderBriefMd(noInstructionsBrief(['IMG_1.MOV', 'IMG_2.MOV']), context);
    expect(out).toBe(
      '# Brief: Job (Client)\n\nNo instructions in the folder.\n\n## Files\n- Footage: IMG_1.MOV, IMG_2.MOV\n',
    );
  });

  it('is just the header and the summary when there are no files either', () => {
    expect(renderBriefMd(noInstructionsBrief([]), context)).toBe(
      '# Brief: Job (Client)\n\nNo instructions in the folder.\n',
    );
  });
});

describe('renderBriefMd: note', () => {
  it.each([
    ['null', null],
    ['undefined', undefined],
    ['an empty string', ''],
    ['only whitespace', '  \n\t \n'],
  ])('leaves the section out for %s', (_name, note) => {
    const out = renderBriefMd(makeDraft(), { ...context, note });
    expect(out).not.toContain('The owner’s note');
  });

  it('leaves the section out when the context has no note key', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('The owner’s note');
  });

  it('puts the trimmed note word for word right after the summary', () => {
    const out = renderBriefMd(makeDraft(), {
      ...context,
      note: '\n  Keep it short.\n\nSecond take of the intro.  \n',
    });
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'A short reel.',
        '',
        '## the owner’s note (word for word; it wins)',
        'Keep it short.',
        '',
        'Second take of the intro.',
        '',
      ].join('\n'),
    );
  });
});

describe('renderBriefMd: decisions', () => {
  it('leaves the section out when no field has a value', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('## Decisions');
  });

  it('lists the fields in the fixed order', () => {
    const out = renderBriefMd(
      makeDraft({
        pacing: 'Fast',
        music: makeMusic({ file: 'm.mp3' }),
        look: { logo: 'l.png', colors: [], fonts: [] },
        hook: { what: 'Open on the oven', file: null, at: null },
        captions: 'off',
        language: 'en',
        length: { targetSec: 20, maxSec: null },
        canvas: '1080x1080',
        platform: ['TikTok'],
        audience: 'Locals',
        goal: 'Sell',
        tone: 'Warm',
      }),
      context,
    );
    expect(decisions(out).map((line) => line.split(':')[0])).toEqual([
      '- Goal',
      '- Audience',
      '- Platform',
      '- Canvas',
      '- Length',
      '- Language',
      '- Captions',
      '- Tone',
      '- Pacing',
      '- Hook',
      '- Music',
      '- Look',
    ]);
  });

  it('treats an empty string like a missing value', () => {
    const out = renderBriefMd(makeDraft({ goal: '', tone: '', pacing: '' }), context);
    expect(out).not.toContain('## Decisions');
  });

  it('joins several platforms with a comma', () => {
    const out = renderBriefMd(
      makeDraft({ platform: ['Instagram Reel', 'WhatsApp status', 'TikTok'] }),
      context,
    );
    expect(decisions(out)).toEqual(['- Platform: Instagram Reel, WhatsApp status, TikTok']);
  });

  describe('first letter', () => {
    it.each([
      ['Bring people in', 'bring people in'],
      ['A warm reel', 'a warm reel'],
      ['WhatsApp status first', 'whatsApp status first'],
      ['UGC style, handheld', 'UGC style, handheld'],
      ['TV spot', 'TV spot'],
      ['already lower', 'already lower'],
      ['I', 'I'],
      ['', ''],
      ['חם ומשפחתי', 'חם ומשפחתי'],
      ['2 quick cuts', '2 quick cuts'],
    ])('starts %j as %j', (text, expected) => {
      const out = renderBriefMd(
        makeDraft({ goal: text, audience: text, tone: text, pacing: text }),
        context,
      );
      const lines = decisions(out);
      if (text === '') {
        expect(lines).toEqual([]);
      } else {
        expect(lines).toEqual([
          `- Goal: ${expected}`,
          `- Audience: ${expected}`,
          `- Tone: ${expected}`,
          `- Pacing: ${expected}`,
        ]);
      }
    });

    it('lower-cases the hook text the same way', () => {
      const out = renderBriefMd(
        makeDraft({ hook: { what: 'The challah', file: null, at: null } }),
        context,
      );
      expect(decisions(out)).toEqual(['- Hook: the challah']);
      const caps = renderBriefMd(
        makeDraft({ hook: { what: 'CEO says hi', file: null, at: null } }),
        context,
      );
      expect(decisions(caps)).toEqual(['- Hook: CEO says hi']);
    });

    it('does not touch platform, music or look values', () => {
      const out = renderBriefMd(
        makeDraft({
          platform: ['Instagram Reel'],
          music: makeMusic({ file: 'Track.mp3', note: 'The client’s pick' }),
          look: { logo: 'Logo.png', colors: [], fonts: ['Heebo 800'] },
        }),
        context,
      );
      expect(decisions(out)).toEqual([
        '- Platform: Instagram Reel',
        '- Music: Track.mp3 (The client’s pick)',
        '- Look: logo Logo.png; font Heebo 800',
      ]);
    });
  });

  describe('length', () => {
    it.each([
      [{ targetSec: null, maxSec: 30 }, '30 s at most'],
      [{ targetSec: 45, maxSec: null }, 'about 45 s'],
      [{ targetSec: 30, maxSec: 45 }, 'about 30 s, 45 s at most'],
      [{ targetSec: 22.5, maxSec: 30.25 }, 'about 22.5 s, 30.25 s at most'],
      [{ targetSec: 0.1 + 0.2, maxSec: null }, 'about 0.3 s'],
    ])('writes %j as "%s"', (length, expected) => {
      const out = renderBriefMd(makeDraft({ length }), context);
      expect(decisions(out)).toEqual([`- Length: ${expected}`]);
    });

    it('leaves the line out when there is no length or both values are null', () => {
      expect(decisions(renderBriefMd(makeDraft({ length: null }), context))).toEqual([]);
      expect(
        decisions(renderBriefMd(makeDraft({ length: { targetSec: null, maxSec: null } }), context)),
      ).toEqual([]);
    });
  });

  describe('language', () => {
    it.each([
      ['he', 'Hebrew'],
      ['en', 'English'],
      ['ar', 'Arabic'],
      ['ru', 'Russian'],
      ['fr', 'French'],
      ['es', 'Spanish'],
      ['de', 'German'],
    ])('names %s as %s', (code, name) => {
      const out = renderBriefMd(makeDraft({ language: code }), context);
      expect(decisions(out)).toEqual([`- Language: ${name} (transcribe with --language ${code})`]);
    });

    it('shows a code it has no name for as it is', () => {
      const out = renderBriefMd(makeDraft({ language: 'sv' }), context);
      expect(decisions(out)).toEqual(['- Language: sv (transcribe with --language sv)']);
    });

    it('does not read a name off the object prototype', () => {
      const out = renderBriefMd(makeDraft({ language: 'constructor' }), context);
      expect(decisions(out)).toEqual([
        '- Language: constructor (transcribe with --language constructor)',
      ]);
    });
  });

  describe('hook and music', () => {
    it.each([
      [
        { what: 'Open on the oven', file: 'a.mov', at: '0:03' },
        '- Hook: open on the oven (a.mov, 0:03)',
      ],
      [{ what: 'Open on the oven', file: 'a.mov', at: null }, '- Hook: open on the oven (a.mov)'],
      [{ what: 'Open on the oven', file: null, at: null }, '- Hook: open on the oven'],
      [{ what: 'Open on the oven', file: null, at: '0:03' }, '- Hook: open on the oven'],
    ])('writes the hook %j', (hook, expected) => {
      expect(decisions(renderBriefMd(makeDraft({ hook }), context))).toEqual([expected]);
    });

    it('writes the music with and without a note', () => {
      expect(
        decisions(
          renderBriefMd(
            makeDraft({ music: makeMusic({ file: 'm.mp3', note: 'the client’s pick' }) }),
            context,
          ),
        ),
      ).toEqual(['- Music: m.mp3 (the client’s pick)']);
      expect(
        decisions(renderBriefMd(makeDraft({ music: makeMusic({ file: 'm.mp3' }) }), context)),
      ).toEqual(['- Music: m.mp3']);
    });
  });

  describe('the song (Songs)', () => {
    const song = {
      title: 'נתתי לך בית',
      artist: 'Ofek Adanek',
      version: 'sped up' as const,
      link: null,
      fromFile: 'IMG_4412.PNG',
    };
    const lines = (music: NonNullable<ReturnType<typeof makeDraft>['music']>) =>
      decisions(renderBriefMd(makeDraft({ music }), context));

    it('writes the song asked for, from its screenshot', () => {
      expect(lines(makeMusic({ song }))).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG',
      ]);
    });

    it('writes a song with no version, no screenshot or with a link', () => {
      expect(lines(makeMusic({ song: { ...song, version: null, fromFile: null } }))).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek',
      ]);
      expect(
        lines(
          makeMusic({
            song: { ...song, version: null, fromFile: null, link: 'https://youtu.be/Zq3Rk1pXo9A' },
          }),
        ),
      ).toEqual(['- Song: נתתי לך בית by Ofek Adanek, link https://youtu.be/Zq3Rk1pXo9A']);
    });

    it('writes a song that is only a link, and one with half a name', () => {
      const linkOnly = {
        title: null,
        artist: null,
        version: null,
        link: 'https://www.instagram.com/reel/DQx7mK2kF9a/',
        fromFile: null,
      };
      expect(lines(makeMusic({ song: linkOnly }))).toEqual([
        '- Song: the song in the link, link https://www.instagram.com/reel/DQx7mK2kF9a/',
      ]);
      expect(lines(makeMusic({ song: { ...song, artist: null, fromFile: null } }))).toEqual([
        '- Song: נתתי לך בית (sped up)',
      ]);
    });

    it('writes a trending song as the editor’s pick', () => {
      expect(lines(makeMusic({ wantsTrending: true }))).toEqual([
        '- Song: a trending one, picked by the editor',
      ]);
    });

    it('says an Original audio has no song to look up, with its account', () => {
      expect(lines(makeMusic({ original: { by: '@reels.creator' } }))).toEqual([
        '- Song: none to look up, the screenshot says “Original audio” by @reels.creator',
      ]);
    });

    it('prefers the named song to the label and to a wish for a trending one', () => {
      expect(lines(makeMusic({ song, original: { by: '@x' }, wantsTrending: true }))).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG',
      ]);
      expect(lines(makeMusic({ original: { by: '@x' }, wantsTrending: true }))).toEqual([
        '- Song: none to look up, the screenshot says “Original audio” by @x',
      ]);
    });

    it('keeps the music file’s line and puts the song under it', () => {
      expect(lines(makeMusic({ file: 'm.mp3', note: 'the client’s pick', song }))).toEqual([
        '- Music: m.mp3 (the client’s pick)',
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG',
      ]);
    });

    it('puts the note on the song when there is no music file', () => {
      expect(lines(makeMusic({ note: 'start it at the drop', song }))).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG (start it at the drop)',
      ]);
      expect(lines(makeMusic({ note: 'any hit', wantsTrending: true }))).toEqual([
        '- Song: a trending one, picked by the editor (any hit)',
      ]);
    });

    it('keeps a note alone as the Music line, and says nothing for an empty music', () => {
      expect(lines(makeMusic({ note: 'no music at all' }))).toEqual(['- Music: no music at all']);
      expect(lines(makeMusic())).toEqual([]);
    });

    it('marks the song as assumed when music is', () => {
      const out = renderBriefMd(
        makeDraft({ music: makeMusic({ song }), assumed: ['music'] }),
        context,
      );
      expect(decisions(out)).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG (assumed)',
      ]);
    });

    it('renders a draft from before Songs, whose music has no such keys, as it always did', () => {
      const old = { file: 'm.mp3', note: null } as unknown as ReturnType<typeof makeMusic>;
      expect(lines(old)).toEqual(['- Music: m.mp3']);
    });

    // U21: music is made only when the instructions ask for it.
    it('says music was asked for and is made by the editor, with the note after it', () => {
      expect(lines(makeMusic({ wanted: true }))).toEqual([
        '- Music: asked for, made by the editor',
      ]);
      expect(lines(makeMusic({ wanted: true, note: 'intense, with drops' }))).toEqual([
        '- Music: asked for, made by the editor (intense, with drops)',
      ]);
    });

    it('marks the ask as assumed when music is', () => {
      const out = renderBriefMd(
        makeDraft({ music: makeMusic({ wanted: true }), assumed: ['music'] }),
        context,
      );
      expect(decisions(out)).toEqual(['- Music: asked for, made by the editor (assumed)']);
    });

    it('lets a music file, a song or a trending ask say it instead of the ask', () => {
      expect(lines(makeMusic({ wanted: true, file: 'm.mp3' }))).toEqual(['- Music: m.mp3']);
      expect(lines(makeMusic({ wanted: true, song }))).toEqual([
        '- Song: נתתי לך בית by Ofek Adanek (sped up), from IMG_4412.PNG',
      ]);
      expect(lines(makeMusic({ wanted: true, wantsTrending: true }))).toEqual([
        '- Song: a trending one, picked by the editor',
      ]);
    });

    it('says music was not asked for only while the music switch is on', () => {
      const asked = (music: ReturnType<typeof makeMusic> | null, on: boolean) =>
        decisions(renderBriefMd(makeDraft({ music }), on ? { ...context, music: true } : context));
      expect(asked(null, true)).toEqual(['- Music: not asked for']);
      expect(asked(makeMusic(), true)).toEqual(['- Music: not asked for']);
      expect(asked(null, false)).toEqual([]);
      expect(asked(makeMusic(), false)).toEqual([]);
      // A note, a file or an ask says something about the music, so there is no "not asked for".
      expect(asked(makeMusic({ note: 'no music at all' }), true)).toEqual([
        '- Music: no music at all',
      ]);
      expect(asked(makeMusic({ wanted: true }), true)).toEqual([
        '- Music: asked for, made by the editor',
      ]);
    });
  });

  describe('look', () => {
    it('joins its parts with a semicolon', () => {
      const out = renderBriefMd(
        makeDraft({ look: { logo: 'logo.png', colors: ['#112233'], fonts: ['Heebo 800'] } }),
        context,
      );
      expect(decisions(out)).toEqual(['- Look: logo logo.png; colours #112233; font Heebo 800']);
    });

    it('says "fonts" for several fonts and "font" for one', () => {
      const several = renderBriefMd(
        makeDraft({ look: { logo: null, colors: [], fonts: ['Heebo 800', 'Assistant 400'] } }),
        context,
      );
      expect(decisions(several)).toEqual(['- Look: fonts Heebo 800, Assistant 400']);
      const one = renderBriefMd(
        makeDraft({ look: { logo: null, colors: [], fonts: ['Heebo 800'] } }),
        context,
      );
      expect(decisions(one)).toEqual(['- Look: font Heebo 800']);
    });

    it('leaves out the parts that are empty, and the line when all are', () => {
      const colorsOnly = renderBriefMd(
        makeDraft({ look: { logo: null, colors: ['#000000', '#FFFFFF'], fonts: [] } }),
        context,
      );
      expect(decisions(colorsOnly)).toEqual(['- Look: colours #000000, #FFFFFF']);
      expect(decisions(renderBriefMd(makeDraft(), context))).toEqual([]);
    });
  });

  describe('assumed markers', () => {
    const everything = makeDraft({
      goal: 'Sell',
      audience: 'Locals',
      platform: ['TikTok'],
      canvas: '1080x1920',
      length: { targetSec: null, maxSec: 30 },
      language: 'he',
      captions: 'on',
      tone: 'Warm',
      pacing: 'Fast',
      hook: { what: 'Oven', file: null, at: null },
      music: makeMusic({ file: 'm.mp3' }),
      look: { logo: 'l.png', colors: ['#000000'], fonts: ['Heebo'] },
    });

    it('has no marker when assumed is empty', () => {
      expect(renderBriefMd(everything, context)).not.toContain('(assumed)');
    });

    it.each([
      ['goal', '- Goal: sell (assumed)'],
      ['audience', '- Audience: locals (assumed)'],
      ['platform', '- Platform: TikTok (assumed)'],
      ['canvas', '- Canvas: 1080x1920 (assumed)'],
      ['length', '- Length: 30 s at most (assumed)'],
      ['language', '- Language: Hebrew (transcribe with --language he) (assumed)'],
      ['captions', '- Captions: on (assumed)'],
      ['tone', '- Tone: warm (assumed)'],
      ['pacing', '- Pacing: fast (assumed)'],
      ['hook', '- Hook: oven (assumed)'],
      ['music', '- Music: m.mp3 (assumed)'],
    ])('marks only %s when it alone is in assumed', (path, line) => {
      const lines = decisions(renderBriefMd({ ...everything, assumed: [path] }, context));
      expect(lines.filter((l) => l.endsWith('(assumed)'))).toEqual([line]);
      expect(lines).toContain(line);
    });

    it('marks each Look part on its own, and never the Look line as a whole', () => {
      const only = (path: string) =>
        decisions(renderBriefMd({ ...everything, assumed: [path] }, context)).find((l) =>
          l.startsWith('- Look'),
        );
      expect(only('look.logo')).toBe('- Look: logo l.png (assumed); colours #000000; font Heebo');
      expect(only('look.colors')).toBe('- Look: logo l.png; colours #000000 (assumed); font Heebo');
      expect(only('look.fonts')).toBe('- Look: logo l.png; colours #000000; font Heebo (assumed)');
      expect(only('look')).toBe('- Look: logo l.png; colours #000000; font Heebo');
    });

    it('marks several values at once', () => {
      const out = renderBriefMd(
        { ...everything, assumed: ['captions', 'look.colors', 'look.fonts'] },
        context,
      );
      expect(out.match(/\(assumed\)/g)).toHaveLength(3);
    });

    it('ignores a path whose field is not shown', () => {
      const out = renderBriefMd(makeDraft({ assumed: ['canvas', 'look.logo'] }), context);
      expect(out).not.toContain('(assumed)');
    });
  });
});

describe('renderBriefMd: must include and must avoid', () => {
  it('writes what, then the quote, then the file and time', () => {
    const out = renderBriefMd(
      makeDraft({
        mustInclude: [
          { what: 'Name the croissant', file: null, at: null, quote: 'קרואסון פיסטוק' },
          { what: 'Yossi’s line', file: 'a.mov', at: '0:08', quote: 'הכל נאפה פה' },
          { what: 'The sign', file: 'b.mov', at: null, quote: null },
          { what: 'The hours', file: null, at: '0:30', quote: null },
        ],
      }),
      context,
    );
    expect(out).toContain(
      [
        '## Must include',
        '- Name the croissant: "קרואסון פיסטוק"',
        '- Yossi’s line: "הכל נאפה פה" (a.mov, 0:08)',
        '- The sign (b.mov)',
        '- The hours',
      ].join('\n'),
    );
  });

  it('keeps the first letter of a must-include item as written', () => {
    const out = renderBriefMd(
      makeDraft({ mustInclude: [{ what: 'Prices', file: null, at: null, quote: null }] }),
      context,
    );
    expect(out).toContain('## Must include\n- Prices\n');
  });

  it('writes must-avoid items with an optional file', () => {
    const out = renderBriefMd(
      makeDraft({
        mustAvoid: [
          { what: 'The parking lot', file: 'c.mov' },
          { what: 'Prices', file: null },
        ],
      }),
      context,
    );
    expect(out).toContain('## Must avoid\n- The parking lot (c.mov)\n- Prices\n');
  });

  it('leaves both sections out when empty', () => {
    const out = renderBriefMd(makeDraft(), context);
    expect(out).not.toContain('## Must include');
    expect(out).not.toContain('## Must avoid');
  });
});

describe('renderBriefMd: a full stop before a file or quote part', () => {
  it('drops the full stop of a hook when its file part follows', () => {
    expect(
      decisions(
        renderBriefMd(
          makeDraft({
            hook: { what: 'Open on the oven, the Friday rush.', file: 'a.mov', at: '0:03' },
          }),
          context,
        ),
      ),
    ).toEqual(['- Hook: open on the oven, the Friday rush (a.mov, 0:03)']);
    expect(
      decisions(
        renderBriefMd(
          makeDraft({ hook: { what: 'Open on the oven.', file: 'a.mov', at: null } }),
          context,
        ),
      ),
    ).toEqual(['- Hook: open on the oven (a.mov)']);
  });

  it('keeps the full stop of a hook that has no file part', () => {
    expect(
      decisions(
        renderBriefMd(
          makeDraft({ hook: { what: 'Open on the oven.', file: null, at: '0:03' } }),
          context,
        ),
      ),
    ).toEqual(['- Hook: open on the oven.']);
  });

  it('puts the assumed marker after the file part, still without the full stop', () => {
    expect(
      decisions(
        renderBriefMd(
          makeDraft({
            hook: { what: 'Open on the oven.', file: 'a.mov', at: null },
            assumed: ['hook'],
          }),
          context,
        ),
      ),
    ).toEqual(['- Hook: open on the oven (a.mov) (assumed)']);
  });

  it('drops the full stop of a must-include item before its file part, or its quote', () => {
    const out = renderBriefMd(
      makeDraft({
        mustInclude: [
          { what: 'The sign, Friday.', file: 'b.mov', at: null, quote: null },
          { what: 'Yossi’s line.', file: 'a.mov', at: '0:08', quote: 'הכל נאפה פה' },
          { what: 'Name the croissant.', file: null, at: null, quote: 'קרואסון פיסטוק' },
          { what: 'The hours.', file: null, at: '0:30', quote: null },
          { what: 'Prices.', file: null, at: null, quote: null },
        ],
      }),
      context,
    );
    expect(out).toContain(
      [
        '## Must include',
        '- The sign, Friday (b.mov)',
        '- Yossi’s line: "הכל נאפה פה" (a.mov, 0:08)',
        '- Name the croissant: "קרואסון פיסטוק"',
        '- The hours.',
        '- Prices.',
      ].join('\n'),
    );
  });

  it('drops the full stop of a must-avoid item only when its file part follows', () => {
    const out = renderBriefMd(
      makeDraft({
        mustAvoid: [
          { what: 'The parking lot.', file: 'c.mov' },
          { what: 'Prices.', file: null },
        ],
      }),
      context,
    );
    expect(out).toContain('## Must avoid\n- The parking lot (c.mov)\n- Prices.\n');
  });

  it('drops one full stop only, and leaves an ellipsis and other endings alone', () => {
    const out = renderBriefMd(
      makeDraft({
        mustAvoid: [
          { what: 'Wait for it...', file: 'a.mov' },
          { what: 'Really?', file: 'b.mov' },
          { what: 'Stop!', file: 'c.mov' },
          { what: 'Later…', file: 'd.mov' },
          { what: 'The end..', file: 'e.mov' },
          { what: 'No full stop', file: 'f.mov' },
          { what: 'עברית.', file: 'g.mov' },
        ],
      }),
      context,
    );
    expect(out).toContain(
      [
        '## Must avoid',
        '- Wait for it... (a.mov)',
        '- Really? (b.mov)',
        '- Stop! (c.mov)',
        '- Later… (d.mov)',
        '- The end.. (e.mov)',
        '- No full stop (f.mov)',
        '- עברית (g.mov)',
      ].join('\n'),
    );
  });

  it('does not touch a full stop in the middle of the text', () => {
    const out = renderBriefMd(
      makeDraft({
        mustAvoid: [{ what: 'Mr. Cohen. Again', file: 'a.mov' }],
      }),
      context,
    );
    expect(out).toContain('## Must avoid\n- Mr. Cohen. Again (a.mov)\n');
  });
});

describe('renderBriefMd: on-screen text', () => {
  it('writes title, lower thirds, call to action and end card in that order', () => {
    const out = renderBriefMd(
      makeDraft({
        onScreenText: {
          title: 'שבת שלום',
          lowerThirds: [{ name: 'יוסי', role: 'הבעלים' }],
          cta: 'מחכים לכם',
          endCard: 'שישי 6:00–14:00',
        },
      }),
      context,
    );
    expect(out).toContain(
      [
        '## On-screen text (word for word)',
        '- Title: שבת שלום',
        '- Lower third: יוסי · הבעלים',
        '- Call to action: מחכים לכם',
        '- End card: שישי 6:00–14:00',
      ].join('\n'),
    );
  });

  it('writes one line per person for several lower thirds, with or without a role', () => {
    const out = renderBriefMd(
      makeDraft({
        onScreenText: {
          title: null,
          lowerThirds: [
            { name: 'יוסי', role: 'הבעלים' },
            { name: 'מיכל', role: null },
            { name: 'Dana Levi', role: 'Head baker' },
          ],
          cta: null,
          endCard: null,
        },
      }),
      context,
    );
    expect(out).toContain(
      [
        '## On-screen text (word for word)',
        '- Lower third: יוסי · הבעלים',
        '- Lower third: מיכל',
        '- Lower third: Dana Levi · Head baker',
        '',
      ].join('\n'),
    );
  });

  it('does not change the case of on-screen text', () => {
    const out = renderBriefMd(
      makeDraft({
        onScreenText: { title: 'Weekend Special', lowerThirds: [], cta: 'Come in', endCard: null },
      }),
      context,
    );
    expect(out).toContain('- Title: Weekend Special\n- Call to action: Come in\n');
  });

  it('leaves the section out when nothing is set', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('## On-screen text');
  });
});

describe('renderBriefMd: references', () => {
  it('writes one "file: takeaway" line each', () => {
    const out = renderBriefMd(
      makeDraft({
        references: [
          { file: 'ref-1.mp4', takeaway: 'Quick cuts, big captions' },
          { file: 'ref-2.mp4', takeaway: 'Warm grade' },
        ],
      }),
      context,
    );
    expect(out).toContain(
      [
        '## References (style to match, never in the video)',
        '- ref-1.mp4: Quick cuts, big captions',
        '- ref-2.mp4: Warm grade',
        '',
      ].join('\n'),
    );
  });

  it('leaves the section out when there are none', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('## References');
  });
});

describe('renderBriefMd: files', () => {
  const clip = (path: string) => ({ path, role: 'footage' as const, note: null });

  it('lists up to three footage files one by one, in the order given', () => {
    const out = renderBriefMd(
      makeDraft({ files: [clip('c.mov'), clip('a.mov'), clip('b.mov')] }),
      context,
    );
    expect(out).toContain('## Files\n- Footage: c.mov, a.mov, b.mov\n');
  });

  it('lists one footage file on its own', () => {
    const out = renderBriefMd(makeDraft({ files: [clip('only.mov')] }), context);
    expect(out).toContain('## Files\n- Footage: only.mov\n');
  });

  it('collapses more than three footage files to first – last (N clips), sorted by name', () => {
    const out = renderBriefMd(
      makeDraft({ files: [clip('d.mov'), clip('b.mov'), clip('a.mov'), clip('c.mov')] }),
      context,
    );
    expect(out).toContain('## Files\n- Footage: a.mov – d.mov (4 clips)\n');
    expect(out).not.toContain('b.mov');
  });

  it('sorts by code point, so an emoji name comes after a fullwidth one', () => {
    const out = renderBriefMd(
      makeDraft({
        files: [clip('😀.mov'), clip('a.mov'), clip('｡.mov'), clip('b.mov')],
      }),
      context,
    );
    expect(out).toContain('- Footage: a.mov – 😀.mov (4 clips)\n');
  });

  describe('a file of another role among the footage', () => {
    const other = (path: string, role: 'ignore' | 'reference' | 'instructions' | 'music') => ({
      path,
      role,
      note: null,
    });

    it('never collapses footage across an ignored clip: a, b, c, e with d ignored', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            clip('IMG_2201.mp4'),
            clip('IMG_2202.mp4'),
            clip('IMG_2203.mp4'),
            other('IMG_2204.mp4', 'ignore'),
            clip('IMG_2205.mp4'),
          ],
        }),
        context,
      );
      expect(out).not.toContain('IMG_2201.mp4 – IMG_2205.mp4');
      expect(out).toContain(
        '## Files\n- Footage: IMG_2201.mp4 – IMG_2203.mp4 (3 clips), IMG_2205.mp4\n- Ignored: IMG_2204.mp4\n',
      );
    });

    it('splits at a reference or instructions file too, whatever the order given', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            clip('e.mov'),
            other('d.mp4', 'reference'),
            clip('b.mov'),
            clip('a.mov'),
            other('f.txt', 'instructions'),
            clip('c.mov'),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: a.mov – c.mov (3 clips), e.mov\n');
    });

    it('makes several ranges when two or more files break the run', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            ...['a', 'b', 'c'].map((n) => clip(`${n}.mov`)),
            other('d.mov', 'ignore'),
            ...['e', 'f', 'g', 'h'].map((n) => clip(`${n}.mov`)),
            other('i.mov', 'ignore'),
            clip('j.mov'),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: a.mov – c.mov (3 clips), e.mov – h.mov (4 clips), j.mov\n');
    });

    it('lists runs shorter than three clips one by one', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            clip('a.mov'),
            clip('b.mov'),
            other('c.mov', 'ignore'),
            clip('d.mov'),
            clip('e.mov'),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: a.mov, b.mov, d.mov, e.mov\n');
      expect(out).not.toContain('clips)');
    });

    it('sorts the clips by name when it lists them', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            clip('g.mov'),
            other('f.mov', 'ignore'),
            clip('e.mov'),
            other('d.mov', 'ignore'),
            clip('c.mov'),
            other('b.mov', 'ignore'),
            clip('a.mov'),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: a.mov, c.mov, e.mov, g.mov\n');
    });

    it('still collapses to one range when the other files sort outside it', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [
            other('_chat.txt', 'instructions'),
            other('0001.opus', 'instructions'),
            other('music.mp3', 'music'),
            ...['IMG_1', 'IMG_2', 'IMG_3', 'IMG_4'].map((n) => clip(`${n}.mov`)),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: IMG_1.mov – IMG_4.mov (4 clips)\n');
    });

    it('compares by code point when it decides what sorts inside', () => {
      // "😀.mov" sorts after "｡.mov" by code point, though before it by UTF-16 unit.
      const out = renderBriefMd(
        makeDraft({
          files: [
            clip('a.mov'),
            clip('b.mov'),
            clip('c.mov'),
            other('｡.mov', 'ignore'),
            clip('😀.mov'),
          ],
        }),
        context,
      );
      expect(out).toContain('- Footage: a.mov – c.mov (3 clips), 😀.mov\n');
    });

    it('keeps listing three footage files in the order given, whatever sits between them', () => {
      const out = renderBriefMd(
        makeDraft({
          files: [clip('c.mov'), other('b.mov', 'ignore'), clip('a.mov'), clip('d.mov')],
        }),
        context,
      );
      expect(out).toContain('- Footage: c.mov, a.mov, d.mov\n');
    });
  });

  it('only collapses footage, not other roles', () => {
    const out = renderBriefMd(
      makeDraft({
        files: [
          { path: 'a.opus', role: 'instructions', note: null },
          { path: 'b.opus', role: 'instructions', note: null },
          { path: 'c.opus', role: 'instructions', note: null },
          { path: 'd.opus', role: 'instructions', note: null },
        ],
      }),
      context,
    );
    expect(out).toContain('- Instructions, never in the video: a.opus, b.opus, c.opus, d.opus\n');
  });

  it('groups by role in the fixed order and ignores file notes', () => {
    const out = renderBriefMd(
      makeDraft({
        files: [
          { path: 'junk.txt', role: 'ignore', note: 'old draft' },
          { path: 'chat.txt', role: 'instructions', note: 'WhatsApp chat' },
          { path: 'ref.mp4', role: 'reference', note: null },
          { path: 'logo.png', role: 'logo', note: null },
          { path: 'song.mp3', role: 'music', note: null },
          { path: 'clip.mov', role: 'footage', note: null },
        ],
      }),
      context,
    );
    expect(out).toContain(
      [
        '## Files',
        '- Footage: clip.mov',
        '- Music: song.mp3',
        '- Logo: logo.png',
        '- Reference: ref.mp4',
        '- Instructions, never in the video: chat.txt',
        '- Ignored: junk.txt',
        '',
      ].join('\n'),
    );
  });

  it('leaves out a role that has no files', () => {
    const out = renderBriefMd(
      makeDraft({ files: [{ path: 'song.mp3', role: 'music', note: null }] }),
      context,
    );
    expect(out).toBe('# Brief: Job (Client)\n\nA short reel.\n\n## Files\n- Music: song.mp3\n');
  });
});

describe('renderBriefMd: assumptions', () => {
  it('lists each one, last, with a dash', () => {
    const out = renderBriefMd(
      makeDraft({
        files: [{ path: 'a.mov', role: 'footage', note: null }],
        assumptions: ['Picked the newer take.', 'Captions on.'],
      }),
      context,
    );
    expect(out.endsWith('## Assumptions\n- Picked the newer take.\n- Captions on.\n')).toBe(true);
    expect(out.indexOf('## Files')).toBeLessThan(out.indexOf('## Assumptions'));
  });

  it('leaves the section out when there are none', () => {
    expect(renderBriefMd(makeDraft(), context)).not.toContain('## Assumptions');
  });
});

describe('renderBriefMd: header', () => {
  it('writes job then client, and keeps Hebrew as it is', () => {
    const out = renderBriefMd(makeDraft(), { client: 'מאפיית הצפון', job: 'פרומו' });
    expect(out.startsWith('# Brief: פרומו (מאפיית הצפון)\n\nA short reel.\n')).toBe(true);
  });
});

// Phase 2 (C5): the frozen copy of the client's style closes the brief.
describe('renderBriefMd: client style', () => {
  /** The "## Client style" section of a render, as lines, or null when there is none. */
  function styleSection(markdown: string): string[] | null {
    const at = markdown.indexOf('\n## Client style\n');
    return at < 0 ? null : markdown.slice(at + 1).split('\n');
  }

  const bakeryContext = { client: bakery.client, job: bakery.job, note: bakery.note };

  it('reproduces the bakery brief.md with its style, byte for byte', () => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle });
    expect(out).toBe(bakeryStyle.briefMarkdown);
  });

  it('is the brief without a style, then the section: nothing above it changes', () => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle });
    expect(out.startsWith(`${bakery.markdown}\n## Client style\n`)).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('has no section when the style is %s', (_name, style) => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, style });
    expect(out).toBe(bakery.markdown);
    expect(out).not.toContain('Client style');
  });

  it('is added to the no-instructions brief too, after the Files section', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      style: { markdown: '# Style: Client\n', files: ['style.md'] },
    });
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'No instructions in the folder.',
        '',
        '## Files',
        '- Footage: a.mov',
        '',
        '## Client style',
        'This is the client’s house style. Follow it wherever the sections above say nothing.',
        'Its files are in edit/style/: none besides style.md. Build the graphics in this look.',
        '',
        '### Style: Client',
        '',
      ].join('\n'),
    );
  });

  it('comes after the Assumptions, as the last section', () => {
    const out = renderBriefMd(makeDraft({ assumptions: ['Captions on.'] }), {
      ...context,
      style: bakeryStyle,
    });
    expect(out.indexOf('## Assumptions')).toBeLessThan(out.indexOf('## Client style'));
    expect(out.match(/^## .*$/gm)).toEqual(['## Assumptions', '## Client style']);
  });

  it('is pure: the style is not changed and the same input gives the same text', () => {
    const style = { markdown: bakeryStyle.markdown, files: [...bakeryStyle.files] };
    const a = renderBriefMd(bakery.draft, { ...bakeryContext, style });
    const b = renderBriefMd(bakery.draft, { ...bakeryContext, style });
    expect(a).toBe(b);
    expect(style).toEqual({ markdown: bakeryStyle.markdown, files: [...bakeryStyle.files] });
  });

  describe('headings', () => {
    /** style.md as it comes out under the section's two fixed lines and the blank one. */
    function body(markdown: string): string {
      const out = renderBriefMd(makeDraft(), {
        ...context,
        style: { markdown, files: ['style.md'] },
      });
      return (styleSection(out) ?? []).slice(4).join('\n');
    }

    it('moves every heading two levels deeper: # becomes ###, ## becomes ####', () => {
      expect(body('# Style: Acme\n\n## Look\n\n### Fonts\n#### Titles\n')).toBe(
        '### Style: Acme\n\n#### Look\n\n##### Fonts\n###### Titles\n',
      );
    });

    it('keeps a heading that would go past level six at six', () => {
      expect(body('##### Five\n###### Six\n')).toBe('###### Five\n###### Six\n');
    });

    it('moves a heading with no text, a heading with a tab, and one indented up to three spaces', () => {
      expect(body('#\n#\tTabbed\n   ## Indented\n')).toBe('###\n###\tTabbed\n   #### Indented\n');
    });

    it('leaves a hashtag, a # in the middle of a line, and an indented code line alone', () => {
      const text = '#hashtag\nUse # as a bullet\n    # four spaces is code\n####### seven\n';
      expect(body(text)).toBe(text);
    });

    it('leaves the lines inside a fenced code block alone', () => {
      const fenced = '```sh\n# a comment\n## not a heading\n```';
      expect(body(`# Top\n${fenced}\n## After\n`)).toBe(`### Top\n${fenced}\n#### After\n`);
    });

    it('closes a fence only with the same character, as long, and nothing after it', () => {
      const text = '~~~\n# in\n```\n# still in\n~~~ x\n# still in\n~~~~\n# out\n';
      expect(body(text)).toBe('~~~\n# in\n```\n# still in\n~~~ x\n# still in\n~~~~\n### out\n');
    });

    it('keeps the words, Hebrew and braces as they are', () => {
      expect(body('# Style: מאפיית הצפון\n- Use {{client}} and "quotes" word for word\n')).toBe(
        '### Style: מאפיית הצפון\n- Use {{client}} and "quotes" word for word\n',
      );
    });
  });

  describe('the file list', () => {
    function listed(files: readonly string[]): string | undefined {
      const out = renderBriefMd(makeDraft(), {
        ...context,
        style: { markdown: '# Style: Client', files },
      });
      const line = /^Its files are in edit\/style\/: (.*)\. (?:Reuse|Build) the graphics /m;
      return line.exec(out)?.[1];
    }

    it('lists the files without style.md, sorted, then kit/', () => {
      expect(listed(['style.md', 'logo.png', 'kit/', 'brand.pdf', 'A.txt'])).toBe(
        'A.txt, brand.pdf, logo.png, kit/',
      );
    });

    it('leaves out every folder but kit/', () => {
      expect(listed(['style.md', 'notes/', 'kit/', 'logo.png', 'history/'])).toBe('logo.png, kit/');
    });

    it('sorts by code point, so Hebrew names come after Latin ones', () => {
      expect(listed(['style.md', 'לוגו.png', 'b.png', 'a.png'])).toBe('a.png, b.png, לוגו.png');
    });

    it('is only kit/ when the style has nothing else', () => {
      expect(listed(['style.md', 'kit/'])).toBe('kit/');
    });

    it('says so when style.md is all there is', () => {
      expect(listed(['style.md'])).toBe('none besides style.md');
      expect(listed([])).toBe('none besides style.md');
    });
  });

  // C15: a style made only from uploaded files has no kit/ yet, so the brief must not point to one.
  describe('the graphics sentence', () => {
    const REUSE =
      'Reuse the graphics in edit/style/kit/ with this job’s text, and build new ones only for what the kit doesn’t cover, in the same look.';
    const BUILD = 'Build the graphics in this look.';

    function filesLine(files: readonly string[]): string | undefined {
      const out = renderBriefMd(makeDraft(), {
        ...context,
        style: { markdown: '# Style: Client', files },
      });
      return styleSection(out)?.[2];
    }

    it('tells the editor to reuse the kit when the style has one', () => {
      expect(filesLine(['style.md', 'logo.png', 'kit/'])).toBe(
        `Its files are in edit/style/: logo.png, kit/. ${REUSE}`,
      );
    });

    it('says to build the graphics in this look, and not a word of kit/, when it has none', () => {
      const line = filesLine(['style.md', 'logo.png', 'notes.txt']);
      expect(line).toBe(`Its files are in edit/style/: logo.png, notes.txt. ${BUILD}`);
      expect(line).not.toContain('kit');
    });

    it('does not take another folder for a kit', () => {
      expect(filesLine(['style.md', 'logo.png', 'history/', 'notes/'])).toBe(
        `Its files are in edit/style/: logo.png. ${BUILD}`,
      );
    });

    it('has no mention of edit/style/kit/ anywhere in a brief for a style without a kit', () => {
      const style = { markdown: bakeryStyle.markdown, files: ['style.md', 'logo.png'] };
      const out = renderBriefMd(bakery.draft, { ...bakeryContext, style });
      expect(out).not.toContain('edit/style/kit/');
    });
  });

  describe('the layout', () => {
    it('has the fixed lines, one blank line, then style.md, and ends in one newline', () => {
      const out = renderBriefMd(makeDraft(), {
        ...context,
        style: { markdown: '\n\r\n# Style: A\r\nLine\r\n\r\n\r\n', files: ['style.md'] },
      });
      const lines = styleSection(out) ?? [];
      expect(lines[0]).toBe('## Client style');
      expect(lines[1]).toBe(
        'This is the client’s house style. Follow it wherever the sections above say nothing.',
      );
      expect(lines[3]).toBe('');
      expect(lines.slice(4)).toEqual(['### Style: A', 'Line', '']);
      expect(out.endsWith('\n\n')).toBe(false);
      expect(out).not.toContain('\r');
      expect(out).not.toContain('\n\n\n');
    });

    it.each([
      ['empty', ''],
      ['blank', ' \n\t\n'],
    ])('has no section for a style.md that is %s', (_name, markdown) => {
      const out = renderBriefMd(bakery.draft, {
        ...bakeryContext,
        style: { markdown, files: bakeryStyle.files },
      });
      expect(out).toBe(bakery.markdown);
    });
  });
});

// Series plan §4 (CVP-179): an episode's frozen series opens its own section, before the style's.
describe('renderBriefMd: series', () => {
  /** The "## Series" section of a render, as lines (up to the next "## " section), or null. */
  function seriesSection(markdown: string): string[] | null {
    const at = markdown.indexOf('\n## Series\n');
    if (at < 0) return null;
    const rest = markdown.slice(at + 1);
    const next = rest.indexOf('\n## ', 1);
    return (next < 0 ? rest : rest.slice(0, next)).split('\n');
  }

  const SERIES_MD =
    '# Series: מיתוס או אמת\nFormat from מיתוס או אמת 5 (2026-10-21).\n\n## Kept\n- Red stamp\n\n## New in each episode\n- The question\n';
  const series = { name: 'מיתוס או אמת', episode: 6, markdown: SERIES_MD };
  const bakeryContext = { client: bakery.client, job: bakery.job, note: bakery.note };
  const SENTENCE =
    'This job is episode 6 of the series “מיתוס או אמת”. Rebuild it from the series’ composition in edit/series/kit/: keep every beat, timing, graphic, font, colour, music cue and sound exactly as they are (the music and sound files are in edit/series/kit/assets/audio/), and don’t add or redesign graphics. Cut this job’s footage, fill each part under “New in each episode” from the sections above (or from the footage where they say nothing), and make the captions from the speech. The series wins over the Client style below; the sections above win over both. Where the kit mounts compositions/lib-<id>.html, that is a graphic from the Graphics library: take its files from edit/graphics/<id>/ as the Graphics library section says; if edit/graphics/ has no folder for it, build that moment in the look of the series’ other graphics.';

  it('writes the sentence, a blank line, then series.md with its headings two levels deeper', () => {
    const out = renderBriefMd(makeDraft(), { ...context, series });
    expect(seriesSection(out)).toEqual([
      '## Series',
      SENTENCE,
      '',
      '### Series: מיתוס או אמת',
      'Format from מיתוס או אמת 5 (2026-10-21).',
      '',
      '#### Kept',
      '- Red stamp',
      '',
      '#### New in each episode',
      '- The question',
      '',
    ]);
    expect(out.endsWith('\n\n')).toBe(false);
    expect(out).not.toContain('\n\n\n');
  });

  it('says "an episode" when the job’s name has no number', () => {
    const out = renderBriefMd(makeDraft(), { ...context, series: { ...series, episode: null } });
    expect(seriesSection(out)?.[1]).toBe(
      SENTENCE.replace('This job is episode 6 of', 'This job is an episode of'),
    );
  });

  // CVP-279: a kit may mount a library graphic whose files are not in the kit.
  it('tells where a library graphic the kit mounts comes from, in the Series section only', () => {
    const KIT_GRAPHIC =
      'Where the kit mounts compositions/lib-<id>.html, that is a graphic from the Graphics library: take its files from edit/graphics/<id>/ as the Graphics library section says; if edit/graphics/ has no folder for it, build that moment in the look of the series’ other graphics.';
    const withSeries = renderBriefMd(makeDraft(), { ...context, series });
    expect(seriesSection(withSeries)?.[1]?.endsWith(` ${KIT_GRAPHIC}`)).toBe(true);
    expect(withSeries.split(KIT_GRAPHIC)).toHaveLength(2);
    expect(renderBriefMd(makeDraft(), context)).not.toContain('compositions/lib-<id>.html');
  });

  it('comes after the Assumptions and before the Client style', () => {
    const out = renderBriefMd(makeDraft({ assumptions: ['Captions on.'] }), {
      ...context,
      style: bakeryStyle,
      series,
    });
    expect(out.match(/^## .*$/gm)).toEqual(['## Assumptions', '## Series', '## Client style']);
  });

  it('is the brief as it was, then the section: nothing above it changes', () => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, series });
    expect(out.startsWith(`${bakery.markdown}\n## Series\n`)).toBe(true);
  });

  it('is added to the no-instructions brief too, after the Files section', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      series: { name: 'Show', episode: 2, markdown: '# Series: Show\n' },
    });
    expect(out.match(/^## .*$/gm)).toEqual(['## Files', '## Series']);
    expect(out.endsWith('\n### Series: Show\n')).toBe(true);
  });

  it.each([
    ['null', null],
    ['undefined', undefined],
  ])('is the brief it was, byte for byte, when the series is %s', (_name, value) => {
    expect(renderBriefMd(bakery.draft, { ...bakeryContext, series: value })).toBe(bakery.markdown);
    expect(
      renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle, series: value }),
    ).toBe(bakeryStyle.briefMarkdown);
  });

  it.each([
    ['empty', ''],
    ['blank', ' \n\t\n'],
  ])(
    'has no section, and no series kit sentence, for a series.md that is %s',
    (_name, markdown) => {
      const out = renderBriefMd(bakery.draft, {
        ...bakeryContext,
        style: bakeryStyle,
        series: { ...series, markdown },
      });
      expect(out).toBe(bakeryStyle.briefMarkdown);
    },
  );

  it('keeps the series’ code fences and line ends tidy like the style’s', () => {
    const markdown = '\r\n# Series: A\r\n```\r\n# not a heading\r\n```\r\n## Kept\r\n';
    const out = renderBriefMd(makeDraft(), { ...context, series: { ...series, markdown } });
    expect(seriesSection(out)?.slice(3)).toEqual([
      '### Series: A',
      '```',
      '# not a heading',
      '```',
      '#### Kept',
      '',
    ]);
    expect(out).not.toContain('\r');
  });

  it('is pure: the series is not changed and the same input gives the same text', () => {
    const copy = { ...series };
    const a = renderBriefMd(bakery.draft, { ...bakeryContext, series: copy });
    const b = renderBriefMd(bakery.draft, { ...bakeryContext, series: copy });
    expect(a).toBe(b);
    expect(copy).toEqual(series);
  });

  describe('the client style of an episode', () => {
    const SERIES_KIT = 'Use the series kit in edit/series/kit/, not edit/style/kit/.';

    function filesLine(files: readonly string[]): string | undefined {
      const out = renderBriefMd(makeDraft(), {
        ...context,
        style: { markdown: '# Style: Client', files },
        series,
      });
      const at = out.indexOf('\n## Client style\n');
      return out.slice(at + 1).split('\n')[2];
    }

    it('names the series kit in place of the style’s when the style has a kit', () => {
      expect(filesLine(['style.md', 'logo.png', 'kit/'])).toBe(
        `Its files are in edit/style/: logo.png, kit/. ${SERIES_KIT}`,
      );
    });

    it('names the series kit in place of "Build the graphics in this look" when it has none', () => {
      expect(filesLine(['style.md', 'logo.png'])).toBe(
        `Its files are in edit/style/: logo.png. ${SERIES_KIT}`,
      );
    });

    it('never points an episode at edit/style/kit/ for anything but "not"', () => {
      const out = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle, series });
      expect(out.match(/edit\/style\/kit\//g)).toHaveLength(1);
      expect(out).toContain(`${SERIES_KIT}\n`);
      expect(out).not.toContain('Reuse the graphics');
      expect(out).not.toContain('Build the graphics in this look');
    });

    it('is the style section it was for a job that is not an episode', () => {
      const out = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle });
      expect(out).toBe(bakeryStyle.briefMarkdown);
      expect(out).not.toContain('series');
    });
  });
});

// The client's _Shared folder, next to the job's: right after "## Files".
describe('renderBriefMd: client shared files', () => {
  const bakeryContext = { client: bakery.client, job: bakery.job, note: bakery.note };

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', []],
  ])('has no section when the shared files are %s', (_name, shared) => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, shared });
    expect(out).toBe(bakery.markdown);
    expect(out).not.toContain('## Client shared files');
  });

  const howToUse = [
    'They are not this job’s footage, and not all of them are for this video. Use one where the brief, the owner’s note or the client’s style asks for it (the logo, a product shot, an intro or an outro), or as b-roll where it tells this story better than the job’s own footage. Where the job’s folder has its own (its own logo, say), the job’s file wins.',
    'Look only at the ones that may fit (by name, a few frames, the length), and transcribe one only when you will use its sound.',
    'Copy each one you use into edit/shared/ at the same path inside it, as a clone (mkdir -p "edit/shared/broll" && cp -c "../_Shared/broll/a.mp4" "edit/shared/broll/a.mp4"; plain cp if -c fails), and use it from there. Copy only what you use, and never change, move or delete anything in ../_Shared/: it belongs to all of the client’s videos.',
  ];

  it('lists them one line per folder after the job’s files, before the fonts, and says how to use them', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      shared: ['broll/office.mov', 'logo.png', 'broll/beach.mp4', 'intro.mp4'],
      fonts: ['Heebo-Bold.woff2'],
    });
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'No instructions in the folder.',
        '',
        '## Files',
        '- Footage: a.mov',
        '',
        '## Client shared files',
        'The client keeps files for all of its videos in its _Shared folder, next to this job’s folder (../_Shared/ from the job folder), one line per folder in it:',
        '- At the top: intro.mp4, logo.png',
        '- broll/: beach.mp4, office.mov',
        ...howToUse,
        '',
        '## Fonts',
        'Fonts every client can use are in edit/fonts/, one line per folder in it:',
        '- At the top: Heebo-Bold.woff2',
        'Where the brief or the client’s style names one of these fonts, use its file from here. Where nothing names a font, you may pick one of these that fits the look.',
        'Copy each font you use into the assets/fonts/ folder with the other fonts and load it with @font-face. Check that it has the letters of the video’s language first.',
        '',
      ].join('\n'),
    );
  });

  it('folds a folder’s names around what they share and says what the braces mean', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      shared: ['broll/IMG-0012.MOV', 'broll/IMG-0013.MOV', 'broll/IMG-0020.MOV'],
    });
    const section = out.slice(out.indexOf('## Client shared files')).split('\n');
    expect(section.slice(1, 3)).toEqual([
      'The client keeps files for all of its videos in its _Shared folder, next to this job’s folder (../_Shared/ from the job folder), one line per folder in it (a{1,2}.mp4 means a1.mp4 and a2.mp4):',
      '- broll/: IMG-{0012,0013,0020}.MOV',
    ]);
  });
});

// CVP-201: the shared fonts copied into edit/fonts/ close the brief, after the client's style.
describe('renderBriefMd: shared fonts', () => {
  const bakeryContext = { client: bakery.client, job: bakery.job, note: bakery.note };

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', []],
  ])('has no section when the fonts are %s', (_name, fonts) => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, fonts });
    expect(out).toBe(bakery.markdown);
    expect(out).not.toContain('## Fonts');
  });

  /** The "## Fonts" lines of a render. */
  const fontSection = (fonts: readonly string[]): string[] => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), { ...context, fonts });
    return out.slice(out.indexOf('## Fonts')).trimEnd().split('\n').slice(1);
  };

  /** One folder's list line, for the given files in it. */
  const folderLine = (folder: string, names: readonly string[]): string | undefined =>
    fontSection(names.map((name) => `${folder}/${name}`))[1];

  const howToUse = [
    'Where the brief or the client’s style names one of these fonts, use its file from here. Where nothing names a font, you may pick one of these that fits the look.',
    'Copy each font you use into the assets/fonts/ folder with the other fonts and load it with @font-face. Check that it has the letters of the video’s language first.',
  ];

  it('lists the fonts one line per folder, the files at the top first, and says how to use them', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      fonts: ['Rubik/Rubik-Bold.ttf', 'Heebo-Bold.woff2', 'Assistant.otf'],
    });
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'No instructions in the folder.',
        '',
        '## Files',
        '- Footage: a.mov',
        '',
        '## Fonts',
        'Fonts every client can use are in edit/fonts/, one line per folder in it:',
        '- At the top: Assistant.otf, Heebo-Bold.woff2',
        '- Rubik/: Rubik-Bold.ttf',
        ...howToUse,
        '',
      ].join('\n'),
    );
  });

  it('folds a folder’s names around what they share, sorts the folders and says which fonts have no Hebrew', () => {
    expect(
      fontSection([
        'Hebrew + English/Heebo/Heebo-Bold.ttf',
        'Logo.otf',
        'English only/Inter/Inter-Thin.ttf',
        'Hebrew + English/Heebo/Heebo-Black.ttf',
        'Clients/Acme/Brand/Acme Serif.woff2',
        'English only/Inter/Inter-Bold.ttf',
        'Clients/Acme/Brand/Acme Sans.woff2',
      ]),
    ).toEqual([
      'Fonts every client can use are in edit/fonts/, one line per folder in it (a{1,2}.ttf means a1.ttf and a2.ttf):',
      '- At the top: Logo.otf',
      '- Clients/Acme/Brand/: Acme {Sans,Serif}.woff2',
      '- English only/Inter/: Inter-{Bold,Thin}.ttf',
      '- Hebrew + English/Heebo/: Heebo-{Black,Bold}.ttf',
      'A font whose folder path says “English only” has no Hebrew letters: never use it for Hebrew text.',
      ...howToUse,
    ]);
  });

  it.each([
    [
      'cuts the fold at the edge of a word',
      ['Rubik-Black.ttf', 'Rubik-Bold.ttf'],
      'Rubik-{Black,Bold}.ttf',
    ],
    [
      'never folds the end inside a word',
      ['Heebo-Bold.ttf', 'Heebo-ExtraBold.ttf', 'Heebo-SemiBold.ttf'],
      'Heebo-{Bold,ExtraBold,SemiBold}.ttf',
    ],
    [
      'folds the extensions of one font',
      ['Heebo-Bold.ttf', 'Heebo-Bold.woff2'],
      'Heebo-Bold.{ttf,woff2}',
    ],
    [
      'folds names that are not Family-Weight',
      ['Brand Font 1.otf', 'Brand Font 2.otf'],
      'Brand Font {1,2}.otf',
    ],
    [
      'lists names that only end the same way as they are',
      ['Rubik Italic.ttf', 'Rubik.ttf'],
      'Rubik Italic.ttf, Rubik.ttf',
    ],
    ['folds Hebrew names', ['פונט-בולד.ttf', 'פונט-דק.ttf'], 'פונט-{בולד,דק}.ttf'],
    [
      'lists names that share nothing as they are',
      ['Assistant.otf', 'Heebo.woff2'],
      'Assistant.otf, Heebo.woff2',
    ],
    [
      'lists names as they are when one would fold to nothing',
      ['A-.ttf', 'A-B.ttf'],
      'A-.ttf, A-B.ttf',
    ],
    [
      'never folds a name with a brace in it',
      ['Font {1}.ttf', 'Font {2}.ttf'],
      'Font {1}.ttf, Font {2}.ttf',
    ],
    [
      'never folds a name with a comma in it',
      ['Font 1,2.ttf', 'Font 3.ttf'],
      'Font 1,2.ttf, Font 3.ttf',
    ],
  ])('%s', (_name, names, list) => {
    expect(folderLine('F', names)).toBe(`- F/: ${list}`);
  });

  it('says what a{1,2}.ttf means only when a list is folded', () => {
    const explained = (fonts: readonly string[]): boolean =>
      fontSection(fonts)[0]?.includes('a{1,2}.ttf means') ?? false;
    expect(explained(['F/Heebo-Bold.ttf', 'F/Heebo-Thin.ttf'])).toBe(true);
    expect(explained(['F/Font {1}.ttf', 'F/Font {2}.ttf', '{G}/Heebo-Bold.ttf'])).toBe(false);
  });

  it('says a font has no Hebrew only when its folder path says English only, in any case', () => {
    const hebrew =
      'A font whose folder path says “English only” has no Hebrew letters: never use it for Hebrew text.';
    expect(fontSection(['Latin/ENGLISH ONLY fonts/Inter-Bold.ttf'])).toContain(hebrew);
    expect(fontSection(['Inter-English only.ttf', 'Heebo/Heebo-Bold.ttf'])).not.toContain(hebrew);
  });

  it('lists every file: the lines spell out each path once, in any layout', () => {
    const fonts = [
      'Assistant.otf',
      'Heebo-Bold.woff2',
      'English only/Inter/Inter-Bold.ttf',
      'English only/Inter/Inter-ExtraBold.ttf',
      'English only/Inter/Inter-Regular.ttf',
      'English only/Inter/Italic/Inter-Italic.ttf',
      'English only/Roboto Slab/RobotoSlab-Thin.ttf',
      'Hebrew + English/Heebo/Heebo-Bold.ttf',
      'Hebrew + English/Heebo/Heebo-Bold.woff2',
      'Hebrew + English/Heebo/Heebo-Thin.ttf',
      'Hebrew + English/Rubik/Rubik.ttf',
      'Hebrew + English/Rubik/Rubik Italic.ttf',
      'Hebrew + English/Rubik/rubik-black.otf',
      'a/b/c/d/Deep.ttf',
      'a/b/c/d/Deeper.ttf',
      'Odd/A-.ttf',
      'Odd/A-B.ttf',
    ];
    const listed = fontSection(fonts)
      .filter((line) => line.startsWith('- '))
      .flatMap((line) => {
        const [, label = '', list = ''] = /^- (.*?): (.*)$/.exec(line) ?? [];
        const folder = label === 'At the top' ? '' : label;
        const [, head, middles, tail] = /^(.*)\{(.*)\}(.*)$/.exec(list) ?? [];
        const names =
          middles === undefined
            ? list.split(', ')
            : middles.split(',').map((m) => `${head}${m}${tail}`);
        return names.map((name) => `${folder}${name}`);
      });
    expect(listed.sort()).toEqual([...fonts].sort());
  });

  it('comes after the client style, as the last section, and leaves everything above as it was', () => {
    const fonts = ['Heebo-Bold.ttf'];
    const withStyle = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle });
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle, fonts });
    expect(out.startsWith(`${withStyle}\n## Fonts\n`)).toBe(true);
    expect(out.match(/^## .*$/gm)?.slice(-2)).toEqual(['## Client style', '## Fonts']);
  });

  it('does not change the list it is given', () => {
    const fonts = ['b.ttf', 'a.ttf'];
    renderBriefMd(bakery.draft, { ...bakeryContext, fonts });
    expect(fonts).toEqual(['b.ttf', 'a.ttf']);
  });
});

// GR8: the Graphics library copied into edit/graphics/ closes the brief, after the fonts. Only the
// engine hands it graphics, and only while the graphicsInEdits switch is on.
describe('renderBriefMd: graphics library', () => {
  const bakeryContext = { client: bakery.client, job: bakery.job, note: bakery.note };

  const lowerThird: BriefGraphic = {
    id: 'a1b2c3d4e5f6',
    name: 'Name on a white pill',
    kind: 'lower-third',
    lengthSec: 3,
    when: 'The first time a person is named on camera.',
    variables: [
      { id: 'name', label: 'Name' },
      { id: 'role', label: 'Role' },
    ],
  };
  const callout: BriefGraphic = {
    id: '0f9e8d7c6b5a',
    name: 'Big number',
    kind: 'callout',
    lengthSec: 2.5,
    when: 'When a figure is said out loud',
    variables: [{ id: 'figure', label: 'The number' }],
  };

  /** The "## Graphics library" lines of a render, or null when there is no such section. */
  const section = (graphics: readonly BriefGraphic[] | null | undefined): string[] | null => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), { ...context, graphics });
    return out.includes('## Graphics library')
      ? out.slice(out.indexOf('## Graphics library')).trimEnd().split('\n').slice(1)
      : null;
  };

  const intro =
    'Ready-made graphics are in edit/graphics/, one folder per graphic. Each line gives its folder, its kind and length, when it fits, and its text fields as id (label):';

  // What the section says after the list of graphics, word for word: this is the text the editor gets.
  const howToUse = [
    'A graphic’s When is the owner’s own rule for their videos: wherever it fits a moment of this video, use that graphic there, even when the brief doesn’t mention a graphic at that moment. Use one too where the brief or the owner’s note names it, instead of building a new one for that moment. The Series and Client style sections come first: where they set a graphic for that moment, or say to add none, theirs wins.',
    'To use one (<id> is its folder’s name in edit/graphics/):',
    '- Copy edit/graphics/<id>/compositions/lib-<id>.html to compositions/lib-<id>.html and edit/graphics/<id>/lib/<id>/ to lib/<id>/ in the project that holds the composition, at its root: edit/preview/, or a slot’s folder in edit/animations/. Leave its vendor/ behind: the project has GSAP already.',
    '- Mount it inside the composition’s root with a host div: <div data-composition-id="lib-<id>" data-composition-src="compositions/lib-<id>.html" data-variable-values=\'{"name":"…"}\' data-start="…" data-duration="…" style="position:absolute; inset:0"></div>',
    '- Fill data-variable-values with one JSON entry per text field, keyed by the field’s id, with the words of this video (Hebrew works). Set data-start to the moment it plays and data-duration to its length.',
    '- A field with no words in this video gets an empty value ("") and the graphic hides it.',
    '- Never put data-width or data-height on the mount: the graphic is sized by CSS and fits a video of any size.',
    '- Keep its look and timing: don’t edit its files and don’t change its length.',
    '- Place it where it covers no face or text.',
    '- The same graphic may be mounted twice in one video, each mount with its own values.',
  ];

  it.each([
    ['null', null],
    ['undefined', undefined],
    ['empty', []],
  ])('has no section when the graphics are %s', (_name, graphics) => {
    const out = renderBriefMd(bakery.draft, { ...bakeryContext, graphics });
    expect(out).toBe(bakery.markdown);
    expect(out).not.toContain('## Graphics library');
  });

  it('is exactly what it was when the context has no graphics at all', () => {
    const fonts = ['Heebo-Bold.ttf'];
    const withFonts = renderBriefMd(bakery.draft, { ...bakeryContext, fonts });
    expect(renderBriefMd(bakery.draft, { ...bakeryContext, fonts, graphics: undefined })).toBe(
      withFonts,
    );
  });

  it('lists a graphic on one line and says how to use it, word for word', () => {
    const out = renderBriefMd(noInstructionsBrief(['a.mov']), {
      ...context,
      graphics: [lowerThird],
    });
    expect(out).toBe(
      [
        '# Brief: Job (Client)',
        '',
        'No instructions in the folder.',
        '',
        '## Files',
        '- Footage: a.mov',
        '',
        '## Graphics library',
        intro,
        '- Name on a white pill (edit/graphics/a1b2c3d4e5f6/): lower third, 3 s. When: The first time a person is named on camera. Text: name (Name), role (Role).',
        ...howToUse,
        '',
      ].join('\n'),
    );
  });

  it('lists the graphics by name, whatever order it is given them in', () => {
    const lines = (graphics: readonly BriefGraphic[]) =>
      section(graphics)?.filter(
        (line) => line.startsWith('- ') && line.includes('(edit/graphics/'),
      );
    expect(lines([lowerThird, callout])).toEqual([
      '- Big number (edit/graphics/0f9e8d7c6b5a/): callout, 2.5 s. When: When a figure is said out loud. Text: figure (The number).',
      '- Name on a white pill (edit/graphics/a1b2c3d4e5f6/): lower third, 3 s. When: The first time a person is named on camera. Text: name (Name), role (Role).',
    ]);
    expect(lines([callout, lowerThird])).toEqual(lines([lowerThird, callout]));
  });

  it('tells each kind in its words, and a graphic with no kind as a graphic', () => {
    const kindOf = (kind: BriefGraphic['kind']) =>
      /\): (.*?), 3 s\./.exec(section([{ ...lowerThird, kind }])?.[1] ?? '')?.[1];
    expect(kindOf('title')).toBe('title');
    expect(kindOf('lower-third')).toBe('lower third');
    expect(kindOf('callout')).toBe('callout');
    expect(kindOf('end-card')).toBe('end card');
    expect(kindOf('other')).toBe('graphic');
    expect(kindOf(null)).toBe('graphic');
  });

  it('writes the length like the Decisions do: no float noise, no trailing zeros', () => {
    const lengthOf = (lengthSec: number) =>
      /, (.*?) s\. When/.exec(section([{ ...lowerThird, lengthSec }])?.[1] ?? '')?.[1];
    expect(lengthOf(3)).toBe('3');
    expect(lengthOf(2.5)).toBe('2.5');
    expect(lengthOf(0.1 + 0.2)).toBe('0.3');
    expect(lengthOf(12.25)).toBe('12.25');
  });

  it('ends When with a full stop unless it ends with a mark, and says what a blank When means', () => {
    const lineOf = (when: string) => section([{ ...lowerThird, when }])?.[1];
    expect(lineOf('Whenever someone is named')).toContain('When: Whenever someone is named. Text:');
    expect(lineOf('Is it said?')).toContain('When: Is it said? Text:');
    expect(lineOf('Always!')).toContain('When: Always! Text:');
    expect(lineOf('  Two   words\n here  ')).toContain('When: Two words here. Text:');
    expect(lineOf('   ')).toContain(
      'When: only where the brief or the owner’s note names it. Text:',
    );
  });

  it('says "none" for a graphic with no text fields', () => {
    expect(section([{ ...lowerThird, variables: [] }])?.[1]).toMatch(/ Text: none\.$/);
  });

  it('keeps Hebrew names, When lines and labels as they are', () => {
    const graphic: BriefGraphic = {
      ...lowerThird,
      name: 'שם על פיל לבן',
      when: 'בפעם הראשונה שמזכירים אדם בשמו',
      variables: [{ id: 'name', label: 'שם' }],
    };
    expect(section([graphic])?.[1]).toBe(
      '- שם על פיל לבן (edit/graphics/a1b2c3d4e5f6/): lower third, 3 s. When: בפעם הראשונה שמזכירים אדם בשמו. Text: name (שם).',
    );
  });

  it('keeps each graphic to one line, whatever line breaks its words hold', () => {
    const graphic: BriefGraphic = {
      ...lowerThird,
      name: 'Two\nlines',
      variables: [{ id: 'name', label: 'Full\nname' }],
    };
    const lines = section([graphic]) ?? [];
    expect(lines).toHaveLength(1 + 1 + howToUse.length);
    expect(lines[1]).toContain('Two lines (edit/graphics/');
    expect(lines[1]).toContain('name (Full name).');
  });

  it('comes after the fonts, as the last section, and leaves everything above as it was', () => {
    const fonts = ['Heebo-Bold.ttf'];
    const base = { ...bakeryContext, style: bakeryStyle, fonts };
    const withoutGraphics = renderBriefMd(bakery.draft, base);
    const out = renderBriefMd(bakery.draft, { ...base, graphics: [lowerThird] });
    expect(out.startsWith(`${withoutGraphics}\n## Graphics library\n`)).toBe(true);
    expect(out.match(/^## .*$/gm)?.slice(-3)).toEqual([
      '## Client style',
      '## Fonts',
      '## Graphics library',
    ]);
  });

  it('is the last section even when the job has no fonts', () => {
    const withStyle = renderBriefMd(bakery.draft, { ...bakeryContext, style: bakeryStyle });
    const out = renderBriefMd(bakery.draft, {
      ...bakeryContext,
      style: bakeryStyle,
      graphics: [lowerThird],
    });
    expect(out.startsWith(`${withStyle}\n## Graphics library\n`)).toBe(true);
  });

  it('does not change the list it is given', () => {
    const graphics = [lowerThird, callout];
    renderBriefMd(bakery.draft, { ...bakeryContext, graphics });
    expect(graphics).toEqual([lowerThird, callout]);
  });
});

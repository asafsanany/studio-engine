import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import {
  compositionToolsInCommand,
  edlOverlayCount,
  isReviewAgent,
  rendersInCommand,
  signalsFromStreamEvent,
  startsMusicMake,
} from './progress-signals.js';
import { parseStreamLine, type StreamEvent } from './stream-parser.js';

const FIXTURES = fileURLToPath(new URL('../../../../fixtures/stream/', import.meta.url));

/** Every event of a fixture, with the stream line it came from. */
function fixtureEvents(name: string): { line: number; event: StreamEvent }[] {
  return readFileSync(`${FIXTURES}${name}`, 'utf8')
    .split('\n')
    .flatMap((text, line) => parseStreamLine(text).map((event) => ({ line, event })));
}

const toolUse = (name: string, input: Record<string, unknown>): StreamEvent => ({
  kind: 'tool_use',
  raw: {},
  parentToolUseId: null,
  id: 'toolu_1',
  name,
  input,
});

describe('rendersInCommand', () => {
  it('finds the three renders of the E1 run, and nothing in its other 30 commands', () => {
    const found: Record<number, string[]> = {};
    let commands = 0;
    for (const { line, event } of fixtureEvents('sample-run.jsonl')) {
      if (event.kind !== 'tool_use' || event.name !== 'Bash') continue;
      commands += 1;
      const renders = rendersInCommand(String(event.input.command));
      if (renders.length > 0) found[line] = renders;
    }
    expect(commands).toBe(33);
    expect(found).toEqual({
      // "Write EDL and render preview" (it failed: this ffmpeg has no libass)
      61: ['preview'],
      // "Update EDL, render preview, grab check frames"
      87: ['preview'],
      // "Re-render captions, final render, measure"
      107: ['final'],
      // Line 212 ("Render final with end hold") runs render.py to cut_nohold.mp4 and lets ffmpeg add
      // the hold: that cut starts no step, Render shows when ffmpeg starts writing final.mp4.
    });
  });

  it('finds no render in the blocked run or the sub-agent probe', () => {
    for (const name of ['blocked-run.jsonl', 'subagent-probe.jsonl']) {
      for (const { event } of fixtureEvents(name)) {
        expect(signalsFromStreamEvent(event)).toEqual([]);
      }
    }
  });

  it('knows a render.py invocation from a mention', () => {
    const P = '~/Developer/video-use/.venv/bin/python';
    const H = '~/Developer/video-use/helpers';
    expect(rendersInCommand(`${P} ${H}/render.py edl.json -o preview.mp4 --preview`)).toEqual([
      'preview',
    ]);
    expect(rendersInCommand(`$P ${H}/render.py edl.json -o final.mp4 --no-subtitles`)).toEqual([
      'final',
    ]);
    expect(rendersInCommand('cd helpers && P=../.venv/bin/python; $P render.py --help')).toEqual(
      [],
    );
    expect(rendersInCommand('grep -n "tpad\\|loudnorm" render.py | head -40')).toEqual([]);
    expect(rendersInCommand('sed -n 1,40p render.py; cat render.py')).toEqual([]);
    expect(rendersInCommand('python3 render.py edl.json -o draft.mp4 --draft')).toEqual([]);
    expect(rendersInCommand('uv run python render.py edl.json -o final.mp4')).toEqual(['final']);
    expect(rendersInCommand('python -u "/x/render.py" "edl.json" -o "final.mp4"')).toEqual([
      'final',
    ]);
    expect(rendersInCommand('FOO=1 time ./render.py edl.json -o final.mp4 2>&1 | tail -1')).toEqual(
      ['final'],
    );
  });

  it('tells the base cut from the final by the file render.py writes (B8)', () => {
    const P = '~/Developer/video-use/.venv/bin/python';
    const R = '~/Developer/video-use/helpers/render.py';
    // The cut the graphics are laid over, as B8's job ran it: no step.
    expect(rendersInCommand(`${P} ${R} edl.json -o cut.mp4 --no-subtitles --no-loudnorm`)).toEqual(
      [],
    );
    expect(rendersInCommand(`${P} ${R} edl.json -o final.mp4`)).toEqual(['final']);
    expect(rendersInCommand(`${P} ${R} edl.json -o final.mp4 --no-subtitles`)).toEqual(['final']);
    // The flags of a base cut do not make a file named final an intermediate.
    expect(
      rendersInCommand(`${P} ${R} edl.json -o /job/edit/final.mp4 --no-subtitles --no-loudnorm`),
    ).toEqual(['final']);
    // Any other name starts nothing: the files show what happens next.
    for (const name of ['cut.mp4', 'base.mp4', 'cut_nohold.mp4', 'out.mp4', 'vertical.mp4']) {
      expect(rendersInCommand(`${P} ${R} edl.json -o ${name}`)).toEqual([]);
    }
    // The output spelled the other ways argparse takes it.
    expect(rendersInCommand('python render.py edl.json --output final.mp4')).toEqual(['final']);
    expect(rendersInCommand('python render.py edl.json --output=final.mp4')).toEqual(['final']);
    expect(rendersInCommand('python render.py edl.json -ofinal.mp4')).toEqual(['final']);
    expect(rendersInCommand('python render.py -o "/j/edit/final_v2.mp4" edl.json')).toEqual([
      'final',
    ]);
    // A preview is `--preview`, or a file named preview.
    expect(rendersInCommand('python render.py edl.json -o cut.mp4 --preview')).toEqual(['preview']);
    expect(rendersInCommand('python render.py edl.json -o preview.mp4')).toEqual(['preview']);
    expect(rendersInCommand('python render.py edl.json -o preview_2.mp4 --no-subtitles')).toEqual([
      'preview',
    ]);
    // No output at all (render.py needs one): nothing started.
    expect(rendersInCommand('python render.py edl.json')).toEqual([]);
    // The cut, then the check, in one command: only the preview counts.
    expect(
      rendersInCommand(
        'python render.py edl.json -o cut.mp4 --no-subtitles && python render.py edl.json -o preview.mp4 --preview',
      ),
    ).toEqual(['preview']);
  });

  it('reads an output that is only a variable from the flags of a base cut', () => {
    expect(rendersInCommand('python render.py edl.json -o "$OUT" --no-subtitles')).toEqual([]);
    expect(rendersInCommand('python render.py edl.json -o $OUT --no-loudnorm')).toEqual([]);
    const braced = ['python render.py edl.json -o "$', '{OUT}"'].join('');
    expect(rendersInCommand(braced)).toEqual(['final']);
    expect(rendersInCommand('python render.py edl.json -o "$OUT" --preview')).toEqual(['preview']);
    // A name with a variable only in its folder is still read by its file name.
    expect(rendersInCommand('python render.py edl.json -o "$E/cut.mp4"')).toEqual([]);
    expect(rendersInCommand('python render.py edl.json -o "$E/final.mp4"')).toEqual(['final']);
  });

  it('reads quotes, variables and heredocs like a shell', () => {
    // A quoted grep pattern with `\\|` in it is one word, not a pipe (E1 line 29).
    expect(rendersInCommand('$P render.py --help; grep -n "tpad\\|scale=" render.py')).toEqual([]);
    const braced = ['"$', '{PY}" "$H/render.py" edl.json -o final.mp4'].join('');
    expect(rendersInCommand(braced)).toEqual(['final']);
    // A heredoc body is file content: a render.py line in it starts nothing.
    const heredoc = [
      "cat > run.sh <<'EOF'",
      'python render.py edl.json -o final.mp4',
      'EOF',
      'python render.py edl.json -o preview.mp4 --preview',
    ].join('\n');
    expect(rendersInCommand(heredoc)).toEqual(['preview']);
    expect(rendersInCommand('python \\\n  render.py edl.json \\\n  -o final.mp4')).toEqual([
      'final',
    ]);
    expect(rendersInCommand('D=$(python render.py edl.json -o final.mp4)')).toEqual(['final']);
  });

  it('finds several renders in one command, in order', () => {
    expect(
      rendersInCommand(
        '$P render.py edl.json -o preview.mp4 --preview && ffmpeg -i preview.mp4 x.jpg; $P render.py edl.json -o final.mp4',
      ),
    ).toEqual(['preview', 'final']);
  });

  it('reads a HyperFrames render by its output: final or preview, not a slot', () => {
    expect(
      rendersInCommand('npx hyperframes render -q delivery --strict -o /job/edit/final.mp4'),
    ).toEqual(['final']);
    expect(rendersInCommand('npx --yes hyperframes render --output=preview.mp4')).toEqual([
      'preview',
    ]);
    expect(rendersInCommand('npx hyperframes render --format mov -o render.mov')).toEqual([]);
    expect(rendersInCommand('npx hyperframes lint 2>&1 | tail -5')).toEqual([]);
  });

  it('leaves ffmpeg writing the final to the file: final.mp4 showing in edit/ starts Render', () => {
    expect(
      rendersInCommand(
        'ffmpeg -y -i cut.mp4 -i render.mov -filter_complex "[0][1]overlay" -c:a copy final.mp4',
      ),
    ).toEqual([]);
  });

  it('does not take ffmpeg reading or measuring the final for a render', () => {
    expect(
      rendersInCommand('ffmpeg -hide_banner -nostats -i final.mp4 -af ebur128 -f null -'),
    ).toEqual([]);
  });
});

// W2: the HyperFrames commands on a composition tell where a run that ends in Review is.
describe('compositionToolsInCommand', () => {
  it.each([
    ['npx hyperframes lint', ['lint']],
    ['npx hyperframes lint --json', ['lint']],
    ['npx --yes hyperframes@0.8.181 check --json', ['check']],
    [
      'cd "edit/preview" && HYPERFRAMES_NO_TELEMETRY=1 npx hyperframes snapshot --at 1,2',
      ['snapshot'],
    ],
    ['npx hyperframes preview --background', ['preview']],
    ['bunx hyperframes validate', ['check']],
    ['pnpm dlx hyperframes lint', ['lint']],
    ['pnpm exec hyperframes inspect', ['check']],
    ['npx hyperframes layout', ['check']],
    ['hyperframes lint', ['lint']],
    ['cd edit/preview && npx hyperframes lint && npx hyperframes snapshot', ['lint', 'snapshot']],
    ['npx hyperframes lint 2>&1 | tail -20', ['lint']],
    ['npx hyperframes check; npx hyperframes lint', ['check', 'lint']],
    ['(cd "$E/preview" && npx hyperframes lint)', ['lint']],
  ])('finds %j', (command, tools) => {
    expect(compositionToolsInCommand(command)).toEqual(tools);
  });

  it.each([
    'npx hyperframes lint --help',
    'npx hyperframes snapshot -h',
    'npx hyperframes render -q delivery -o ../final.mp4',
    'npx hyperframes render',
    'npx hyperframes',
    'npx hyperframes --version',
    'npx hyperframes play edit/preview',
    'npx hyperframes constructor',
    'npx hyperframes toString',
    'npx other-tool lint',
    'npx hyperframes-extras lint',
    'grep "hyperframes lint" edit/project.md',
    'echo "npx hyperframes lint"',
    'cat edit/project.md',
    'ls edit/preview',
    'python helpers/render.py edl.json -o preview.mp4',
    "cat > notes.md <<'EOF'\nnpx hyperframes lint\nnpx hyperframes snapshot\nEOF",
    '',
  ])('finds nothing in %j', (command) => {
    expect(compositionToolsInCommand(command)).toEqual([]);
  });

  it('keeps the order of the commands and finds one per call', () => {
    expect(
      compositionToolsInCommand(
        'npx hyperframes snapshot && npx hyperframes lint && npx hyperframes snapshot',
      ),
    ).toEqual(['snapshot', 'lint', 'snapshot']);
  });

  it('is not fooled by a render in the same command line', () => {
    expect(
      compositionToolsInCommand('npx hyperframes lint && npx hyperframes render -o final.mp4'),
    ).toEqual(['lint']);
    expect(rendersInCommand('npx hyperframes lint && npx hyperframes render -o final.mp4')).toEqual(
      ['final'],
    );
  });
});

// SD3 (Soundtrack): the edit and revise prompts run the music script as
// `node "<engine>/make-music.mjs" make "<edit dir>"`, with paths that have spaces and Hebrew.
describe('startsMusicMake', () => {
  const SCRIPT = '/Users/owner/studio-engine/apps/server/assets/music/make-music.mjs';
  const EDIT = '/Users/owner/Studio Inbox/מאפיית הצפון/פרומו לסוף השבוע/edit';

  it.each([
    `node "${SCRIPT}" make "${EDIT}"`,
    `node "${SCRIPT}" make "${EDIT}" --by revise`,
    `node "${SCRIPT}" make "${EDIT}" --again --ask "darker, more drums" --by revise`,
    `node "${SCRIPT}" --by revise make "${EDIT}"`,
    `node "${SCRIPT}" make "${EDIT}" --ask "make it calmer"`,
    `MUSIC_FAKE=1 node "${SCRIPT}" make "${EDIT}"`,
    `node --no-warnings "${SCRIPT}" make "${EDIT}"`,
    `/opt/homebrew/bin/node "${SCRIPT}" make "${EDIT}"`,
    `"$NODE" "${SCRIPT}" make "${EDIT}"`,
    `"${SCRIPT}" make "${EDIT}"`,
    `time node "${SCRIPT}" make "${EDIT}"`,
    `node "${SCRIPT}" make "${EDIT}" 2>&1 | tail -1`,
    `node "${SCRIPT}" make "${EDIT}"; echo "exit $?"`,
    `cd "${EDIT}" && node "${SCRIPT}" make "$PWD"`,
    `mkdir -p "${EDIT}/music"\nnode "${SCRIPT}" make "${EDIT}"`,
  ])('finds the make in %j', (command) => {
    expect(startsMusicMake(command)).toBe(true);
  });

  // Songs (SG3): getting a song takes as long as making music, so it says "making the music" too.
  it.each([
    `node "${SCRIPT}" song "${EDIT}" --title "נתתי לך בית" --artist "Ofek Adanek" --from screenshot --file "IMG_4412.PNG" --by brief`,
    `node "${SCRIPT}" song "${EDIT}" --link "https://www.instagram.com/reel/C1/" --from link --by brief`,
    `node "${SCRIPT}" song "${EDIT}" --trending --from trending --by editor --niche "#fpv #fpvdrone"`,
    `node "${SCRIPT}" song "${EDIT}" --trending --from trending --by you`,
    `node "${SCRIPT}" --by you --title Make song "${EDIT}"`,
    `MUSIC_FAKE=1 node "${SCRIPT}" song "${EDIT}" --title "Song" --artist "Make" --length-ms 20000`,
    `cd "${EDIT}" && node "${SCRIPT}" song "$PWD" --title "Pick" --artist "Off" --from note --by you`,
  ])('finds the song in %j', (command) => {
    expect(startsMusicMake(command)).toBe(true);
  });

  it.each([
    `node "${SCRIPT}" song --help`,
    `node "${SCRIPT}" pick "${EDIT}" song`,
    `node "${SCRIPT}" none "${EDIT}" "song"`,
    `grep -n song "${SCRIPT}"`,
    `echo "node ${SCRIPT} song edit"`,
    `cat > "${EDIT}/music/notes.md" <<'EOF'\nnode "${SCRIPT}" song "${EDIT}" --trending\nEOF`,
    `node /engine/assets/music/get-song.mjs song "${EDIT}"`,
  ])('finds no song in %j', (command) => {
    expect(startsMusicMake(command)).toBe(false);
  });

  it.each([
    `node "${SCRIPT}" pick "${EDIT}" v1`,
    `node "${SCRIPT}" pick "${EDIT}" off`,
    `node "${SCRIPT}" supplied "${EDIT}" "Summer Vibes.mp3"`,
    `node "${SCRIPT}" series "${EDIT}" "edit/series/kit/assets/audio/bed.mp3"`,
    `node "${SCRIPT}" none "${EDIT}" "The client's style says no music."`,
    `node "${SCRIPT}" --ask make pick "${EDIT}" v1`,
    `node "${SCRIPT}" make --help`,
    `node "${SCRIPT}"`,
    `node /engine/assets/music/other.mjs make "${EDIT}"`,
    `node "${SCRIPT}.bak" make "${EDIT}"`,
    `grep -n make "${SCRIPT}"`,
    `cat "${SCRIPT}"`,
    `echo "node ${SCRIPT} make edit"`,
    `cat > "${EDIT}/music/notes.md" <<'EOF'\nnode "${SCRIPT}" make "${EDIT}"\nEOF`,
    `ls "${EDIT}/music"`,
    '',
  ])('finds no make in %j', (command) => {
    expect(startsMusicMake(command)).toBe(false);
  });
});

describe('isReviewAgent', () => {
  it('knows the critic pass', () => {
    expect(isReviewAgent('Critic pass on teaser')).toBe(true);
    expect(isReviewAgent('Review the final cut')).toBe(true);
    expect(isReviewAgent('QA the render')).toBe(true);
  });

  it('not the other sub-agents video-use starts', () => {
    expect(isReviewAgent('Build lower-third animation')).toBe(false);
    expect(isReviewAgent('Pick the best takes for the EDL')).toBe(false);
  });
});

describe('signalsFromStreamEvent', () => {
  it('turns a Bash render into a render signal', () => {
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', { command: 'python render.py edl.json -o p.mp4 --preview' }),
      ),
    ).toEqual([{ type: 'render', target: 'preview' }]);
  });

  it('gives no signal for the base cut render.py makes before the graphics (B8)', () => {
    const cut =
      'cd "$E" || exit 1\n~/Developer/video-use/.venv/bin/python ~/Developer/video-use/helpers/render.py edl.json -o cut.mp4 --no-subtitles --no-loudnorm 2>&1 | tail -5; ffprobe -v error -show_entries format=duration -of compact cut.mp4';
    expect(signalsFromStreamEvent(toolUse('Bash', { command: cut }))).toEqual([]);
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', { command: 'python render.py edl.json -o final.mp4 --no-subtitles' }),
      ),
    ).toEqual([{ type: 'render', target: 'final' }]);
  });

  it('turns a HyperFrames command on the composition into a composition signal', () => {
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', { command: 'cd edit/preview && npx hyperframes lint' }),
      ),
    ).toEqual([{ type: 'composition', tool: 'lint' }]);
    expect(
      signalsFromStreamEvent(toolUse('Bash', { command: 'npx hyperframes snapshot --at 1,2.5' })),
    ).toEqual([{ type: 'composition', tool: 'snapshot' }]);
    expect(
      signalsFromStreamEvent(toolUse('Bash', { command: 'npx hyperframes validate' })),
    ).toEqual([{ type: 'composition', tool: 'check' }]);
  });

  it('gives the render signals first, then the composition ones', () => {
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', {
          command: 'npx hyperframes lint && npx hyperframes render -o ../final.mp4',
        }),
      ),
    ).toEqual([
      { type: 'render', target: 'final' },
      { type: 'composition', tool: 'lint' },
    ]);
  });

  it('gives no composition signal for --help, a render or a mention', () => {
    for (const command of [
      'npx hyperframes lint --help',
      'npx hyperframes render -q delivery -o ../render.mov',
      'grep "hyperframes lint" project.md',
    ]) {
      expect(signalsFromStreamEvent(toolUse('Bash', { command }))).toEqual([]);
    }
  });

  it('turns a music make into a music signal, after the others', () => {
    const make = 'node "/engine/assets/music/make-music.mjs" make "/j/edit" --by revise';
    expect(signalsFromStreamEvent(toolUse('Bash', { command: make }))).toEqual([{ type: 'music' }]);
    expect(
      signalsFromStreamEvent(toolUse('Bash', { command: `npx hyperframes lint && ${make}` })),
    ).toEqual([{ type: 'composition', tool: 'lint' }, { type: 'music' }]);
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', {
          command: 'node "/engine/assets/music/make-music.mjs" pick "/j/edit" off',
        }),
      ),
    ).toEqual([]);
    // A song call is making music too (Songs, SG3).
    expect(
      signalsFromStreamEvent(
        toolUse('Bash', {
          command:
            'node "/engine/assets/music/make-music.mjs" song "/j/edit" --trending --from trending --by editor',
        }),
      ),
    ).toEqual([{ type: 'music' }]);
  });

  it('turns a critic sub-agent into a review signal', () => {
    expect(
      signalsFromStreamEvent(toolUse('Agent', { description: 'Critic pass on teaser' })),
    ).toEqual([{ type: 'review' }]);
    expect(signalsFromStreamEvent(toolUse('Task', { description: 'Animate slot 2' }))).toEqual([]);
  });

  it('gives nothing for other tools, other events or odd input', () => {
    expect(signalsFromStreamEvent(toolUse('Write', { file_path: '/j/edit/final.mp4' }))).toEqual(
      [],
    );
    expect(signalsFromStreamEvent(toolUse('Bash', { command: 42 }))).toEqual([]);
    expect(signalsFromStreamEvent({ kind: 'unparsed', line: 'x', raw: null })).toEqual([]);
  });

  it('sees the critic in the E1 run', () => {
    const reviews = fixtureEvents('sample-run.jsonl').filter(({ event }) =>
      signalsFromStreamEvent(event).some((signal) => signal.type === 'review'),
    );
    expect(reviews.map(({ line }) => line)).toEqual([119]);
  });
});

describe('edlOverlayCount', () => {
  it('counts the overlays of an EDL', () => {
    expect(edlOverlayCount('{"overlays":[{"file":"a"},{"file":"b"}]}')).toBe(2);
    expect(edlOverlayCount('{"ranges":[]}')).toBe(0);
  });

  it('says null for an EDL that is not complete yet', () => {
    expect(edlOverlayCount('{"ranges": [')).toBeNull();
    expect(edlOverlayCount('')).toBeNull();
    expect(edlOverlayCount('[1]')).toBeNull();
  });
});

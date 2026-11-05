import { describe, expect, it } from 'vitest';
import { RefusalLedger, readScriptAnswers, scriptOfCommand } from './script-answers.js';

// What the Generate run's script calls answered (Generated videos, GN5).

describe('scriptOfCommand', () => {
  it('knows the two scripts by name, quoted or not, and nothing else', () => {
    expect(scriptOfCommand(`node "/a b/assets/generate/make-voice.mjs" line "/x/edit"`)).toBe(
      'voice',
    );
    expect(scriptOfCommand('node /a/assets/generate/make-shots.mjs clip /x/edit A')).toBe('shots');
    expect(scriptOfCommand('ffmpeg -i a.mp4 b.jpg')).toBeNull();
  });
});

describe('readScriptAnswers', () => {
  it('reads the characters of a voice take and of a sound effect, none for a check or an assembly', () => {
    const lines = [
      '{"ok":true,"command":"line","id":"L1","take":1,"file":"voice/L1-take1.mp3","durationSec":3,"chars":38,"characters":40}',
      '{"ok":true,"command":"sfx","name":"alert","file":"sfx/alert.mp3","durationSec":1,"characters":10}',
      '{"ok":true,"command":"sfx","name":"x","file":"sfx/x.mp3","durationSec":1,"characters":null}',
      '{"ok":true,"command":"check","id":"L1","take":1,"file":"f","match":true,"missing":[],"extra":[],"heard":"x","words":[]}',
      '{"ok":true,"command":"assemble","file":"voice.mp3","wordsFile":"voice-words.json","durationSec":3,"lines":[]}',
    ].join('\n');

    expect(
      readScriptAnswers('voice', lines).map((answer) => answer.kind === 'ok' && answer.chars),
    ).toEqual([40, 10, 0, 0, 0]);
  });

  it('falls back to chars when a take says no characters', () => {
    const [answer] = readScriptAnswers(
      'voice',
      '{"ok":true,"command":"line","id":"L1","take":1,"file":"f","durationSec":1,"chars":12}',
    );
    expect(answer).toEqual({ kind: 'ok', script: 'voice', chars: 12 });
  });

  it('reads a refusal with its service, and the dollars of a budget stop', () => {
    expect(
      readScriptAnswers(
        'shots',
        'progress on stderr\n{"ok":false,"code":"over_budget","message":"m","needUsd":4.1,"budgetUsd":3}',
      ),
    ).toEqual([
      {
        kind: 'refused',
        script: 'shots',
        refusal: { code: 'over_budget', service: 'higgsfield', needUsd: 4.1, budgetUsd: 3 },
      },
    ]);
    expect(readScriptAnswers('voice', '{"ok":false,"code":"key_rejected","message":"m"}')).toEqual([
      {
        kind: 'refused',
        script: 'voice',
        refusal: { code: 'key_rejected', service: 'elevenlabs' },
      },
    ]);
  });

  it('reads pending as neither a failure nor a success', () => {
    expect(
      readScriptAnswers('shots', '{"ok":false,"code":"pending","message":"m","requestId":"r1"}'),
    ).toEqual([{ kind: 'pending', script: 'shots' }]);
  });

  it('ignores everything that is not an answer of that script', () => {
    expect(readScriptAnswers('shots', 'Exit code 2\n\nnot json\n{"broken":')).toEqual([]);
    expect(readScriptAnswers('shots', '{"ok":true,"command":"line","id":"L1"}')).toEqual([]);
    expect(readScriptAnswers('voice', '{"ok":true,"command":"clip","id":"A"}')).toEqual([]);
  });
});

describe('RefusalLedger', () => {
  const refused = (script: 'voice' | 'shots', code: 'balance_empty' | 'unavailable') =>
    ({
      kind: 'refused',
      script,
      refusal: { code, service: script === 'voice' ? 'elevenlabs' : 'higgsfield' },
    }) as const;

  it('keeps the latest refusal until a call of that service worked', () => {
    const ledger = new RefusalLedger();
    ledger.take(refused('shots', 'unavailable'));
    expect(ledger.latest()?.code).toBe('unavailable');
    ledger.take(refused('shots', 'balance_empty'));
    expect(ledger.latest()?.code).toBe('balance_empty');
    ledger.take({ kind: 'ok', script: 'shots', chars: 0 });
    expect(ledger.latest()).toBeNull();
  });

  it('does not let a good voice call forget a Higgsfield refusal, and a pending clip changes nothing', () => {
    const ledger = new RefusalLedger();
    ledger.take(refused('shots', 'balance_empty'));
    ledger.take({ kind: 'ok', script: 'voice', chars: 30 });
    ledger.take({ kind: 'pending', script: 'shots' });
    expect(ledger.latest()?.code).toBe('balance_empty');
    expect(ledger.chars).toBe(30);
  });

  it('says the newest of two services’ refusals', () => {
    const ledger = new RefusalLedger();
    ledger.take(refused('shots', 'balance_empty'));
    ledger.take(refused('voice', 'unavailable'));
    expect(ledger.latest()).toMatchObject({ code: 'unavailable', service: 'elevenlabs' });
  });
});

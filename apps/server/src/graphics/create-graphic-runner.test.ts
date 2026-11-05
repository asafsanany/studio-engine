import { describe, expect, it } from 'vitest';
import { ClaudeGraphicRunner } from './claude-graphic.js';
import { createGraphicRunner } from './create-graphic-runner.js';
import { FakeGraphicRunner } from './fake-graphic-runner.js';

const config = {
  inboxPath: '/inbox',
  logsDir: '/data/logs',
  dataDir: '/data',
  claudeBin: 'claude',
  model: undefined,
};

describe('createGraphicRunner', () => {
  it('gives the Claude run for claude and the fake at STUDIO_FAKE_SPEED for fake', () => {
    expect(createGraphicRunner({ ...config, runner: 'claude' })).toBeInstanceOf(
      ClaudeGraphicRunner,
    );
    const fake = createGraphicRunner(
      { ...config, runner: 'fake' },
      { env: { STUDIO_FAKE_SPEED: '5' } },
    );
    expect(fake).toBeInstanceOf(FakeGraphicRunner);
    expect(fake.kind).toBe('fake');
    expect((fake as FakeGraphicRunner).speed).toBe(5);
    expect(
      (createGraphicRunner({ ...config, runner: 'fake' }, { env: {} }) as FakeGraphicRunner).speed,
    ).toBe(1);
  });

  it('refuses a STUDIO_FAKE_SPEED that is not a number above 0', () => {
    expect(() =>
      createGraphicRunner({ ...config, runner: 'fake' }, { env: { STUDIO_FAKE_SPEED: '0' } }),
    ).toThrow(/STUDIO_FAKE_SPEED/);
  });
});

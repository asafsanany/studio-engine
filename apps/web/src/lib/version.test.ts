import { describe, expect, it } from 'vitest';
import rootPackage from '../../../../package.json';
import { APP_VERSION, APP_VERSION_LABEL } from './version';

describe('app version', () => {
  it('is the root package.json version', () => {
    expect(APP_VERSION).toBe(rootPackage.version);
  });

  it('is an X.Y.Z version, shown with a leading v', () => {
    expect(APP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
    expect(APP_VERSION_LABEL).toBe(`v${APP_VERSION}`);
  });
});

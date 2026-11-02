import {describe, expect, test} from 'vitest';
import {buildChildEnv} from '../src/wallet.js';

const ctx = {jarPath: '/j.jar', keystorePath: '/k.p12', password: 'pw'};

describe('buildChildEnv', () => {
  test('sets the wallet variables', () => {
    expect(buildChildEnv(ctx, {PATH: '/bin'}, 'darwin')).toMatchObject({
      CL_KEYSTORE: '/k.p12', CL_KEYALIAS: 'alias', CL_PASSWORD: 'pw', CL_APP_ENV: 'mainnet', PATH: '/bin',
    });
  });
  test('linux with LANG=C forces a UTF-8 locale', () => {
    expect(buildChildEnv(ctx, {LANG: 'C'}, 'linux').LC_ALL).toBe('C.UTF-8');
  });
  test('linux with no locale forces a UTF-8 locale', () => {
    expect(buildChildEnv(ctx, {}, 'linux').LC_ALL).toBe('C.UTF-8');
  });
  test('linux with a UTF-8 LANG leaves the locale alone', () => {
    expect(buildChildEnv(ctx, {LANG: 'en_US.UTF-8'}, 'linux').LC_ALL).toBeUndefined();
  });
  test('LC_ALL takes precedence over LANG', () => {
    expect(buildChildEnv(ctx, {LC_ALL: 'C', LANG: 'en_US.UTF-8'}, 'linux').LC_ALL).toBe('C.UTF-8');
  });
  test('darwin never sets a locale', () => {
    expect(buildChildEnv(ctx, {LANG: 'C'}, 'darwin').LC_ALL).toBeUndefined();
  });
});

import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {promisify} from 'node:util';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {buildP12, deriveAddress} from '../../src/key.js';
import {createNodeParams, showAddress, showId, WalletError, WrongPasswordError, type KeyContext} from '../../src/wallet.js';

const run = promisify(execFile);
// Fixed test key, never funded.
const KEY = '4f3c9a1be27d58606c1e0a9d3b7f2e84a5d1c60f93b8e7254d0a6c1f8e39b72d';
const PASSWORD = `p@ss w'rd ${Math.random().toString(36).slice(2, 10)}`;
const ZERO = {hash: '0'.repeat(64), ordinal: 0};
const JARS = path.resolve(import.meta.dirname, '../../.test-jars');

let work: string;
let ctx: KeyContext;

beforeAll(async () => {
  work = await fs.mkdtemp(path.join(os.tmpdir(), 'wallet-test-'));
  const keystorePath = path.join(work, 'key.p12');
  await fs.writeFile(keystorePath, await buildP12(KEY, PASSWORD));
  ctx = {jarPath: path.join(JARS, 'cl-wallet.jar'), keystorePath, password: PASSWORD};
});
afterAll(async () => {
  await fs.rm(work, {recursive: true, force: true});
});

const params = (over: Partial<{name: string; description: string}> = {}) =>
  createNodeParams(ctx, {name: 'Test', description: 'Desc', parent: ZERO, ...over});

describe('wallet.jar', () => {
  test('address matches dag4', async () => expect(await showAddress(ctx)).toBe(deriveAddress(KEY)));

  test('keytool export returns the original key', async () => {
    // keytool.jar writes id_ecdsa.hex next to the keystore, so give it a copy in its own directory.
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'keytool-test-'));
    try {
      const p12 = path.join(dir, 'key.p12');
      await fs.copyFile(ctx.keystorePath, p12);
      await run('java', ['-jar', path.join(JARS, 'cl-keytool.jar'), 'export'], {
        cwd: dir,
        env: {...process.env, CL_KEYSTORE: p12, CL_KEYALIAS: 'alias', CL_PASSWORD: PASSWORD, CL_APP_ENV: 'mainnet'},
      });
      expect((await fs.readFile(path.join(dir, 'id_ecdsa.hex'), 'utf8')).trim()).toBe(KEY);
    } finally {
      await fs.rm(dir, {recursive: true, force: true});
    }
  });

  test('signs a first registration', async () => {
    const e = JSON.parse(await params());
    expect(e.value.source).toBe(deriveAddress(KEY));
    expect(e.value.delegatedStakeRewardParameters.rewardFraction).toBe(10000000);
    expect(e.value.parent).toEqual(ZERO);
    expect(e.proofs).toHaveLength(1);
    expect(e.proofs[0].id).toBe(await showId(ctx));
  });

  test('keeps special characters in the name', async () => {
    const name = `It's "great" — Ünï`;
    const e = JSON.parse(await params({name}));
    expect(e.value.nodeMetadataParameters.name).toBe(name);
  });

  test('wrong password throws WrongPasswordError with a one-line message', async () => {
    const err = await showAddress({...ctx, password: 'wrong-password'}).catch((e) => e);
    expect(err).toBeInstanceOf(WrongPasswordError);
    expect(err.message).not.toContain('\n');
    const err2 = await createNodeParams({...ctx, password: 'wrong-password'}, {name: 'a', description: 'b', parent: ZERO}).catch((e) => e);
    expect(err2).toBeInstanceOf(WrongPasswordError);
  });

  test('a failure is a clean one-line WalletError', async () => {
    const err = await showAddress({...ctx, keystorePath: path.join(work, 'missing.p12')}).catch((e) => e);
    expect(err).toBeInstanceOf(WalletError);
    expect(err.message).not.toContain('\n');
    expect(err.message).not.toMatch(/\bat\s+\S+\(/);
    expect(err.message).not.toContain(PASSWORD);
  });

  test('no secrets in temp files or errors', async () => {
    const seen: string[] = [];
    const realRm = fs.rm.bind(fs);
    const spy = vi.spyOn(fs, 'rm').mockImplementation(async (p, o) => {
      for (const f of await fs.readdir(p as string)) seen.push(await fs.readFile(path.join(p as string, f), 'latin1'));
      return realRm(p, o);
    });
    try {
      await params();
      const bad = await createNodeParams({...ctx, keystorePath: path.join(work, 'missing.p12')}, {name: 'a', description: 'b', parent: ZERO}).catch((e) => e);
      for (const text of [...seen, String(bad.message), String(bad.stack)]) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(PASSWORD);
        expect(text.toLowerCase()).not.toContain(KEY.toLowerCase());
        expect(text).not.toContain(Buffer.from(KEY, 'hex').toString('latin1'));
      }
      expect(seen.length).toBeGreaterThan(0);
    } finally {
      spy.mockRestore();
    }
  });

  test('removes its temp directory, including after failure', async () => {
    const dirs: string[] = [];
    const realMk = fs.mkdtemp.bind(fs);
    const spy = vi.spyOn(fs, 'mkdtemp').mockImplementation(async (p: string, o?: never) => {
      const d = await realMk(p, o);
      dirs.push(d);
      return d;
    });
    try {
      await params();
      await createNodeParams({...ctx, password: 'wrong-password'}, {name: 'a', description: 'b', parent: ZERO}).catch(() => {});
      expect(dirs).toHaveLength(2);
      for (const d of dirs) await expect(fs.stat(d)).rejects.toMatchObject({code: 'ENOENT'});
    } finally {
      spy.mockRestore();
    }
  });
}, 60_000);

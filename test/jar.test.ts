import {createHash} from 'node:crypto';
import {existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {ensureWalletJar, parseJavaMajor, SetupError} from '../src/jar.js';

const BASE = 'https://github.com/Constellation-Labs/tessellation/releases/download';
const JAR_BYTES = Buffer.from('fake jar bytes');
const sha = (b: Buffer) => createHash('sha256').update(b).digest('hex');

let cacheDir: string;
let root: string;
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'jar-test-'));
  cacheDir = join(root, 'cache');
});
afterEach(() => rmSync(root, {recursive: true, force: true}));

function fakeFetch(opts: {jar?: Buffer; hash?: string; status?: number} = {}) {
  const urls: string[] = [];
  const fn = (async (url: string | URL | Request) => {
    const u = String(url);
    urls.push(u);
    if (opts.status) return new Response('nope', {status: opts.status});
    if (u.endsWith('cl-wallet.jar')) return new Response(opts.jar ?? JAR_BYTES);
    if (u.endsWith('cl-wallet.sha256')) return new Response(`  ${opts.hash ?? sha(opts.jar ?? JAR_BYTES)}  cl-wallet.jar\n`);
    return new Response('', {status: 404});
  }) as typeof fetch;
  return {fn, urls};
}

function seed(version: string) {
  mkdirSync(join(cacheDir, version), {recursive: true});
  writeFileSync(join(cacheDir, version, 'wallet.jar'), 'cached');
}

const api = (v: string | Error) => ({getNodeVersion: async () => { if (v instanceof Error) throw v; return v; }});

test('parseJavaMajor', () => {
  expect(parseJavaMajor('openjdk version "21.0.9" 2025-10-21')).toBe(21);
  expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
  expect(parseJavaMajor('openjdk version "25" 2025-09-16')).toBe(25);
  expect(parseJavaMajor('garbage')).toBeNull();
});

describe('ensureWalletJar', () => {
  test('downloads, verifies and caches the version mainnet runs', async () => {
    const f = fakeFetch();
    const warnings: string[] = [];
    const deps = {api: api('v3.6.2'), fetchFn: f.fn, cacheDir, warn: (m: string) => warnings.push(m)};
    const path = await ensureWalletJar(deps);
    expect(path).toBe(join(cacheDir, '3.6.2', 'wallet.jar'));
    expect(f.urls).toContain(`${BASE}/v3.6.2/cl-wallet.jar`);
    expect(f.urls).toContain(`${BASE}/v3.6.2/cl-wallet.sha256`);
    expect(statSync(cacheDir).mode & 0o777).toBe(0o700);
    expect(statSync(join(cacheDir, '3.6.2')).mode & 0o777).toBe(0o700);
    expect(readdirSync(join(cacheDir, '3.6.2'))).toEqual(['wallet.jar']);
    const n = f.urls.length;
    expect(await ensureWalletJar(deps)).toBe(path);
    expect(f.urls.length).toBe(n);
    expect(warnings).toEqual([]);
  });

  test('a checksum mismatch throws SetupError, keeps no file and does not fall back', async () => {
    seed('3.5.0');
    const f = fakeFetch({hash: 'a'.repeat(64)});
    await expect(ensureWalletJar({api: api('3.6.2'), fetchFn: f.fn, cacheDir, warn: () => {}})).rejects.toThrow(SetupError);
    expect(existsSync(join(cacheDir, '3.6.2', 'wallet.jar'))).toBe(false);
    expect(readdirSync(join(cacheDir, '3.6.2'))).toEqual([]);
  });

  test('a 404 or failed download falls back to the newest cached version and warns', async () => {
    seed('3.5.34');
    seed('3.6.1');
    const warnings: string[] = [];
    const path = await ensureWalletJar({api: api('3.6.2'), fetchFn: fakeFetch({status: 404}).fn, cacheDir, warn: (m) => warnings.push(m)});
    expect(path).toBe(join(cacheDir, '3.6.1', 'wallet.jar'));
    expect(warnings).toHaveLength(1);
    expect(warnings[0]).toContain('3.6.1');
  });

  test('a failed version lookup also falls back', async () => {
    seed('3.5.34');
    const warnings: string[] = [];
    const f = fakeFetch();
    const path = await ensureWalletJar({api: api(new Error('down')), fetchFn: f.fn, cacheDir, warn: (m) => warnings.push(m)});
    expect(path).toBe(join(cacheDir, '3.5.34', 'wallet.jar'));
    expect(warnings[0]).toMatch(/could not be fetched/i);
    expect(warnings[0]).toContain('3.5.34');
    expect(f.urls).toEqual([]);
  });

  test('a version that is not plain dotted numbers is treated as a failed lookup', async () => {
    seed('3.5.34');
    const f = fakeFetch();
    const path = await ensureWalletJar({api: api('../../etc'), fetchFn: f.fn, cacheDir, warn: () => {}});
    expect(path).toBe(join(cacheDir, '3.5.34', 'wallet.jar'));
    expect(f.urls).toEqual([]);
  });

  test('no cached version and a failed download throws SetupError', async () => {
    await expect(ensureWalletJar({api: api('3.6.2'), fetchFn: fakeFetch({status: 500}).fn, cacheDir, warn: () => {}})).rejects.toThrow(SetupError);
  });
});

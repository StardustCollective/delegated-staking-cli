import { afterEach, beforeEach, expect, test } from 'vitest';
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  AccountExistsError,
  DEFAULT_ROOT,
  InvalidAddressError,
  makeAccountStore,
} from '../src/accounts.js';

const A = 'DAG7Ghth1WhWK83SB3MtXgX1LGmnuXx4PJDvrfq4';
const B = 'DAG0y4eLqhhXUafeE3mgBstezPTnr8L3tZjAtMWB';

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'accounts-'));
  root = join(base, 'root');
});
afterEach(async () => {
  await rm(base, { recursive: true, force: true });
});

const mode = async (p: string) => (await stat(p)).mode & 0o777;

test('save creates 0700 directories and a 0600 file', async () => {
  const s = makeAccountStore(root);
  await s.save(A, Buffer.from('one'));
  expect(await mode(root)).toBe(0o700);
  expect(await mode(join(root, A))).toBe(0o700);
  expect(await mode(s.keystorePath(A))).toBe(0o600);
  expect(await readdir(join(root, A))).toEqual(['key.p12']);
});

test('save tightens an existing root directory with wider permissions', async () => {
  await mkdir(root, { mode: 0o755 });
  await chmod(root, 0o755);
  await mkdir(join(root, A), { mode: 0o755 });
  await chmod(join(root, A), 0o755);
  await makeAccountStore(root).save(A, Buffer.from('one'));
  expect(await mode(root)).toBe(0o700);
  expect(await mode(join(root, A))).toBe(0o700);
});

test('save refuses to overwrite by default', async () => {
  const s = makeAccountStore(root);
  await s.save(A, Buffer.from('one'));
  await expect(s.save(A, Buffer.from('two'))).rejects.toBeInstanceOf(AccountExistsError);
  expect((await readFile(s.keystorePath(A))).toString()).toBe('one');
  expect(await readdir(join(root, A))).toEqual(['key.p12']);
});

test('save with overwrite leaves valid contents', async () => {
  const s = makeAccountStore(root);
  await s.save(A, Buffer.from('one'));
  await s.save(A, Buffer.from('two'), { overwrite: true });
  expect((await readFile(s.keystorePath(A))).toString()).toBe('two');
  expect(await mode(s.keystorePath(A))).toBe(0o600);
  expect(await readdir(join(root, A))).toEqual(['key.p12']);
});

test('list ignores the jars directory, stray files and empty account directories', async () => {
  const s = makeAccountStore(root);
  expect(await s.list()).toEqual([]);
  await s.save(B, Buffer.from('b'));
  await s.save(A, Buffer.from('a'));
  await mkdir(s.jarCacheDir(), { recursive: true });
  await writeFile(join(root, 'stray.txt'), 'x');
  await writeFile(join(root, 'DAG7Ghth1WhWK83SB3MtXgX1LGmnuXx4PJDvrfq5'), 'x');
  await mkdir(join(root, 'DAG2aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'));
  expect(await s.list()).toEqual([A, B].sort());
  expect(s.jarCacheDir()).toBe(join(root, 'jars'));
});

test('exists reflects saved state', async () => {
  const s = makeAccountStore(root);
  expect(await s.exists(A)).toBe(false);
  await s.save(A, Buffer.from('a'));
  expect(await s.exists(A)).toBe(true);
});

test('remove deletes the account and leaves others', async () => {
  const s = makeAccountStore(root);
  await s.save(A, Buffer.from('a'));
  await s.save(B, Buffer.from('b'));
  await s.remove(A);
  expect(await s.list()).toEqual([B]);
  await expect(s.remove(A)).resolves.toBeUndefined();
});

test('rejects an address that is not DAG + base58, including path traversal', async () => {
  const s = makeAccountStore(root);
  for (const bad of ['../x', 'jars', '', A + 'x', A.slice(1), 'DAG0' + 'l'.repeat(36), A.replace('DAG', 'dag')]) {
    expect(() => s.keystorePath(bad)).toThrow(InvalidAddressError);
    await expect(s.exists(bad)).rejects.toBeInstanceOf(InvalidAddressError);
    await expect(s.save(bad, Buffer.from('x'))).rejects.toBeInstanceOf(InvalidAddressError);
    await expect(s.remove(bad)).rejects.toBeInstanceOf(InvalidAddressError);
  }
});

test('DEFAULT_ROOT is under the home directory', () => {
  expect(DEFAULT_ROOT.endsWith('.delegated-staking-cli')).toBe(true);
});

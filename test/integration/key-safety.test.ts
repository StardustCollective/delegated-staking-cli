import * as childProcess from 'node:child_process';
import {existsSync} from 'node:fs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {afterAll, beforeAll, describe, expect, test, vi} from 'vitest';
import {buildP12, deriveAddress} from '../../src/key.js';
import {createNodeParams, showAddress, showId, type KeyContext} from '../../src/wallet.js';

// Record every execFile call while still running the real one.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>();
  return {...actual, execFile: vi.fn(actual.execFile)};
});

// Fixed test key, never funded.
const KEY = '4f3c9a1be27d58606c1e0a9d3b7f2e84a5d1c60f93b8e7254d0a6c1f8e39b72d';
const PASSWORD = `key-safety ${Math.random().toString(36).slice(2, 10)}`;
const REPO = path.resolve(import.meta.dirname, '../..');
const WALLET_JAR = path.join(REPO, '.test-jars', 'cl-wallet.jar');
const CLI = path.join(REPO, 'dist', 'cli.js');
const EXPECT = '/usr/bin/expect';

// Every form the key could leak in: hex in both cases, and the raw bytes.
const NEEDLES: [string, Buffer][] = [
  ['key (lowercase hex)', Buffer.from(KEY)],
  ['key (uppercase hex)', Buffer.from(KEY.toUpperCase())],
  ['key (raw bytes)', Buffer.from(KEY, 'hex')],
  ['password', Buffer.from(PASSWORD)],
];

function leaks(data: Buffer): string[] {
  return NEEDLES.filter(([, needle]) => data.includes(needle)).map(([name]) => name);
}

async function filesUnder(dir: string): Promise<string[]> {
  const found: string[] = [];
  for (const e of await fs.readdir(dir, {withFileTypes: true, recursive: true})) {
    if (e.isFile()) found.push(path.join(e.parentPath, e.name));
  }
  return found;
}

// The prompts need a terminal, so expect drives the CLI through a pseudo-terminal. The secrets reach
// expect through its environment and are removed from it before the CLI starts.
const EXPECT_SCRIPT = String.raw`
set timeout 60
set key $env(DSC_TEST_KEY)
set pw $env(DSC_TEST_PASSWORD)
unset env(DSC_TEST_KEY)
unset env(DSC_TEST_PASSWORD)
lassign $argv preload cli
spawn node --import $preload $cli
expect "Private key" { send -- "$key\r" } timeout { exit 101 }
expect "Choose a password" { send -- "$pw\r" } timeout { exit 102 }
expect "again" { send -- "$pw\r" } timeout { exit 103 }
expect "Is this the address" { send -- "y\r" } timeout { exit 104 }
expect eof
lassign [wait] pid spawnid oserror code
exit $code
`;

describe('the compiled CLI with no network', () => {
  let work: string;
  let home: string;
  let tmp: string;
  let transcript: string;
  let code: number | null;

  beforeAll(async () => {
    if (!existsSync(EXPECT)) throw new Error(`${EXPECT} is needed to drive the prompts through a terminal.`);
    if (!existsSync(CLI)) throw new Error('dist/cli.js is missing. Run npm run build first.');
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'key-safety-'));
    home = path.join(work, 'home');
    tmp = path.join(work, 'tmp');
    const harness = path.join(work, 'harness');
    const jarDir = path.join(home, '.delegated-staking-cli', 'jars', '3.6.2');
    await fs.mkdir(jarDir, {recursive: true});
    await fs.mkdir(tmp);
    await fs.mkdir(harness);
    await fs.copyFile(WALLET_JAR, path.join(jarDir, 'wallet.jar'));
    const preload = path.join(harness, 'no-network.mjs');
    await fs.writeFile(preload, 'globalThis.fetch = async () => { throw new TypeError("fetch failed"); };\n');
    const script = path.join(harness, 'drive.exp');
    await fs.writeFile(script, EXPECT_SCRIPT);

    const result = await new Promise<{out: string; code: number | null}>((resolve, reject) => {
      const child = childProcess.spawn(EXPECT, [script, preload, CLI], {
        cwd: home,
        env: {...process.env, HOME: home, TMPDIR: tmp, DSC_TEST_KEY: KEY, DSC_TEST_PASSWORD: PASSWORD},
      });
      let out = '';
      child.stdout.on('data', (d) => (out += d));
      child.stderr.on('data', (d) => (out += d));
      child.on('error', reject);
      child.on('close', (c) => resolve({out, code: c}));
    });
    transcript = result.out;
    code = result.code;
  }, 120_000);

  afterAll(async () => {
    if (work) await fs.rm(work, {recursive: true, force: true});
  });

  test('stops with a plain message when the registration lookup fails', () => {
    expect(transcript).toContain('Using the saved wallet.jar for version 3.6.2');
    expect(transcript).toContain(`Address: ${deriveAddress(KEY)}`);
    expect(transcript).toContain('Could not reach the Constellation network.');
    expect(transcript).not.toMatch(/\n\s+at /);
    expect(code).not.toBe(0);
    expect(code).toBeLessThan(100); // Not one of the expect script's own timeouts.
  });

  test('the key and password appear nowhere in the output', () => {
    expect(leaks(Buffer.from(transcript))).toEqual([]);
  });

  test('the key and password appear in no file under HOME or the temp directory', async () => {
    const files = [...(await filesUnder(home)), ...(await filesUnder(tmp))];
    const p12 = path.join(home, '.delegated-staking-cli', deriveAddress(KEY), 'key.p12');
    expect(files).toContain(p12);
    for (const file of files) {
      expect({file, leaks: leaks(await fs.readFile(file))}).toEqual({file, leaks: []});
    }
  });
});

describe('wallet.jar arguments', () => {
  let work: string;
  let ctx: KeyContext;

  beforeAll(async () => {
    work = await fs.mkdtemp(path.join(os.tmpdir(), 'key-args-'));
    const keystorePath = path.join(work, 'key.p12');
    await fs.writeFile(keystorePath, await buildP12(KEY, PASSWORD));
    ctx = {jarPath: WALLET_JAR, keystorePath, password: PASSWORD};
  });
  afterAll(async () => {
    await fs.rm(work, {recursive: true, force: true});
  });

  test('never contain the key or password', async () => {
    const spy = vi.mocked(childProcess.execFile);
    spy.mockClear();
    await showAddress(ctx);
    await showId(ctx);
    await createNodeParams(ctx, {name: 'Name', description: 'Description', parent: {hash: '0'.repeat(64), ordinal: 0}});

    expect(spy).toHaveBeenCalledTimes(3);
    for (const call of spy.mock.calls) {
      const [file, args, options] = call as unknown as [string, string[], {env: NodeJS.ProcessEnv}];
      for (const arg of [file, ...args]) expect(leaks(Buffer.from(arg))).toEqual([]);
      // The password goes through the environment instead.
      expect(options.env.CL_PASSWORD).toBe(PASSWORD);
    }
  });
});

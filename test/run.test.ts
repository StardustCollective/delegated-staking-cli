import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {mkdtemp, readdir, rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeAccountStore} from '../src/accounts.js';
import {NetworkError} from '../src/api.js';
import {type Deps} from '../src/flow.js';
import {SetupError} from '../src/jar.js';
import {deriveAddress} from '../src/key.js';
import {WalletError} from '../src/wallet.js';
import {run, type RunDeps} from '../src/run.js';

const KEY = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988';
const KEY_ADDRESS = deriveAddress(KEY);
const PASSWORD = 'correct horse battery';
const JAR = '/fake/wallet.jar';

// Same shape as the error @inquirer/prompts throws when the user presses Ctrl-C at a prompt.
class ExitPromptError extends Error {
  name = 'ExitPromptError';
}

type Step = {secret: string} | {text: string} | {confirm: boolean} | {select: string} | {exit: true};

function scripted(steps: Step[]): Deps['prompts'] {
  const script = [...steps];
  const next = (kind: string, message: string): any => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected ${kind} prompt: ${message}`);
    if ('exit' in step) throw new ExitPromptError('User force closed the prompt with SIGINT');
    if (!(kind in step)) throw new Error(`expected a ${Object.keys(step)[0]} prompt, got ${kind}: ${message}`);
    return (step as any)[kind];
  };
  return {
    async secret(message) {
      return next('secret', message);
    },
    async text(message) {
      return next('text', message);
    },
    async confirm(message) {
      return next('confirm', message);
    },
    async select<T>(message: string, choices: {name: string; value: T}[]) {
      const name: string = next('select', message);
      return choices.find((c) => c.name === name)!.value;
    },
  };
}

// Paste the key, choose a password, confirm the address.
const ADD: Step[] = [{secret: KEY}, {secret: PASSWORD}, {secret: PASSWORD}, {confirm: true}];
const DETAILS: Step[] = [{text: 'My node'}, {text: 'A description'}];

let base: string;
let root: string;
let savedTmpdir: string | undefined;
let out: string[];
let err: string[];
let calls: string[];

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'run-test-'));
  root = join(base, 'root');
  savedTmpdir = process.env.TMPDIR;
  // The flow's temp directories go here, so the tests can check they were removed.
  process.env.TMPDIR = base;
  out = [];
  err = [];
  calls = [];
});

afterEach(async () => {
  if (savedTmpdir === undefined) delete process.env.TMPDIR;
  else process.env.TMPDIR = savedTmpdir;
  await rm(base, {recursive: true, force: true});
});

function deps(script: Step[], over: Partial<RunDeps> = {}): Partial<RunDeps> {
  return {
    platform: 'darwin',
    checkJava: async () => {
      calls.push('checkJava');
    },
    ensureWalletJar: async () => {
      calls.push('ensureWalletJar');
      return JAR;
    },
    store: makeAccountStore(root),
    api: {
      getNodeVersion: async () => '3.6.2',
      getBalance: async () => 2_000_000 * 1e8,
      getEpoch: async () => 1,
      getRegistration: async () => null,
      postRegistration: async () => ({ok: true, hash: 'abc'}),
    },
    wallet: {
      showAddress: async (ctx) => {
        calls.push(`showAddress ${ctx.jarPath}`);
        return KEY_ADDRESS;
      },
      showId: async () => 'node-id',
      createNodeParams: async () => '{"event":1}',
    },
    prompts: scripted(script),
    log: (m) => out.push(m),
    error: (m) => err.push(m),
    sleep: async () => {},
    ...over,
  };
}

const tempDirsLeft = async () => (await readdir(base)).filter((n) => n.startsWith('dsc-'));
const noStack = (lines: string[]) => expect(lines.join('\n')).not.toMatch(/\n\s+at /);

describe('run', () => {
  test('returns 0 on success', async () => {
    const code = await run(deps([...ADD, ...DETAILS, {confirm: true}], {
      api: {
        ...deps([]).api!,
        getRegistration: (() => {
          let n = 0;
          return async () => (n++ === 0 ? null : {name: 'My node', description: 'A description', lastRef: {hash: 'h', ordinal: 1}});
        })(),
      },
    }));
    expect(code).toBe(0);
    expect(calls).toEqual(['checkJava', 'ensureWalletJar', `showAddress ${JAR}`]);
    expect(out).toContain('The registration is now visible on the network.');
    expect(err).toEqual([]);
    expect(await makeAccountStore(root).list()).toEqual([KEY_ADDRESS]);
  });

  test('returns 0 when the user declines at the summary', async () => {
    expect(await run(deps([...ADD, ...DETAILS, {confirm: false}]))).toBe(0);
    expect(out).toContain('Nothing was sent.');
  });

  describe('returns 1 and prints only the message', () => {
    const cases: [string, Partial<RunDeps>, string][] = [
      ['SubmissionRejected', {api: {...deps([]).api!, postRegistration: async () => ({ok: false, message: '"TooLargeName"'})}},
        'The name is longer than 140 characters.\n\nServer response: TooLargeName'],
      ['NetworkError', {api: {...deps([]).api!, getRegistration: async () => {
        throw new NetworkError('Could not reach the Constellation network.');
      }}}, 'Could not reach the Constellation network.'],
      ['SetupError', {checkJava: async () => {
        throw new SetupError('Java was not found.');
      }}, 'Java was not found.'],
      ['WalletError', {wallet: {...deps([]).wallet!, showId: async () => {
        throw new WalletError('wallet.jar show-id failed: boom');
      }}}, 'wallet.jar show-id failed: boom'],
    ];
    test.each(cases)('%s', async (_name, over, message) => {
      const code = await run(deps([...ADD, ...DETAILS, {confirm: true}], over));
      expect(code).toBe(1);
      expect(err).toEqual([message]);
      noStack(err);
    });
  });

  test('Ctrl-C at a prompt returns 130 with no stack trace and saves nothing', async () => {
    const code = await run(deps([{secret: KEY}, {secret: PASSWORD}, {secret: PASSWORD}, {exit: true}]));
    expect([code, err]).toEqual([130, ['Cancelled.']]);
    expect(await makeAccountStore(root).list()).toEqual([]);
    expect(await tempDirsLeft()).toEqual([]);
  });

  test('Ctrl-C while Java runs cleans up, saves nothing and returns 130', async () => {
    const listeners = process.listenerCount('SIGINT');
    const code = await run(deps(ADD, {
      wallet: {
        ...deps([]).wallet!,
        // Java gets the same SIGINT from the terminal and exits, so the call fails.
        showAddress: async () => {
          expect(await tempDirsLeft()).toHaveLength(1);
          process.emit('SIGINT');
          throw new WalletError('wallet.jar show-address failed: exit code 130');
        },
      },
    }));
    expect([code, err]).toEqual([130, ['Cancelled.']]);
    expect(await makeAccountStore(root).list()).toEqual([]);
    expect(await tempDirsLeft()).toEqual([]);
    expect(process.listenerCount('SIGINT')).toBe(listeners);
  });

  test('Ctrl-C during a call that still succeeds stops before the next prompt', async () => {
    const code = await run(deps(ADD, {
      wallet: {
        ...deps([]).wallet!,
        showAddress: async () => {
          process.emit('SIGINT');
          return KEY_ADDRESS;
        },
      },
    }));
    expect([code, err]).toEqual([130, ['Cancelled.']]);
    expect(await makeAccountStore(root).list()).toEqual([]);
    expect(await tempDirsLeft()).toEqual([]);
  });

  test('Ctrl-C while waiting for the registration to appear returns 130 at once', async () => {
    let sleeps = 0;
    const code = await run(deps([...ADD, ...DETAILS, {confirm: true}], {
      sleep: () => {
        sleeps++;
        process.emit('SIGINT');
        return new Promise(() => {}); // Never settles on its own.
      },
    }));
    expect([code, err]).toEqual([130, ['Cancelled.']]);
    expect(sleeps).toBe(1);
  });

  test('Ctrl-C cancels network reads but lets a registration POST finish', async () => {
    const seen: {method: string; aborted: boolean}[] = [];
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {status});
    const fakeFetch = async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const method = init?.method ?? 'GET';
      if (method === 'POST') {
        process.emit('SIGINT');
        seen.push({method, aborted: init?.signal?.aborted ?? false});
        return json({hash: 'sent-hash'});
      }
      if (u.includes('/node-params/')) {
        seen.push({method, aborted: init?.signal?.aborted ?? false});
        if (init?.signal?.aborted) throw new DOMException('aborted', 'AbortError');
        return json({}, 404);
      }
      if (u.endsWith('/balance')) return json({balance: 0});
      return json({value: {epochProgress: 1}});
    };
    const original = globalThis.fetch;
    globalThis.fetch = fakeFetch as typeof fetch;
    try {
      const {api: _api, ...rest} = deps([...ADD, ...DETAILS, {confirm: true}]);
      const code = await run({...rest, sleep: async () => {}});
      expect([code, err]).toEqual([130, ['Cancelled.']]);
    } finally {
      globalThis.fetch = original;
    }
    expect(seen).toEqual([{method: 'GET', aborted: false}, {method: 'POST', aborted: false}]);
    expect(out).toContain('Sent. Hash: sent-hash');
  });

  test('unexpected errors print a generic message and scrub the key and password', async () => {
    const pasted = `0x${KEY.toUpperCase()}`;
    const code = await run(deps([{secret: pasted}, {secret: PASSWORD}, {secret: PASSWORD}], {
      wallet: {
        ...deps([]).wallet!,
        showAddress: async () => {
          throw new Error(`boom ${KEY} ${pasted} ${KEY.toUpperCase()} pw=${PASSWORD}`);
        },
      },
    }));
    expect(code).toBe(1);
    const text = [...out, ...err].join('\n');
    expect(text).not.toContain(PASSWORD);
    expect(text.toLowerCase()).not.toContain(KEY);
    expect(err[0]).toBe('The tool stopped because of an error:');
    expect(err[1]).toContain('boom');
    expect(err[1]).toContain('[redacted]');
    noStack(err);
  });

  test('rejects unsupported platforms with a WSL message', async () => {
    const code = await run(deps([], {platform: 'win32'}));
    expect(code).toBe(1);
    expect(err.join('\n')).toMatch(/WSL/);
    expect(calls).toEqual([]);
  });
});

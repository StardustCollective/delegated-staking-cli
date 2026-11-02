import {afterEach, beforeEach, describe, expect, test} from 'vitest';
import {mkdtemp, readFile, rm, stat} from 'node:fs/promises';
import {existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {makeAccountStore} from '../src/accounts.js';
import {NetworkError, type Registration} from '../src/api.js';
import {deriveAddress} from '../src/key.js';
import {type KeyContext, WalletError, WrongPasswordError} from '../src/wallet.js';
import {chooseAccount, deleteAccount, type Deps, registerOrEdit, SubmissionRejected} from '../src/flow.js';

const KEY = '1f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a79881f2e3d4c5b6a7988';
const KEY_ADDRESS = deriveAddress(KEY);
const OTHER = 'DAG0y4eLqhhXUafeE3mgBstezPTnr8L3tZjAtMWB';
const A = 'DAG7Ghth1WhWK83SB3MtXgX1LGmnuXx4PJDvrfq4';
const PASSWORD = 'correct horse battery';
const WARNING =
  'Your private key controls your funds. Only use this tool from the official StardustCollective repository or npm package.';
const STAKING = 'https://mainnet.dagexplorer.io/staking';
const ZERO = {hash: '0'.repeat(64), ordinal: 0};

type Step =
  | {secret: string}
  | {text: string}
  | {confirm: boolean}
  | {select: string}
  | {interrupt: true};

function scripted(script: Step[]) {
  const asked: {kind: string; message: string; default?: unknown; choices?: string[]}[] = [];
  const rejected: string[] = [];
  const next = (kind: string, message: string): any => {
    const step = script.shift();
    if (!step) throw new Error(`unexpected ${kind} prompt: ${message}`);
    if ('interrupt' in step) throw new Error('User force closed the prompt with SIGINT');
    if (!(kind in step)) throw new Error(`expected a ${Object.keys(step)[0]} prompt, got ${kind}: ${message}`);
    return (step as any)[kind];
  };
  const answerValid = (kind: string, message: string, validate?: (v: string) => true | string) => {
    for (;;) {
      const v: string = next(kind, message);
      const r = validate ? validate(v) : true;
      if (r === true) return v;
      rejected.push(r);
    }
  };
  const prompts: Deps['prompts'] = {
    async secret(message, validate) {
      asked.push({kind: 'secret', message});
      return answerValid('secret', message, validate);
    },
    async text(message, opts) {
      asked.push({kind: 'text', message, default: opts.default});
      return answerValid('text', message, opts.validate);
    },
    async confirm(message, defaultValue) {
      asked.push({kind: 'confirm', message, default: defaultValue});
      return next('confirm', message);
    },
    async select<T>(message: string, choices: {name: string; value: T}[]) {
      asked.push({kind: 'select', message, choices: choices.map((c) => c.name)});
      const name: string = next('select', message);
      const choice = choices.find((c) => c.name === name);
      if (!choice) throw new Error(`no choice named ${name}; have ${choices.map((c) => c.name).join(', ')}`);
      return choice.value;
    },
  };
  return {prompts, asked, rejected, remaining: script};
}

type WalletFake = Partial<Deps['wallet']>;
type ApiFake = Partial<Deps['api']>;

let base: string;
let root: string;

beforeEach(async () => {
  base = await mkdtemp(join(tmpdir(), 'flow-test-'));
  root = join(base, 'root');
});
afterEach(async () => {
  await rm(base, {recursive: true, force: true});
});

function makeDeps(script: Step[], opts: {wallet?: WalletFake; api?: ApiFake} = {}) {
  const s = scripted(script);
  const logs: string[] = [];
  const sleeps: number[] = [];
  const deps: Deps = {
    api: opts.api as Deps['api'],
    store: makeAccountStore(root),
    wallet: opts.wallet as Deps['wallet'],
    prompts: s.prompts,
    log: (m) => logs.push(m),
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    jarPath: '/fake/wallet.jar',
  };
  return {deps, logs, sleeps, ...s};
}

// A wallet whose showAddress records the temp keystore it was given.
function recordingWallet(address: string) {
  const seen: KeyContext[] = [];
  const wallet: WalletFake = {
    showAddress: async (ctx) => {
      seen.push({...ctx});
      const st = await stat(ctx.keystorePath);
      expect(st.mode & 0o777).toBe(0o600);
      expect((await stat(join(ctx.keystorePath, '..'))).mode & 0o777).toBe(0o700);
      return address;
    },
  };
  return {wallet, seen};
}

const addSteps = (): Step[] => [{secret: KEY}, {secret: PASSWORD}, {secret: PASSWORD}];

function expectNoSecrets(logs: string[]) {
  const all = logs.join('\n');
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(PASSWORD);
}

describe('chooseAccount', () => {
  test('new account: address shown and confirmed before saving', async () => {
    const {wallet, seen} = recordingWallet(KEY_ADDRESS);
    const t = makeDeps([...addSteps(), {confirm: true}], {wallet});
    const store = t.deps.store;
    const origSave = store.save;
    let savedAfterConfirm = false;
    store.save = async (...args) => {
      savedAfterConfirm = t.asked.some((a) => a.kind === 'confirm');
      return origSave(...args);
    };

    const acct = await chooseAccount(t.deps);

    expect(acct).toEqual({jarPath: '/fake/wallet.jar', keystorePath: store.keystorePath(KEY_ADDRESS), password: PASSWORD, address: KEY_ADDRESS});
    expect(savedAfterConfirm).toBe(true);
    expect(t.logs[0]).toBe(WARNING);
    expect(t.logs.join('\n')).toContain(KEY_ADDRESS);
    const confirm = t.asked.find((a) => a.kind === 'confirm')!;
    expect(confirm.default).toBe(false);
    expect(await store.list()).toEqual([KEY_ADDRESS]);
    const saved = await readFile(store.keystorePath(KEY_ADDRESS));
    expect(saved.toString('hex')).not.toContain(KEY);
    expect(seen[0].password).toBe(PASSWORD);
    expect(existsSync(join(seen[0].keystorePath, '..'))).toBe(false);
    expectNoSecrets(t.logs);
  });

  test('new account: invalid key asks again, up to 3 tries', async () => {
    const {wallet} = recordingWallet(KEY_ADDRESS);
    const t = makeDeps([{secret: 'nothex'}, {secret: '0x' + KEY.toUpperCase()}, {secret: PASSWORD}, {secret: PASSWORD}, {confirm: true}], {wallet});
    await chooseAccount(t.deps);
    expect(t.logs.some((l) => l.startsWith('Invalid private key'))).toBe(true);
    expectNoSecrets(t.logs);
  });

  test('new account: 3 invalid keys stop with a plain message', async () => {
    const {wallet} = recordingWallet(KEY_ADDRESS);
    const t2 = makeDeps([{secret: 'a'}, {secret: 'b'}, {secret: 'c'}], {wallet});
    await expect(chooseAccount(t2.deps)).rejects.toThrow(/3 tries/);
    expect(t2.remaining).toEqual([]);
  });

  test('new account: password must be valid and confirmed', async () => {
    const {wallet} = recordingWallet(KEY_ADDRESS);
    const t = makeDeps(
      [{secret: KEY}, {secret: 'short'}, {secret: PASSWORD}, {secret: 'different pw'}, {secret: PASSWORD}, {secret: PASSWORD}, {confirm: true}],
      {wallet},
    );
    const acct = await chooseAccount(t.deps);
    expect(acct.password).toBe(PASSWORD);
    expect(t.rejected).toHaveLength(1);
    expect(t.logs.join('\n')).toMatch(/do not match/);
    expectNoSecrets(t.logs);
  });

  test('new account: declining the address saves nothing', async () => {
    const {wallet, seen} = recordingWallet(KEY_ADDRESS);
    // Declining returns to adding (no saved accounts yet); then the user quits with Ctrl-C.
    const t = makeDeps([...addSteps(), {confirm: false}, {interrupt: true}], {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow(/SIGINT/);
    expect(await t.deps.store.list()).toEqual([]);
    expect(existsSync(join(seen[0].keystorePath, '..'))).toBe(false);
    expect(t.logs.filter((l) => l === WARNING)).toHaveLength(2);
  });

  test('new account: stops and saves nothing if wallet.jar and derived addresses differ', async () => {
    const {wallet, seen} = recordingWallet(OTHER);
    const t = makeDeps(addSteps(), {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow(/does not match/);
    expect(await t.deps.store.list()).toEqual([]);
    expect(existsSync(join(seen[0].keystorePath, '..'))).toBe(false);
    expect(t.remaining).toEqual([]);
  });

  test('new account: asks before replacing an existing saved key', async () => {
    const {wallet} = recordingWallet(KEY_ADDRESS);
    await makeAccountStore(root).save(KEY_ADDRESS, Buffer.from('old'));

    // Declining the replacement keeps the old file and returns to the menu.
    const t = makeDeps([{select: 'Add an account'}, ...addSteps(), {confirm: true}, {confirm: false}, {select: KEY_ADDRESS}, {secret: PASSWORD}], {wallet});
    await chooseAccount(t.deps);
    const replace = t.asked.filter((a) => a.kind === 'confirm')[1];
    expect(replace.message).toMatch(/replace/i);
    expect(replace.default).toBe(false);
    expect(await readFile(t.deps.store.keystorePath(KEY_ADDRESS), 'utf8')).toBe('old');

    // Accepting replaces it.
    const t2 = makeDeps([{select: 'Add an account'}, ...addSteps(), {confirm: true}, {confirm: true}], {wallet});
    await chooseAccount(t2.deps);
    expect(await readFile(t2.deps.store.keystorePath(KEY_ADDRESS), 'utf8')).not.toBe('old');
  });

  test('new account: a prompt interrupted mid-add leaves no temp directory and no saved account', async () => {
    const {wallet, seen} = recordingWallet(KEY_ADDRESS);
    const t = makeDeps([...addSteps(), {interrupt: true}], {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow(/SIGINT/);
    expect(seen).toHaveLength(1);
    expect(existsSync(join(seen[0].keystorePath, '..'))).toBe(false);
    expect(await t.deps.store.list()).toEqual([]);

    const t2 = makeDeps([{secret: KEY}, {interrupt: true}], {wallet});
    await expect(chooseAccount(t2.deps)).rejects.toThrow(/SIGINT/);
    expect(await t2.deps.store.list()).toEqual([]);
  });

  test('new account: a wallet.jar failure removes the temp directory', async () => {
    let dir = '';
    const wallet: WalletFake = {
      showAddress: async (ctx) => {
        dir = join(ctx.keystorePath, '..');
        throw new WalletError('wallet.jar show-address failed: boom');
      },
    };
    const t = makeDeps(addSteps(), {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow(/boom/);
    expect(dir).not.toBe('');
    expect(existsSync(dir)).toBe(false);
    expect(await t.deps.store.list()).toEqual([]);
  });

  test('menu lists saved accounts, then add and delete', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    await makeAccountStore(root).save(OTHER, Buffer.from('b'));
    const wallet: WalletFake = {showAddress: async () => A};
    const t = makeDeps([{select: A}, {secret: PASSWORD}], {wallet});
    const acct = await chooseAccount(t.deps);
    expect(t.asked[0].choices).toEqual([...[A, OTHER].sort(), 'Add an account', 'Delete a saved account']);
    expect(acct).toEqual({jarPath: '/fake/wallet.jar', keystorePath: t.deps.store.keystorePath(A), password: PASSWORD, address: A});
  });

  test('menu: delete removes the chosen account after confirming, then shows the menu again', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    await makeAccountStore(root).save(OTHER, Buffer.from('b'));
    const wallet: WalletFake = {showAddress: async () => OTHER};
    const t = makeDeps(
      [{select: 'Delete a saved account'}, {select: A}, {confirm: true}, {select: OTHER}, {secret: PASSWORD}],
      {wallet},
    );
    await chooseAccount(t.deps);
    expect(await t.deps.store.list()).toEqual([OTHER]);
    expect(t.asked[2].default).toBe(false);
    expect(t.logs.join('\n')).toContain(`Deleted the saved key for ${A}`);
    expect(t.asked[3].choices).toEqual([OTHER, 'Add an account', 'Delete a saved account']);
  });

  test('deleteAccount: declining keeps the account', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    const t = makeDeps([{select: A}, {confirm: false}]);
    await deleteAccount(t.deps);
    expect(await t.deps.store.list()).toEqual([A]);
  });

  test('deleteAccount: with no saved accounts says so', async () => {
    const t = makeDeps([]);
    await deleteAccount(t.deps);
    expect(t.logs.join('\n')).toMatch(/no saved accounts/i);
  });

  test('saved account: wrong password retries, then fails after 3 tries with a plain message', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    let calls = 0;
    const wallet: WalletFake = {
      showAddress: async () => {
        calls++;
        throw new WrongPasswordError();
      },
    };
    const t = makeDeps([{select: A}, {secret: 'one'}, {secret: 'two'}, {secret: 'three'}], {wallet});
    const err = await chooseAccount(t.deps).catch((e) => e);
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toBe('Wrong password 3 times. Run the tool again to retry.');
    expect(err.message).not.toMatch(/java|exception|\bat\b/i);
    expect(calls).toBe(3);
    expect(t.logs.filter((l) => l === 'Wrong password. Try again.')).toHaveLength(2);
  });

  test('saved account: a later correct password succeeds', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    const wallet: WalletFake = {
      showAddress: async (ctx) => {
        if (ctx.password !== PASSWORD) throw new WrongPasswordError();
        return A;
      },
    };
    const t = makeDeps([{select: A}, {secret: 'nope'}, {secret: PASSWORD}], {wallet});
    expect((await chooseAccount(t.deps)).password).toBe(PASSWORD);
    expectNoSecrets(t.logs);
  });

  test('saved account: a key file for a different address stops', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    const wallet: WalletFake = {showAddress: async () => OTHER};
    const t = makeDeps([{select: A}, {secret: PASSWORD}], {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow(/belongs to/);
  });

  test('saved account: other wallet errors propagate', async () => {
    await makeAccountStore(root).save(A, Buffer.from('a'));
    const wallet: WalletFake = {showAddress: async () => { throw new WalletError('Java was not found.'); }};
    const t = makeDeps([{select: A}, {secret: PASSWORD}], {wallet});
    await expect(chooseAccount(t.deps)).rejects.toThrow('Java was not found.');
  });
});

describe('registerOrEdit', () => {
  const ACCOUNT = {jarPath: '/fake/wallet.jar', keystorePath: '/fake/key.p12', password: PASSWORD, address: A};
  const OLD_REF = {hash: 'ab'.repeat(32), ordinal: 7};
  const NEW_REF = {hash: 'cd'.repeat(32), ordinal: 8};
  const EXISTING: Registration = {name: 'Old name', description: 'Old description', lastRef: OLD_REF};

  type Setup = {
    registration?: Registration | null | Error;
    polls?: (Registration | null | Error)[];
    balance?: number | Error;
    epoch?: number | Error;
    post?: {ok: true; hash: string} | {ok: false; message: string};
  };

  function setup(script: Step[], s: Setup = {}) {
    const lookups: string[] = [];
    const signed: any[] = [];
    const posted: string[] = [];
    const polls = [...(s.polls ?? [])];
    let first = true;
    const api: ApiFake = {
      getRegistration: async (id) => {
        lookups.push(id);
        let r: Registration | null | Error;
        if (first) {
          first = false;
          r = s.registration === undefined ? null : s.registration;
        } else {
          r = polls.length ? polls.shift()! : null;
        }
        if (r instanceof Error) throw r;
        return r;
      },
      getBalance: async () => {
        const b = s.balance ?? 300_000 * 1e8;
        if (b instanceof Error) throw b;
        return b;
      },
      getEpoch: async () => {
        const e = s.epoch ?? 2_940_000;
        if (e instanceof Error) throw e;
        return e;
      },
      postRegistration: async (event) => {
        posted.push(event);
        return s.post ?? {ok: true, hash: 'f00d'.repeat(16)};
      },
    };
    const wallet: WalletFake = {
      showId: async () => 'node-id-1',
      createNodeParams: async (ctx, input) => {
        signed.push({ctx, input});
        return '{"signed":true}';
      },
    };
    const t = makeDeps(script, {api, wallet});
    return {...t, lookups, signed, posted};
  }

  const answers = (name: string, description: string): Step[] => [{text: name}, {text: description}, {confirm: true}];
  const NEW_VALUES = (ref: typeof OLD_REF) => ({name: 'My node', description: 'Runs well', lastRef: ref});

  test('new registration: 404 uses the zero parent', async () => {
    const t = setup(answers('My node', 'Runs well'), {polls: [NEW_VALUES(NEW_REF)]});
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.lookups[0]).toBe('node-id-1');
    expect(t.signed).toHaveLength(1);
    expect(t.signed[0].input).toEqual({name: 'My node', description: 'Runs well', parent: ZERO});
    expect(t.signed[0].ctx).toEqual({jarPath: ACCOUNT.jarPath, keystorePath: ACCOUNT.keystorePath, password: PASSWORD});
    expect(t.posted).toEqual(['{"signed":true}']);
    expectNoSecrets(t.logs);
  });

  test('edit: prefills name and description and uses lastRef as parent', async () => {
    const t = setup(answers('My node', 'Runs well'), {registration: EXISTING, polls: [NEW_VALUES(NEW_REF)]});
    await registerOrEdit(t.deps, ACCOUNT);
    const texts = t.asked.filter((a) => a.kind === 'text');
    expect(texts.map((a) => a.default)).toEqual(['Old name', 'Old description']);
    expect(t.signed[0].input.parent).toEqual(OLD_REF);
  });

  test('edit: unchanged name and description send nothing', async () => {
    const t = setup([{text: ' Old name '}, {text: 'Old description'}], {registration: EXISTING});
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.signed).toHaveLength(0);
    expect(t.posted).toHaveLength(0);
    expect(t.logs.join('\n')).toMatch(/nothing changed/i);
  });

  test('server failure on the lookup stops the run and sends nothing', async () => {
    const t = setup([], {registration: new NetworkError('The network returned status 503 for the registration lookup.')});
    await expect(registerOrEdit(t.deps, ACCOUNT)).rejects.toThrow(/503/);
    expect(t.signed).toHaveLength(0);
    expect(t.posted).toHaveLength(0);
    expect(t.asked).toHaveLength(0);
  });

  test('balance under the minimum warns and still sends', async () => {
    const t = setup(answers('My node', 'Runs well'), {balance: 12.5 * 1e8, epoch: 2_960_000, polls: [NEW_VALUES(NEW_REF)]});
    await registerOrEdit(t.deps, ACCOUNT);
    const warning = t.logs.find((l) => l.includes('under the'));
    expect(warning).toContain('12.5 DAG');
    expect(warning).toContain('1,000,000 DAG');
    expect(t.posted).toHaveLength(1);
  });

  test('balance at the minimum does not warn', async () => {
    const t = setup(answers('My node', 'Runs well'), {balance: 250_000 * 1e8, polls: [NEW_VALUES(NEW_REF)]});
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.logs.some((l) => l.includes('under the'))).toBe(false);
  });

  test('balance or epoch lookup failure skips the warning and still sends', async () => {
    for (const s of [{balance: new NetworkError('x')}, {epoch: new NetworkError('y')}]) {
      const t = setup(answers('My node', 'Runs well'), {...s, polls: [NEW_VALUES(NEW_REF)]});
      await registerOrEdit(t.deps, ACCOUNT);
      expect(t.logs).toContain('Could not check your balance; the network will decide.');
      expect(t.logs.some((l) => l.includes('under the'))).toBe(false);
      expect(t.posted).toHaveLength(1);
    }
    const t = setup([], {balance: new TypeError('bug')});
    await expect(registerOrEdit(t.deps, ACCOUNT)).rejects.toThrow('bug');
  });

  test('name and description require non-empty text, at most 140 characters', async () => {
    const t = setup(
      [{text: '   '}, {text: 'x'.repeat(141)}, {text: '  My node  '}, {text: ''}, {text: 'y'.repeat(140)}, {confirm: true}],
      {polls: [{name: 'My node', description: 'y'.repeat(140), lastRef: NEW_REF}]},
    );
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.rejected).toEqual(['Enter at least one character.', 'Use at most 140 characters.', 'Enter at least one character.']);
    expect(t.signed[0].input).toMatchObject({name: 'My node', description: 'y'.repeat(140)});
  });

  test('declining the summary sends nothing', async () => {
    const t = setup([{text: 'My node'}, {text: 'Runs well'}, {confirm: false}]);
    await registerOrEdit(t.deps, ACCOUNT);
    const summary = t.asked.find((a) => a.kind === 'confirm')!;
    expect(summary.default).toBe(false);
    expect(t.logs.join('\n')).toContain('My node');
    expect(t.signed).toHaveLength(0);
    expect(t.posted).toHaveLength(0);
  });

  test('400 throws SubmissionRejected with the explanation', async () => {
    const message = '"InsufficientRegistrationBalance{source=DAG7r19DkWQSsmDMM1CGh4seEVdPqYB8hkgs82i1,balance=0,minimum=25000000000000}"';
    const t = setup(answers('My node', 'Runs well'), {post: {ok: false, message}});
    const err = await registerOrEdit(t.deps, ACCOUNT).catch((e) => e);
    expect(err).toBeInstanceOf(SubmissionRejected);
    expect(err.message).toContain('Your balance (0 DAG) is under the minimum (250,000 DAG)');
    expect(err.message).toContain('Server response: InsufficientRegistrationBalance{');
    expect(t.sleeps).toHaveLength(0);
  });

  test('success polls until the new values appear, then shows the staking page', async () => {
    const t = setup(answers('My node', 'Runs well'), {polls: [null, {...EXISTING}, NEW_VALUES(NEW_REF)]});
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.logs.join('\n')).toContain('f00d'.repeat(16));
    expect(t.sleeps).toEqual([10_000, 10_000, 10_000]);
    expect(t.lookups).toHaveLength(4);
    expect(t.logs.join('\n')).toMatch(/now visible/);
    expect(t.logs.at(-1)).toContain(STAKING);
  });

  test('edit: success also needs a new lastRef', async () => {
    const t = setup(answers('My node', 'Runs well'), {
      registration: EXISTING,
      polls: [NEW_VALUES(OLD_REF), NEW_VALUES(NEW_REF)],
    });
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.sleeps).toHaveLength(2);
    expect(t.logs.join('\n')).toMatch(/now visible/);
  });

  test('poll timeout reports submitted but not yet visible, and does not throw', async () => {
    const t = setup(answers('My node', 'Runs well'));
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.sleeps).toHaveLength(30);
    expect(t.sleeps.every((ms) => ms === 10_000)).toBe(true);
    expect(t.logs.join('\n')).toMatch(/submitted but is not yet visible/);
    expect(t.logs.at(-1)).toContain(STAKING);
  });

  test('poll errors keep polling until the timeout', async () => {
    const t = setup(answers('My node', 'Runs well'), {polls: Array(30).fill(new NetworkError('down'))});
    await registerOrEdit(t.deps, ACCOUNT);
    expect(t.lookups).toHaveLength(31);
    expect(t.logs.join('\n')).toMatch(/submitted but is not yet visible/);
    expect(t.logs.at(-1)).toContain(STAKING);
  });
});

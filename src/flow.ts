import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {makeAccountStore} from './accounts.js';
import {formatDag, type makeApi, minimumBalance, NetworkError, type Ref, type Registration} from './api.js';
import {explainServerError} from './explain.js';
import {buildP12, deriveAddress, InvalidKeyError, normalizePrivateKey, validatePassword} from './key.js';
import {type createNodeParams, type KeyContext, type showAddress, type showId, WrongPasswordError} from './wallet.js';

export type Deps = {
  api: ReturnType<typeof makeApi>;
  store: ReturnType<typeof makeAccountStore>;
  wallet: {showAddress: typeof showAddress; showId: typeof showId; createNodeParams: typeof createNodeParams};
  prompts: {
    secret(message: string, validate?: (v: string) => true | string): Promise<string>;
    text(message: string, opts: {default?: string; validate: (v: string) => true | string}): Promise<string>;
    confirm(message: string, defaultValue: boolean): Promise<boolean>;
    select<T>(message: string, choices: {name: string; value: T}[]): Promise<T>;
  };
  log: (message: string) => void;
  sleep: (ms: number) => Promise<void>;
  jarPath: string;
};

export type Account = KeyContext & {address: string};

export class SubmissionRejected extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SubmissionRejected';
  }
}

const KEY_WARNING =
  'Your private key controls your funds. Only use this tool from the official StardustCollective repository or npm package.';
export const STAKING_PAGE = 'https://mainnet.dagexplorer.io/staking';
const ZERO_PARENT: Ref = {hash: '0'.repeat(64), ordinal: 0};
const MAX_TRIES = 3;
const MAX_TEXT = 140;
const POLL_INTERVAL_MS = 10_000;
const POLL_COUNT = 30; // 5 minutes

// ---- Choosing the account ----

type MenuChoice = {kind: 'saved'; address: string} | {kind: 'add'} | {kind: 'delete'};

export async function chooseAccount(deps: Deps): Promise<Account> {
  for (;;) {
    const saved = await deps.store.list();
    const choice: MenuChoice = saved.length === 0
      ? {kind: 'add'}
      : await deps.prompts.select<MenuChoice>('Choose an account', [
          ...saved.map((address) => ({name: address, value: {kind: 'saved' as const, address}})),
          {name: 'Add an account', value: {kind: 'add'}},
          {name: 'Delete a saved account', value: {kind: 'delete'}},
        ]);
    if (choice.kind === 'saved') return unlockSaved(deps, choice.address);
    if (choice.kind === 'delete') {
      await deleteAccount(deps);
      continue;
    }
    const added = await addAccount(deps);
    if (added) return added;
  }
}

export async function deleteAccount(deps: Deps): Promise<void> {
  const saved = await deps.store.list();
  if (saved.length === 0) {
    deps.log('There are no saved accounts.');
    return;
  }
  const address = await deps.prompts.select('Which saved account do you want to delete?', saved.map((a) => ({name: a, value: a})));
  const dir = path.dirname(deps.store.keystorePath(address));
  if (!(await deps.prompts.confirm(`Delete the saved key for ${address}? This cannot be undone.`, false))) {
    deps.log('Nothing was deleted.');
    return;
  }
  await deps.store.remove(address);
  deps.log(`Deleted the saved key for ${address} (${dir}).`);
}

async function unlockSaved(deps: Deps, address: string): Promise<Account> {
  const keystorePath = deps.store.keystorePath(address);
  for (let tries = 1; ; tries++) {
    const password = await deps.prompts.secret(`Password for ${address}`);
    const ctx: KeyContext = {jarPath: deps.jarPath, keystorePath, password};
    let shown: string;
    try {
      shown = await deps.wallet.showAddress(ctx);
    } catch (e) {
      if (!(e instanceof WrongPasswordError)) throw e;
      if (tries >= MAX_TRIES) throw new Error(`Wrong password ${MAX_TRIES} times. Run the tool again to retry.`);
      deps.log('Wrong password. Try again.');
      continue;
    }
    if (shown !== address) {
      throw new Error(`The saved key file for ${address} belongs to ${shown}. Delete it and add the account again.`);
    }
    return {...ctx, address};
  }
}

async function readPrivateKey(deps: Deps): Promise<string> {
  for (let tries = 1; ; tries++) {
    try {
      return normalizePrivateKey(await deps.prompts.secret('Private key (hex, from Stargazer)'));
    } catch (e) {
      if (!(e instanceof InvalidKeyError)) throw e;
      deps.log(e.message);
      if (tries >= MAX_TRIES) throw new Error(`No valid private key after ${MAX_TRIES} tries.`);
    }
  }
}

async function readNewPassword(deps: Deps): Promise<string> {
  for (;;) {
    const password = await deps.prompts.secret('Choose a password to encrypt the saved key', validatePassword);
    const again = await deps.prompts.secret('Enter the password again');
    if (password === again) return password;
    deps.log('The passwords do not match. Try again.');
  }
}

// Returns null when the user declines, so the menu shows again.
async function addAccount(deps: Deps): Promise<Account | null> {
  deps.log(KEY_WARNING);
  const hex = await readPrivateKey(deps);
  const password = await readNewPassword(deps);
  const address = deriveAddress(hex);
  const p12 = await buildP12(hex, password);

  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), 'dsc-key-'));
  try {
    await fs.chmod(tmp, 0o700);
    const tmpKeystore = path.join(tmp, 'key.p12');
    await fs.writeFile(tmpKeystore, p12, {mode: 0o600});
    const shown = await deps.wallet.showAddress({jarPath: deps.jarPath, keystorePath: tmpKeystore, password});
    if (shown !== address) {
      throw new Error(`The address from wallet.jar (${shown}) does not match the address from the private key (${address}). Nothing was saved.`);
    }

    deps.log(`Address: ${address}`);
    if (!(await deps.prompts.confirm('Is this the address of your account?', false))) {
      deps.log('Nothing was saved.');
      return null;
    }
    const overwrite = await deps.store.exists(address);
    if (overwrite && !(await deps.prompts.confirm(`A saved key for ${address} already exists. Replace it?`, false))) {
      deps.log('Kept the existing saved key.');
      return null;
    }
    await deps.store.save(address, p12, {overwrite});
    const keystorePath = deps.store.keystorePath(address);
    deps.log(`Saved the encrypted key to ${keystorePath}`);
    return {jarPath: deps.jarPath, keystorePath, password, address};
  } finally {
    await fs.rm(tmp, {recursive: true, force: true});
  }
}

// ---- Registering or editing ----

function validateText(v: string): true | string {
  const t = v.trim();
  if (t.length === 0) return 'Enter at least one character.';
  if (t.length > MAX_TEXT) return `Use at most ${MAX_TEXT} characters.`;
  return true;
}

async function warnIfUnderMinimum(deps: Deps, address: string): Promise<void> {
  let balance: number;
  let minimum: number;
  try {
    balance = await deps.api.getBalance(address);
    minimum = minimumBalance(await deps.api.getEpoch());
  } catch (e) {
    if (!(e instanceof NetworkError)) throw e;
    deps.log('Could not check your balance; the network will decide.');
    return;
  }
  if (balance < minimum) {
    deps.log(
      `Warning: your balance is ${formatDag(balance)}, under the ${formatDag(minimum)} minimum for delegated staking. ` +
        'The request will still be sent, and the network will decide.',
    );
  }
}

const sameRef = (a: Ref, b: Ref) => a.hash === b.hash && a.ordinal === b.ordinal;

async function waitUntilVisible(deps: Deps, id: string, sent: {name: string; description: string}, before: Registration | null) {
  for (let i = 0; i < POLL_COUNT; i++) {
    await deps.sleep(POLL_INTERVAL_MS);
    let now: Registration | null;
    try {
      now = await deps.api.getRegistration(id);
    } catch {
      continue; // Keep polling through network errors.
    }
    if (now && now.name === sent.name && now.description === sent.description && (!before || !sameRef(now.lastRef, before.lastRef))) {
      return true;
    }
  }
  return false;
}

export async function registerOrEdit(deps: Deps, account: Account): Promise<void> {
  const ctx: KeyContext = {jarPath: account.jarPath, keystorePath: account.keystorePath, password: account.password};
  const id = await deps.wallet.showId(ctx);
  const existing = await deps.api.getRegistration(id);
  deps.log(existing ? 'This account is already registered. You can edit its name and description.' : 'This account is not registered yet.');

  await warnIfUnderMinimum(deps, account.address);

  const name = (await deps.prompts.text('Name', {default: existing?.name, validate: validateText})).trim();
  const description = (await deps.prompts.text('Description', {default: existing?.description, validate: validateText})).trim();
  if (existing && existing.name === name && existing.description === description) {
    deps.log('Nothing changed, so nothing was sent.');
    return;
  }

  deps.log([
    existing ? 'Edit registration:' : 'New registration:',
    `  Address:     ${account.address}`,
    `  Name:        ${name}`,
    `  Description: ${description}`,
  ].join('\n'));
  if (!(await deps.prompts.confirm('Sign and send this registration? It will be public and cannot be deleted.', false))) {
    deps.log('Nothing was sent.');
    return;
  }

  const parent = existing ? existing.lastRef : ZERO_PARENT;
  const event = await deps.wallet.createNodeParams(ctx, {name, description, parent});
  const result = await deps.api.postRegistration(event);
  if (!result.ok) throw new SubmissionRejected(explainServerError(result.message));

  deps.log(`Sent. Hash: ${result.hash}`);
  deps.log('Waiting for the change to appear on the network (up to 5 minutes)...');
  if (await waitUntilVisible(deps, id, {name, description}, existing)) {
    deps.log('The registration is now visible on the network.');
  } else {
    deps.log('The registration was submitted but is not yet visible on the network. Check again in a few minutes.');
  }
  deps.log(`Staking page: ${STAKING_PAGE}`);
}

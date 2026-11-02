import {confirm, input, password, select} from '@inquirer/prompts';
import {DEFAULT_ROOT, makeAccountStore} from './accounts.js';
import {makeApi, NetworkError} from './api.js';
import {chooseAccount, type Deps, registerOrEdit, SubmissionRejected} from './flow.js';
import {checkJava, ensureWalletJar, SetupError} from './jar.js';
import {createNodeParams, showAddress, showId, WalletError} from './wallet.js';

// jarPath is not an input: it comes from ensureWalletJar.
export type RunDeps = Omit<Deps, 'jarPath'> & {
  checkJava: () => Promise<void>;
  ensureWalletJar: typeof ensureWalletJar;
  platform: NodeJS.Platform;
  error: (message: string) => void;
};

const SUPPORTED: NodeJS.Platform[] = ['darwin', 'linux'];
const PLATFORM_MESSAGE =
  'This tool runs on macOS and Linux only. On Windows, use WSL: https://learn.microsoft.com/windows/wsl/';

class Interrupted extends Error {
  constructor() {
    super('Interrupted');
    this.name = 'Interrupted';
  }
}

const isExitPrompt = (e: unknown) => e instanceof Error && e.name === 'ExitPromptError';
const isKnown = (e: unknown): e is Error =>
  e instanceof SubmissionRejected || e instanceof NetworkError || e instanceof SetupError || e instanceof WalletError;

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Removes every secret typed in this run from a message. Keys are matched in any case, with or without 0x.
function scrubber(secrets: string[]) {
  return (text: string, opts: {anyHex?: boolean} = {}): string => {
    let t = text;
    for (const s of secrets) {
      if (!s) continue;
      t = t.split(s).join('[redacted]');
      const trimmed = s.trim();
      if (trimmed) t = t.split(trimmed).join('[redacted]');
      const hex = trimmed.replace(/^0x/i, '');
      if (/^[0-9a-f]{16,}$/i.test(hex)) t = t.replace(new RegExp(`(0x)?${escapeRe(hex)}`, 'gi'), '[redacted]');
    }
    if (opts.anyHex) t = t.replace(/\b(0x)?[0-9a-fA-F]{64}\b/g, '[redacted]');
    return t;
  };
}

function realPrompts(): Deps['prompts'] {
  return {
    // No mask characters, and no Ctrl-T to reveal: the secret never reaches the screen.
    secret: (message, validate) => password({message, mask: false, toggleMask: false, validate}),
    text: (message, opts) => input({message, default: opts.default, validate: opts.validate}),
    confirm: (message, defaultValue) => confirm({message, default: defaultValue}),
    select: (message, choices) => select({message, choices}),
  };
}

export async function run(partial: Partial<RunDeps> = {}): Promise<number> {
  const log = partial.log ?? ((m: string) => process.stdout.write(`${m}\n`));
  const error = partial.error ?? ((m: string) => process.stderr.write(`${m}\n`));
  const platform = partial.platform ?? process.platform;

  if (!SUPPORTED.includes(platform)) {
    error(PLATFORM_MESSAGE);
    return 1;
  }

  // Ctrl-C between prompts (for example while Java runs) arrives as SIGINT. Without a handler Node
  // would exit at once and skip the flow's cleanup. With it, the call in progress settles (Java gets
  // the same SIGINT and exits), and every later step refuses to start. A second Ctrl-C exits at once.
  let interrupted = false;
  const abort = new AbortController();
  const onSigint = () => {
    if (interrupted) {
      error('Stopping now.');
      process.exit(130);
    }
    interrupted = true;
    abort.abort();
  };
  const guard = () => {
    if (interrupted) throw new Interrupted();
  };
  const guarded = <A extends unknown[], R>(fn: (...args: A) => Promise<R>) =>
    async (...args: A): Promise<R> => {
      guard();
      return fn(...args);
    };

  const secrets: string[] = [];
  const scrub = scrubber(secrets);

  // Ctrl-C cancels reads at once. A POST is left to finish, so the user is never told a registration
  // was cancelled when the network may already have it.
  const fetchFn: typeof fetch = (url, init) => {
    if (init?.method && init.method !== 'GET') return fetch(url, init);
    return fetch(url, {...init, signal: init?.signal ? AbortSignal.any([init.signal, abort.signal]) : abort.signal});
  };

  const store = partial.store ?? makeAccountStore(DEFAULT_ROOT);
  const api = partial.api ?? makeApi(fetchFn);
  const wallet = partial.wallet ?? {showAddress, showId, createNodeParams};
  const prompts = partial.prompts ?? realPrompts();
  const sleep = partial.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  const flowDeps: Omit<Deps, 'jarPath'> = {
    store,
    log,
    api: {
      getNodeVersion: guarded(api.getNodeVersion),
      getBalance: guarded(api.getBalance),
      getEpoch: guarded(api.getEpoch),
      getRegistration: guarded(api.getRegistration),
      postRegistration: guarded(api.postRegistration),
    },
    wallet: {
      showAddress: guarded(wallet.showAddress),
      showId: guarded(wallet.showId),
      createNodeParams: guarded(wallet.createNodeParams),
    },
    prompts: {
      secret: guarded(async (message: string, validate?: (v: string) => true | string) => {
        const value = await prompts.secret(message, validate);
        secrets.push(value);
        return value;
      }),
      text: guarded(prompts.text),
      confirm: guarded(prompts.confirm),
      select: guarded(prompts.select) as Deps['prompts']['select'],
    },
    sleep: guarded(
      (ms: number) =>
        new Promise<void>((resolve, reject) => {
          const onAbort = () => reject(new Interrupted());
          abort.signal.addEventListener('abort', onAbort, {once: true});
          sleep(ms)
            .finally(() => abort.signal.removeEventListener('abort', onAbort))
            .then(resolve, reject);
        }),
    ),
  };

  process.on('SIGINT', onSigint);
  try {
    await (partial.checkJava ?? checkJava)();
    guard();
    const jarPath = await (partial.ensureWalletJar ?? ensureWalletJar)({
      api: flowDeps.api,
      fetchFn,
      cacheDir: store.jarCacheDir(),
      warn: log,
    });
    guard();
    const deps: Deps = {...flowDeps, jarPath};
    const account = await chooseAccount(deps);
    await registerOrEdit(deps, account);
    return 0;
  } catch (e) {
    if (interrupted || isExitPrompt(e)) {
      error('Cancelled.');
      return 130;
    }
    if (isKnown(e)) {
      error(scrub(e.message));
      return 1;
    }
    error('The tool stopped because of an error:');
    error(scrub(e instanceof Error ? e.message : String(e), {anyHex: true}));
    return 1;
  } finally {
    process.off('SIGINT', onSigint);
  }
}

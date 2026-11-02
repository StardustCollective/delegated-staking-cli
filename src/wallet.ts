import {execFile} from 'node:child_process';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

export type KeyContext = {jarPath: string; keystorePath: string; password: string};

export class WrongPasswordError extends Error {
  constructor() {
    super('Wrong password for this account.');
    this.name = 'WrongPasswordError';
  }
}

export class WalletError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'WalletError';
  }
}

type RunResult = {stdout: string; stderr: string; code: number | null; spawnError?: NodeJS.ErrnoException};

// On Linux the JVM decodes command-line arguments using the locale, so a C/POSIX locale
// would mangle non-ASCII names. macOS always decodes them as UTF-8.
export function buildChildEnv(
  ctx: KeyContext,
  base: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    CL_KEYSTORE: ctx.keystorePath,
    CL_KEYALIAS: 'alias',
    CL_PASSWORD: ctx.password,
    CL_APP_ENV: 'mainnet',
  };
  if (platform === 'linux') {
    const locale = base.LC_ALL || base.LC_CTYPE || base.LANG || '';
    if (!/utf-?8/i.test(locale)) env.LC_ALL = 'C.UTF-8';
  }
  return env;
}

function run(ctx: KeyContext, args: string[], cwd: string): Promise<RunResult> {
  return new Promise((resolve) => {
    execFile(
      'java',
      ['-jar', ctx.jarPath, ...args],
      {env: buildChildEnv(ctx), cwd, encoding: 'utf8', maxBuffer: 10 * 1024 * 1024},
      (err, stdout, stderr) => {
        const e = err as (NodeJS.ErrnoException & {code?: number | string}) | null;
        if (!e) return resolve({stdout, stderr, code: 0});
        if (typeof e.code === 'string') return resolve({stdout, stderr, code: null, spawnError: e});
        resolve({stdout, stderr, code: typeof e.code === 'number' ? e.code : 1});
      },
    );
  });
}

function scrub(text: string, ctx: KeyContext): string {
  let t = text;
  if (ctx.password) t = t.split(ctx.password).join('[redacted]');
  return t.replace(/\b[0-9a-fA-F]{64}\b/g, '[redacted]');
}

function fail(r: RunResult, ctx: KeyContext, what: string): never {
  if (r.spawnError) {
    if (r.spawnError.code === 'ENOENT') throw new WalletError('Java was not found. Install Java 21 or newer and try again.');
    throw new WalletError(`Could not run Java (${r.spawnError.code}).`);
  }
  const all = `${r.stdout}\n${r.stderr}`;
  if (/mac invalid/i.test(all)) throw new WrongPasswordError();
  const lines = scrub(all, ctx)
    .split('\n')
    .map((l) => l.trim())
    .filter((l) => l && !/^at\s/.test(l) && !/^\.\.\. \d+ more/.test(l));
  const detail = (lines[0] ?? `exit code ${r.code}`).slice(0, 200);
  throw new WalletError(`wallet.jar ${what} failed: ${detail}`);
}

async function runForLastLine(ctx: KeyContext, cmd: string): Promise<string> {
  const r = await run(ctx, [cmd], process.cwd());
  if (r.code !== 0) fail(r, ctx, cmd);
  const last = r.stdout.split('\n').map((l) => l.trim()).filter(Boolean).pop();
  if (!last) throw new WalletError(`wallet.jar ${cmd} printed nothing.`);
  return last;
}

export const showAddress = (ctx: KeyContext): Promise<string> => runForLastLine(ctx, 'show-address');
export const showId = (ctx: KeyContext): Promise<string> => runForLastLine(ctx, 'show-id');

export async function createNodeParams(
  ctx: KeyContext,
  input: {name: string; description: string; parent: {hash: string; ordinal: number}},
): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'dsc-'));
  try {
    await fs.chmod(dir, 0o700);
    await fs.writeFile(path.join(dir, 'parent.json'), JSON.stringify(input.parent), {mode: 0o600});
    const r = await run(
      ctx,
      ['create-node-params', '--reward-fraction', '0.1', '--name', input.name, '--description', input.description, '-p', 'parent.json'],
      dir,
    );
    if (r.code !== 0) fail(r, ctx, 'create-node-params');
    try {
      return await fs.readFile(path.join(dir, 'event'), 'utf8');
    } catch {
      throw new WalletError('wallet.jar create-node-params did not write a signed request.');
    }
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

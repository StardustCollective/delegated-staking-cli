import { chmod, link, mkdir, open, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';

export const DEFAULT_ROOT = join(homedir(), '.delegated-staking-cli');

const ADDRESS_RE = /^DAG[0-9][1-9A-HJ-NP-Za-km-z]{36}$/;

export class InvalidAddressError extends Error {
  constructor(address: string) {
    super(`Not a valid DAG address: ${JSON.stringify(address)}`);
    this.name = 'InvalidAddressError';
  }
}

export class AccountExistsError extends Error {
  constructor(address: string) {
    super(`A saved key already exists for ${address}`);
    this.name = 'AccountExistsError';
  }
}

function check(address: string): string {
  if (typeof address !== 'string' || !ADDRESS_RE.test(address)) {
    throw new InvalidAddressError(String(address));
  }
  return address;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw err;
  }
}

async function privateDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await chmod(path, 0o700);
}

export function makeAccountStore(rootDir: string) {
  const accountDir = (address: string) => join(rootDir, check(address));
  const keystorePath = (address: string) => join(accountDir(address), 'key.p12');

  return {
    keystorePath,

    jarCacheDir: () => join(rootDir, 'jars'),

    async list(): Promise<string[]> {
      let entries;
      try {
        entries = await readdir(rootDir, { withFileTypes: true });
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw err;
      }
      const found: string[] = [];
      for (const e of entries) {
        if (!e.isDirectory() || !ADDRESS_RE.test(e.name)) continue;
        if (await fileExists(join(rootDir, e.name, 'key.p12'))) found.push(e.name);
      }
      return found.sort();
    },

    async exists(address: string): Promise<boolean> {
      return fileExists(keystorePath(address));
    },

    async save(address: string, p12: Buffer, opts: { overwrite?: boolean } = {}): Promise<void> {
      const dir = accountDir(address);
      const target = keystorePath(address);
      await privateDir(rootDir);
      await privateDir(dir);

      const tmp = join(dir, `.key.p12.${randomBytes(6).toString('hex')}.tmp`);
      try {
        const fh = await open(tmp, 'wx', 0o600);
        try {
          await fh.writeFile(p12);
          await fh.sync();
        } finally {
          await fh.close();
        }
        if (opts.overwrite) {
          await rename(tmp, target);
        } else {
          // link() fails with EEXIST if the target exists, so a concurrent
          // save cannot be silently overwritten.
          try {
            await link(tmp, target);
          } catch (err) {
            if ((err as NodeJS.ErrnoException).code === 'EEXIST') throw new AccountExistsError(address);
            throw err;
          }
          await unlink(tmp);
        }
      } catch (err) {
        await rm(tmp, { force: true });
        throw err;
      }
    },

    async remove(address: string): Promise<void> {
      await rm(accountDir(address), { recursive: true, force: true });
    },
  };
}

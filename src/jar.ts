import {execFile} from 'node:child_process';
import {createHash, randomBytes} from 'node:crypto';
import {existsSync} from 'node:fs';
import {mkdir, readdir, rename, rm, writeFile} from 'node:fs/promises';
import {join} from 'node:path';

const RELEASES_URL = 'https://github.com/Constellation-Labs/tessellation/releases/download';
const MIN_JAVA = 21;
const VERSION_RE = /^\d+(\.\d+)*$/;

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SetupError';
  }
}

const JAVA_HELP =
  `Java ${MIN_JAVA} or newer is required.\n` +
  '  macOS: brew install --cask temurin@21\n' +
  '  Linux: install a package such as openjdk-21-jre with your package manager';

export function parseJavaMajor(versionOutput: string): number | null {
  const m = /version "(\d+)(?:\.(\d+))?/.exec(versionOutput);
  if (!m) return null;
  const first = Number(m[1]);
  // Java 8 and earlier report "1.8.0_x".
  return first === 1 && m[2] !== undefined ? Number(m[2]) : first;
}

export async function checkJava(): Promise<void> {
  const output = await new Promise<string>((resolve, reject) => {
    execFile('java', ['-version'], (err, stdout, stderr) => {
      if (err && (err as NodeJS.ErrnoException).code === 'ENOENT') {
        reject(new SetupError(`Java was not found. ${JAVA_HELP}`));
      } else {
        resolve(`${stderr}\n${stdout}`);
      }
    });
  });
  const major = parseJavaMajor(output);
  if (major === null) throw new SetupError(`Could not read the installed Java version. ${JAVA_HELP}`);
  if (major < MIN_JAVA) throw new SetupError(`Java ${major} is installed, which is too old. ${JAVA_HELP}`);
}

function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

async function newestCached(cacheDir: string): Promise<string | null> {
  let names: string[];
  try {
    names = await readdir(cacheDir);
  } catch {
    return null;
  }
  const versions = names.filter((n) => VERSION_RE.test(n) && existsSync(join(cacheDir, n, 'wallet.jar')));
  versions.sort(compareVersions);
  return versions.at(-1) ?? null;
}

async function download(fetchFn: typeof fetch, url: string): Promise<Buffer> {
  const res = await fetchFn(url);
  if (!res.ok) throw new Error(`HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

export async function ensureWalletJar(deps: {
  api: {getNodeVersion(): Promise<string>};
  fetchFn: typeof fetch;
  cacheDir: string;
  warn(msg: string): void;
}): Promise<string> {
  const {api, fetchFn, cacheDir, warn} = deps;

  async function fallback(reason: string, cause?: unknown): Promise<string> {
    const cached = await newestCached(cacheDir);
    if (!cached) {
      const detail = cause instanceof Error ? ` (${cause.message})` : '';
      throw new SetupError(`${reason} and no wallet.jar is saved from an earlier run, so there is nothing to use${detail}.`);
    }
    warn(`${reason}. Using the saved wallet.jar for version ${cached} instead.`);
    return join(cacheDir, cached, 'wallet.jar');
  }

  let version: string;
  try {
    const raw = (await api.getNodeVersion()).trim().replace(/^v/, '');
    if (!VERSION_RE.test(raw)) throw new Error('unexpected version format');
    version = raw;
  } catch (e) {
    return fallback("The version mainnet is running could not be fetched", e);
  }

  const dir = join(cacheDir, version);
  const jarPath = join(dir, 'wallet.jar');
  if (existsSync(jarPath)) return jarPath;

  await mkdir(dir, {recursive: true, mode: 0o700});

  let jar: Buffer;
  let expected: string;
  warn(`Downloading wallet.jar ${version} (about 85 MB) from GitHub...`);
  try {
    const base = `${RELEASES_URL}/v${version}`;
    jar = await download(fetchFn, `${base}/cl-wallet.jar`);
    const hashText = (await download(fetchFn, `${base}/cl-wallet.sha256`)).toString('utf8');
    expected = (hashText.trim().split(/\s+/)[0] ?? '').toLowerCase();
  } catch (e) {
    // Ctrl-C: let it propagate so the caller reports "Cancelled." instead of falling back.
    if (e instanceof Error && e.name === 'AbortError') throw e;
    return fallback(`The wallet.jar for mainnet's version ${version} could not be downloaded`, e);
  }

  const actual = createHash('sha256').update(jar).digest('hex');
  if (actual !== expected) {
    throw new SetupError(`The downloaded wallet.jar for version ${version} failed its checksum check, so it was discarded. Try again later.`);
  }

  const tmp = join(dir, `.wallet.jar.${randomBytes(6).toString('hex')}.tmp`);
  try {
    await writeFile(tmp, jar, {mode: 0o600});
    await rename(tmp, jarPath);
  } catch (e) {
    await rm(tmp, {force: true});
    throw e;
  }
  return jarPath;
}

const BASE_URL = 'https://l0-lb-mainnet.constellationnetwork.io';
const TIMEOUT_MS = 15_000;
const UNITS_PER_DAG = 100_000_000;
const MINIMUM_CHANGE_EPOCH = 2_954_500;

export type Ref = {hash: string; ordinal: number};
export type Registration = {name: string; description: string; lastRef: Ref};
export type PostResult = {ok: true; hash: string} | {ok: false; message: string};

export class NetworkError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'NetworkError';
  }
}

type Json = Record<string, any>;

const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null;

export function makeApi(fetchFn: typeof fetch = fetch) {
  async function request(path: string, init: RequestInit = {}): Promise<Response> {
    try {
      return await fetchFn(`${BASE_URL}${path}`, {...init, signal: AbortSignal.timeout(TIMEOUT_MS)});
    } catch (e) {
      const timedOut = e instanceof Error && (e.name === 'TimeoutError' || e.name === 'AbortError');
      throw new NetworkError(timedOut ? 'The request to the Constellation network timed out.' : 'Could not reach the Constellation network.');
    }
  }

  async function readJson(res: Response, what: string): Promise<Json> {
    let body: unknown;
    try {
      body = await res.json();
    } catch {
      throw new NetworkError(`The network returned an unreadable response for ${what}.`);
    }
    if (!isObject(body)) throw new NetworkError(`The network returned an unexpected response for ${what}.`);
    return body;
  }

  async function getJson(path: string, what: string): Promise<Json> {
    const res = await request(path);
    if (!res.ok) throw new NetworkError(`The network returned status ${res.status} for ${what}.`);
    return readJson(res, what);
  }

  const bad = (what: string) => new NetworkError(`The network returned an unexpected response for ${what}.`);
  const isRef = (v: unknown): v is Ref => isObject(v) && typeof v.hash === 'string' && Number.isInteger(v.ordinal);

  return {
    async getNodeVersion(): Promise<string> {
      const body = await getJson('/node/info', 'the node version');
      if (typeof body.version !== 'string') throw bad('the node version');
      return body.version;
    },

    async getBalance(address: string): Promise<number> {
      const body = await getJson(`/dag/${encodeURIComponent(address)}/balance`, 'the balance');
      if (typeof body.balance !== 'number') throw bad('the balance');
      return body.balance;
    },

    async getEpoch(): Promise<number> {
      const body = await getJson('/global-snapshots/latest', 'the current epoch');
      const epoch = body.value?.epochProgress;
      if (typeof epoch !== 'number') throw bad('the current epoch');
      return epoch;
    },

    // Only a 404 means "not registered". Any other failure stops the run.
    async getRegistration(id: string): Promise<Registration | null> {
      const res = await request(`/node-params/${encodeURIComponent(id)}`);
      if (res.status === 404) return null;
      if (!res.ok) throw new NetworkError(`The network returned status ${res.status} for the registration lookup.`);
      const body = await readJson(res, 'the registration lookup');
      const meta = body.latest?.value?.nodeMetadataParameters;
      if (!isObject(meta) || typeof meta.name !== 'string' || typeof meta.description !== 'string' || !isRef(body.lastRef)) {
        throw bad('the registration lookup');
      }
      return {name: meta.name, description: meta.description, lastRef: {hash: body.lastRef.hash, ordinal: body.lastRef.ordinal}};
    },

    async postRegistration(event: string): Promise<PostResult> {
      const res = await request('/node-params', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: event});
      if (res.status === 400) return {ok: false, message: await res.text()};
      if (!res.ok) throw new NetworkError(`The network returned status ${res.status} for the registration.`);
      const body = await readJson(res, 'the registration');
      if (typeof body.hash !== 'string') throw bad('the registration');
      return {ok: true, hash: body.hash};
    },
  };
}

export function minimumBalance(epoch: number): number {
  return (epoch < MINIMUM_CHANGE_EPOCH ? 250_000 : 1_000_000) * UNITS_PER_DAG;
}

export function formatDag(units: number): string {
  const whole = Math.floor(units / UNITS_PER_DAG);
  const frac = String(units - whole * UNITS_PER_DAG).padStart(8, '0').replace(/0+$/, '');
  const wholeText = whole.toLocaleString('en-US');
  return `${frac ? `${wholeText}.${frac}` : wholeText} DAG`;
}

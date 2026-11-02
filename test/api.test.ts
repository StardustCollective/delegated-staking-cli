import {describe, expect, test} from 'vitest';
import {formatDag, makeApi, minimumBalance, NetworkError} from '../src/api.js';

const ID = '0174825ea2f952d7795475b690ffcc9960c486e7809fa9973e9db42cfc4f6360890d80a0e9a2363a5acf6c04cc188fa6405fae4bfdb9055b7361e0bbfe78941c';

// Trimmed copy of a real mainnet GET /node-params/{id} response (2026-11-02).
const REAL_REGISTRATION = {
  latest: {
    value: {
      source: 'DAG3Dq8e6hYrs1DQbxB3ZFD7nv7yAD7SpmsdcsMm',
      delegatedStakeRewardParameters: {rewardFraction: 5000000},
      nodeMetadataParameters: {name: 'Benny', description: 'Short description'},
      parent: {ordinal: 0, hash: '0'.repeat(64)},
    },
    proofs: [{id: ID, signature: '3045'}],
  },
  lastRef: {ordinal: 1, hash: 'd3fd2d952f6a6f50ab726e22da9b1e3e96693294df222a1ce98565fd01619167'},
  acceptedOrdinal: 4514104,
};

type Calls = {url: string; init?: RequestInit}[];
function fakeFetch(status: number, body: string, calls: Calls = []): typeof fetch {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push({url: String(url), init});
    return new Response(body, {status});
  }) as typeof fetch;
}
const api = (status: number, body: unknown = '', calls?: Calls) =>
  makeApi(fakeFetch(status, typeof body === 'string' ? body : JSON.stringify(body), calls));

describe('getRegistration', () => {
  test('returns null only on 404', async () => {
    expect(await api(404).getRegistration(ID)).toBeNull();
    for (const s of [500, 503]) await expect(api(s).getRegistration(ID)).rejects.toBeInstanceOf(NetworkError);
  });
  test('maps name, description and lastRef from latest.value', async () => {
    const calls: Calls = [];
    expect(await api(200, REAL_REGISTRATION, calls).getRegistration(ID)).toEqual({
      name: 'Benny',
      description: 'Short description',
      lastRef: REAL_REGISTRATION.lastRef,
    });
    expect(calls[0].url).toBe(`https://l0-lb-mainnet.constellationnetwork.io/node-params/${ID}`);
  });
  test('non-JSON or wrongly shaped 200 becomes NetworkError', async () => {
    await expect(api(200, 'not json').getRegistration(ID)).rejects.toBeInstanceOf(NetworkError);
    await expect(api(200, {latest: {}}).getRegistration(ID)).rejects.toBeInstanceOf(NetworkError);
  });
});

describe('postRegistration', () => {
  test('returns hash on 200 and sends JSON', async () => {
    const calls: Calls = [];
    expect(await api(200, {hash: 'abc'}, calls).postRegistration('EVENT')).toEqual({ok: true, hash: 'abc'});
    expect(calls[0].url).toBe('https://l0-lb-mainnet.constellationnetwork.io/node-params');
    expect(calls[0].init?.method).toBe('POST');
    expect(calls[0].init?.body).toBe('EVENT');
    expect(new Headers(calls[0].init?.headers).get('content-type')).toBe('application/json');
  });
  test('returns the server text on 400', async () => {
    const text = '{"errors":[{"InsufficientRegistrationBalance":{}}]}';
    expect(await api(400, text).postRegistration('E')).toEqual({ok: false, message: text});
  });
  test('throws NetworkError on 503 and non-JSON 200', async () => {
    await expect(api(503, 'down').postRegistration('E')).rejects.toBeInstanceOf(NetworkError);
    await expect(api(200, 'oops').postRegistration('E')).rejects.toBeInstanceOf(NetworkError);
    await expect(api(200, {nohash: 1}).postRegistration('E')).rejects.toBeInstanceOf(NetworkError);
  });
  test('NetworkError never includes the request body', async () => {
    const err = await api(503, 'down').postRegistration('SECRET-EVENT').catch((e) => e);
    expect(err.message).not.toContain('SECRET-EVENT');
    expect(err.message).not.toContain('\n');
  });
});

describe('network failures', () => {
  test('fetch failure and timeout become NetworkError', async () => {
    const boom = makeApi((async () => { throw new TypeError('fetch failed'); }) as typeof fetch);
    await expect(boom.getEpoch()).rejects.toBeInstanceOf(NetworkError);
    await expect(boom.postRegistration('E')).rejects.toBeInstanceOf(NetworkError);
    const timeout = makeApi((async () => { throw new DOMException('timed out', 'TimeoutError'); }) as typeof fetch);
    await expect(timeout.getNodeVersion()).rejects.toBeInstanceOf(NetworkError);
  });
  test('passes an abort signal', async () => {
    const calls: Calls = [];
    await api(200, {version: '3.6.2'}, calls).getNodeVersion();
    expect(calls[0].init?.signal).toBeInstanceOf(AbortSignal);
  });
});

describe('simple reads', () => {
  test('getNodeVersion reads version', async () => {
    expect(await api(200, {version: '3.6.2'}).getNodeVersion()).toBe('3.6.2');
  });
  test('getBalance reads balance from the address path', async () => {
    const calls: Calls = [];
    expect(await api(200, {ordinal: 1, balance: 12345}, calls).getBalance('DAG1')).toBe(12345);
    expect(calls[0].url).toBe('https://l0-lb-mainnet.constellationnetwork.io/dag/DAG1/balance');
  });
  test('getEpoch reads value.epochProgress', async () => {
    expect(await api(200, {value: {epochProgress: 2938528}}).getEpoch()).toBe(2938528);
  });
  test('wrongly shaped bodies become NetworkError', async () => {
    await expect(api(200, {}).getBalance('DAG1')).rejects.toBeInstanceOf(NetworkError);
    await expect(api(200, {}).getEpoch()).rejects.toBeInstanceOf(NetworkError);
    await expect(api(200, {}).getNodeVersion()).rejects.toBeInstanceOf(NetworkError);
  });
});

test('minimumBalance', () => {
  expect(minimumBalance(2_954_499)).toBe(250_000e8);
  expect(minimumBalance(2_954_500)).toBe(1_000_000e8);
});

test('formatDag', () => {
  expect(formatDag(250_000e8)).toBe('250,000 DAG');
  expect(formatDag(1_000_000e8)).toBe('1,000,000 DAG');
  expect(formatDag(0)).toBe('0 DAG');
  expect(formatDag(150_000_000)).toBe('1.5 DAG');
  expect(formatDag(1)).toBe('0.00000001 DAG');
  expect(formatDag(1234_56789012)).toBe('1,234.56789012 DAG');
});

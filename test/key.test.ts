import {expect, test} from 'vitest';
import {InvalidKeyError, base58Encode, buildP12, deriveAddress, normalizePrivateKey, validatePassword} from '../src/key.js';

const K = '11'.repeat(32);

test('accepts surrounding whitespace, 0x and uppercase', () => {
  for (const v of [K, ` ${K}\n`, `0x${K}`, K.toUpperCase()]) expect(normalizePrivateKey(v)).toBe(K);
});

test('rejects bad input without echoing it', () => {
  const curveOrder = 'fffffffffffffffffffffffffffffffebaaedce6af48a03bbfd25e8cd0364141';
  for (const v of ['', 'abc', '11'.repeat(31), 'zz'.repeat(32), '00'.repeat(32), 'ff'.repeat(32), curveOrder]) {
    expect(() => normalizePrivateKey(v)).toThrow(InvalidKeyError);
    try { normalizePrivateKey(v) } catch (e) { if (v) expect(String(e)).not.toContain(v) }
  }
});

test('deriveAddress gives the known address for a fixed key', () => {
  expect(deriveAddress(K)).toMatch(/^DAG/);
  expect(deriveAddress(K)).toBe('DAG34CEZdkmwK9dQu3h5pCYZ7GZGf5x24ULKsQEP');
});

test('buildP12 returns DER with the key encrypted', async () => {
  const p12 = await buildP12(K, 'pw-Test 1');
  expect(p12[0]).toBe(0x30);
  expect(p12.includes(Buffer.from(K, 'hex'))).toBe(false);
});

test('validatePassword', () => {
  expect(validatePassword('short')).not.toBe(true);
  expect(validatePassword('pässwörd-long')).not.toBe(true);
  expect(validatePassword(`it's a "good" one`)).toBe(true);
});

test('base58Encode known vectors', () => {
  expect(base58Encode(new Uint8Array([]))).toBe('');
  expect(base58Encode(Buffer.from('00', 'hex'))).toBe('1');
  expect(base58Encode(Buffer.from('0000', 'hex'))).toBe('11');
  expect(base58Encode(Buffer.from('00000102', 'hex'))).toBe('11' + base58Encode(Buffer.from('0102', 'hex')));
  expect(base58Encode(Buffer.from('0102', 'hex'))).toBe('5T');
  expect(base58Encode(Buffer.from('hello world'))).toBe('StV1DL6CwTryKyV');
});

// Sends one registration from a freshly generated, unfunded random key to mainnet and checks
// that the server rejects it only for InsufficientRegistrationBalance. That proves the P12
// conversion and signing satisfy the server. Nothing is registered.
// Usage: npx tsx scripts/rejected-mainnet-test.ts [path to save the raw error text]
import {randomBytes} from 'node:crypto';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {makeApi} from '../src/api.js';
import {buildP12, deriveAddress} from '../src/key.js';
import {createNodeParams, showAddress, showId} from '../src/wallet.js';

const ZERO_PARENT = {hash: '0'.repeat(64), ordinal: 0};
const jarPath = path.resolve(import.meta.dirname, '../.test-jars/cl-wallet.jar');

// The server answers 400 with a JSON string such as
// "InsufficientRegistrationBalance{source=...,balance=0,minimum=...}". Each error is a name followed by "{".
function errorNames(message: string): string[] {
  return message.match(/[A-Z][A-Za-z]*(?=\{)/g) ?? [];
}

async function main(): Promise<number> {
  const savePath = process.argv[2];
  const key = randomBytes(32).toString('hex');
  const password = randomBytes(16).toString('hex');
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'rejected-test-'));
  try {
    await fs.chmod(dir, 0o700);
    const keystorePath = path.join(dir, 'key.p12');
    await fs.writeFile(keystorePath, await buildP12(key, password), {mode: 0o600});
    const ctx = {jarPath, keystorePath, password};

    const address = await showAddress(ctx);
    if (address !== deriveAddress(key)) throw new Error('wallet.jar address does not match the derived address');
    console.log(`Address: ${address}`);
    console.log(`Id: ${await showId(ctx)}`);

    const event = await createNodeParams(ctx, {name: 'rejection-test', description: 'rejection-test', parent: ZERO_PARENT});
    const result = await makeApi().postRegistration(event);
    if (result.ok) {
      console.log(`UNEXPECTED: the server accepted the request, hash ${result.hash}`);
      return 1;
    }
    console.log('Status: 400');
    console.log(`Response: ${result.message}`);
    if (savePath) await fs.writeFile(savePath, result.message);

    const names = errorNames(result.message);
    if (names.length === 1 && names[0] === 'InsufficientRegistrationBalance') {
      console.log('OK: rejected with InsufficientRegistrationBalance only.');
      return 0;
    }
    console.log(`FAIL: expected only InsufficientRegistrationBalance, got [${names.join(', ')}]`);
    return 1;
  } finally {
    await fs.rm(dir, {recursive: true, force: true});
  }
}

main().then(
  (code) => process.exit(code),
  (e) => {
    console.error(`FAIL: ${e instanceof Error ? `${e.name}: ${e.message}` : 'unknown error'}`);
    process.exit(1);
  },
);

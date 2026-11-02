# Delegated Staking CLI Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build an interactive mainnet-only CLI that registers a Stargazer account for delegated staking, and edits that registration, without a node.

**Architecture:** A small TypeScript program. Plain modules cover key conversion, `wallet.jar` calls, the mainnet HTTP API and saved accounts. A flow layer ties them together and receives its dependencies as arguments, so it can be tested without a network or a terminal.

**Tech Stack:** TypeScript (ESM, NodeNext), Node ≥ 22, `pkijs` + `asn1js` (P12), `@stardust-collective/dag4-keystore` (address check), `@inquirer/prompts`, `vitest`.

**Spec:** `docs/superpowers/specs/2026-11-02-delegated-staking-cli-design.md`. Read it first. It holds the network facts and the reasons behind these decisions.

## Global Constraints

- Mainnet only, at `https://l0-lb-mainnet.constellationnetwork.io`. No network flag and no fallback to a source node.
- No commission prompt. Always sign with `--reward-fraction 0.1`.
- A balance under the minimum warns and still sends. Only the server rejects.
- Read the private key and password only from hidden prompts. Add no flags or environment variables for them.
- Never write the unencrypted key to disk, and never put the key or password in command-line arguments, logs or error text.
- Pass the password to child processes through environment variables only: `CL_KEYSTORE`, `CL_KEYALIAS=alias`, `CL_PASSWORD`, `CL_APP_ENV=mainnet`.
- macOS and Linux only. Windows users are pointed to WSL.
- Java 21 or newer.
- Saved files: `~/.delegated-staking-cli/` and each account directory are mode `0700`, and `key.p12` is mode `0600`.
- Never overwrite a saved P12 without asking.
- The build stops at a tested release candidate. Do not run `npm publish`, and do not submit a real registration. Frank runs those.
- Commit on the current branch with pathspec-scoped commits. Do not create a branch unless asked.
- **Deadline:** the first release should be out before the minimum rises around 2026-11-14. Tasks 1–3 prove the risky path first. If time runs short, drop the optional items marked in Task 6.

## Review Focus

1. A pasted key with surrounding spaces, a newline, a `0x` prefix or uppercase letters should work and give the same address (Task 1).
2. A server `503` or `500` on `GET /node-params/{id}` must stop the run, not be treated as "not registered". Otherwise a real account gets a false new-registration flow and a confusing `InvalidParent` (Task 3 and Task 6).
3. A wrong password on a saved account should say so and let the user retry, with no Java stack trace (Task 2 and Task 6).
4. Ctrl-C at any prompt should exit cleanly with no stack trace, no half-saved account and no temp directory left behind (Task 6 and Task 7).
5. A name containing an apostrophe, double quote or non-ASCII character should reach the signed request unchanged (Task 2).

---

### Task 1: Project setup and key conversion

**Files:**
- Create: `package.json`, `tsconfig.json`, `.gitignore`, `vitest.config.ts`, `CLAUDE.md`
- Create: `src/key.ts`
- Test: `test/key.test.ts`
- Commit also: `README.md`, `LICENSE`, `docs/` (already written, not yet committed)

**Interfaces:**
- Produces:
  - `normalizePrivateKey(input: string): string`: returns 64 lowercase hex characters, or throws `InvalidKeyError` whose message never contains the input.
  - `deriveAddress(hex: string): string`: the DAG address.
  - `buildP12(hex: string, password: string): Promise<Buffer>`
  - `validatePassword(password: string): true | string`: for the prompt library.

- [ ] **Step 1: Set up the project**

Use npm, so the lockfile is `package-lock.json`. `package.json`: name `@stardust-collective/delegated-staking-cli`, `"type": "module"`, `"license": "MIT"`, `bin` `{"delegated-staking-cli": "dist/cli.js"}`, `engines.node >=22`, `files` `["dist"]`, repository `StardustCollective/delegated-staking-cli`, dev dependencies including `typescript`, `vitest` and `tsx`. Scripts: `build` (`tsc`), `test` (`vitest run --exclude test/integration`), `test:integration` (`vitest run test/integration`). TypeScript strict, NodeNext. `.gitignore`: `node_modules`, `dist`, `.test-jars`.

`CLAUDE.md`: a short note that this is a temporary tool, a pointer to the spec and this plan, and the key-handling rules from Global Constraints.

- [ ] **Step 2: Write the failing tests**

```ts
const K = '11'.repeat(32);
test('accepts surrounding whitespace, 0x and uppercase', () => {
  for (const v of [K, ` ${K}\n`, `0x${K}`, K.toUpperCase()]) expect(normalizePrivateKey(v)).toBe(K);
});
test('rejects bad input without echoing it', () => {
  for (const v of ['', 'abc', '11'.repeat(31), 'zz'.repeat(32), '00'.repeat(32)]) {
    expect(() => normalizePrivateKey(v)).toThrow(InvalidKeyError);
    try { normalizePrivateKey(v) } catch (e) { if (v) expect(String(e)).not.toContain(v) }
  }
});
test('deriveAddress matches dag4', () => { expect(deriveAddress(K)).toMatch(/^DAG/) });
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
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run test/key.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 4: Implement `src/key.ts`**

`normalizePrivateKey` also rejects the all-zero key. `deriveAddress` uses `keyStore.getDagAddressFromPrivateKey`. `validatePassword` requires at least 8 printable ASCII characters. Non-ASCII passwords are rejected because they have not been tested with `wallet.jar`.

`buildP12` uses the code below, which passed a throwaway-key test on 2026-11-02 against the v3.6.2 JARs: address match, `keytool.jar export` match, and signing. Three details are required, and each one failed without it:
- `notAfter` must be GeneralizedTime, because `asn1js` rejects UTCTime after 2049.
- Both bags need the `localKeyId` attribute, or `wallet.jar` finds no certificate and throws a `NullPointerException`.
- The inner key must include the public key (`3074…`), or `keytool.jar export` returns the wrong format. `pkijs` can't parse this form for secp256k1, so build `PrivateKeyInfo` directly as shown.

```ts
pkijs.setEngine('node', new pkijs.CryptoEngine({name: 'node', crypto: crypto.webcrypto}));
const ab = (b: Buffer) => b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;

const ecdh = crypto.createECDH('secp256k1'); ecdh.setPrivateKey(hex, 'hex');
const sec1 = Buffer.from(`30740201010420${hex}a00706052b8104000aa144034200${ecdh.getPublicKey('hex', 'uncompressed')}`, 'hex');
const priv = crypto.createPrivateKey({key: sec1, format: 'der', type: 'sec1'});
const pub = crypto.createPublicKey(priv);

const cert = new pkijs.Certificate();
cert.version = 2;
cert.serialNumber = new asn1js.Integer({valueHex: ab(Buffer.concat([Buffer.from([1]), crypto.randomBytes(7)]))});
const dn = () => [
  new pkijs.AttributeTypeAndValue({type: '2.5.4.3', value: new asn1js.Utf8String({value: 'constellationnetwork.io'})}),
  new pkijs.AttributeTypeAndValue({type: '2.5.4.10', value: new asn1js.Utf8String({value: 'Constellation Labs'})}),
];
cert.issuer.typesAndValues = dn();
cert.subject.typesAndValues = dn();
cert.notBefore.value = new Date();
cert.notAfter = new pkijs.Time({type: 1, value: new Date(Date.now() + 365000 * 864e5)});
cert.subjectPublicKeyInfo = new pkijs.PublicKeyInfo({schema: asn1js.fromBER(ab(pub.export({format: 'der', type: 'spki'}) as Buffer)).result});
const alg = () => new pkijs.AlgorithmIdentifier({algorithmId: '1.2.840.10045.4.3.4'}); // ecdsa-with-SHA512
cert.signature = alg();
cert.signatureAlgorithm = alg();
const tbs = Buffer.from(cert.encodeTBS().toBER(false));
cert.tbsView = new Uint8Array(tbs);
cert.signatureValue = new asn1js.BitString({valueHex: ab(crypto.sign('sha512', tbs, priv))});

const certDer = Buffer.from(cert.toSchema(true).toBER(false));
const attrs = () => [
  new pkijs.Attribute({type: '1.2.840.113549.1.9.20', values: [new asn1js.BmpString({value: 'alias'})]}),
  new pkijs.Attribute({type: '1.2.840.113549.1.9.21', values: [new asn1js.OctetString({valueHex: ab(crypto.createHash('sha1').update(certDer).digest())})]}),
];

const pkcs8 = new pkijs.PrivateKeyInfo();
pkcs8.version = 0;
pkcs8.privateKeyAlgorithm = new pkijs.AlgorithmIdentifier({algorithmId: '1.2.840.10045.2.1', algorithmParams: new asn1js.ObjectIdentifier({value: '1.3.132.0.10'})});
pkcs8.privateKey = new asn1js.OctetString({valueHex: ab(sec1)});

const pw = ab(Buffer.from(password, 'utf8'));
const enc = {password: pw, contentEncryptionAlgorithm: {name: 'AES-CBC', length: 256}, hmacHashAlgorithm: 'SHA-256', iterationCount: 100000};
const keyBag = new pkijs.PKCS8ShroudedKeyBag({parsedValue: pkcs8});
await keyBag.makeInternalValues(enc);

const pfx = new pkijs.PFX({parsedValue: {integrityMode: 0, authenticatedSafe: new pkijs.AuthenticatedSafe({parsedValue: {safeContents: [
  {privacyMode: 1, value: new pkijs.SafeContents({safeBags: [new pkijs.SafeBag({bagId: '1.2.840.113549.1.12.10.1.3', bagValue: new pkijs.CertBag({parsedValue: cert}), bagAttributes: attrs()})]})},
  {privacyMode: 0, value: new pkijs.SafeContents({safeBags: [new pkijs.SafeBag({bagId: '1.2.840.113549.1.12.10.1.2', bagValue: keyBag, bagAttributes: attrs()})]})},
]}})}});
await pfx.parsedValue.authenticatedSafe.makeInternalValues({safeContents: [enc, {}]});
await pfx.makeInternalValues({password: pw, iterations: 100000, pbkdf2HashAlgorithm: 'SHA-256', hmacHashAlgorithm: 'SHA-256'});
return Buffer.from(pfx.toSchema().toBER(false));
```

The spike ran as plain JavaScript, so TypeScript may need small type adjustments. Keep the behavior the same.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run test/key.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json tsconfig.json .gitignore vitest.config.ts CLAUDE.md LICENSE src/key.ts test/key.test.ts docs
git commit -m "feat: add project setup and in-process P12 conversion" -- package.json package-lock.json tsconfig.json .gitignore vitest.config.ts CLAUDE.md LICENSE README.md src/key.ts test/key.test.ts docs
```

### Task 2: Running `wallet.jar`

**Files:**
- Create: `src/wallet.ts`, `scripts/fetch-test-jars.sh`
- Test: `test/integration/wallet.test.ts`

**Interfaces:**
- Consumes: `buildP12`, `deriveAddress`.
- Produces:
  - `type KeyContext = {jarPath: string; keystorePath: string; password: string}`
  - `showAddress(ctx: KeyContext): Promise<string>`
  - `showId(ctx: KeyContext): Promise<string>`
  - `createNodeParams(ctx: KeyContext, input: {name: string; description: string; parent: {hash: string; ordinal: number}}): Promise<string>`: returns the signed request as a string.
  - `class WrongPasswordError extends Error`
  - `class WalletError extends Error`: its message is one scrubbed line, never a stack trace.

- [ ] **Step 1: Add the JAR fetch script**

`scripts/fetch-test-jars.sh` downloads `cl-wallet.jar` and `cl-keytool.jar` plus their `.sha256` files for release `v3.6.2` with `curl -fsSL` from `https://github.com/Constellation-Labs/tessellation/releases/download/v3.6.2/` into `.test-jars/`, and verifies each checksum. Each `.sha256` file holds only the hash. The `test:integration` script runs it first if the files are missing.

- [ ] **Step 2: Write the failing integration tests**

Use a fixed test key that is never funded, plus a random password that contains a space and an apostrophe.

```ts
test('address matches dag4', async () => expect(await showAddress(ctx)).toBe(deriveAddress(KEY)));
test('keytool export returns the original key', ...);   // run cl-keytool.jar export in a temp dir, read id_ecdsa.hex, expect KEY
test('signs a first registration', async () => {
  const e = JSON.parse(await createNodeParams(ctx, {name: 'Test', description: 'Desc', parent: ZERO}));
  expect(e.value.source).toBe(deriveAddress(KEY));
  expect(e.value.delegatedStakeRewardParameters.rewardFraction).toBe(10000000);
  expect(e.value.parent).toEqual(ZERO);
  expect(e.proofs).toHaveLength(1);
  expect(e.proofs[0].id).toBe(await showId(ctx));
});
test('keeps special characters in the name', async () => {
  const name = `It's "great" — Ünï`;
  const e = JSON.parse(await createNodeParams(ctx, {name, description: 'Desc', parent: ZERO}));
  expect(e.value.nodeMetadataParameters.name).toBe(name);
});
test('wrong password throws WrongPasswordError', async () => {
  await expect(showAddress({...ctx, password: 'wrong-password'})).rejects.toBeInstanceOf(WrongPasswordError);
});
test('no secrets in temp files or errors', ...);  // run createNodeParams, spy on the temp dir before cleanup and on errors; KEY, its bytes and the password must not appear
test('removes its temp directory, including after failure', ...);
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npm run test:integration`
Expected: FAIL, `src/wallet.ts` not found.

- [ ] **Step 4: Implement `src/wallet.ts`**

Use `child_process.execFile('java', ['-jar', jarPath, …], {env, cwd})`, with no shell. For `createNodeParams`, create a temp directory with `fs.mkdtemp`, write `parent.json`, run with `--reward-fraction 0.1 --name … --description … -p parent.json`, read `event`, and always remove the directory in `finally`.

Treat output containing `mac invalid` as `WrongPasswordError`. `show-address` and `show-id` print their result on the last line. Include `LC_ALL` in the child environment if the non-ASCII name test requires it.

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npm run test:integration`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add src/wallet.ts scripts/fetch-test-jars.sh test/integration/wallet.test.ts
git commit -m "feat: run wallet.jar without exposing secrets" -- src/wallet.ts scripts/fetch-test-jars.sh test/integration/wallet.test.ts
```

### Task 3: Mainnet API and the rejection test

This task proves the whole conversion path against the real network. **If the result isn't the expected one, stop and report it to Frank before continuing.**

**Files:**
- Create: `src/api.ts`, `scripts/rejected-mainnet-test.ts`
- Test: `test/api.test.ts`

**Interfaces:**
- Consumes: `buildP12`, `createNodeParams`, `showId`.
- Produces:
  - `type Registration = {name: string; description: string; lastRef: {hash: string; ordinal: number}}`
  - `type PostResult = {ok: true; hash: string} | {ok: false; message: string}`
  - `class NetworkError extends Error`
  - `makeApi(fetchFn: typeof fetch = fetch)`, returning:
    - `getNodeVersion(): Promise<string>`
    - `getBalance(address: string): Promise<number>`: in units of 1e-8 DAG.
    - `getEpoch(): Promise<number>`
    - `getRegistration(id: string): Promise<Registration | null>`
    - `postRegistration(event: string): Promise<PostResult>`
  - `minimumBalance(epoch: number): number`
  - `formatDag(units: number): string`

- [ ] **Step 1: Write the failing tests**

Use a fake `fetch` returning fixed responses.

```ts
test('getRegistration returns null only on 404', async () => {
  expect(await api(404).getRegistration(ID)).toBeNull();
  for (const s of [500, 503]) await expect(api(s).getRegistration(ID)).rejects.toBeInstanceOf(NetworkError);
});
test('getRegistration maps name, description and lastRef from latest.value', ...);
test('postRegistration returns hash on 200', ...);       // body {"hash":"abc"}, expect {ok: true, hash: 'abc'}
test('postRegistration returns the server text on 400', ...);  // expect {ok: false, message: <text>}
test('postRegistration throws NetworkError on 503 and non-JSON 200', ...);
test('fetch failure and timeout become NetworkError', ...);
test('getEpoch reads value.epochProgress', ...);
test('minimumBalance', () => {
  expect(minimumBalance(2_954_499)).toBe(250_000e8);
  expect(minimumBalance(2_954_500)).toBe(1_000_000e8);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/api.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/api.ts`**

Base URL `https://l0-lb-mainnet.constellationnetwork.io`. Requests time out after 15 seconds using `AbortSignal.timeout`. `POST /node-params` sends `Content-Type: application/json`.

Endpoints: `GET /node/info` (`version`), `GET /dag/{address}/balance` (`balance`), `GET /global-snapshots/latest` (`value.epochProgress`), `GET /node-params/{id}` (`latest.value.nodeMetadataParameters`, `lastRef`).

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/api.test.ts`
Expected: PASS.

- [ ] **Step 5: Write and run the rejection test against mainnet**

`scripts/rejected-mainnet-test.ts` generates a random key, builds a P12 in a temp directory, signs with the `.test-jars/` wallet JAR using name `rejection-test`, and sends the request with `postRegistration`. It prints the result and exits non-zero unless the response is a `400` with `InsufficientRegistrationBalance` as the only error. The key has no funds, so nothing is registered.

Run: `npx tsx scripts/rejected-mainnet-test.ts`
Expected: exit 0, with `InsufficientRegistrationBalance` printed.

Copy the exact error text into the test fixture for Task 6. Any error such as `InvalidSigned` means the conversion or signing doesn't satisfy the server, so stop and report it.

- [ ] **Step 6: Commit**

```bash
git add src/api.ts scripts/rejected-mainnet-test.ts test/api.test.ts
git commit -m "feat: add mainnet API and rejection test" -- src/api.ts scripts/rejected-mainnet-test.ts test/api.test.ts package.json
```

### Task 4: Java check and `wallet.jar` download

**Files:**
- Create: `src/jar.ts`
- Test: `test/jar.test.ts`

**Interfaces:**
- Consumes: `api.getNodeVersion()`.
- Produces:
  - `parseJavaMajor(versionOutput: string): number | null`
  - `checkJava(): Promise<void>`: throws `SetupError` with install instructions if Java is missing or older than 21.
  - `ensureWalletJar(deps: {api: {getNodeVersion(): Promise<string>}; fetchFn: typeof fetch; cacheDir: string; warn(msg: string): void}): Promise<string>`: returns the JAR path.
  - `class SetupError extends Error`

- [ ] **Step 1: Write the failing tests**

```ts
test('parseJavaMajor', () => {
  expect(parseJavaMajor('openjdk version "21.0.9" 2025-10-21')).toBe(21);
  expect(parseJavaMajor('java version "1.8.0_392"')).toBe(8);
  expect(parseJavaMajor('garbage')).toBeNull();
});
test('downloads, verifies and caches the version mainnet runs', ...);   // second call makes no fetch
test('a checksum mismatch throws SetupError, keeps no file and does not fall back', ...);
test('a 404 or failed download falls back to the newest cached version and warns', ...);  // cached 3.5.34 and 3.6.1: expect 3.6.1, comparing numerically
test('a failed version lookup also falls back', ...);
test('no cached version and a failed download throws SetupError', ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/jar.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/jar.ts`**

Download `https://github.com/Constellation-Labs/tessellation/releases/download/v{version}/cl-wallet.jar` and `cl-wallet.sha256`. Cache at `{cacheDir}/{version}/wallet.jar`. Write to a temp name in that directory, verify, then rename, so an interrupted download never looks valid. Use `semver` for version comparison only if a simple numeric comparison isn't enough.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/jar.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/jar.ts test/jar.test.ts
git commit -m "feat: fetch and verify the wallet.jar mainnet runs" -- src/jar.ts test/jar.test.ts
```

### Task 5: Saved accounts

**Files:**
- Create: `src/accounts.ts`
- Test: `test/accounts.test.ts`

**Interfaces:**
- Produces, as `makeAccountStore(rootDir: string)`:
  - `list(): Promise<string[]>`: saved addresses, sorted.
  - `keystorePath(address: string): string`
  - `exists(address: string): Promise<boolean>`
  - `save(address: string, p12: Buffer, opts?: {overwrite?: boolean}): Promise<void>`: throws `AccountExistsError` unless `overwrite` is set.
  - `remove(address: string): Promise<void>`
  - `jarCacheDir(): string`: `{rootDir}/jars`.
- `DEFAULT_ROOT`: `~/.delegated-staking-cli`.

- [ ] **Step 1: Write the failing tests**

```ts
test('save creates 0700 directories and a 0600 file', ...);  // check mode bits on root, account dir and key.p12
test('save tightens an existing root directory with wider permissions', ...);
test('save refuses to overwrite by default', ...);
test('save with overwrite leaves valid contents', ...);
test('list ignores the jars directory, stray files and empty account directories', ...);
test('remove deletes the account and leaves others', ...);
test('rejects an address that is not DAG + base58, including path traversal', ...);  // '../x'
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/accounts.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/accounts.ts`**

Write to a temporary name with mode `0600` in the account directory, then rename, so a crash can't leave a partial P12.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/accounts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/accounts.ts test/accounts.test.ts
git commit -m "feat: store encrypted key files per address" -- src/accounts.ts test/accounts.test.ts
```

### Task 6: Registration flow

**Files:**
- Create: `src/flow.ts`, `src/explain.ts`
- Test: `test/flow.test.ts`, `test/explain.test.ts`

**Interfaces:**
- Consumes: everything from Tasks 1–5.
- Produces:
  - `explainServerError(text: string): string`: a plain explanation followed by the original server text.
  - ```ts
    type Deps = {
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
    ```
  - `chooseAccount(deps: Deps): Promise<KeyContext & {address: string}>`
  - `registerOrEdit(deps: Deps, account: KeyContext & {address: string}): Promise<void>`
  - `deleteAccount(deps: Deps): Promise<void>`
  - `class SubmissionRejected extends Error`, whose message is the explained server error. The CLI maps it to exit code 1.

- [ ] **Step 1: Write the failing tests**

`explainServerError` covers these, using the exact `InsufficientRegistrationBalance` text recorded in Task 3: `InsufficientRegistrationBalance`, `InvalidParent`, `TooLargeName`, `TooLargeDescription`, `InvalidName`, `InvalidDescription`, `InvalidSigned`, `NodeNotInSeedList`, `InvalidRewardValue`, `InvalidProofsCount`. Unknown text is returned unchanged.

`test/flow.test.ts`, using fake dependencies:

```ts
// chooseAccount
test('new account: address shown and confirmed before saving', ...);
test('new account: declining the address saves nothing', ...);
test('new account: stops and saves nothing if wallet.jar and dag4 addresses differ', ...);
test('new account: asks before replacing an existing saved key', ...);
test('saved account: wrong password retries, then fails after 3 tries with a plain message', ...);

// registerOrEdit
test('new registration: 404 uses the zero parent', ...);  // hash of 64 zeros, ordinal 0
test('edit: prefills name and description and uses lastRef as parent', ...);
test('edit: unchanged name and description send nothing', ...);
test('server failure on the lookup stops the run and sends nothing', ...);   // Review Focus 2
test('balance under the minimum warns and still sends', ...);
test('balance or epoch lookup failure skips the warning and still sends', ...);
test('name and description require non-empty text, at most 140 characters', ...);
test('declining the summary sends nothing', ...);
test('400 throws SubmissionRejected with the explanation', ...);
test('success polls until the new values appear, then shows the staking page', ...);
test('poll timeout reports submitted but not yet visible, and does not throw', ...);
test('poll errors keep polling until the timeout', ...);
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/flow.test.ts test/explain.test.ts`
Expected: FAIL, modules not found.

- [ ] **Step 3: Implement `src/explain.ts` and `src/flow.ts`**

Follow the spec's "User flow". Exact values:

- Warning before the first key prompt: `Your private key controls your funds. Only use this tool from the official StardustCollective repository or npm package.`
- Staking page: `https://mainnet.dagexplorer.io/staking`
- Polling: every 10 seconds for up to 5 minutes. It succeeds when `latest` shows the submitted name and description, and, for an edit, a `lastRef` different from the one before.
- The new-account path builds the P12 in a temp directory, verifies the address with `wallet.showAddress`, asks the user to confirm, and only then calls `store.save`. Clear the temp directory in `finally`.

**If time runs short before the deadline, these can move to a follow-up release:** the `deleteAccount` menu option (the README must then say to remove the folder by hand), and the plain explanations for errors other than `InsufficientRegistrationBalance`. The rest is required.

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run test/flow.test.ts test/explain.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/flow.ts src/explain.ts test/flow.test.ts test/explain.test.ts
git commit -m "feat: add register and edit flow" -- src/flow.ts src/explain.ts test/flow.test.ts test/explain.test.ts
```

### Task 7: CLI entry point and release candidate

**Files:**
- Create: `src/cli.ts`, `src/run.ts`
- Modify: `README.md`
- Test: `test/run.test.ts`, `test/integration/key-safety.test.ts`

**Interfaces:**
- Consumes: `checkJava`, `ensureWalletJar`, `makeApi`, `makeAccountStore`, `chooseAccount`, `registerOrEdit`, `deleteAccount`.
- Produces: `run(deps?: Partial<Deps>): Promise<number>`, which returns the exit code. `cli.ts` is `#!/usr/bin/env node` and calls `process.exit(await run())`.

- [ ] **Step 1: Write the failing tests**

```ts
test('returns 0 on success', ...);
test('returns 1 and prints only the message for SubmissionRejected, NetworkError, SetupError and WalletError', ...); // no stack trace
test('Ctrl-C at a prompt returns 130 with no stack trace and saves nothing', ...);  // @inquirer ExitPromptError
test('unexpected errors print a generic message and scrub the key and password', ...);
test('rejects unsupported platforms with a WSL message', ...);  // process.platform === 'win32'
```

`test/integration/key-safety.test.ts`: run the compiled CLI as a child process through the new-account path using a fixed test key, with the `.test-jars/` wallet JAR copied into the temporary `HOME`'s JAR cache and an unreachable network, so the version lookup falls back to that cached copy. Capture stdout and stderr, and read every file under a temporary `HOME` and temp directory. Assert the key, its raw bytes and the password appear nowhere, and that `ps`-visible arguments never contain them (`createNodeParams` and `show-*` arguments are asserted through a spy on `execFile`).

- [ ] **Step 2: Run the tests to verify they fail**

Run: `npx vitest run test/run.test.ts`
Expected: FAIL, module not found.

- [ ] **Step 3: Implement `src/run.ts` and `src/cli.ts`**

Order: platform check, `checkJava`, `ensureWalletJar`, then a menu of saved accounts plus "Add an account" and "Delete a saved account", then `registerOrEdit`. Real prompts use `password` (with `mask` off), `input`, `confirm` and `select` from `@inquirer/prompts`. Non-secret messages go through a `log` function that writes to stdout.

- [ ] **Step 4: Run all tests and the build**

Run: `npm run build && npm test && npm run test:integration`
Expected: all pass, and `dist/cli.js` exists.

- [ ] **Step 5: Try the package as a user would**

Run: `npm pack`, install the `.tgz` in a temp directory, then run `npx delegated-staking-cli` with a throwaway key. Confirm the prompts appear, the address shows, and the summary appears. Decline at the summary, so nothing is sent.

- [ ] **Step 6: Update the README**

Keep the "in development" note, reworded to say a release candidate exists and is awaiting Frank's manual tests. Correct anything that changed during the build. If `deleteAccount` was deferred, update the Security section.

- [ ] **Step 7: Commit**

```bash
git add src/cli.ts src/run.ts test/run.test.ts test/integration/key-safety.test.ts README.md
git commit -m "feat: add CLI entry point and release candidate" -- src/cli.ts src/run.ts test/run.test.ts test/integration/key-safety.test.ts README.md package.json
```

- [ ] **Step 8: Hand over to Frank**

Stop here. List the remaining manual tests from the spec:
1. A real Stargazer export: check the key format, that the address matches, and what happens with the wrong network's key.
2. A real registration and edit from an account above the minimum, checked on the staking page. It stays public.
3. Confirm the hardware wallet statement in the README.
4. `npm publish`.

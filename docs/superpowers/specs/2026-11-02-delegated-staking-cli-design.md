# Delegated Staking CLI: Design

Date: 2026-11-02
Repo: `StardustCollective/delegated-staking-cli`

## Intent

Let someone register a Constellation mainnet account for delegated staking, and later edit that registration, without running a node.

The network used to require a node on the seedlist. Registration now depends on the balance of the signing account. Stargazer Wallet will eventually offer this directly, and this CLI is a workaround until it does. Keep it small, because it is meant to be retired.

## Goals

- Register a Stargazer account from its exported private key.
- Edit the name and description of an existing registration.
- Show the server's reason clearly when a request is rejected.

## Non-goals

- Testnet or integrationnet support. The tool is mainnet only and has no network flag.
- Setting a commission. The backend ignores the submitted value and uses a fixed 10%.
- Running, monitoring or configuring a node. Node operators keep using node-pilot, which this project does not change.
- Delegating stake, withdrawing or sending funds.
- Hardware wallet accounts. They are assumed not to export a private key, so the docs should state they are unsupported.

## Anti-goals

These would make the tool a failure even if registration worked:

- The private key leaks through plain-text files, command-line arguments, logs, shell history or error messages.
- The tool registers a different account from the one the user intended without showing them.
- The tool blocks a request based on its own balance rule and disagrees with the server.

## Decisions made by Frank

- It is a CLI.
- Signing uses `wallet.jar`, so users need Java.
- The tool accepts a private key exported from Stargazer and converts it to a P12.
- Users can return to the tool to edit a registration.
- There is no commission prompt.
- It supports mainnet only, with no network flag.
- A balance under the minimum produces a warning, and the request is still sent so the server's rule decides the outcome.
- The project lives at `~/Projects/StardustCollective/delegated-staking-cli`. This repo already exists, with only a first commit and a README.
- The license is MIT.
- **Deadline:** the first release should be out before the minimum rises around 2026-11-14. Build the key conversion and the mainnet rejection test first, and ship a smaller first release if needed.
- **Platforms:** macOS and Linux only. The docs point Windows users to WSL (Linux on Windows), and no Windows-specific key protection is built.
- **Release scope:** the build stops at a tested release candidate. Frank runs the real Stargazer export and real registration tests with an account of his choosing, then publishes.

## User flow

The primary command takes no required arguments and runs interactively.

### Choosing the account

1. List the accounts saved by earlier runs, and offer to add a new one.
2. For a new account, read the private key from a hidden prompt, convert it to a P12 protected by a password the user chooses, and show the DAG address.
3. Ask the user to confirm the address before continuing.
4. For a saved account, ask for its P12 password.

### Registering or editing

5. Get the account's ID with `wallet.jar show-id`.
6. Call `GET /node-params/{id}`.
   - A `404` means a new registration, and the parent reference is the all-zero hash with ordinal 0.
   - A `200` means an edit. Fill in the current name and description, and use the response's `lastRef` as the parent reference.
7. Call `GET /dag/{address}/balance`. If the balance is under the minimum, warn and continue.
8. Ask for the name and description, then show a summary and ask for confirmation.
9. Sign with `wallet.jar create-node-params`, using `--reward-fraction 0.1`.
10. Call `POST /node-params` with the signed request.
    - On `400`, show the server's error text with a plain explanation of known errors, and exit non-zero.
    - On success, show the returned hash.
11. Poll `GET /node-params/{id}` until the change appears or a timeout passes. A timeout is reported as "submitted but not yet visible", not as a failure.
12. Show `https://mainnet.dagexplorer.io/staking`.

## Network facts

These were checked against mainnet and Tessellation v3.6.2 on 2026-11-02.

**Endpoints**, all on `https://l0-lb-mainnet.constellationnetwork.io`:

| Call | Result |
|---|---|
| `GET /node/info` | Includes the `version` mainnet is running |
| `GET /dag/{address}/balance` | `{"ordinal":7220086,"balance":0}`, in units of 1e-8 DAG |
| `GET /node-params/{id}` | `404` when unregistered. When registered, returns `latest` and `lastRef` |
| `POST /node-params` | Validates immediately. Returns the hash on success and `400` with the error text when invalid |

**Validation rules** in `UpdateNodeParametersValidator`:

- Signed by exactly one key, and that key must belong to the `source` address.
- The parent must match the latest registration, or be the empty reference for a first registration.
- The commission must be between 5000000 and 10000000. Sending 0.1 becomes 10000000.
- Name and description can each be at most 140 characters. v3.6.2 checks nothing else about them. An older local checkout and the `develop` branch also require non-empty, printable ASCII text, so a later release may bring that back.

The tool follows the same approach as the balance rule: it requires a non-empty value at the prompt (Claude's choice) and leaves everything else to the server. It shows any server rejection as usual. node-pilot's 6–139 length rule is stricter than the server and should not be copied.

**No removal:** the v3.6.2 `node-params` routes only create, update and read. A registration can't be deleted, so a test registration stays public.

**Minimum balance:** 250,000 DAG until epoch 2,954,500 (about 2026-11-14), then 1,000,000 DAG. Mainnet was at epoch 2,938,494 on 2026-11-02. The tool needs the current minimum only for its warning. The epoch number comes from `GET /global-snapshots/latest` (`value.epochProgress`). If that call fails, skip the warning rather than stopping.

**Commission:** the single-registration response for one live account shows `rewardFraction` 5000000, while the list response shows 10000000 for the same account. This matches the backend ignoring the submitted value.

## Key conversion

`keytool.jar` has no import command, so the tool has to build the P12 itself.

A throwaway test with v3.6.2 JARs and OpenSSL 3.6.1 passed:

- `wallet.jar show-address` returned the same address dag4 derives from the hex key.
- `keytool.jar export` returned the original hex key.
- `wallet.jar create-node-params` produced a signed request.

The steps that passed in the test:

1. Wrap the 32-byte key as SEC1 DER: `302e0201010420` + key hex + `a00706052b8104000a` (curve secp256k1).
2. Create a self-signed certificate with SHA-512, subject `CN=constellationnetwork.io, O=Constellation Labs`, and validity of 365,000 days. These match the values `keytool.jar` uses.
3. Build a PKCS12 file with the alias `alias`, using the same password for the store and the key.

The test wrote the unencrypted key to a temporary file and passed the password as an argument. **The tool must not do either.**

A second test built the P12 in-process with Node's `crypto` and `pkijs`, with no OpenSSL and no temporary key file, and passed the same three checks. The tool uses this method. Unlike the steps above, the inner key must include the public key. The exact code is in the implementation plan.

After conversion, the address from `wallet.jar show-address` must equal the address dag4 derives from the hex key. If they differ, stop and delete the new P12.

`wallet.jar` reads its settings from environment variables: `CL_KEYSTORE`, `CL_KEYALIAS`, `CL_PASSWORD` and `CL_APP_ENV=mainnet`. It writes the signed request to a file named `event` in the working directory, and reads the parent reference from a JSON file given with `-p`. Run it in a new temporary directory with owner-only permissions, and remove that directory afterwards.

## Key handling requirements

- Read the private key and password only from hidden prompts. Add no flags or environment variables for them.
- Validate the key as 64 hex characters, allowing an optional `0x` prefix.
- Pass the password to child processes through their environment only, and clear it from logs and error output.
- Do not write the unencrypted key to disk, even temporarily. This rules out the temporary PEM file used in the test.
- Store P12 files in a directory that only the owner can read, such as `~/.delegated-staking-cli/<address>/key.p12`.
- Never overwrite a saved P12 without asking.
- Include a command or menu option that deletes a saved account.
- Warn the user that the private key controls their funds, and that they should get the tool from the official repo.

## Choices made by Claude

Frank can overrule any of these while reading.

- **Language and distribution:** TypeScript on Node, published as `@stardust-collective/delegated-staking-cli`, matching node-pilot's stack and run with `npx` or a global install.
- **P12 kept for edits:** the encrypted file stays on disk so editing doesn't need the private key pasted again.
- **Several accounts:** files are stored per address, because the cost is small and one person may have more than one account.
- **`wallet.jar` version:** read mainnet's version from `/node/info`, download the matching `cl-wallet.jar` from the `Constellation-Labs/tessellation` GitHub release, check it against the release's `cl-wallet.sha256`, and cache it by version. This keeps signing in step with the network without needing a new CLI release after each network upgrade. If mainnet's version has no matching release or download, fall back to the newest cached JAR and warn.
- **Java check:** check for Java at startup and print install instructions if it is missing. The test ran on Java 21, so require 21 or newer until a lower version is shown to work.
- **Server failover:** use only the load balancer. Unlike node-pilot, there is no fallback to a source node. Add one only if the load balancer proves unreliable here.
- **Verification step:** polling after submission is included because a successful POST doesn't by itself show the registration has reached a snapshot.

## Left to the builder

- The CLI framework and prompt library.
- Polling interval and timeout.
- Wording of messages and error explanations.
- Other server errors worth explaining, using `UpdateNodeParametersValidationError` as the list.

## Testing

Automated tests:

- Conversion with fixed test keys: the address from the P12 matches dag4's, and `keytool.jar export` returns the original key. Run these against the real JARs.
- Parsing and flow logic with mocked HTTP responses: new registration, edit, `400`, under-minimum warning, and poll timeout.
- Key safety: run a conversion and sign with a test key, then confirm the key and password don't appear in captured output or the temporary directory.

Manual tests before release:

1. **Real Stargazer export.** Confirm the format of the exported key and that the shown address matches Stargazer. Only a generated hex key has been tested so far. Stargazer's export screen has a network dropdown, so also check what happens if the user exports the wrong network's key.
2. **Rejected mainnet request.** Submit from an unfunded throwaway key. Expect `400` with `InsufficientRegistrationBalance` as the only error. Validation collects all errors, so this also shows the signature and parent reference were accepted. No request from this conversion path has been sent to any network yet.
3. **Real registration and edit.** Use an account above the minimum, confirm it appears on the staking page, then edit it.

## Risks and open items

- **Date change:** the minimum rises around 2026-11-14. The tool handles both values, and the hard-coded epoch should come out once it has passed. If Tessellation changes the epoch, the warning may be wrong, but the server still decides.
- **Network upgrades:** a future change to the request format could break signing. Matching the JAR to mainnet's version covers this unless the new JAR's command-line options change.
- **Retirement:** when Stargazer ships this feature, the README should point there and the npm package should be deprecated.

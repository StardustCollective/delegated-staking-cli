# delegated-staking-cli

Temporary tool: registers a Constellation mainnet account for delegated staking without running a node. It is meant to be retired once the wallets support this.

Design: `docs/superpowers/specs/2026-11-02-delegated-staking-cli-design.md`
Plan: `docs/superpowers/plans/2026-11-02-delegated-staking-cli.md`

## Key handling rules

- Read the private key and password only from hidden prompts. No flags or environment variables for them.
- Never write the unencrypted key to disk.
- Never put the key or password in command-line arguments, logs or error text.
- Pass the password to child processes through environment variables only: `CL_KEYSTORE`, `CL_KEYALIAS=alias`, `CL_PASSWORD`, `CL_APP_ENV=mainnet`.
- Saved files: `~/.delegated-staking-cli/` and each account directory are mode `0700`, and `key.p12` is mode `0600`.
- Never overwrite a saved P12 without asking.
- `npm run test:integration` needs Java 21 and `expect` (`/usr/bin/expect` on macOS; the `expect` package on Linux).
- `npm run test:e2e-linux` needs Docker. It installs the packed CLI in a fresh Ubuntu container and sends one real registration request to mainnet from a new unfunded key, which the server rejects.
- Do not run `npm publish`, and do not submit a real registration.

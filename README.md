# delegated-staking-cli

Register a Constellation mainnet account for delegated staking, without running a node.

This is a temporary tool. Stargazer Wallet will offer registration directly, and this project will be retired when it does.

> **Status: release candidate.** A release candidate is built and tested, and is waiting for Frank's manual tests before it's published to npm. Until then, the `npx` command below won't work. See the [design document](docs/superpowers/specs/2026-11-02-delegated-staking-cli-design.md).

## Requirements

- **A minimum balance in the account you register from:** 250,000 DAG until about November 14, 2026, then 1,000,000 DAG.
- **A private key exported from Stargazer Wallet.** Hardware wallet accounts aren't supported, because they don't export a private key.
- **Java 21 or newer.** The tool checks this when it starts. Signing uses Constellation's official `wallet.jar`, which the tool downloads for you.
- **Node.js 22 or newer.**
- **macOS or Linux.** On Windows, use [WSL](https://learn.microsoft.com/windows/wsl/).

You don't need a node, and you don't need to be on the seedlist.

## Usage

```bash
npx @stardust-collective/delegated-staking-cli
```

The tool is interactive: it asks for everything it needs at prompts, and has no options. Press Ctrl-C at any prompt to stop.

### Register

1. Export the private key for your Constellation account from Stargazer.
2. Run the tool and paste the key at the hidden prompt.
3. Choose a password. The tool uses it to protect the key file it saves for you.
4. Check that the DAG address shown is the account you meant to use.
5. Enter a name and description, up to 140 characters each. These are public, and a registration can be edited but not removed.
6. Review the summary and confirm.

The tool sends your registration to mainnet and waits for it to appear. You can then find it on the [staking page](https://mainnet.dagexplorer.io/staking).

If your balance is under the minimum, the tool warns you and still sends the request. The network makes the final decision, and the tool shows you its response.

### Edit

Run the tool again, choose your saved account and enter its password. Your current name and description are filled in for you to change. You don't need to paste your private key again.

### Commission

The tool doesn't ask for a commission because the network applies a fixed 10%.

## Security

**Your private key controls your funds. Anyone who has it can take them.**

- Only install this tool from the official package or this repository.
- The tool reads your key from a hidden prompt, and never accepts it as a command-line argument or environment variable.
- Your key is saved only in an encrypted key file, at `~/.delegated-staking-cli/<address>/key.p12`, which only your user account can read.
- The password can't be recovered. If you lose it, delete the saved account and add it again using your private key.
- You can delete a saved account from the tool at any time. This removes the key file from your computer and doesn't affect your funds or your registration.

## License

[MIT](LICENSE)

# Paseo client commands

Your server agent requests a command. You review it in Paseo on your laptop, press **Yep, run on Laptop**, and it starts in a real laptop terminal using your account's login shell in interactive mode.

The plugin installs on the **server**. Its client screen arrives through the existing Paseo connection. Your laptop's **local Paseo daemon** owns execution; the server never receives its connection credentials or command output.

Requires Paseo **0.15.0 or newer** on both hosts and the viewing app. The laptop must run macOS or Linux with bash, zsh, or fish as its account login shell. The desktop app starts its local daemon automatically. For a browser client, start a local daemon and connect it to that app. Mobile clients can approve commands for a connected laptop host; they cannot execute shells on the phone.

## Install

On your server, from this checkout:

```sh
paseo plugin install /absolute/path/to/paseo-client-commands
paseo plugin ls client-commands
```

Paseo compiles the plugin and supplies its runtime dependencies. Installing the directory does not need `npm install`. Plugins must be enabled on the target server in **Settings → Plugins**. Plugins are trusted, unsandboxed code.

In the laptop app:

1. Keep your server connection and the laptop's local host connected.
2. Create or open a workspace on the laptop, such as your home directory or project checkout.
3. Open **Client commands** in the sidebar. Select your **server** in Paseo's screen host picker if necessary.
4. Under **Run commands on**, explicitly select your **laptop**, then its workspace. The picker collapses to a destination summary; use **Change** to expand it, and **Collapse** to hide it again. Your selection and collapsed state survive leaving and returning to the screen, separately for each source server in this client session. Reloading or unloading the plugin resets them.
5. Review a request's reason, complete command, directory, and destination, then approve or deny it.

You do not need to install this plugin on the laptop daemon. Never select the server as the execution destination when you mean to run on the laptop. The app's host labels are the available machine identities; the SDK does not identify which host is physically running your viewer.

Existing agents receive the tools when their next idle prompt opens a fresh session. After changing plugin source, run:

```sh
paseo plugin reload client-commands
```

## Host tools

`request_client_command` queues a request and immediately returns its ID:

```json
{
  "command": "open 'https://example.com'",
  "reason": "Open the deployment on your Mac"
}
```

Optional `cwd` is an absolute **laptop** directory. Omit it to use the selected laptop workspace. Commands use the laptop's shell syntax, so use `xdg-open` on Linux or fish syntax when appropriate. The agent's server working directory is never forwarded implicitly.

`client_command_status` accepts `{ "id": "<request ID>" }`. An agent can inspect only its own requests. Statuses are:

| Status | Meaning |
| --- | --- |
| `pending` | Awaiting a person's decision. |
| `denied` | Rejected; cannot execute. |
| `expired` | Unapproved for 24 hours; cannot execute. |
| `approved` | One viewer owns the approval; a launch receipt has not arrived. |
| `launched` | The selected daemon created a PTY terminal. Check that terminal for output and success. |
| `uncertain` | Approval was interrupted or launch could not be confirmed. Inspect laptop terminals before requesting it again. |

**Launched does not mean succeeded.** The terminal runs `/bin/sh` as a launcher, resolves the local account's login shell through `getent` or macOS `dscl`, and invokes it with `-l -i -c`. The command is passed as one argument, preserving quoting and newlines. After the command exits, the terminal displays its exit status and waits for Enter, keeping output visible. Open the laptop workspace to interact with prompts, enter passwords, or use Ctrl-C. The login shell reads your normal startup files.

## Queue and approval behavior

- All connected viewers see the server queue. The first approval or denial wins; a request runs on one selected destination, rather than broadcasting to every client.
- Reading the queue and receiving an approval update never execute anything. Execution is called directly from the approve button's action, using the command that was displayed at that click.
- The queue survives server restarts in `$PASEO_HOME/client-commands/queue.json` (default `~/.paseo`). Set `PASEO_HOME` when using a custom daemon home. This plugin uses one queue per daemon home; install it once per home, under the `client-commands` ID.
- A restart turns unfinished approvals into `uncertain`. Network failures and lost receipts never cause an automatic retry. This favors preventing duplicate side effects over guaranteeing execution after a disconnect.
- Up to 200 requests are retained. Old decided requests are evicted for new requests; pending and approved requests are preserved. The queue file is private to the daemon user. Treat its command text as sensitive.
- Output stays in the laptop terminal. There is no remote input, cancellation, output upload, or blanket approval tool. The host tool only queues requests and reads status.

## Development

Use Node 24+, npm, and Python 3 for the real PTY checks:

```sh
npm ci
npm run check
```

Tests cover approval races, exact command provenance, restart recovery, expiry, denial, lost launch receipts, screen teardown, queue bounds, and login/interactive behavior in real PTYs. Shell-specific tests skip a shell that is not installed. Paseo's own compiler validates the client/server/shared boundaries during installation and reload.

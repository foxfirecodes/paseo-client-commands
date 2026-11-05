import type { RpcInput, RpcOutput } from "@getpaseo/plugin";
import type { approveCommand, reportLaunch, CommandRequest, Executor } from "../shared/commands.ts";

// Resolve the account's login shell locally. All request text is a separate argv value.
// The outer sh keeps output visible after the interactive login shell exits.
export const shellLauncher = `
shell=
if command -v getent >/dev/null 2>&1; then
  entry=$(getent passwd "$(id -u)") || exit 1
  shell=\${entry##*:}
elif [ "$(uname -s)" = Darwin ]; then
  entry=$(/usr/bin/dscl . -read "/Users/$(id -un)" UserShell) || exit 1
  shell=\${entry#UserShell: }
else
  shell=\${SHELL:-}
fi
case "$shell" in
  /*/bash|/*/zsh|/*/fish) ;;
  *) printf 'Unsupported login shell: %s. Use bash, zsh, or fish.\\n' "$shell"; exit 1 ;;
esac
"$shell" -l -i -c "$1"
result=$?
printf '\\nCommand exited with status %s. Press Enter to close.\\n' "$result"
IFS= read -r reply
exit "$result"
`;

type ApprovalDependencies = {
  approve(input: RpcInput<typeof approveCommand>): Promise<RpcOutput<typeof approveCommand>>;
  report(input: RpcInput<typeof reportLaunch>): Promise<unknown>;
  launch(options: { workspaceId: string; cwd: string; name: string; command: string; args: string[] }): Promise<{ id: string }>;
  signal: AbortSignal;
};

export async function approveAndLaunch(request: CommandRequest, executor: Executor, dependencies: ApprovalDependencies) {
  if (request.status !== "pending") throw new Error("This command is no longer awaiting approval.");
  dependencies.signal.throwIfAborted();
  const approval = await dependencies.approve({
    id: request.id,
    expected: { command: request.command, reason: request.reason, cwd: request.cwd },
    executor,
  });
  let terminal: { id: string };
  try {
    dependencies.signal.throwIfAborted();
    // Execute the reviewed snapshot, never executable data returned by the host after the click.
    terminal = await dependencies.launch({
      workspaceId: executor.workspaceId,
      cwd: request.cwd ?? executor.directory,
      name: `Client command: ${request.id.slice(0, 8)}`,
      command: "/bin/sh",
      args: ["-c", shellLauncher, "paseo-client-command", request.command],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    try {
      await dependencies.report({ id: request.id, token: approval.token, result: { status: "uncertain", error: message.slice(0, 4_000) } });
    } catch {
      // Preserve the uncertain-launch warning even when the source host also disconnects.
    }
    throw new Error(`Launch could not be confirmed: ${message}. Check laptop terminals before requesting this command again.`);
  }
  try {
    await dependencies.report({ id: request.id, token: approval.token, result: { status: "launched", terminalId: terminal.id } });
  } catch {
    throw new Error(`Terminal ${terminal.id} was launched on ${executor.label}, but its receipt could not be saved. Do not run this command again without checking that terminal.`);
  }
  return terminal;
}

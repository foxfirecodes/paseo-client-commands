import type { PluginClientContext } from "@getpaseo/plugin/client";
import { CAPTURE_LINES, reportCompletion, watchCommands, type RunningCommand } from "../shared/commands.ts";
import { readCompletion } from "../shared/output.ts";

type TerminalApi = {
  terminals: { ref(id: string): {
    refresh(): Promise<object | null>;
    capture(options: { start: number; stripAnsi: boolean }): Promise<{ lines: string[]; totalLines: number }>;
  } };
};

// Owned by the client installation, so navigating away does not stop collection.
// Running jobs live on the source host and can be rediscovered after reconnection.
export function collectResults(client: Pick<PluginClientContext, "rpc">, getClient: (serverId: string) => TerminalApi) {
  let stopped = false;
  let pending: Promise<void> | undefined;

  async function collect(job: RunningCommand) {
    const terminal = getClient(job.executor.serverId).terminals.ref(job.terminalId);
    const exists = await terminal.refresh();
    if (stopped) return;
    const capture = await terminal.capture({ start: -CAPTURE_LINES, stripAnsi: true });
    if (stopped) return;
    const result = readCompletion(job.token, capture) ?? (!exists ? {
      exitCode: null, output: "", outputStream: "combined" as const, truncated: true,
      error: "The terminal closed before its completion result could be captured.",
    } : undefined);
    if (result) await client.rpc(reportCompletion, { id: job.id, token: job.token, result });
  }

  function poll() {
    if (stopped || pending) return pending;
    pending = (async () => {
      const jobs = await client.rpc(watchCommands, {});
      for (const job of jobs) {
        if (stopped) break;
        // Offline and unknown destination hosts are retried; never substitute a host.
        try { await collect(job); } catch { /* A later poll rediscovers this job. */ }
      }
    })().catch(() => {}).finally(() => { pending = undefined; });
    return pending;
  }
  const timer = setInterval(() => void poll(), 2_000);
  void poll();
  return () => { stopped = true; clearInterval(timer); };
}

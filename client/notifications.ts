import type { PluginClientContext } from "@getpaseo/plugin/client";
import { listCommands } from "../shared/commands.ts";
import type { DesktopNotifications } from "./web.ts";

// One watcher per installation, independent of sidebar/screen visibility. Retain
// dismissed notifications until the request leaves pending so polling cannot spam.
export function notifyPendingCommands(client: Pick<PluginClientContext, "rpc" | "openScreen">, notifications: DesktopNotifications) {
  const shown = new Map<string, () => void>();
  let stopped = false;
  let pending: Promise<void> | undefined;

  function closeAll() {
    for (const close of shown.values()) close();
    shown.clear();
  }

  function poll() {
    if (stopped || pending) return;
    if (notifications.permission() !== "granted") { closeAll(); return; }
    pending = (async () => {
      const requests = await client.rpc(listCommands, {});
      if (stopped) return;
      const awaiting = requests.filter((request) => request.status === "pending");
      const ids = new Set(awaiting.map((request) => request.id));
      for (const [id, close] of shown) {
        if (!ids.has(id)) { close(); shown.delete(id); }
      }
      for (const request of awaiting) {
        if (shown.has(request.id)) continue;
        try {
          const close = notifications.show(request.id, () => {
            if (!stopped) client.openScreen({ screenId: "queue" });
          });
          if (close) shown.set(request.id, close);
        } catch (error) {
          console.error("Client command desktop notification failed", {
            requestId: request.id,
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }
    })().catch(() => {}).finally(() => { pending = undefined; });
  }

  const timer = setInterval(poll, 2_000);
  poll();
  return () => { stopped = true; clearInterval(timer); closeAll(); };
}

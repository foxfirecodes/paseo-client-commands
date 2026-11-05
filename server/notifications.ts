import type { PluginHandlerContext } from "@getpaseo/plugin/server";
import type { CommandRequest } from "../shared/commands.ts";
import type { CommandQueue } from "./queue.ts";

export const MAX_MESSAGE_CHARS = 20_000;
type FinishedRequest = Extract<CommandRequest, { status: "completed" | "failed" }>;

export function completionMessage(request: FinishedRequest) {
  const error = request.result.error?.slice(0, 1_000);
  const alreadyTruncated = request.result.truncated || error !== request.result.error;
  const encode = (output: string, truncated: boolean) => JSON.stringify({
    type: "client_command_result", requestId: request.id, status: request.status,
    host: request.executor.label.slice(0, 200), terminalId: request.terminalId.slice(0, 200),
    ...request.result, output, truncated, error,
  });
  const original = encode(request.result.output, alreadyTruncated);
  if (original.length <= MAX_MESSAGE_CHARS) return original;
  // JSON escaping can expand control characters. Bound the whole notification too.
  let low = 0;
  let high = request.result.output.length;
  while (low < high) {
    const length = Math.ceil((low + high) / 2);
    if (encode(request.result.output.slice(-length), true).length <= MAX_MESSAGE_CHARS) low = length;
    else high = length - 1;
  }
  const tail = low ? request.result.output.slice(-low).replace(/^[\uDC00-\uDFFF]/, "") : "";
  return encode(tail, true);
}

// The outbox is persisted on each command. A stable Paseo messageId makes a retry
// after a lost acknowledgement safe; it never retries the laptop command itself.
export function resultNotifications(queue: CommandQueue) {
  let paseo: PluginHandlerContext["paseo"] | undefined;
  let pending: Promise<void> | undefined;
  let stopped = false;

  function flush() {
    if (!paseo || stopped || pending) return pending;
    const api = paseo;
    pending = (async () => {
      for (const { request, notificationId } of await queue.notifications()) {
        if (stopped) break;
        try {
          await api.agents.ref(request.requester.agentId).send(completionMessage(request), {
            messageId: notificationId, activeTurnBehavior: "steer",
          });
          await queue.acknowledgeNotification(request.id, notificationId);
        } catch (error) {
          // Retain the outbox item when delivery or its acknowledgement fails.
          console.error("Command result notification failed", {
            requestId: request.id,
            error: (error instanceof Error ? error.message : String(error)).slice(0, 500),
          });
        }
      }
    })().catch(() => {}).finally(() => { pending = undefined; });
    return pending;
  }
  const timer = setInterval(() => void flush(), 10_000);
  return {
    use(api: PluginHandlerContext["paseo"]) {
      if (!paseo) { paseo = api; void flush(); }
    },
    flush,
    stop() { stopped = true; clearInterval(timer); },
  };
}

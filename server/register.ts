import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { approveCommand, commandInput, denyCommand, listCommands, reportCompletion, reportLaunch, watchCommands } from "../shared/commands.ts";
import type { CommandQueue } from "./queue.ts";
import { resultNotifications } from "./notifications.ts";

export function registerCommands(server: PluginServerContext, queue: CommandQueue) {
  const notifications = resultNotifications(queue);
  server.handle(listCommands, (_, { paseo }) => { notifications.use(paseo); return queue.list(); });
  server.handle(approveCommand, ({ id, expected, executor }) => queue.approve(id, expected, executor));
  server.handle(denyCommand, ({ id }) => queue.deny(id));
  server.handle(reportLaunch, ({ id, token, result }) => queue.report(id, token, result));
  server.handle(watchCommands, (_, { paseo }) => { notifications.use(paseo); return queue.running(); });
  server.handle(reportCompletion, async ({ id, token, result }, { paseo }) => {
    notifications.use(paseo);
    const request = await queue.complete(id, token, result);
    void notifications.flush();
    return request;
  });

  const request = defineAgentTool({
    name: "request_client_command",
    description: "Queue a command for a person viewing Paseo to approve and run on their laptop. This does not execute anything until a person approves. Use client_command_status with the returned ID to retrieve running/completed/failed status, exit code, and bounded combined stdout/stderr terminal output. A completion message is also sent to this agent asynchronously.",
    input: commandInput,
    async execute(input, { agent }) {
      const request = await queue.enqueue(input, { agentId: agent.id, title: agent.title ?? agent.id, workspaceId: agent.workspaceId });
      return { text: `Queued ${request.id}. Awaiting approval in Paseo → Client commands.`, structuredContent: request };
    },
  });
  const status = defineAgentTool({
    name: "client_command_status",
    description: "Retrieve one of this agent's client command requests by ID, including running/completed/failed status. Completed/failed results contain exitCode, output (combined stdout/stderr terminal text, capped at 16384 characters), outputStream, truncated, and optional error. An unknown exit code is null; running does not imply success.",
    input: z.object({ id: z.string().uuid() }),
    async execute({ id }, { agent, paseo }) {
      notifications.use(paseo);
      const request = (await queue.list()).find((request) => request.id === id && request.requester.agentId === agent.id);
      if (!request) return { isError: true, text: "Request not found for this agent." };
      return { structuredContent: request };
    },
  });
  server.addHook("agent.open.before", async ({ request: opening }, { paseo }) => {
    notifications.use(paseo);
    return { ...opening, tools: [...opening.tools, request, status] };
  });
  return () => notifications.stop();
}

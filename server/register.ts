import { defineAgentTool, type PluginServerContext } from "@getpaseo/plugin/server";
import { z } from "zod";
import { approveCommand, commandInput, denyCommand, listCommands, reportLaunch } from "../shared/commands.ts";
import type { CommandQueue } from "./queue.ts";

export function registerCommands(server: PluginServerContext, queue: CommandQueue) {
  server.handle(listCommands, () => queue.list());
  server.handle(approveCommand, ({ id, expected, executor }) => queue.approve(id, expected, executor));
  server.handle(denyCommand, ({ id }) => queue.deny(id));
  server.handle(reportLaunch, ({ id, token, result }) => queue.report(id, token, result));

  const request = defineAgentTool({
    name: "request_client_command",
    description: "Queue a command for a person viewing Paseo to approve and run on their laptop. This does not execute anything on this server or the laptop. The person selects their laptop and approves the exact command. Use client_command_status to check whether a terminal was launched; launched does not mean completed.",
    input: commandInput,
    async execute(input, { agent }) {
      const request = await queue.enqueue(input, { agentId: agent.id, title: agent.title ?? agent.id, workspaceId: agent.workspaceId });
      return { text: `Queued ${request.id}. Awaiting approval in Paseo → Client commands.`, structuredContent: request };
    },
  });
  const status = defineAgentTool({
    name: "client_command_status",
    description: "Check one of this agent's client command requests. Launched means a PTY terminal was created, not that the command succeeded. Output stays on the selected client host.",
    input: z.object({ id: z.string().uuid() }),
    async execute({ id }, { agent }) {
      const request = (await queue.list()).find((request) => request.id === id && request.requester.agentId === agent.id);
      if (!request) return { isError: true, text: "Request not found for this agent." };
      return { structuredContent: request };
    },
  });
  server.addHook("agent.open.before", async ({ request: opening }) => ({ ...opening, tools: [...opening.tools, request, status] }));
}

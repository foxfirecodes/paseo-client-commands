import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";

const text = z.string().min(1).max(16_384).refine((value) => !value.includes("\0"), "NUL is not allowed");
export const commandInput = z.object({
  command: text.describe("Exact command in the laptop's shell syntax. Never runs until a person approves."),
  reason: z.string().trim().min(1).max(2_000).describe("Explain why this needs to run on the viewing person's laptop."),
  cwd: text.startsWith("/").optional().describe("Optional absolute directory on the laptop, not the server. Defaults to the selected laptop workspace."),
});

export const executorSchema = z.object({
  serverId: z.string().min(1),
  label: z.string().min(1),
  workspaceId: z.string().min(1),
  workspaceName: z.string().min(1),
  directory: z.string().min(1),
});
const base = commandInput.extend({
  id: z.string().uuid(),
  createdAt: z.number(),
  expiresAt: z.number(),
  requester: z.object({ agentId: z.string(), title: z.string(), workspaceId: z.string().nullable() }),
});
const approved = base.extend({ executor: executorSchema, approvedAt: z.number() });
export const requestSchema = z.discriminatedUnion("status", [
  base.extend({ status: z.literal("pending") }),
  base.extend({ status: z.literal("denied"), decidedAt: z.number() }),
  base.extend({ status: z.literal("expired"), decidedAt: z.number() }),
  approved.extend({ status: z.literal("approved") }),
  approved.extend({ status: z.literal("launched"), terminalId: z.string(), launchedAt: z.number() }),
  approved.extend({ status: z.literal("uncertain"), error: z.string(), decidedAt: z.number() }),
]);
export type CommandRequest = z.infer<typeof requestSchema>;
export type CommandInput = z.infer<typeof commandInput>;
export type Executor = z.infer<typeof executorSchema>;

export const listCommands = defineRpc({
  name: "commands.list", input: z.object({}), output: z.array(requestSchema),
});
export const approveCommand = defineRpc({
  name: "commands.approve",
  input: z.object({ id: z.string().uuid(), expected: commandInput, executor: executorSchema }),
  output: z.object({ request: requestSchema, token: z.string().uuid() }),
});
export const denyCommand = defineRpc({
  name: "commands.deny", input: z.object({ id: z.string().uuid() }), output: requestSchema,
});
export const launchResult = z.discriminatedUnion("status", [
  z.object({ status: z.literal("launched"), terminalId: z.string().min(1) }),
  z.object({ status: z.literal("uncertain"), error: z.string().max(4_000) }),
]);
export const reportLaunch = defineRpc({
  name: "commands.report",
  input: z.object({ id: z.string().uuid(), token: z.string().uuid(), result: launchResult }),
  output: requestSchema,
});

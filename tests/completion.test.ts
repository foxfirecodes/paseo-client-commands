import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { createPaseoClient } from "@getpaseo/client";
import { CommandQueue } from "../server/queue.ts";
import { completionMessage, MAX_MESSAGE_CHARS, resultNotifications } from "../server/notifications.ts";
import { commandResult, MAX_OUTPUT_CHARS, type CommandResult } from "../shared/commands.ts";

const input = { command: "printf 'output'", reason: "Test output" };
const requester = { agentId: "requesting-agent", title: "Requester", workspaceId: null };
const executor = { serverId: "laptop", label: "Laptop", workspaceId: "workspace", workspaceName: "Workspace", directory: "/tmp" };
const success: CommandResult = { exitCode: 0, output: "output", outputStream: "combined", truncated: false };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "completion-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const file = join(directory, "queue.json");
  const queue = new CommandQueue(file);
  const request = await queue.enqueue(input, requester);
  const { token } = await queue.approve(request.id, input, executor);
  await queue.report(request.id, token, { status: "launched", terminalId: "terminal" });
  return { file, queue, request, token };
}

test("completion stores output and exit status by request ID; the first result wins", async (t) => {
  const { queue, request, token } = await fixture(t);
  await assert.rejects(queue.complete(request.id, "wrong-token", success), /does not belong/);
  const final = await queue.complete(request.id, token, success);
  assert.equal(final.status, "completed");
  if (final.status !== "completed") throw new Error("Expected completion");
  assert.deepEqual(final.result, success);
  const repeated = await queue.complete(request.id, token, { ...success, exitCode: 1, output: "different" });
  assert.deepEqual(repeated, final);
  assert.equal((await queue.notifications()).length, 1);
  assert.deepEqual((await queue.list()).find((item) => item.id === request.id), final);
});

test("nonzero or unavailable exit codes produce failed results, never successful empty results", async (t) => {
  const { queue, request, token } = await fixture(t);
  const failed = await queue.complete(request.id, token, { ...success, exitCode: 7 });
  assert.equal(failed.status, "failed");
  const next = await queue.enqueue(input, requester);
  const approval = await queue.approve(next.id, input, executor);
  await queue.report(next.id, approval.token, { status: "launched", terminalId: "second-terminal" });
  const unknown = await queue.complete(next.id, approval.token, { ...success, exitCode: null, error: "Terminal closed" });
  assert.equal(unknown.status, "failed");
  if (unknown.status === "failed") assert.equal(unknown.result.exitCode, null);
});

test("running jobs and undelivered completion messages survive a server restart", async (t) => {
  const { file, queue, request, token } = await fixture(t);
  await queue.close();
  const restarted = new CommandQueue(file);
  assert.deepEqual(await restarted.running(), [{ id: request.id, token, executor, terminalId: "terminal" }]);
  await restarted.complete(request.id, token, success);
  const notification = (await restarted.notifications())[0];
  await restarted.close();
  const again = new CommandQueue(file);
  assert.deepEqual(await again.notifications(), [notification]);
  assert.deepEqual(await again.running(), []);
  await again.acknowledgeNotification(request.id, notification.notificationId);
  assert.deepEqual(await again.notifications(), []);
});

test("result and notification sizes are bounded even when JSON expands control characters", async (t) => {
  assert.equal(commandResult.safeParse({ ...success, output: "x".repeat(MAX_OUTPUT_CHARS + 1) }).success, false);
  const { queue, request, token } = await fixture(t);
  const completed = await queue.complete(request.id, token, { ...success, output: "\u0001".repeat(MAX_OUTPUT_CHARS) });
  if (completed.status !== "completed") throw new Error("Expected completion");
  const message = completionMessage(completed);
  assert.ok(message.length <= MAX_MESSAGE_CHARS);
  const decoded = JSON.parse(message);
  assert.equal(decoded.requestId, request.id);
  assert.equal(decoded.truncated, true);
  assert.equal(decoded.exitCode, 0);
  const pathological = completionMessage({ ...completed, result: { ...completed.result, error: "\u0001".repeat(4_000) } });
  assert.ok(pathological.length <= MAX_MESSAGE_CHARS);
});

test("completion notifies the requesting agent and retries with the same message ID after failure", async (t) => {
  const { queue, request, token } = await fixture(t);
  await queue.complete(request.id, token, success);
  const sent: { agentId: string; text: string; messageId?: string }[] = [];
  const api = createPaseoClient({ url: "ws://127.0.0.1:1/ws", reconnect: { enabled: false } });
  t.after(() => api.close());
  const realRef = api.agents.ref;
  api.agents.ref = (agentId) => {
    const handle = realRef(agentId);
    handle.send = async (text, options) => {
      assert.equal(options?.activeTurnBehavior, "steer");
      sent.push({ agentId: typeof agentId === "string" ? agentId : agentId.id, text, messageId: options?.messageId });
      if (sent.length === 1) throw new Error("Connection lost before receipt");
    };
    return handle;
  };
  const outbox = resultNotifications(queue);
  t.after(outbox.stop);
  outbox.use(api);
  await outbox.flush();
  assert.equal((await queue.notifications()).length, 1);
  await outbox.flush();
  assert.deepEqual(await queue.notifications(), []);
  assert.equal(sent.length, 2);
  assert.deepEqual(sent[0], sent[1]);
  assert.equal(sent[0].agentId, "requesting-agent");
  assert.equal(JSON.parse(sent[0].text).requestId, request.id);
  await outbox.flush();
  assert.equal(sent.length, 2);
});

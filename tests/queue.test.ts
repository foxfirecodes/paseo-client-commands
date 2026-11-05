import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import { CommandQueue } from "../server/queue.ts";
import { commandInput } from "../shared/commands.ts";

const input = { command: "printf 'hello from laptop'", reason: "Check the laptop shell" };
const requester = { agentId: "agent-1", title: "Server agent", workspaceId: "server-workspace" };
const executor = { serverId: "laptop", label: "My laptop", workspaceId: "laptop-workspace", workspaceName: "Home", directory: "/tmp" };

async function fixture(t: TestContext) {
  const directory = await mkdtemp(join(tmpdir(), "client-command-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return join(directory, "queue.json");
}

test("two viewers approving the same request produce one approval", async (t) => {
  const queue = new CommandQueue(await fixture(t));
  const request = await queue.enqueue(input, requester);
  const results = await Promise.allSettled([queue.approve(request.id, input, executor), queue.approve(request.id, input, executor)]);
  assert.equal(results.filter((result) => result.status === "fulfilled").length, 1);
  assert.equal((await queue.list())[0].status, "approved");
});

test("approval fails if the command, reason, or local directory differs from the reviewed request", async (t) => {
  const queue = new CommandQueue(await fixture(t));
  const request = await queue.enqueue(input, requester);
  for (const expected of [{ ...input, command: "rm file" }, { ...input, cwd: "/elsewhere" }, { ...input, reason: "Other reason" }]) {
    await assert.rejects(queue.approve(request.id, expected, executor), /changed/);
  }
  assert.equal((await queue.list())[0].status, "pending");
});

test("denied and expired requests cannot run", async (t) => {
  let now = 1_000;
  const queue = new CommandQueue(await fixture(t), () => now);
  const denied = await queue.enqueue(input, requester);
  await queue.deny(denied.id);
  await assert.rejects(queue.approve(denied.id, input, executor), /no longer/);
  const expired = await queue.enqueue(input, requester);
  now += 24 * 60 * 60 * 1_000;
  await assert.rejects(queue.approve(expired.id, input, executor), /no longer/);
  assert.equal((await queue.list())[0].status, "expired");
});

test("pending requests survive restart; interrupted approvals become uncertain and are never replayable", async (t) => {
  const file = await fixture(t);
  const original = new CommandQueue(file);
  const approved = await original.enqueue(input, requester);
  await original.approve(approved.id, input, executor);
  const pending = await original.enqueue(input, requester);
  await original.close();
  const restarted = new CommandQueue(file);
  const requests = await restarted.list();
  assert.equal(requests.find((request) => request.id === pending.id)?.status, "pending");
  assert.equal(requests.find((request) => request.id === approved.id)?.status, "uncertain");
  await assert.rejects(restarted.approve(approved.id, input, executor));
  assert.equal((await stat(file)).mode & 0o777, 0o600);
});

test("only the winning approval token can report a launch; tokens are not listed", async (t) => {
  const queue = new CommandQueue(await fixture(t));
  const request = await queue.enqueue(input, requester);
  const approval = await queue.approve(request.id, input, executor);
  assert.ok(!JSON.stringify(await queue.list()).includes(approval.token));
  await assert.rejects(queue.report(request.id, "wrong", { status: "launched", terminalId: "terminal" }), /owned/);
  await queue.report(request.id, approval.token, { status: "launched", terminalId: "terminal" });
  const repeated = await queue.report(request.id, approval.token, { status: "uncertain", error: "late failure" });
  assert.equal(repeated.status, "launched");
});

test("a read-only poll does not rewrite the queue file", async (t) => {
  const file = await fixture(t);
  const queue = new CommandQueue(file);
  await queue.enqueue(input, requester);
  const before = await stat(file);
  await queue.list();
  assert.equal((await stat(file)).mtimeMs, before.mtimeMs);
});

test("invalid persisted data fails closed instead of silently dropping approvals", async (t) => {
  const file = await fixture(t);
  await writeFile(file, "broken data");
  const queue = new CommandQueue(file);
  await assert.rejects(queue.list());
  await assert.rejects(queue.enqueue(input, requester));
  assert.equal(await readFile(file, "utf8"), "broken data");
});

test("queue capacity does not discard pending requests", async (t) => {
  const queue = new CommandQueue(await fixture(t));
  const requests: { id: string }[] = [];
  for (let index = 0; index < 200; index++) requests.push(await queue.enqueue(input, requester));
  await assert.rejects(queue.enqueue(input, requester), /full/);
  await queue.deny(requests[0].id);
  const latest = await queue.enqueue(input, requester);
  const remaining = await queue.list();
  assert.equal(remaining.length, 200);
  assert.ok(remaining.some((request) => request.id === latest.id));
  assert.ok(remaining.some((request) => request.id === requests[1].id));
});

test("command schemas preserve literal whitespace and omitted cwd; invalid execution input fails", () => {
  assert.deepEqual(commandInput.parse({ command: "  printf x\n", reason: "Test" }), { command: "  printf x\n", reason: "Test" });
  for (const bad of [{ ...input, command: "echo\0x" }, { ...input, cwd: "relative" }, { ...input, cwd: null }]) {
    assert.equal(commandInput.safeParse(bad).success, false);
  }
});

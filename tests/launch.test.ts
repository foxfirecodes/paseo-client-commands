import assert from "node:assert/strict";
import { test } from "node:test";
import { approveAndLaunch } from "../client/launch.ts";
import { CommandQueue } from "../server/queue.ts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { CommandRequest, Executor } from "../shared/commands.ts";

const executor: Executor = { serverId: "laptop", label: "Laptop", workspaceId: "local-workspace", workspaceName: "Local", directory: "/tmp" };
const request: CommandRequest = {
  id: "d09a9525-f73c-4942-914a-9f4dd5a1c402", status: "pending", command: "printf '%s' 'quotes ` $()\nnext line'", reason: "Run here", cwd: "/tmp/with spaces",
  requester: { agentId: "agent", title: "Server", workspaceId: "remote-workspace" }, createdAt: 0, expiresAt: Number.MAX_SAFE_INTEGER,
};
const token = "380ad358-b6fa-4eaf-9da0-72439580712d";

test("nothing launches until approval resolves, and the exact reviewed command travels as one argv", async () => {
  const events: string[] = [];
  await approveAndLaunch(request, executor, {
    signal: new AbortController().signal,
    approve: async (input) => {
      events.push("approve");
      assert.equal(input.executor.serverId, "laptop");
      assert.equal(input.expected.command, request.command);
      // Even an altered server response cannot substitute a command after approval.
      return { request: { ...request, command: "unexpected command" }, token };
    },
    launch: async (options) => {
      events.push("launch");
      assert.equal(options.workspaceId, "local-workspace");
      assert.equal(options.cwd, request.cwd);
      assert.equal(options.command, "/bin/sh");
      assert.equal(options.args.length, 4);
      assert.equal(options.args[3], request.command);
      return { id: "terminal-1" };
    },
    report: async (input) => { events.push("report"); assert.deepEqual(input.result, { status: "launched", terminalId: "terminal-1" }); },
  });
  assert.deepEqual(events, ["approve", "launch", "report"]);
});

test("a denied approval never reaches the laptop", async () => {
  let launches = 0;
  await assert.rejects(approveAndLaunch(request, executor, {
    signal: new AbortController().signal,
    approve: async () => { throw new Error("Already denied"); },
    launch: async () => { launches++; return { id: "bad" }; }, report: async () => {},
  }), /Already denied/);
  assert.equal(launches, 0);
});

test("leaving the initiating screen while approval is in flight stops execution", async () => {
  let launches = 0;
  const controller = new AbortController();
  await assert.rejects(approveAndLaunch(request, executor, {
    signal: controller.signal,
    approve: async () => { controller.abort(); return { request, token }; },
    launch: async () => { launches++; return { id: "bad" }; },
    report: async (input) => { assert.equal(input.result.status, "uncertain"); },
  }), /could not be confirmed/);
  assert.equal(launches, 0);
});

test("a disconnected execution host is reported as uncertain without retry", async () => {
  let launches = 0;
  await assert.rejects(approveAndLaunch(request, executor, {
    signal: new AbortController().signal,
    approve: async () => ({ request, token }),
    launch: async () => { launches++; throw new Error("Laptop disconnected"); },
    report: async (input) => { assert.deepEqual(input.result, { status: "uncertain", error: "Laptop disconnected" }); },
  }), /Laptop disconnected/);
  assert.equal(launches, 1);
});

test("failure to save the receipt never retries an already launched terminal", async () => {
  let launches = 0;
  await assert.rejects(approveAndLaunch(request, executor, {
    signal: new AbortController().signal, approve: async () => ({ request, token }),
    launch: async () => { launches++; return { id: "terminal-already-running" }; },
    report: async () => { throw new Error("Server disconnected"); },
  }), /terminal-already-running.*was launched/);
  assert.equal(launches, 1);
});

test("losing both host connections preserves the uncertain-launch warning", async () => {
  await assert.rejects(approveAndLaunch(request, executor, {
    signal: new AbortController().signal, approve: async () => ({ request, token }),
    launch: async () => { throw new Error("Laptop disconnected"); },
    report: async () => { throw new Error("Server disconnected"); },
  }), /Launch could not be confirmed.*Check laptop terminals/);
});

test("two simultaneous viewing clients reach one local terminal through the real queue", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "approval-flow-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const queue = new CommandQueue(join(directory, "queue.json"));
  const pending = await queue.enqueue({ command: request.command, reason: request.reason }, request.requester);
  let launches = 0;
  const dependencies = {
    signal: new AbortController().signal,
    approve: (input: { id: string; expected: { command: string; reason: string }; executor: Executor }) => queue.approve(input.id, input.expected, input.executor),
    report: (input: { id: string; token: string; result: { status: "launched"; terminalId: string } | { status: "uncertain"; error: string } }) => queue.report(input.id, input.token, input.result),
    launch: async () => { launches++; return { id: "one-terminal" }; },
  };
  await Promise.allSettled([approveAndLaunch(pending, executor, dependencies), approveAndLaunch(pending, executor, dependencies)]);
  assert.equal(launches, 1);
  assert.equal((await queue.list())[0].status, "launched");
});

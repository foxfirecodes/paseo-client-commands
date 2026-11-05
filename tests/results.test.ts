import assert from "node:assert/strict";
import { setImmediate } from "node:timers/promises";
import { test } from "node:test";
import { collectResults } from "../client/results.ts";
import { MAX_OUTPUT_CHARS, reportCompletion, type RunningCommand } from "../shared/commands.ts";
import { readCompletion, resultMarker } from "../shared/output.ts";
import type { PluginClientContext } from "@getpaseo/plugin/client";

const job: RunningCommand = {
  id: "d09a9525-f73c-4942-914a-9f4dd5a1c402", token: "380ad358-b6fa-4eaf-9da0-72439580712d", terminalId: "terminal",
  executor: { serverId: "laptop", label: "Laptop", workspaceId: "workspace", workspaceName: "Workspace", directory: "/tmp" },
};
const marker = `${resultMarker(job.token)}:7`;

function completedReply(input: unknown) {
  const { result } = reportCompletion.input.parse(input);
  return {
    ...job, command: "test command", reason: "Test", createdAt: 0, expiresAt: 1,
    requester: { agentId: "requester", title: "Requester", workspaceId: null },
    approvedAt: 0, launchedAt: 0, finishedAt: 1,
    status: result.exitCode === 0 && !result.error ? "completed" : "failed", result,
  };
}

test("only this command's complete marker establishes its exit status", () => {
  assert.equal(readCompletion(job.token, { lines: ["still running", "Command exited with status 0"], totalLines: 2 }), undefined);
  assert.equal(readCompletion(job.token, { lines: ["PASEO_RESULT_wrong:0"], totalLines: 1 }), undefined);
  assert.deepEqual(readCompletion(job.token, { lines: ["out", "err", marker, "Press Enter to close."], totalLines: 4 }), {
    exitCode: 7, output: "out\nerr", outputStream: "combined", truncated: false,
  });
});

test("wrapped terminal markers and output tails remain bounded", () => {
  const wrapped = marker.match(/.{1,10}/g)!;
  const completion = readCompletion(job.token, { lines: ["x".repeat(MAX_OUTPUT_CHARS + 100), ...wrapped], totalLines: wrapped.length + 20 });
  assert.equal(completion?.exitCode, 7);
  assert.equal(completion?.output.length, MAX_OUTPUT_CHARS);
  assert.equal(completion?.truncated, true);
  const tinyWindow = readCompletion(job.token, { lines: ["tail", marker], totalLines: 20_000 });
  assert.equal(tinyWindow?.truncated, true);
});

test("truncation does not leave half of a Unicode character", () => {
  const text = "😀".repeat(MAX_OUTPUT_CHARS) + "x";
  const result = readCompletion(job.token, { lines: [text, marker], totalLines: 2 });
  assert.ok(result && result.output.length <= MAX_OUTPUT_CHARS);
  assert.equal(/^[\uDC00-\uDFFF]/.test(result!.output), false);
});

async function until(condition: () => boolean) {
  for (let attempt = 0; attempt < 50 && !condition(); attempt++) await setImmediate();
  assert.ok(condition(), "expected the asynchronous collector to finish");
}

test("an installation collects results independently of any mounted queue screen", async (t) => {
  let completed = false;
  const client: Pick<PluginClientContext, "rpc"> = {
    async rpc(contract, input) {
      if (contract.name === "commands.watch") return contract.output.parse(completed ? [] : [job]);
      assert.equal(contract.name, "commands.complete");
      const result = reportCompletion.input.parse(input);
      assert.equal(result.id, job.id);
      assert.equal(result.result.exitCode, 7);
      assert.equal(result.result.output, "out\nerr");
      completed = true;
      return contract.output.parse(completedReply(input));
    },
  };
  const stop = collectResults(client, (id) => {
    assert.equal(id, "laptop");
    return { terminals: { ref: () => ({ refresh: async () => ({}), capture: async () => ({ lines: ["out", "err", marker], totalLines: 3 }) }) } };
  });
  t.after(stop);
  await until(() => completed);
});

test("offline destinations are retained and polled after reconnect without launching another command", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let online = false;
  let polled = false;
  let completed = false;
  const client: Pick<PluginClientContext, "rpc"> = {
    async rpc(contract, input) {
      if (contract.name === "commands.watch") { polled = true; return contract.output.parse([job]); }
      completed = true;
      return contract.output.parse(completedReply(input));
    },
  };
  const stop = collectResults(client, () => {
    if (!online) throw new Error("Laptop offline");
    return { terminals: { ref: () => ({ refresh: async () => ({}), capture: async () => ({ lines: [marker], totalLines: 1 }) }) } };
  });
  t.after(stop);
  await until(() => polled);
  await setImmediate();
  assert.equal(completed, false);
  online = true;
  t.mock.timers.tick(2_000);
  await until(() => completed);
});

test("closing a terminal before capture reports an unknown exit code instead of success", async (t) => {
  let completed = false;
  const client: Pick<PluginClientContext, "rpc"> = {
    async rpc(contract, input) {
      if (contract.name === "commands.watch") return contract.output.parse([job]);
      const { result } = reportCompletion.input.parse(input);
      assert.equal(result.exitCode, null);
      assert.match(result.error!, /closed/);
      completed = true;
      return contract.output.parse(completedReply(input));
    },
  };
  const stop = collectResults(client, () => ({ terminals: { ref: () => ({ refresh: async () => null, capture: async () => ({ lines: [], totalLines: 0 }) }) } }));
  t.after(stop);
  await until(() => completed);
});

test("unloading the plugin stops a pending capture from reporting afterwards", async () => {
  let capturing = false;
  let reported = false;
  let resolve!: (capture: { lines: string[]; totalLines: number }) => void;
  const capture = new Promise<{ lines: string[]; totalLines: number }>((done) => { resolve = done; });
  const client: Pick<PluginClientContext, "rpc"> = {
    async rpc(contract, input) {
      if (contract.name === "commands.watch") return contract.output.parse([job]);
      reported = true;
      return contract.output.parse(completedReply(input));
    },
  };
  const stop = collectResults(client, () => ({ terminals: { ref: () => ({ refresh: async () => ({}), capture: () => { capturing = true; return capture; } }) } }));
  await until(() => capturing);
  stop();
  resolve({ lines: [marker], totalLines: 1 });
  await setImmediate();
  assert.equal(reported, false);
});

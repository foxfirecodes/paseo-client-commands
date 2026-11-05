import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { requestSchema, type CommandRequest, type CommandInput, type CommandResult, type Executor, type launchResult } from "../shared/commands.ts";

const storedSchema = z.object({ version: z.literal(1), records: z.array(z.object({
  request: requestSchema, token: z.string().uuid().optional(),
  notificationId: z.string().uuid().optional(), notified: z.boolean().optional(),
})).max(200) });
type RecordEntry = z.infer<typeof storedSchema>["records"][number];
const DAY = 24 * 60 * 60 * 1_000;

export class CommandQueue {
  private records: RecordEntry[] = [];
  private tail: Promise<unknown> = Promise.resolve();
  private readonly ready: Promise<void>;
  private recovered = false;

  constructor(private readonly file: string, private readonly now = Date.now) {
    this.ready = this.load();
    void this.ready.catch(() => {}); // Surface storage failures through RPC/tool calls.
  }

  private async load() {
    try {
      this.records = storedSchema.parse(JSON.parse(await readFile(this.file, "utf8"))).records;
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
    }
    // A previous process could have lost the launch acknowledgement. Never offer replay.
    for (const entry of this.records) {
      if (entry.request.status === "approved") {
        this.recovered = true;
        entry.request = { ...entry.request, status: "uncertain", error: "Approval was interrupted. Check the laptop's terminals before requesting this command again.", decidedAt: this.now() };
        delete entry.token;
      }
    }
  }

  private async save(records: RecordEntry[]) {
    await mkdir(dirname(this.file), { recursive: true, mode: 0o700 });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify({ version: 1, records }), { mode: 0o600 });
    await rename(temporary, this.file);
  }

  private transaction<T>(change: (records: RecordEntry[]) => T): Promise<T> {
    const operation = this.tail.then(async () => {
      await this.ready;
      const records = structuredClone(this.records);
      for (const entry of records) {
        if (entry.request.status === "pending" && entry.request.expiresAt <= this.now()) {
          entry.request = { ...entry.request, status: "expired", decidedAt: this.now() };
        }
      }
      const result = change(records);
      if (this.recovered || JSON.stringify(records) !== JSON.stringify(this.records)) await this.save(records);
      this.recovered = false;
      this.records = records;
      return structuredClone(result);
    });
    this.tail = operation.catch(() => {});
    return operation;
  }

  list() {
    return this.transaction((records) => records.map(({ request }) => request).reverse());
  }

  enqueue(input: CommandInput, requester: CommandRequest["requester"]) {
    return this.transaction((records) => {
      if (records.length >= 200) {
        const finished = records.findIndex(({ request, notificationId, notified }) => request.status !== "pending" && request.status !== "approved" && request.status !== "running" && (!notificationId || notified));
        if (finished < 0) throw new Error("The command queue is full. Decide pending requests or wait for running commands and result delivery.");
        records.splice(finished, 1);
      }
      const request: CommandRequest = { ...input, requester, id: randomUUID(), status: "pending", createdAt: this.now(), expiresAt: this.now() + DAY };
      records.push({ request });
      return request;
    });
  }

  approve(id: string, expected: CommandInput, executor: Executor) {
    return this.transaction((records) => {
      const entry = this.pending(records, id);
      const current = entry.request;
      if (current.command !== expected.command || current.cwd !== expected.cwd || current.reason !== expected.reason) {
        throw new Error("The request changed. Review it again before approving.");
      }
      entry.request = { ...current, status: "approved", executor, approvedAt: this.now() };
      entry.token = randomUUID();
      return { request: entry.request, token: entry.token };
    });
  }

  deny(id: string) {
    return this.transaction((records) => {
      const entry = this.pending(records, id);
      entry.request = { ...entry.request, status: "denied", decidedAt: this.now() };
      return entry.request;
    });
  }

  report(id: string, token: string, result: z.infer<typeof launchResult>) {
    return this.transaction((records) => {
      const entry = records.find(({ request }) => request.id === id);
      if (!entry || entry.token !== token) throw new Error("This approval is no longer owned by this client.");
      if (entry.request.status !== "approved") return entry.request;
      entry.request = result.status === "launched"
        ? { ...entry.request, ...result, status: "running", launchedAt: this.now() }
        : { ...entry.request, ...result, decidedAt: this.now() };
      return entry.request;
    });
  }

  running() {
    return this.transaction((records) => records.flatMap(({ request, token }) => request.status === "running" && token
      ? [{ id: request.id, token, executor: request.executor, terminalId: request.terminalId }] : []));
  }

  complete(id: string, token: string, result: CommandResult) {
    return this.transaction((records) => {
      const entry = records.find(({ request }) => request.id === id);
      if (!entry || entry.token !== token) throw new Error("This result does not belong to this command.");
      if (entry.request.status === "completed" || entry.request.status === "failed") return entry.request;
      if (entry.request.status !== "running") throw new Error("This command is not running.");
      entry.request = { ...entry.request, status: result.exitCode === 0 && !result.error ? "completed" : "failed", result, finishedAt: this.now() };
      entry.notificationId = randomUUID();
      entry.notified = false;
      return entry.request;
    });
  }

  notifications() {
    return this.transaction((records) => records.flatMap(({ request, notificationId, notified }) =>
      (request.status === "completed" || request.status === "failed") && notificationId && !notified
        ? [{ request, notificationId }] : []));
  }

  acknowledgeNotification(id: string, notificationId: string) {
    return this.transaction((records) => {
      const entry = records.find(({ request }) => request.id === id);
      if (entry?.notificationId === notificationId) entry.notified = true;
    });
  }

  private pending(records: RecordEntry[], id: string) {
    const entry = records.find(({ request }) => request.id === id);
    if (!entry || entry.request.status !== "pending") throw new Error("This request is no longer awaiting approval.");
    return entry;
  }

  async close() { await this.tail; await this.ready; }
}

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { setImmediate } from "node:timers/promises";
import { test, type TestContext } from "node:test";
import type { PluginClientContext } from "@getpaseo/plugin/client";
import { notifyPendingCommands } from "../client/notifications.ts";
import { createDesktopNotifications, type DesktopNotificationPermission, type DesktopNotifications } from "../client/web.ts";
import type { CommandRequest } from "../shared/commands.ts";

function request(): CommandRequest {
  return {
    id: randomUUID(), command: "printf secret", reason: "Private reason", status: "pending",
    createdAt: 0, expiresAt: Date.now() + 86_400_000,
    requester: { agentId: "agent", title: "Requester", workspaceId: null },
  };
}

function watcher(t: TestContext, initial: DesktopNotificationPermission = "granted") {
  t.mock.timers.enable({ apis: ["setInterval"] });
  const state = { requests: [request()], permission: initial, online: true, calls: 0, opened: 0 };
  const shown: { id: string; click: () => void; closed: boolean }[] = [];
  const notifications: DesktopNotifications = {
    permission: () => state.permission,
    requestPermission: async () => { assert.fail("Polling must never request permission"); },
    observePermission: () => () => {},
    show(id, click) {
      const notification = { id, click, closed: false };
      shown.push(notification);
      return () => { notification.closed = true; };
    },
  };
  const client: Pick<PluginClientContext, "rpc" | "openScreen"> = {
    async rpc(contract) {
      assert.equal(contract.name, "commands.list", "Notifications must only read the queue");
      state.calls++;
      if (!state.online) throw new Error("Disconnected");
      return contract.output.parse(state.requests);
    },
    openScreen(input) { assert.deepEqual(input, { screenId: "queue" }); state.opened++; },
  };
  const stop = notifyPendingCommands(client, notifications);
  t.after(stop);
  return { state, shown, stop, async poll() { t.mock.timers.tick(2_000); await setImmediate(); } };
}

test("pending requests alert once; clicking only opens the review queue", async (t) => {
  const { state, shown, poll } = watcher(t);
  await setImmediate();
  assert.equal(shown.length, 1);
  shown[0].click();
  assert.equal(state.opened, 1);
  await poll();
  assert.equal(shown.length, 1, "A clicked or dismissed alert must not repeat every poll");
  const first = state.requests[0];
  state.requests = [{ ...first, status: "denied", decidedAt: 1 }, request()];
  await poll();
  assert.equal(shown[0].closed, true);
  assert.equal(shown.length, 2);
  assert.equal(shown[1].id, state.requests[1].id);
});

test("polling waits for explicit notification permission and closes alerts when it is revoked", async (t) => {
  const { state, shown, poll } = watcher(t, "default");
  await poll();
  assert.equal(state.calls, 0);
  state.permission = "granted";
  await poll();
  assert.equal(shown.length, 1);
  state.permission = "denied";
  await poll();
  assert.equal(shown[0].closed, true);
  assert.equal(state.calls, 1);
});

test("a disconnection retains alert history and reconnect finds new pending requests", async (t) => {
  const { state, shown, poll } = watcher(t);
  await setImmediate();
  state.online = false;
  await poll();
  assert.equal(shown[0].closed, false);
  state.online = true;
  state.requests.push(request());
  await poll();
  assert.equal(shown.length, 2);
});

test("unloading closes alerts, disables their callbacks, and stops polling", async (t) => {
  const { state, shown, poll, stop } = watcher(t);
  await setImmediate();
  stop();
  assert.equal(shown[0].closed, true);
  shown[0].click();
  assert.equal(state.opened, 0);
  const calls = state.calls;
  await poll();
  assert.equal(state.calls, calls);
});

test("a slow queue read cannot overlap another poll or alert after unloading", async (t) => {
  t.mock.timers.enable({ apis: ["setInterval"] });
  let resolve!: () => void;
  const pending = new Promise<void>((done) => { resolve = done; });
  let calls = 0;
  let alerts = 0;
  const client: Pick<PluginClientContext, "rpc" | "openScreen"> = {
    async rpc(contract) { calls++; await pending; return contract.output.parse([request()]); },
    openScreen() { assert.fail("Unloaded plugin must not navigate"); },
  };
  const stop = notifyPendingCommands(client, {
    permission: () => "granted", requestPermission: async () => "granted", observePermission: () => () => {},
    show() { alerts++; return () => {}; },
  });
  t.after(stop);
  t.mock.timers.tick(10_000);
  assert.equal(calls, 1);
  stop();
  resolve();
  await setImmediate();
  assert.equal(alerts, 0);
});

function browser(t: TestContext) {
  const descriptor = Object.getOwnPropertyDescriptor(globalThis, "window");
  const instances: FakeNotification[] = [];
  let permissionRequests = 0;
  let focused = 0;
  const listeners = new Set<() => void>();
  class FakeNotification {
    static permission: NotificationPermission = "default";
    static requestPermission() { permissionRequests++; return Promise.resolve(FakeNotification.permission); }
    onclick: (() => void) | null = null;
    closed = 0;
    constructor(public title: string, public options: NotificationOptions) { instances.push(this); }
    close() { this.closed++; }
  }
  const window = {
    isSecureContext: true, Notification: FakeNotification,
    focus() { focused++; },
    addEventListener(event: string, listener: () => void) { assert.equal(event, "focus"); listeners.add(listener); },
    removeEventListener(event: string, listener: () => void) { assert.equal(event, "focus"); listeners.delete(listener); },
  };
  Object.defineProperty(globalThis, "window", { value: window, configurable: true });
  t.after(() => {
    if (descriptor) Object.defineProperty(globalThis, "window", descriptor);
    else Reflect.deleteProperty(globalThis, "window");
  });
  return { window, instances, listeners, permissionRequests: () => permissionRequests, focused: () => focused };
}

test("desktop API requests permission only on demand and respects unavailable platforms", async (t) => {
  const env = browser(t);
  const desktop = createDesktopNotifications("web");
  assert.equal(desktop.permission(), "default");
  assert.equal(desktop.show("request", () => assert.fail()), undefined);
  assert.equal(env.permissionRequests(), 0);
  assert.equal(await desktop.requestPermission(), "default");
  assert.equal(env.permissionRequests(), 1);
  env.window.Notification.permission = "granted";
  for (const platform of ["ios", "android"]) {
    const native = createDesktopNotifications(platform);
    assert.equal(native.permission(), "unsupported");
    assert.equal(await native.requestPermission(), "unsupported");
    assert.equal(native.show("request", () => assert.fail()), undefined);
  }
  env.window.isSecureContext = false;
  assert.equal(desktop.permission(), "unsupported");
  Reflect.deleteProperty(globalThis, "window");
  assert.equal(desktop.permission(), "unsupported");
});

test("desktop alerts have stable request tags, generic text, click navigation, and cleanup", (t) => {
  const env = browser(t);
  env.window.Notification.permission = "granted";
  const desktop = createDesktopNotifications("web");
  let clicks = 0;
  const close = desktop.show("request-123", () => { clicks++; });
  assert.ok(close);
  const notification = env.instances[0];
  assert.equal(notification.options.tag, "paseo-client-command:request-123");
  assert.equal(notification.title, "Client command awaiting approval");
  assert.match(notification.options.body!, /review/);
  const click = notification.onclick!;
  click();
  assert.equal(clicks, 1);
  assert.equal(env.focused(), 1);
  assert.equal(notification.closed, 1);
  assert.equal(notification.onclick, null);
  click();
  assert.equal(clicks, 1);
  close();
});

test("permission observers release their browser listener on screen teardown", (t) => {
  const env = browser(t);
  const desktop = createDesktopNotifications("web");
  let updates = 0;
  const stop = desktop.observePermission(() => { updates++; });
  for (const listener of env.listeners) listener();
  assert.equal(updates, 1);
  stop();
  assert.equal(env.listeners.size, 0);
});

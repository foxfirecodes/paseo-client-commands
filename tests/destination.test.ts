import assert from "node:assert/strict";
import { test } from "node:test";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { useDestination } from "../client/destination.ts";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

test("leaving and returning to the queue restores its destination and collapsed state", async () => {
  let selection!: ReturnType<typeof useDestination>;
  function Queue() {
    selection = useDestination("restore-test-server");
    return null;
  }
  let screen!: ReactTestRenderer;
  await act(async () => { screen = create(createElement(Queue)); });
  assert.deepEqual(selection[0], { expanded: true });
  const saved = { executorId: "my-laptop", workspaceId: "my-workspace", expanded: false };
  await act(async () => selection[1](saved));
  await act(async () => screen.unmount());
  await act(async () => { screen = create(createElement(Queue)); });
  try {
    assert.deepEqual(selection[0], saved);
    await act(async () => selection[1]({ ...selection[0], expanded: true }));
    await act(async () => screen.unmount());
    await act(async () => { screen = create(createElement(Queue)); });
    assert.deepEqual(selection[0], { ...saved, expanded: true });
  } finally {
    await act(async () => screen.unmount());
  }
});

test("switching source servers restores each server's own destination", async () => {
  let selection!: ReturnType<typeof useDestination>;
  function Queue({ sourceHostId }: { sourceHostId: string }) {
    selection = useDestination(sourceHostId);
    return null;
  }
  let screen!: ReactTestRenderer;
  await act(async () => { screen = create(createElement(Queue, { sourceHostId: "first-source-server" })); });
  const first = { executorId: "first-laptop", workspaceId: "first-workspace", expanded: false };
  const second = { executorId: "second-laptop", workspaceId: "second-workspace", expanded: true };
  try {
    await act(async () => selection[1](first));
    await act(async () => screen.update(createElement(Queue, { sourceHostId: "second-source-server" })));
    assert.deepEqual(selection[0], { expanded: true });
    await act(async () => selection[1](second));
    await act(async () => screen.update(createElement(Queue, { sourceHostId: "first-source-server" })));
    assert.deepEqual(selection[0], first);
    await act(async () => screen.update(createElement(Queue, { sourceHostId: "second-source-server" })));
    assert.deepEqual(selection[0], second);
  } finally {
    await act(async () => screen.unmount());
  }
});

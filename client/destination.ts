import { useSyncExternalStore } from "react";

interface Destination {
  executorId?: string;
  workspaceId?: string;
  expanded: boolean;
}

// The plugin client outlives its screens. Each source host keeps this viewer's
// selection until the plugin unloads; no destination is shared with other viewers.
const destinations = new Map<string, Destination>();
const listeners = new Set<() => void>();
const emptyDestination: Destination = { expanded: true };

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => { listeners.delete(listener); };
}

export function useDestination(sourceHostId: string): [Destination, (next: Destination) => void] {
  const destination = useSyncExternalStore(subscribe, () => destinations.get(sourceHostId) ?? emptyDestination);
  return [destination, (next) => {
    destinations.set(sourceHostId, next);
    for (const listener of listeners) listener();
  }];
}

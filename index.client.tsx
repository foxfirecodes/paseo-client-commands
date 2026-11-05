import { getPaseoClient, useRpc, type PluginClientContext, type PluginSidebarItemProps } from "@getpaseo/plugin/client";
import { SidebarRow } from "@getpaseo/plugin/client/ui";
import { useQuery } from "@tanstack/react-query";
import { Platform, Text } from "react-native";
import { QueueScreen } from "./client/queue-screen.tsx";
import { listCommands } from "./shared/commands.ts";
import { collectResults } from "./client/results.ts";
import { notifyPendingCommands } from "./client/notifications.ts";
import { createDesktopNotifications } from "./client/web.ts";

function QueueItem({ host, theme, currentScreen, openScreen }: PluginSidebarItemProps) {
  const list = useRpc(listCommands);
  const queue = useQuery({ queryKey: ["client-commands", host.id], queryFn: () => list({}), refetchInterval: 2_000 });
  const pending = queue.data?.filter((request) => request.status === "pending").length ?? 0;
  return <SidebarRow icon="Terminal" label="Client commands" active={currentScreen?.screenId === "queue"}
    trailing={pending > 0 ? <Text accessibilityLabel={`${pending} client ${pending === 1 ? "command" : "commands"} awaiting approval`}
      style={{ color: theme.colors.accentForeground, backgroundColor: theme.colors.accent, minWidth: 20, paddingHorizontal: 6, paddingVertical: 2, borderRadius: 10, textAlign: "center", fontSize: 12, fontWeight: "600" }}>{pending}</Text> : undefined}
    onPress={() => openScreen({ screenId: "queue" })} />;
}

export default function contribute(client: PluginClientContext) {
  const stopResults = collectResults(client, getPaseoClient);
  const stopNotifications = notifyPendingCommands(client, createDesktopNotifications(Platform.OS));
  client.addScreen({ id: "queue", title: "Client commands", Component: QueueScreen });
  client.addSidebarHeaderItem({ id: "queue", title: "Client commands", Component: QueueItem });
  client.addCommandCenterItem({ id: "open-queue", title: "Review client commands", icon: "Terminal", context: "global",
    onSelect: ({ openScreen }) => openScreen({ screenId: "queue" }),
  });
  return () => { stopNotifications(); stopResults(); };
}

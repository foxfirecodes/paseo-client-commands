import { getPaseoClient, useHosts, useRpc, type PluginScreenProps } from "@getpaseo/plugin/client";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { approveCommand, denyCommand, listCommands, reportLaunch, type CommandRequest, type Executor } from "../shared/commands.ts";
import { approveAndLaunch } from "./launch.ts";
import { useDestination } from "./destination.ts";
import { NotificationSettings } from "./notification-settings.tsx";

export function QueueScreen(props: PluginScreenProps) {
  // Keep mutation state and async work bound to the initiating source host.
  return <HostQueue key={props.host.id} {...props} />;
}

function HostQueue({ host, theme, layout, navigation }: PluginScreenProps) {
  const hosts = useHosts();
  const list = useRpc(listCommands);
  const approve = useRpc(approveCommand);
  const deny = useRpc(denyCommand);
  const report = useRpc(reportLaunch);
  const queries = useQueryClient();
  const [destination, setDestination] = useDestination(host.id);
  const { executorId, workspaceId } = destination;
  const lifetime = useRef<AbortController | null>(null);
  const inFlight = useRef(false);
  useEffect(() => {
    const controller = new AbortController();
    lifetime.current = controller;
    return () => controller.abort();
  }, []);

  const queueKey = ["client-commands", host.id];
  const queue = useQuery({ queryKey: queueKey, queryFn: () => list({}), refetchInterval: 2_000 });
  const executorHost = hosts.find((item) => item.serverId === executorId);
  const workspaces = useQuery({
    queryKey: ["client-command-workspaces", host.id, executorId],
    enabled: !!executorId && executorHost?.status === "online",
    queryFn: async () => {
      if (!executorId) throw new Error("Select your laptop first.");
      return (await getPaseoClient(executorId).workspaces.list()).entries;
    },
    refetchInterval: 5_000,
  });
  const workspace = workspaces.data?.find((item) => item.id === workspaceId);
  const executor: Executor | undefined = executorHost?.status === "online" && workspace
    ? { serverId: executorHost.serverId, label: executorHost.label, workspaceId: workspace.id, workspaceName: workspace.name, directory: workspace.workspaceDirectory }
    : undefined;

  const decision = useMutation({
    retry: false,
    mutationFn: async (action: { request: CommandRequest; executor?: Executor }) => {
      if (inFlight.current) throw new Error("An approval is already in progress.");
      inFlight.current = true;
      try {
        if (!action.executor) return await deny({ id: action.request.id });
        if (!lifetime.current) throw new Error("The queue is no longer open.");
        const signal = lifetime.current.signal;
        const api = getPaseoClient(action.executor.serverId);
        return await approveAndLaunch(action.request, action.executor, {
          approve, report, signal, launch: (options) => api.terminals.create(options),
        });
      } finally {
        inFlight.current = false;
      }
    },
    onSettled: () => { void queries.invalidateQueries({ queryKey: queueKey }); },
  });

  const colors = theme.colors;
  const text = { color: colors.foreground };
  const muted = { color: colors.foregroundMuted };
  const button = { borderWidth: 1, borderColor: colors.border, borderRadius: 8, padding: 12 };
  const pending = queue.data?.filter((request) => request.status === "pending") ?? [];
  const history = queue.data?.filter((request) => request.status !== "pending") ?? [];
  const busy = decision.isPending;
  const pickerExpanded = destination.expanded || !executorId || !workspaceId;

  function renderRequest(request: CommandRequest) {
    return (
      <View key={request.id} style={{ padding: 16, gap: 12, borderWidth: 1, borderColor: colors.border, borderRadius: 12 }}>
        <Text style={text}>{request.reason}</Text>
        <Text selectable style={{ ...text, fontFamily: "monospace", padding: 12, backgroundColor: colors.surface0, borderRadius: 8 }}>{request.command}</Text>
        <Text selectable style={muted}>From {request.requester.title} · {new Date(request.createdAt).toLocaleString()}</Text>
        <Text selectable style={muted}>Directory: {request.cwd ?? executor?.directory ?? "selected laptop workspace"}</Text>
        {request.status === "pending" ? (
          <View style={{ gap: 10 }}>
            <Text style={muted}>{executor ? `Run on ${executor.label} in ${executor.workspaceName}` : "Select your laptop and a workspace to approve."}</Text>
            <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
              <Pressable
                accessibilityRole="button" accessibilityLabel={`Approve and run ${request.command} on ${executor?.label ?? "your laptop"}`}
                disabled={busy || !executor || queue.isError}
                onPress={() => { if (executor) decision.mutate({ request, executor }); }}
                style={{ ...button, backgroundColor: colors.accent, opacity: busy || !executor || queue.isError ? 0.45 : 1 }}
              ><Text style={{ color: colors.accentForeground }}>{busy && decision.variables?.request.id === request.id ? "Working…" : `Yep, run on ${executor?.label ?? "laptop"}`}</Text></Pressable>
              <Pressable accessibilityRole="button" disabled={busy} onPress={() => decision.mutate({ request })} style={button}>
                <Text style={text}>Deny</Text>
              </Pressable>
            </View>
          </View>
        ) : <Text style={text}>{statusText(request)}</Text>}
        {request.status === "uncertain" && <Text selectable style={text}>{request.error} Check the laptop's terminals before requesting this command again.</Text>}
        {(request.status === "completed" || request.status === "failed") && <>
          {request.result.error && <Text selectable style={text}>{request.result.error}</Text>}
          <Text style={muted}>Combined stdout/stderr{request.result.truncated ? " · truncated tail" : ""}</Text>
          <Text selectable style={{ ...text, fontFamily: "monospace" }}>{request.result.output || "(no captured output)"}</Text>
        </>}
        {"executor" in request && navigation && (
          <Pressable accessibilityRole="button" style={button} onPress={() => navigation.openWorkspace({ serverId: request.executor.serverId, workspaceId: request.executor.workspaceId })}>
            <Text style={text}>Open {request.executor.label} workspace</Text>
          </Pressable>
        )}
      </View>
    );
  }

  return (
    <ScrollView style={{ flex: 1, backgroundColor: colors.surface0 }} contentContainerStyle={{ padding: layout.compact ? 16 : 24, gap: 18 }}>
      <Text style={{ ...text, fontSize: 24, fontWeight: "600" }}>Client commands</Text>
      <Text style={muted}>Requests from {host.label}. Choose the Paseo host running on this laptop. Commands start only when you approve them below.</Text>
      <NotificationSettings theme={theme} />
      <View style={{ flexDirection: "row", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <View style={{ flex: 1, gap: 4 }}>
          <Text style={{ ...text, fontWeight: "600" }}>Run commands on</Text>
          {executorId && <Text style={text}>{executorHost?.label ?? "Saved host unavailable"}{workspaceId ? ` · ${workspace?.name ?? (workspaces.isLoading ? "Loading workspace…" : "Workspace unavailable")}` : ""}</Text>}
        </View>
        {executorId && workspaceId && <Pressable accessibilityRole="button" accessibilityLabel={pickerExpanded ? "Collapse destination picker" : "Change destination"}
          accessibilityState={{ expanded: pickerExpanded }} disabled={busy} style={button}
          onPress={() => setDestination({ ...destination, expanded: !pickerExpanded })}>
          <Text style={text}>{pickerExpanded ? "Collapse" : "Change"}</Text>
        </Pressable>}
      </View>
      {pickerExpanded && <>
        <View style={{ flexDirection: "row", flexWrap: "wrap", gap: 10 }}>
          {hosts.map((item) => (
            <Pressable key={item.serverId} accessibilityRole="button" accessibilityState={{ selected: executorId === item.serverId }} disabled={busy || item.status !== "online"}
              onPress={() => { if (item.serverId !== executorId) setDestination({ executorId: item.serverId, expanded: true }); }}
              style={{ ...button, borderColor: executorId === item.serverId ? colors.accent : colors.border, opacity: item.status === "online" ? 1 : 0.45 }}>
              <Text style={text}>{item.label} · {item.status}</Text>
            </Pressable>
          ))}
        </View>
        <Text style={muted}>Your laptop needs a local Paseo daemon connected in this app. The desktop app starts one automatically. A browser or phone cannot spawn a shell by itself.</Text>
        {executorId && <>
          <Text style={{ ...text, fontWeight: "600" }}>Laptop workspace</Text>
          <View style={{ gap: 10 }}>
            {workspaces.data?.map((item) => (
              <Pressable key={item.id} accessibilityRole="button" accessibilityState={{ selected: workspaceId === item.id }} disabled={busy}
                onPress={() => setDestination({ executorId, workspaceId: item.id, expanded: false })} style={{ ...button, borderColor: workspaceId === item.id ? colors.accent : colors.border }}>
                <Text style={text}>{item.name}</Text><Text selectable style={muted}>{item.workspaceDirectory}</Text>
              </Pressable>
            ))}
            {workspaces.isLoading && <Text style={muted}>Loading workspaces…</Text>}
            {workspaces.data?.length === 0 && <Text style={muted}>Create a workspace on your laptop, then return here.</Text>}
          </View>
        </>}
      </>}
      {executorId && executorHost?.status !== "online" && <Text style={text}>The selected laptop is offline or unavailable. Reconnect it or change the destination before approving.</Text>}
      {executorId && workspaces.isError && <Text style={text}>Could not load laptop workspaces: {workspaces.error.message}</Text>}
      {executorHost?.status === "online" && workspaceId && workspaces.isSuccess && !workspace && <Text style={text}>The saved workspace is no longer available. Change the destination to select another workspace.</Text>}
      {decision.isError && <Text selectable accessibilityRole="alert" style={text}>{decision.error.message}</Text>}
      {queue.isError && <Text style={text}>Could not refresh the queue: {queue.error.message}</Text>}
      <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Awaiting approval · {pending.length}</Text>
      {queue.isLoading ? <Text style={muted}>Loading requests…</Text> : pending.length === 0 && <Text style={muted}>No commands waiting. Your server agent can use request_client_command to add one.</Text>}
      {pending.map(renderRequest)}
      {history.length > 0 && <Text style={{ ...text, fontSize: 18, fontWeight: "600" }}>Recent requests</Text>}
      {history.map(renderRequest)}
    </ScrollView>
  );
}

function statusText(request: CommandRequest) {
  switch (request.status) {
    case "pending": return "Awaiting approval";
    case "approved": return `Approved for ${request.executor.label}; launch not yet confirmed. Do not submit it again.`;
    case "launched": return `Terminal launched on ${request.executor.label} · ${request.terminalId}. Check the terminal for output and exit status.`;
    case "running": return `Running on ${request.executor.label} · ${request.terminalId}`;
    case "completed": return `Completed on ${request.executor.label} · exit code ${request.result.exitCode}`;
    case "failed": return `Failed on ${request.executor.label} · ${request.result.exitCode === null ? "exit code unknown" : `exit code ${request.result.exitCode}`}`;
    case "denied": return "Denied";
    case "expired": return "Expired without approval";
    case "uncertain": return `Launch uncertain on ${request.executor.label}`;
  }
}

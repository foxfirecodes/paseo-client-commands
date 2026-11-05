import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { useEffect, useState } from "react";
import { Platform, Pressable, Text, View } from "react-native";
import { createDesktopNotifications } from "./web.ts";

const notifications = createDesktopNotifications(Platform.OS);

export function NotificationSettings({ theme }: Pick<PluginScreenProps, "theme">) {
  const [permission, setPermission] = useState(notifications.permission);
  const [requesting, setRequesting] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => notifications.observePermission(() => setPermission(notifications.permission())), []);

  async function enable() {
    setRequesting(true);
    setError(undefined);
    try { setPermission(await notifications.requestPermission()); }
    catch (error) { setError(error instanceof Error ? error.message : String(error)); }
    finally { setRequesting(false); }
  }

  const colors = theme.colors;
  return (
    <View style={{ padding: 14, gap: 8, borderWidth: 1, borderColor: colors.border, borderRadius: 10 }}>
      <Text style={{ color: colors.foreground, fontWeight: "600" }}>Desktop notifications</Text>
      <Text style={{ color: colors.foregroundMuted }}>{
        permission === "granted" ? "Enabled on this device. New pending requests alert you even when this page is closed." :
        permission === "denied" ? "Blocked on this device. Allow notifications for Paseo in your browser or system settings." :
        permission === "unsupported" ? "Desktop notifications are unavailable in this client. The sidebar badge still shows pending requests." :
        "Get an alert when a command needs your approval. Clicking it opens this queue."
      }</Text>
      {permission === "default" && <Pressable accessibilityRole="button" disabled={requesting} onPress={() => void enable()}
        style={{ alignSelf: "flex-start", padding: 10, borderRadius: 8, backgroundColor: colors.accent, opacity: requesting ? 0.5 : 1 }}>
        <Text style={{ color: colors.accentForeground }}>{requesting ? "Requesting permission…" : "Enable notifications"}</Text>
      </Pressable>}
      {error && <Text accessibilityRole="alert" style={{ color: colors.foreground }}>{error}</Text>}
    </View>
  );
}

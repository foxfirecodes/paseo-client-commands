export type DesktopNotificationPermission = NotificationPermission | "unsupported";

export interface DesktopNotifications {
  permission(): DesktopNotificationPermission;
  requestPermission(): Promise<DesktopNotificationPermission>;
  show(requestId: string, onClick: () => void): (() => void) | undefined;
  observePermission(listener: () => void): () => void;
}

// Keep browser APIs behind the platform boundary: this bundle also runs on phones.
export function createDesktopNotifications(platform: string): DesktopNotifications {
  function api() {
    if (platform !== "web" || typeof window === "undefined" || window.isSecureContext === false || typeof window.Notification !== "function") return;
    return window.Notification;
  }

  return {
    permission: () => api()?.permission ?? "unsupported",
    async requestPermission() {
      // Called directly by the enable button, while its user gesture is active.
      return api()?.requestPermission() ?? "unsupported";
    },
    show(requestId, onClick) {
      const NotificationApi = api();
      if (NotificationApi?.permission !== "granted") return;
      const notification = new NotificationApi("Client command awaiting approval", {
        body: "A server agent requested a command. Open Client commands in Paseo to review it.",
        tag: `paseo-client-command:${requestId}`,
      });
      let active = true;
      function close() {
        if (!active) return;
        active = false;
        notification.onclick = null;
        notification.close();
      }
      notification.onclick = () => {
        if (!active) return;
        try {
          try { window.focus(); } catch { /* Opening the queue still works if focus is denied. */ }
          onClick();
        } finally { close(); }
      };
      return close;
    },
    observePermission(listener) {
      if (!api()) return () => {};
      window.addEventListener("focus", listener);
      return () => window.removeEventListener("focus", listener);
    },
  };
}

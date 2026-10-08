/** Browser Web Push opt-in. Permission is requested ONLY from an explicit click. */
export type PushState =
  | "unsupported"
  | "open-in-new-tab"
  | "default"
  | "denied"
  | "subscribed"
  | "unlinked"
  | "not-subscribed"
  | "not-configured";

export function pushSupport(): PushState | null {
  if (typeof window === "undefined") return null;
  if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window))
    return "unsupported";
  if (window.top !== window.self) return "open-in-new-tab";
  return null;
}

const toKey = (b64: string) => {
  const s = b64.replace(/-/g, "+").replace(/_/g, "/");
  const p = s + "===".slice((s.length + 3) % 4);
  return Uint8Array.from(atob(p), (c) => c.charCodeAt(0));
};
const b64u = (buf: ArrayBuffer | null) =>
  buf
    ? btoa(String.fromCharCode(...new Uint8Array(buf)))
        .replace(/\+/g, "-")
        .replace(/\//g, "_")
        .replace(/=+$/, "")
    : "";

export async function currentPushState(): Promise<PushState> {
  const s = pushSupport();
  if (s) return s;
  if (Notification.permission === "denied") return "denied";
  const reg = await navigator.serviceWorker.getRegistration("/signal-sw.js");
  const sub = await reg?.pushManager.getSubscription();
  return sub ? "subscribed" : Notification.permission === "default" ? "default" : "not-subscribed";
}
export async function currentPushEndpoint(): Promise<string | null> {
  if (pushSupport()) return null;
  const reg = await navigator.serviceWorker.getRegistration("/signal-sw.js");
  return (await reg?.pushManager.getSubscription())?.endpoint ?? null;
}

export async function subscribePush(
  publicKey: string,
): Promise<{ endpoint: string; p256dh: string; auth: string } | PushState> {
  const s = pushSupport();
  if (s) return s;
  const perm =
    Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (perm !== "granted") return "denied";
  const reg = await navigator.serviceWorker.register("/signal-sw.js");
  await navigator.serviceWorker.ready;
  const sub =
    (await reg.pushManager.getSubscription()) ??
    (await reg.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: toKey(publicKey),
    }));
  return {
    endpoint: sub.endpoint,
    p256dh: b64u(sub.getKey("p256dh")),
    auth: b64u(sub.getKey("auth")),
  };
}

export async function unsubscribePush(): Promise<string | null> {
  const reg = await navigator.serviceWorker.getRegistration("/signal-sw.js");
  const sub = await reg?.pushManager.getSubscription();
  if (!sub) return null;
  const ep = sub.endpoint;
  await sub.unsubscribe();
  return ep;
}

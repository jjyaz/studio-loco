/* Studio Loco Signal Box service worker: displays alerts and opens a fresh-context handoff.
   It never stores or approves transactions; clicking only navigates. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (e) => e.waitUntil(self.clients.claim()));
self.addEventListener("push", (event) => {
  let d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  const url = typeof d.url === "string" && d.url.startsWith("/") ? d.url : "/app/signal-box";
  event.waitUntil(self.registration.showNotification(String(d.title || "Signal Box"), {
    body: String(d.body || "A watch rule triggered. Open for a fresh review."),
    icon: "/favicon.png", badge: "/favicon-32.png", tag: d.alert ? `alert-${d.alert}` : undefined, data: { url },
  }));
});
self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || "/app/signal-box";
  event.waitUntil((async () => {
    const all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of all) { if (new URL(c.url).origin === self.location.origin && "navigate" in c) { await c.focus(); return c.navigate(url); } }
    return self.clients.openWindow(url);
  })());
});

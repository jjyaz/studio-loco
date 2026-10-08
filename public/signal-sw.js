/* Studio Loco Signal Box service worker: displays alerts and opens the inbox for that alert.
   It never stores or approves transactions. Navigation is only ever to this origin's
   /app/signal-box with a validated alert UUID — payload-supplied URLs are ignored. */
var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function signalHandoffPath(alert) {
  return typeof alert === "string" && UUID_RE.test(alert) ? "/app/signal-box?alert=" + alert.toLowerCase() : "/app/signal-box";
}
self.signalHandoffPath = signalHandoffPath;
self.addEventListener("install", function () { self.skipWaiting(); });
self.addEventListener("activate", function (e) { e.waitUntil(self.clients.claim()); });
self.addEventListener("push", function (event) {
  var d = {};
  try { d = event.data ? event.data.json() : {}; } catch (_) { d = {}; }
  var alert = typeof d.alert === "string" && UUID_RE.test(d.alert) ? d.alert.toLowerCase() : null;
  event.waitUntil(self.registration.showNotification(String(d.title || "Signal Box").slice(0, 80), {
    body: String(d.body || "A watch rule triggered. Open the inbox for details.").slice(0, 200),
    icon: "/favicon.png", badge: "/favicon-32.png", tag: alert ? "alert-" + alert : undefined, data: { alert: alert },
  }));
});
self.addEventListener("notificationclick", function (event) {
  event.notification.close();
  var path = signalHandoffPath(event.notification.data && event.notification.data.alert);
  var url = new URL(path, self.location.origin).href;
  event.waitUntil((async function () {
    var all = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (var i = 0; i < all.length; i++) {
      var c = all[i];
      if (new URL(c.url).origin === self.location.origin && "navigate" in c) { await c.focus(); return c.navigate(url); }
    }
    return self.clients.openWindow(url);
  })());
});

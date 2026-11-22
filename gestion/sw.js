/* Tout'zafer · Gestion : notifications des nouvelles demandes.
   Ce service ne met rien en cache : la page reste toujours à jour. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));

self.addEventListener("push", e => {
  let d = {};
  try { d = e.data ? e.data.json() : {}; } catch (x) { d = { body: e.data ? e.data.text() : "" }; }
  e.waitUntil((async () => {
    await self.registration.showNotification(d.title || "Tout’zafer", {
      body: d.body || "", tag: d.tag || "tz", renotify: true,
      icon: "../img/ico/gestion-192.png", data: { url: d.url || "./" }
    });
    if (typeof d.n === "number" && self.navigator && self.navigator.setAppBadge) {
      try { d.n > 0 ? await self.navigator.setAppBadge(d.n) : await self.navigator.clearAppBadge(); } catch (x) {}
    }
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    wins.forEach(c => c.postMessage({ type: "refresh" }));
  })());
});

self.addEventListener("notificationclick", e => {
  e.notification.close();
  const url = new URL((e.notification.data && e.notification.data.url) || "./", self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const c of wins) {
      if (c.url.startsWith(self.registration.scope)) { await c.focus(); c.postMessage({ type: "refresh", tab: "orders" }); return; }
    }
    await self.clients.openWindow(url);
  })());
});

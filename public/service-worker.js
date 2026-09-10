"use strict";

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || payload.status !== "at_risk") return;
  const projected = Number(payload.projectedPercent);
  const body = Number.isFinite(projected)
    ? `Projected ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(projected)}% used by reset.`
    : "Current usage is projected to finish over budget.";
  event.waitUntil(self.registration.showNotification("Usage over budget", {
    body,
    tag: "usage-at-risk",
    renotify: true,
    data: { url: "/" },
  }));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  event.waitUntil((async () => {
    const target = new URL("/", self.location.origin);
    const windows = await self.clients.matchAll({ type: "window", includeUncontrolled: true });
    for (const client of windows) {
      if (new URL(client.url).origin !== self.location.origin) continue;
      if ("navigate" in client) await client.navigate(target.href);
      return client.focus();
    }
    return self.clients.openWindow(target.href);
  })());
});

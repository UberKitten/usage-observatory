"use strict";

self.addEventListener("push", (event) => {
  let payload;
  try {
    payload = event.data?.json();
  } catch {
    return;
  }
  if (!payload || typeof payload !== "object") return;

  let title;
  let body;
  let tag;
  if (payload.type === "overBudget") {
    const projected = payload.projectedPercent === null ? NaN : Number(payload.projectedPercent);
    title = "Usage over budget";
    body = Number.isFinite(projected)
      ? `Projected ${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(projected)}% used by reset.`
      : "Current usage is over budget.";
    tag = "usage-over-budget";
  } else if (payload.type === "remaining") {
    const remaining = payload.remainingPercent === null ? NaN : Number(payload.remainingPercent);
    const suppliedThresholds = Array.isArray(payload.thresholds) ? payload.thresholds : [];
    const thresholds = [25, 15, 5].filter((value) => suppliedThresholds.includes(value));
    if (!Number.isFinite(remaining) || !thresholds.length) return;
    const crossed = new Intl.ListFormat(undefined, { style: "short", type: "conjunction" })
      .format(thresholds.map((value) => `${value}%`));
    title = "Usage running low";
    body = `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(remaining)}% remaining · crossed ${crossed}.`;
    tag = "usage-remaining";
  } else if (payload.type === "weeklyReset") {
    title = "Weekly usage reset";
    body = "Weekly allowance has reset.";
    tag = "usage-weekly-reset";
  } else if (payload.type === "unscheduledReset") {
    title = "Unscheduled usage reset";
    body = "Allowance reset earlier than scheduled.";
    tag = "usage-unscheduled-reset";
  } else {
    return;
  }

  event.waitUntil(self.registration.showNotification(title, {
    body,
    tag,
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

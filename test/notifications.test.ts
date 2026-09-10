import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageCollector, type CollectorConfig } from "../src/collector";
import { DatabaseStore } from "../src/db";
import {
  PushNotificationService,
  loadVapidConfiguration,
  type PushSender,
  type VapidConfiguration,
} from "../src/notifications";
import { createRequestHandler } from "../src/server";
import type {
  CollectionResult,
  NormalizedObservation,
  PaceStatus,
  PaceSummary,
  PushSubscriptionInput,
} from "../src/types";

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-observatory-push-test-"));
  roots.push(root);
  return root;
}

function fixtureCollectorConfig(): CollectorConfig {
  return {
    mode: "fixture",
    usageEndpoint: "https://chatgpt.com/backend-api/wham/usage",
    tokenFile: null,
    accountIdFile: null,
    oauthFile: null,
    oauthIssuer: "https://auth.openai.com",
    oauthClientId: "test-client",
    usageCommand: ["false"],
    intervalSeconds: 300,
    staleAfterSeconds: 900,
    requestTimeoutMilliseconds: 2_000,
    backoffBaseSeconds: 30,
    backoffMaximumSeconds: 900,
    autoRedeem: false,
    autoRedeemHorizonHours: 12,
    maximumReportAgeSeconds: 600,
  };
}

function observation(observedAt: string): NormalizedObservation {
  return {
    observedAt,
    account: { planType: null, subscriptionExpiresAt: null, renewalAt: null },
    windows: [],
    credits: { hasCredits: null, balance: null },
    resetCredits: { availableCount: null, earliestExpiresAt: null, actionSupported: false },
  };
}

function pace(status: PaceStatus, projectedUsedAtReset: number | null = null): PaceSummary {
  return {
    status,
    ratio: null,
    recentRatePercentPerHour: null,
    projectedUsedAtReset,
    projectedExhaustionAt: null,
    basisHours: null,
    explanation: "Test pace.",
  };
}

function vapidConfiguration(): VapidConfiguration {
  return {
    subject: "mailto:operator@example.invalid",
    publicKey: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 1)]).toString("base64url"),
    privateKey: Buffer.alloc(32, 2).toString("base64url"),
  };
}

function browserSubscription(suffix = "synthetic"): PushSubscriptionInput {
  return {
    endpoint: `https://fcm.googleapis.com/fcm/send/test-only-${suffix}`,
    expirationTime: null,
    keys: {
      p256dh: Buffer.concat([Buffer.from([4]), Buffer.alloc(64, 3)]).toString("base64url"),
      auth: Buffer.alloc(16, 4).toString("base64url"),
    },
  };
}

function collection(observationId: number, observedAt: string): CollectionResult {
  return {
    ok: true,
    state: "healthy",
    observedAt,
    observationId,
    error: null,
    nextAttemptAt: null,
    redemptionAudit: null,
  };
}

function insert(store: DatabaseStore, sequence: number, gapThresholdSeconds = 10_000): CollectionResult {
  const observedAt = new Date(Date.UTC(2026, 8, 1, 0, sequence)).toISOString();
  const observationId = store.insertObservation(observation(observedAt), "fixture", gapThresholdSeconds);
  return collection(observationId, observedAt);
}

describe("Web Push transition dispatch", () => {
  test("requires opt-in, baselines the current pace, sends once, rearms on recovery, and honors opt-out", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    let currentPace = pace("on_track", 99);
    const payloads: string[] = [];
    const sender: PushSender = async (_subscription, payload) => {
      payloads.push(payload);
    };
    const notifications = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => currentPace,
      { send: sender, sleep: async () => {} },
    );

    notifications.initializeBaseline();
    const first = insert(store, 0);
    await notifications.handleCollection(first);
    currentPace = pace("exhausted", 100);
    await notifications.handleCollection(insert(store, 1));
    expect(payloads).toEqual([]);

    notifications.subscribe(browserSubscription());
    expect(payloads).toEqual([]);
    await notifications.handleCollection(insert(store, 2));
    expect(payloads).toEqual([]);

    currentPace = pace("on_track", 100);
    await notifications.handleCollection(insert(store, 3));
    currentPace = pace("at_risk", 121.3);
    await notifications.handleCollection(insert(store, 4));
    await notifications.handleCollection(insert(store, 5));
    expect(payloads.map((payload) => JSON.parse(payload))).toEqual([
      { status: "at_risk", projectedPercent: 121.3 },
    ]);

    currentPace = pace("room_to_spend", 80);
    await notifications.handleCollection(insert(store, 6));
    currentPace = pace("at_risk", 130);
    await notifications.handleCollection(insert(store, 7));
    expect(payloads).toHaveLength(2);

    notifications.unsubscribe(browserSubscription().endpoint);
    currentPace = pace("on_track", 100);
    await notifications.handleCollection(insert(store, 8));
    currentPace = pace("at_risk", 110);
    await notifications.handleCollection(insert(store, 9));
    expect(payloads).toHaveLength(2);
    store.close();
  });

  test("persists the cursor before delivery and suppresses repeats, restart replay, gaps, and unknown paths", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    let currentPace = pace("on_track", 100);
    const deliveredAtCursors: number[] = [];
    const sender: PushSender = async () => {
      deliveredAtCursors.push(store.getPushTransitionState()?.lastObservationId ?? -1);
    };
    const dependencies = { send: sender, sleep: async () => {} };
    const notifications = new PushNotificationService(store, vapidConfiguration(), () => currentPace, dependencies);
    const initial = insert(store, 0);
    notifications.initializeBaseline();
    notifications.subscribe(browserSubscription("restart"));

    currentPace = pace("at_risk", 120);
    const crossing = insert(store, 1);
    await notifications.handleCollection(crossing);
    expect(deliveredAtCursors).toEqual([crossing.observationId!]);

    const restarted = new PushNotificationService(store, vapidConfiguration(), () => currentPace, dependencies);
    restarted.initializeBaseline();
    await restarted.handleCollection(crossing);
    await restarted.handleCollection(insert(store, 2));
    expect(deliveredAtCursors).toHaveLength(1);

    currentPace = pace("unknown");
    await restarted.handleCollection(insert(store, 3));
    currentPace = pace("at_risk", 125);
    await restarted.handleCollection(insert(store, 4));
    currentPace = pace("exhausted", 140);
    await restarted.handleCollection(insert(store, 5));
    expect(deliveredAtCursors).toHaveLength(1);

    currentPace = pace("on_track", 100);
    await restarted.handleCollection(insert(store, 6));
    currentPace = pace("exhausted", 140);
    const exhaustionCrossing = insert(store, 7);
    await restarted.handleCollection(exhaustionCrossing);
    currentPace = pace("at_risk", 115);
    await restarted.handleCollection(insert(store, 8));
    currentPace = pace("on_track", 100);
    await restarted.handleCollection(insert(store, 9));
    currentPace = pace("at_risk", 115);
    await restarted.handleCollection(insert(store, 20, 60));
    await restarted.handleCollection(insert(store, 21));
    expect(deliveredAtCursors).toEqual([crossing.observationId!, exhaustionCrossing.observationId!]);
    expect(store.getPushTransitionState()?.paceStatus).toBe("at_risk");
    expect(initial.observationId).toBeGreaterThan(0);
    store.close();
  });

  test("prunes gone subscriptions, retries an explicit transient response once, and does not retry ambiguity", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    let currentPace = pace("on_track", 100);
    const attempts: Record<string, number> = {};
    const sender: PushSender = async (subscription) => {
      attempts[subscription.endpoint] = (attempts[subscription.endpoint] ?? 0) + 1;
      if (subscription.endpoint.endsWith("ambiguous")) throw new Error("synthetic ambiguous transport failure");
      const error = new Error("synthetic push rejection") as Error & { statusCode: number };
      error.statusCode = subscription.endpoint.endsWith("gone") ? 410 : 503;
      if (subscription.endpoint.endsWith("transient") && attempts[subscription.endpoint] === 2) return;
      throw error;
    };
    const notifications = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => currentPace,
      { send: sender, sleep: async () => {} },
    );
    insert(store, 0);
    notifications.initializeBaseline();
    notifications.subscribe(browserSubscription("gone"));
    notifications.subscribe(browserSubscription("transient"));
    notifications.subscribe(browserSubscription("ambiguous"));
    currentPace = pace("at_risk", 120);
    await notifications.handleCollection(insert(store, 1));

    expect(attempts[browserSubscription("gone").endpoint]).toBe(1);
    expect(attempts[browserSubscription("transient").endpoint]).toBe(2);
    expect(attempts[browserSubscription("ambiguous").endpoint]).toBe(1);
    expect(store.getPushSubscriptionCount()).toBe(2);
    store.close();
  });
});

describe("Web Push API and configuration boundary", () => {
  test("keeps private VAPID material out of config and enforces origin, schema, endpoint allowlist, and unsubscribe", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const collector = new UsageCollector(store, fixtureCollectorConfig());
    const config = vapidConfiguration();
    const notifications = new PushNotificationService(store, config, () => pace("on_track"), {
      send: async () => {},
    });
    const handler = createRequestHandler(store, collector, join(root, "public"), notifications);

    const configResponse = await handler(new Request("https://observatory.example/api/push/config"));
    const configBody = await configResponse.json();
    expect(configBody).toEqual({ enabled: true, publicKey: config.publicKey });
    expect(JSON.stringify(configBody)).not.toContain(config.privateKey);

    const subscription = browserSubscription("api");
    const missingOrigin = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(subscription),
    }));
    expect(missingOrigin.status).toBe(403);

    const crossOrigin = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://other.example" },
      body: JSON.stringify(subscription),
    }));
    expect(crossOrigin.status).toBe(403);

    const rejectedSchema = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({ ...subscription, unexpected: true }),
    }));
    expect(rejectedSchema.status).toBe(400);

    const oversized = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({ padding: "x".repeat(8_192) }),
    }));
    expect(oversized.status).toBe(413);

    const rejectedEndpoint = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({ ...subscription, endpoint: "https://127.0.0.1/private" }),
    }));
    expect(rejectedEndpoint.status).toBe(400);
    expect(store.getPushSubscriptionCount()).toBe(0);

    const subscribeResponse = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify(subscription),
    }));
    expect(subscribeResponse.status).toBe(201);
    expect(await subscribeResponse.json()).toEqual({ subscribed: true });
    expect(store.getPushSubscriptionCount()).toBe(1);

    const unsubscribeResponse = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "DELETE",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({ endpoint: subscription.endpoint }),
    }));
    expect(unsubscribeResponse.status).toBe(200);
    expect(await unsubscribeResponse.json()).toEqual({ subscribed: false });
    expect(store.getPushSubscriptionCount()).toBe(0);
    store.close();
  });

  test("requires an owner-only VAPID file", () => {
    const path = join(scratch(), "vapid.json");
    const config = vapidConfiguration();
    writeFileSync(path, JSON.stringify(config), { mode: 0o644 });
    chmodSync(path, 0o644);
    expect(() => loadVapidConfiguration({ VAPID_FILE: path })).toThrow("mode 0600");
    chmodSync(path, 0o600);
    expect(loadVapidConfiguration({ VAPID_FILE: path })).toEqual(config);
  });
});

describe("notification service worker", () => {
  test("shows the minimal over-budget payload and focuses the protected root when clicked", async () => {
    const source = readFileSync(join(import.meta.dir, "..", "public", "service-worker.js"), "utf8");
    const listeners: Record<string, (event: Record<string, unknown>) => void> = {};
    const shown: Array<{ title: string; options: Record<string, unknown> }> = [];
    const navigated: string[] = [];
    let focused = 0;
    const worker = {
      location: { origin: "https://observatory.example" },
      registration: {
        showNotification: async (title: string, options: Record<string, unknown>) => {
          shown.push({ title, options });
        },
      },
      clients: {
        matchAll: async () => [{
          url: "https://observatory.example/history",
          navigate: async (url: string) => { navigated.push(url); },
          focus: async () => { focused += 1; },
        }],
        openWindow: async () => { throw new Error("existing app window should be reused"); },
      },
      addEventListener: (type: string, listener: (event: Record<string, unknown>) => void) => {
        listeners[type] = listener;
      },
    };
    Function("self", source)(worker);

    let pushCompletion: Promise<unknown> | null = null;
    listeners.push({
      data: { json: () => ({ status: "at_risk", projectedPercent: 123.4 }) },
      waitUntil: (promise: Promise<unknown>) => { pushCompletion = promise; },
    });
    await pushCompletion;
    expect(shown).toEqual([{
      title: "Usage over budget",
      options: {
        body: "Projected 123.4% used by reset.",
        tag: "usage-at-risk",
        renotify: true,
        data: { url: "/" },
      },
    }]);

    let clickCompletion: Promise<unknown> | null = null;
    let closed = 0;
    listeners.notificationclick({
      notification: {
        data: { url: "https://untrusted.example/" },
        close: () => { closed += 1; },
      },
      waitUntil: (promise: Promise<unknown>) => { clickCompletion = promise; },
    });
    await clickCompletion;
    expect(closed).toBe(1);
    expect(navigated).toEqual(["https://observatory.example/"]);
    expect(focused).toBe(1);
  });
});

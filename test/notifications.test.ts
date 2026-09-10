import { afterEach, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageCollector, type CollectorConfig } from "../src/collector";
import { DatabaseStore } from "../src/db";
import {
  DEFAULT_PUSH_PREFERENCES,
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
  PushPreferences,
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

function observation(
  observedAt: string,
  usedPercent = 0,
  resetsAt = "2026-09-08T00:00:00.000Z",
): NormalizedObservation {
  return {
    observedAt,
    account: { planType: null, subscriptionExpiresAt: null, renewalAt: null },
    windows: [{
      key: "openai-codex:secondary",
      label: "OpenAI Codex weekly window",
      usedPercent,
      remainingPercent: 100 - usedPercent,
      resetsAt,
      windowSeconds: 604_800,
      observedAt,
    }],
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

function preferences(overrides: Partial<PushPreferences> = {}): PushPreferences {
  return { ...DEFAULT_PUSH_PREFERENCES, ...overrides };
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

function insertAt(
  store: DatabaseStore,
  observedAt: string,
  usedPercent: number,
  resetsAt: string,
  gapThresholdSeconds = 10_000,
): CollectionResult {
  const observationId = store.insertObservation(
    observation(observedAt, usedPercent, resetsAt),
    "fixture",
    gapThresholdSeconds,
  );
  return collection(observationId, observedAt);
}

function insert(
  store: DatabaseStore,
  sequence: number,
  usedPercent = 0,
  gapThresholdSeconds = 10_000,
): CollectionResult {
  const observedAt = new Date(Date.UTC(2026, 8, 1, 0, sequence)).toISOString();
  return insertAt(
    store,
    observedAt,
    usedPercent,
    "2026-09-08T00:00:00.000Z",
    gapThresholdSeconds,
  );
}

describe("Web Push transition dispatch", () => {
  test("filters six preferences per subscriber and coalesces crossed remaining thresholds", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    let currentPace = pace("on_track", 90);
    const deliveries: Array<{ endpoint: string; payload: unknown; cursor: number | null }> = [];
    const notifications = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => currentPace,
      {
        send: async (subscription, payload) => {
          deliveries.push({
            endpoint: subscription.endpoint,
            payload: JSON.parse(payload),
            cursor: store.getPushNotificationState(subscription.endpoint)?.lastObservationId ?? null,
          });
        },
        sleep: async () => {},
      },
    );
    insert(store, 0, 70);
    notifications.subscribe({
      ...browserSubscription("over"),
      preferences: preferences(),
    });
    notifications.subscribe({
      ...browserSubscription("remaining"),
      preferences: preferences({
        overBudget: false,
        remaining25: true,
        remaining15: true,
        remaining5: true,
      }),
    });
    notifications.subscribe({
      ...browserSubscription("reset-only"),
      preferences: preferences({
        overBudget: false,
        weeklyReset: true,
        unscheduledReset: true,
      }),
    });
    notifications.subscribe({
      ...browserSubscription("disabled"),
      preferences: preferences({ overBudget: false }),
    });

    currentPace = pace("exhausted", null);
    const crossing = insert(store, 1, 96);
    await notifications.handleCollection(crossing);
    await notifications.handleCollection(crossing);

    expect(deliveries).toEqual([
      {
        endpoint: browserSubscription("over").endpoint,
        payload: { type: "overBudget", projectedPercent: null },
        cursor: crossing.observationId,
      },
      {
        endpoint: browserSubscription("remaining").endpoint,
        payload: {
          type: "remaining",
          thresholds: [25, 15, 5],
          remainingPercent: 4,
        },
        cursor: crossing.observationId,
      },
    ]);
    store.close();
  });

  test("rearms remaining alerts only on confirmed resets and classifies scheduled versus early resets", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    const payloads: unknown[] = [];
    const notifications = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => pace("on_track"),
      {
        send: async (_subscription, payload) => {
          payloads.push(JSON.parse(payload));
        },
        sleep: async () => {},
      },
    );
    insertAt(
      store,
      "2026-09-01T00:00:00.000Z",
      80,
      "2026-09-01T00:05:00.000Z",
    );
    notifications.subscribe({
      ...browserSubscription("resets"),
      preferences: preferences({
        overBudget: false,
        remaining25: true,
        weeklyReset: true,
        unscheduledReset: true,
      }),
    });

    await notifications.handleCollection(insertAt(
      store,
      "2026-09-01T00:06:00.000Z",
      0,
      "2026-09-08T00:05:00.000Z",
    ));
    await notifications.handleCollection(insertAt(
      store,
      "2026-09-01T00:10:00.000Z",
      80,
      "2026-09-08T00:05:00.000Z",
    ));
    await notifications.handleCollection(insertAt(
      store,
      "2026-09-01T00:20:00.000Z",
      0,
      "2026-09-15T00:05:00.000Z",
    ));

    expect(payloads).toEqual([
      { type: "weeklyReset" },
      { type: "remaining", thresholds: [25], remainingPercent: 20 },
      { type: "unscheduledReset" },
    ]);
    store.close();
  });

  test("suppresses ambiguous and gap-attached resets", async () => {
    const ambiguousStore = new DatabaseStore(join(scratch(), "ambiguous.sqlite"));
    const ambiguousPayloads: string[] = [];
    const ambiguousNotifications = new PushNotificationService(
      ambiguousStore,
      vapidConfiguration(),
      () => pace("on_track"),
      { send: async (_subscription, payload) => { ambiguousPayloads.push(payload); } },
    );
    insertAt(
      ambiguousStore,
      "2026-09-01T00:00:00.000Z",
      50,
      "2026-09-08T00:00:00.000Z",
    );
    ambiguousNotifications.subscribe({
      ...browserSubscription("ambiguous-reset"),
      preferences: preferences({
        overBudget: false,
        weeklyReset: true,
        unscheduledReset: true,
      }),
    });
    await ambiguousNotifications.handleCollection(insertAt(
      ambiguousStore,
      "2026-09-01T00:05:00.000Z",
      50,
      "2026-09-15T00:00:00.000Z",
    ));
    expect(ambiguousPayloads).toEqual([]);
    ambiguousStore.close();

    const gapStore = new DatabaseStore(join(scratch(), "gap.sqlite"));
    const gapPayloads: string[] = [];
    const gapNotifications = new PushNotificationService(
      gapStore,
      vapidConfiguration(),
      () => pace("on_track"),
      { send: async (_subscription, payload) => { gapPayloads.push(payload); } },
    );
    insertAt(
      gapStore,
      "2026-09-01T00:00:00.000Z",
      80,
      "2026-09-08T00:00:00.000Z",
      60,
    );
    gapNotifications.subscribe({
      ...browserSubscription("gap-reset"),
      preferences: preferences({
        overBudget: false,
        weeklyReset: true,
        unscheduledReset: true,
      }),
    });
    await gapNotifications.handleCollection(insertAt(
      gapStore,
      "2026-09-01T00:20:00.000Z",
      0,
      "2026-09-15T00:00:00.000Z",
      60,
    ));
    expect(gapPayloads).toEqual([]);
    gapStore.close();
  });

  test("preference updates baseline without catchup, persists before delivery, and prevents restart replay", async () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    let currentPace = pace("at_risk", 130);
    const payloads: unknown[] = [];
    const cursors: number[] = [];
    const dependencies = {
      send: async (subscription: { endpoint: string }, payload: string) => {
        payloads.push(JSON.parse(payload));
        cursors.push(store.getPushNotificationState(subscription.endpoint)!.lastObservationId);
      },
      sleep: async () => {},
    };
    const notifications = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => currentPace,
      dependencies,
    );
    insert(store, 0, 80);
    const subscription = browserSubscription("baseline");
    notifications.subscribe({
      ...subscription,
      preferences: preferences({ overBudget: false }),
    });
    notifications.updatePreferences(
      subscription.endpoint,
      preferences({ remaining25: true }),
    );
    await notifications.handleCollection(insert(store, 1, 90));
    expect(payloads).toEqual([]);

    notifications.updatePreferences(
      subscription.endpoint,
      preferences({ remaining25: true, overBudget: true }),
    );
    await notifications.handleCollection(insert(store, 2, 91));
    currentPace = pace("on_track", 95);
    await notifications.handleCollection(insert(store, 3, 92));
    currentPace = pace("exhausted");
    const directExhaustion = insert(store, 4, 100);
    await notifications.handleCollection(directExhaustion);
    expect(payloads).toEqual([{ type: "overBudget", projectedPercent: null }]);
    expect(cursors).toEqual([directExhaustion.observationId!]);

    const restarted = new PushNotificationService(
      store,
      vapidConfiguration(),
      () => currentPace,
      dependencies,
    );
    restarted.initializeBaseline();
    await restarted.handleCollection(directExhaustion);
    expect(payloads).toHaveLength(1);

    restarted.unsubscribe(subscription.endpoint);
    currentPace = pace("on_track");
    await restarted.handleCollection(insert(store, 5, 100));
    currentPace = pace("exhausted");
    await restarted.handleCollection(insert(store, 6, 100));
    expect(payloads).toHaveLength(1);
    expect(store.getPushNotificationState(subscription.endpoint)).toBeNull();
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
    insert(store, 0, 10);
    notifications.subscribe(browserSubscription("gone"));
    notifications.subscribe(browserSubscription("transient"));
    notifications.subscribe(browserSubscription("ambiguous"));
    currentPace = pace("at_risk", 120);
    await notifications.handleCollection(insert(store, 1, 11));

    expect(attempts[browserSubscription("gone").endpoint]).toBe(1);
    expect(attempts[browserSubscription("transient").endpoint]).toBe(2);
    expect(attempts[browserSubscription("ambiguous").endpoint]).toBe(1);
    expect(store.getPushSubscriptionCount()).toBe(2);
    expect(store.getPushNotificationState(browserSubscription("gone").endpoint)).toBeNull();
    store.close();
  });
});

describe("Web Push database migration", () => {
  test("preserves existing opt-in with only over-budget enabled and cascades durable state", () => {
    const path = join(scratch(), "legacy.sqlite");
    const legacy = new Database(path, { create: true });
    legacy.exec(`
      CREATE TABLE observations (id INTEGER PRIMARY KEY AUTOINCREMENT);
      INSERT INTO observations DEFAULT VALUES;
      CREATE TABLE redemption_audit (
        state TEXT NOT NULL,
        finalized_at TEXT,
        outcome TEXT,
        reason TEXT
      );
      CREATE TABLE web_push_subscriptions (
        endpoint TEXT PRIMARY KEY,
        expiration_time INTEGER,
        p256dh TEXT NOT NULL,
        auth TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO web_push_subscriptions(
        endpoint, expiration_time, p256dh, auth, created_at, updated_at
      ) VALUES (
        'https://fcm.googleapis.com/fcm/send/legacy',
        NULL,
        'legacy-p256dh',
        'legacy-auth',
        '2026-09-01T00:00:00.000Z',
        '2026-09-01T00:00:00.000Z'
      );
      PRAGMA user_version = 3;
    `);
    legacy.close();

    const store = new DatabaseStore(path);
    const subscription = store.getPushSubscriptions()[0]!;
    expect(subscription.preferences).toEqual(DEFAULT_PUSH_PREFERENCES);
    store.setPushNotificationState({
      endpoint: subscription.endpoint,
      lastObservationId: 1,
      paceStatus: "on_track",
      remainingPercent: 50,
      resetAt: null,
      remaining25Delivered: false,
      remaining15Delivered: false,
      remaining5Delivered: false,
      updatedAt: "2026-09-01T00:00:00.000Z",
    });
    store.deletePushSubscription(subscription.endpoint);
    expect(store.getPushNotificationState(subscription.endpoint)).toBeNull();
    store.close();

    const reopened = new DatabaseStore(path);
    expect(reopened.getPushSubscriptionCount()).toBe(0);
    reopened.close();
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
    expect(await subscribeResponse.json()).toEqual({
      subscribed: true,
      preferences: DEFAULT_PUSH_PREFERENCES,
    });
    expect(store.getPushSubscriptionCount()).toBe(1);

    const selected = preferences({
      remaining25: true,
      remaining15: true,
      weeklyReset: true,
    });
    const patchResponse = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({ endpoint: subscription.endpoint, preferences: selected }),
    }));
    expect(patchResponse.status).toBe(200);
    expect(await patchResponse.json()).toEqual({ subscribed: true, preferences: selected });

    const preservedResponse = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "POST",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify(subscription),
    }));
    expect(await preservedResponse.json()).toEqual({ subscribed: true, preferences: selected });

    const rejectedPatch = await handler(new Request("https://observatory.example/api/push/subscriptions", {
      method: "PATCH",
      headers: { "Content-Type": "application/json", Origin: "https://observatory.example" },
      body: JSON.stringify({
        endpoint: subscription.endpoint,
        preferences: { ...selected, extra: false },
      }),
    }));
    expect(rejectedPatch.status).toBe(400);

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
      data: { json: () => ({ type: "overBudget", projectedPercent: 123.4 }) },
      waitUntil: (promise: Promise<unknown>) => { pushCompletion = promise; },
    });
    await pushCompletion;
    expect(shown).toEqual([{
      title: "Usage over budget",
      options: {
        body: "Projected 123.4% used by reset.",
        tag: "usage-over-budget",
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

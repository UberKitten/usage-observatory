import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageCollector, normalizeUsagePayload, type CollectorConfig } from "../src/collector";
import { DatabaseStore } from "../src/db";
import { createRequestHandler } from "../src/server";
import type { NormalizedObservation } from "../src/types";

const roots: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.ADMIN_TOKEN;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-observatory-test-"));
  roots.push(root);
  return root;
}

function collectorConfig(overrides: Partial<CollectorConfig> = {}): CollectorConfig {
  return {
    mode: "fixture",
    usageEndpoint: "https://chatgpt.com/backend-api/wham/usage",
    tokenFile: null,
    accountIdFile: null,
    oauthFile: null,
    oauthIssuer: "https://auth.openai.com",
    oauthClientId: "test-client",
    usageCommand: ["omp", "usage", "--json"],
    intervalSeconds: 300,
    staleAfterSeconds: 900,
    requestTimeoutMilliseconds: 2_000,
    backoffBaseSeconds: 30,
    backoffMaximumSeconds: 900,
    autoRedeem: false,
    autoRedeemHorizonHours: 12,
    maximumReportAgeSeconds: 600,
    ...overrides,
  };
}

function observation(at: string, used: number, resetsAt: string): NormalizedObservation {
  return {
    observedAt: at,
    account: { planType: "pro", subscriptionExpiresAt: null, renewalAt: null },
    windows: [{
      key: "openai-codex:primary",
      label: "7 days",
      usedPercent: used,
      remainingPercent: 100 - used,
      resetsAt,
      windowSeconds: 604_800,
      observedAt: at,
    }],
    credits: { hasCredits: null, balance: null },
    resetCredits: { availableCount: 1, earliestExpiresAt: null, actionSupported: false },
  };
}

describe("provider normalization", () => {
  test("preserves zero-valued OMP meters and reset expiries without account identity", () => {
    const fetchedAt = Date.parse("2026-09-09T02:00:00Z");
    const parsed = normalizeUsagePayload({
      provider: "openai-codex",
      fetchedAt,
      limits: [{
        id: "openai-codex:spark:primary",
        label: "5 hours (Spark)",
        window: { durationMs: 18_000_000, resetsAt: fetchedAt + 18_000_000 },
        amount: { used: 0, remaining: 100, usedFraction: 0, remainingFraction: 1, unit: "percent" },
      }],
      resetCredits: {
        availableCount: 1,
        credits: [{ status: "available", expiresAt: "2026-09-21T00:19:09.361Z" }],
      },
      metadata: { planType: "pro", email: "must-not-persist@example.invalid", accountId: "must-not-persist" },
    }, "2026-09-09T02:00:01Z", true);

    expect(parsed.payload.account).toEqual({ planType: "pro", subscriptionExpiresAt: null, renewalAt: null });
    expect(parsed.payload.windows).toEqual([{
      key: "openai-codex:spark:primary",
      label: "5 hours (Spark)",
      usedPercent: 0,
      remainingPercent: 100,
      resetsAt: "2026-09-09T07:00:00.000Z",
      windowSeconds: 18_000,
    }]);
    expect(parsed.payload.resetCreditsAvailableCount).toBe(1);
    expect(parsed.embeddedCredits[0]?.expiresAt).toBe("2026-09-21T00:19:09.361Z");
  });
});

describe("history and pace", () => {
  test("quarantines the real nonzero drop and reset-date excursion after it rebounds", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const originalReset = "2026-09-15T01:26:05.000Z";
    const excursionReset = "2026-09-14T08:29:04.000Z";
    const samples: Array<[string, number, string]> = [
      ["2026-09-09T17:06:44.000Z", 17, originalReset],
      ["2026-09-09T17:11:43.000Z", 17, originalReset],
      ["2026-09-09T17:16:45.000Z", 6, excursionReset],
      ["2026-09-09T17:21:46.000Z", 6, excursionReset],
      ["2026-09-09T17:26:47.000Z", 6, excursionReset],
      ["2026-09-09T17:31:48.000Z", 6, excursionReset],
      ["2026-09-09T17:41:50.000Z", 17, originalReset],
      ["2026-09-09T17:51:52.000Z", 18, originalReset],
    ];
    for (const [at, used, resetAt] of samples) {
      store.insertObservation(observation(at, used, resetAt), "command", 1_800);
    }
    store.recordAttempt(new Date().toISOString(), "healthy", null, true);
    const collector = new UsageCollector(store, collectorConfig({ mode: "command" }));
    const handler = createRequestHandler(store, collector, join(root, "public"));

    const history = await (await handler(new Request("http://local/api/history?range=all"))).json();
    const dashboard = await (await handler(new Request("http://local/api/dashboard"))).json();
    expect(history.points.map((point: { usedPercent: number }) => point.usedPercent)).toEqual([
      17,
      17,
      17,
      18,
    ]);
    expect(history.points.some((point: { resetsAt: string }) => point.resetsAt === excursionReset)).toBe(false);
    expect(history.events).toEqual([]);
    expect(dashboard.windows[0]?.usedPercent).toBe(18);
    expect(dashboard.windows[0]?.resetsAt).toBe(originalReset);
    expect(
      store.getWindowPacePoints("openai-codex:primary", originalReset, samples[0][0])
        .map((point) => point.usedPercent),
    ).toEqual([17, 17, 17, 18]);
    expect(store.getCounts()).toEqual({ observationCount: 8, eventCount: 2 });
    const raw = store.database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM usage_windows")
      .get();
    expect(raw?.count).toBe(8);
    store.close();
  });

  test("accepts zero usage with an advanced reset as one confirmed reset", () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const previousReset = "2026-09-09T04:00:00.000Z";
    const nextReset = "2026-09-16T04:00:00.000Z";
    store.insertObservation(
      observation("2026-09-09T00:00:00.000Z", 40, previousReset),
      "command",
      7_200,
    );
    store.insertObservation(
      observation("2026-09-09T01:00:00.000Z", 0, nextReset),
      "command",
      7_200,
    );

    const history = store.getHistory("all");
    expect(history.points.map((point) => point.usedPercent)).toEqual([40, 0]);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      kind: "reset_timestamp_changed",
      observedAt: "2026-09-09T01:00:00.000Z",
      previousResetAt: previousReset,
      currentResetAt: nextReset,
      deltaUsedPercent: -40,
      uncertainty: "low",
    });
    store.close();
  });

  test("accepts a used new-cycle point after the prior scheduled boundary was crossed", () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const previousReset = "2026-09-09T00:05:00.000Z";
    const nextReset = "2026-09-16T00:05:00.000Z";
    store.insertObservation(
      observation("2026-09-09T00:00:00.000Z", 80, previousReset),
      "command",
      1_800,
    );
    store.insertObservation(
      observation("2026-09-09T00:10:00.000Z", 3, nextReset),
      "command",
      1_800,
    );

    const history = store.getHistory("all");
    expect(history.points.map((point) => point.usedPercent)).toEqual([80, 3]);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      kind: "reset_timestamp_changed",
      observedAt: "2026-09-09T00:10:00.000Z",
      previousResetAt: previousReset,
      currentResetAt: nextReset,
      deltaUsedPercent: -77,
      uncertainty: "low",
    });
    store.close();
  });

  test("deduplicates identical timestamp samples before calculating recent rate", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const firstAt = new Date(now - 12 * 60_000).toISOString();
    const lastAt = new Date(now - 6 * 60_000).toISOString();
    const resetAt = new Date(now + 6 * 86_400_000).toISOString();
    store.insertObservation(observation(firstAt, 10, resetAt), "command", 1_800);
    store.insertObservation(observation(firstAt, 10, resetAt), "command", 1_800);
    store.insertObservation(observation(lastAt, 11, resetAt), "command", 1_800);
    store.recordAttempt(new Date(now).toISOString(), "healthy", null, true);
    const collector = new UsageCollector(store, collectorConfig({ mode: "command" }));
    const handler = createRequestHandler(store, collector, join(root, "public"));

    const dashboard = await (await handler(new Request("http://local/api/dashboard"))).json();
    expect(store.getHistory("all").points).toHaveLength(2);
    expect(dashboard.pace.recentRatePercentPerHour).toBe(10);
    expect(store.getCounts()).toEqual({ observationCount: 3, eventCount: 0 });
    store.close();
  });

  test("keeps a real collection gap as separate evidence", () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const resetAt = "2026-09-16T03:00:00.000Z";
    store.insertObservation(
      observation("2026-09-09T03:00:00.000Z", 5, resetAt),
      "command",
      300,
    );
    store.insertObservation(
      observation("2026-09-09T03:20:00.000Z", 6, resetAt),
      "command",
      300,
    );

    const history = store.getHistory("all");
    expect(history.points.map((point) => point.usedPercent)).toEqual([5, 6]);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      kind: "observation_gap",
      observedAt: "2026-09-09T03:20:00.000Z",
    });
    store.close();
  });

  test("holds an ambiguous decrease pending and reports pace as unknown", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const resetAt = new Date(now + 5 * 86_400_000).toISOString();
    const stableAt = new Date(now - 50 * 60_000).toISOString();
    store.insertObservation(
      observation(new Date(now - 60 * 60_000).toISOString(), 20, resetAt),
      "command",
      10_000,
    );
    store.insertObservation(observation(stableAt, 20, resetAt), "command", 10_000);
    store.insertObservation(
      observation(new Date(now - 20 * 60_000).toISOString(), 8, resetAt),
      "command",
      10_000,
    );
    store.insertObservation(
      observation(new Date(now - 10 * 60_000).toISOString(), 9, resetAt),
      "command",
      10_000,
    );
    store.recordAttempt(new Date(now).toISOString(), "healthy", null, true);
    const collector = new UsageCollector(store, collectorConfig({ mode: "command" }));
    const handler = createRequestHandler(store, collector, join(root, "public"));

    const dashboard = await (await handler(new Request("http://local/api/dashboard"))).json();
    const history = store.getHistory("all");
    expect(dashboard.windows[0]?.usedPercent).toBe(20);
    expect(dashboard.windows[0]?.observedAt).toBe(stableAt);
    expect(dashboard.pace.status).toBe("unknown");
    expect(dashboard.pace.projectedUsedAtReset).toBeNull();
    expect(history.points.map((point) => point.usedPercent)).toEqual([20, 20]);
    expect(history.events).toEqual([]);
    expect(store.getCounts()).toEqual({ observationCount: 4, eventCount: 1 });
    store.close();
  });

  test("admits a sustained corrected trajectory without calling it a reset", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const resetAt = new Date(now + 5 * 86_400_000).toISOString();
    const samples: Array<[number, number]> = [
      [-50, 20],
      [-40, 8],
      [-30, 8],
      [-20, 9],
      [-10, 10],
    ];
    for (const [minutes, used] of samples) {
      store.insertObservation(
        observation(new Date(now + minutes * 60_000).toISOString(), used, resetAt),
        "command",
        10_000,
      );
    }
    store.recordAttempt(new Date(now).toISOString(), "healthy", null, true);
    const collector = new UsageCollector(store, collectorConfig({ mode: "command" }));
    const handler = createRequestHandler(store, collector, join(root, "public"));

    const dashboard = await (await handler(new Request("http://local/api/dashboard"))).json();
    const history = store.getHistory("all");
    expect(history.points.map((point) => point.usedPercent)).toEqual([20, 8, 8, 9, 10]);
    expect(history.events).toHaveLength(1);
    expect(history.events[0]).toMatchObject({
      kind: "usage_decreased",
      deltaUsedPercent: -12,
      uncertainty: "high",
    });
    expect(dashboard.windows[0]?.usedPercent).toBe(10);
    expect(dashboard.pace.status).not.toBe("unknown");
    store.close();
  });

  test("does not derive events from reset timestamps rolling with each poll", () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    store.insertObservation(
      observation("2026-09-09T00:00:00.000Z", 0, "2026-09-16T00:00:00.000Z"),
      "command",
      1_800,
    );
    store.insertObservation(
      observation("2026-09-09T00:05:00.000Z", 0, "2026-09-16T00:05:00.000Z"),
      "command",
      1_800,
    );
    store.insertObservation(
      observation("2026-09-09T00:10:00.000Z", 0, "2026-09-16T00:10:00.000Z"),
      "command",
      1_800,
    );

    expect(store.getHistory("all").events).toEqual([]);
    expect(store.getHistory("all").points).toHaveLength(3);
    expect(store.getCounts()).toEqual({ observationCount: 3, eventCount: 0 });
    store.close();
  });
});

describe("saved-reset safety", () => {
  test("persists one idempotency key and never automatically retries an ambiguous consume", async () => {
    const root = scratch();
    const tokenPath = join(root, "token");
    writeFileSync(tokenPath, "opaque-test-token\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const credit = { id: "RateLimitResetCredit_test", status: "available", expires_at: new Date(now + 2 * 3_600_000).toISOString() };
    const usage = {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 18_000,
          reset_at: Math.floor((now + 3_600_000) / 1_000),
        },
      },
      rate_limit_reset_credits: { available_count: 1 },
    };
    let consumeCalls = 0;
    let requestId: string | null = null;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        const body = JSON.parse(String(init?.body));
        requestId = body.redeem_request_id;
        throw new TypeError("simulated response loss");
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [credit] });
      }
      return Response.json(usage);
    }) as typeof fetch;

    const collector = new UsageCollector(store, collectorConfig({
      mode: "live",
      tokenFile: tokenPath,
      autoRedeem: true,
    }));
    const first = await collector.collect();
    const second = await collector.collect();
    expect(first.redemptionAudit?.state).toBe("ambiguous");
    expect(first.redemptionAudit?.redeemRequestId).toBe(requestId);
    expect(second.redemptionAudit?.redeemRequestId).toBe(requestId);
    expect(consumeCalls).toBe(1);
    expect(store.getLatestAudit()?.state).toBe("ambiguous");
    store.close();
  });
  test("attempts an in-horizon available credit even when regular usage is zero", async () => {
    const root = scratch();
    const tokenPath = join(root, "token");
    writeFileSync(tokenPath, "opaque-test-token\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const credit = {
      id: "RateLimitResetCredit_zero_usage",
      status: "available",
      expires_at: new Date(now + 2 * 3_600_000).toISOString(),
    };
    const usage = {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18_000,
          reset_at: Math.floor((now + 3_600_000) / 1_000),
        },
      },
      rate_limit_reset_credits: { available_count: 1 },
    };
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        return Response.json({ status: "nothing_to_reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [credit] });
      }
      return Response.json(usage);
    }) as typeof fetch;

    const collector = new UsageCollector(store, collectorConfig({
      mode: "live",
      tokenFile: tokenPath,
      autoRedeem: true,
    }));
    const result = await collector.collect();
    expect(result.redemptionAudit?.state).toBe("final");
    expect(result.redemptionAudit?.outcome).toBe("nothing_to_reset");
    expect(consumeCalls).toBe(1);
    store.close();
  });

  test("does not attempt an available credit outside the expiry horizon", async () => {
    const root = scratch();
    const tokenPath = join(root, "token");
    writeFileSync(tokenPath, "opaque-test-token\n", { mode: 0o600 });
    chmodSync(tokenPath, 0o600);
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const credit = {
      id: "RateLimitResetCredit_not_expiring",
      status: "available",
      expires_at: new Date(now + 13 * 3_600_000).toISOString(),
    };
    const usage = {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 0,
          limit_window_seconds: 18_000,
          reset_at: Math.floor((now + 3_600_000) / 1_000),
        },
      },
      rate_limit_reset_credits: { available_count: 1 },
    };
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        return Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [credit] });
      }
      return Response.json(usage);
    }) as typeof fetch;

    const collector = new UsageCollector(store, collectorConfig({
      mode: "live",
      tokenFile: tokenPath,
      autoRedeem: true,
    }));
    const result = await collector.collect();
    expect(result.redemptionAudit).toBeNull();
    expect(store.getLatestAudit()).toBeNull();
    expect(consumeCalls).toBe(0);
    store.close();
  });
});

import { afterEach, describe, expect, setSystemTime, test } from "bun:test";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { UsageCollector, normalizeUsagePayload, type CollectorConfig } from "../src/collector";
import { DatabaseStore } from "../src/db";
import { buildPace, createRequestHandler } from "../src/server";
import type { NormalizedObservation } from "../src/types";

const roots: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  setSystemTime();
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
    autoRedeemHorizonHours: 1,
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
        credits: [{ status: "available", expiresAt: "2026-09-20T13:19:09.361-07:00" }],
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
    expect(parsed.embeddedCredits[0]?.expiresAt).toBe("2026-09-20T20:19:09.361Z");
  });
  test("rejects a timezone-less credit expiry instead of inferring the host timezone", () => {
    const fetchedAt = Date.parse("2026-09-20T12:00:00Z");
    const parsed = normalizeUsagePayload({
      provider: "openai-codex",
      fetchedAt,
      limits: [{
        id: "openai-codex:primary",
        amount: { used: 20 },
        window: { resetsAt: fetchedAt + 18_000_000 },
      }],
      resetCredits: {
        availableCount: 1,
        credits: [{
          id: "RateLimitResetCredit_without_timezone",
          status: "available",
          expiresAt: "2026-09-20T13:00:00",
        }],
      },
    }, "2026-09-20T12:00:00Z", true);

    expect(parsed.embeddedCredits).toEqual([{
      id: "RateLimitResetCredit_without_timezone",
      status: "available",
      expiresAt: null,
    }]);
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

  test("projects and dates runout from a trustworthy positive current-rate segment", () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    const resetAt = "2026-09-01T03:00:00.000Z";
    store.insertObservation(
      observation("2026-09-01T00:00:00.000Z", 70, resetAt),
      "command",
      7_200,
    );
    store.insertObservation(
      observation("2026-09-01T01:00:00.000Z", 80, resetAt),
      "command",
      7_200,
    );
    const latest = store.getLatestObservation()!;

    expect(buildPace(
      store,
      latest.windows,
      "healthy",
      new Date("2026-09-01T01:00:00.000Z"),
    )).toMatchObject({
      recentRatePercentPerHour: 10,
      projectedUsedAtReset: 100,
      projectedExhaustionAt: resetAt,
      basisHours: 1,
    });
    store.close();
  });

  test("reports a trustworthy zero rate without inventing projection or runout", () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    const resetAt = "2026-09-08T00:00:00.000Z";
    store.insertObservation(
      observation("2026-09-01T00:00:00.000Z", 0, resetAt),
      "command",
      7_200,
    );
    store.insertObservation(
      observation("2026-09-01T00:10:00.000Z", 0, resetAt),
      "command",
      7_200,
    );
    const latest = store.getLatestObservation()!;
    const result = buildPace(
      store,
      latest.windows,
      "healthy",
      new Date("2026-09-01T00:10:00.000Z"),
    );

    expect(result.recentRatePercentPerHour).toBe(0);
    expect(result.projectedUsedAtReset).toBeNull();
    expect(result.projectedExhaustionAt).toBeNull();
    expect(result.basisHours).toBeCloseTo(0.17, 2);
    store.close();
  });

  test("rejects a recent-rate basis intersected by an observation gap", () => {
    const store = new DatabaseStore(join(scratch(), "usage.sqlite"));
    const resetAt = "2026-09-08T00:00:00.000Z";
    store.insertObservation(
      observation("2026-09-01T00:00:00.000Z", 10, resetAt),
      "command",
      300,
    );
    store.insertObservation(
      observation("2026-09-01T00:20:00.000Z", 20, resetAt),
      "command",
      300,
    );
    const latest = store.getLatestObservation()!;
    const result = buildPace(
      store,
      latest.windows,
      "healthy",
      new Date("2026-09-01T00:20:00.000Z"),
    );

    expect(result.recentRatePercentPerHour).toBeNull();
    expect(result.projectedUsedAtReset).toBeNull();
    expect(result.projectedExhaustionAt).toBeNull();
    expect(result.explanation).toContain("observation gap");
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

  test("keeps sub-minute reset jitter in the current trusted trajectory", async () => {
    const root = scratch();
    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const now = Date.now();
    const resetAt = new Date(now + 4 * 86_400_000).toISOString();
    const jitteredResetAt = new Date(Date.parse(resetAt) - 1_000).toISOString();
    const samples: Array<[string, number, string]> = [
      [new Date(now - 25 * 60_000).toISOString(), 15, resetAt],
      [new Date(now - 20 * 60_000).toISOString(), 16, resetAt],
      [new Date(now - 15 * 60_000).toISOString(), 17, resetAt],
      [new Date(now - 10 * 60_000).toISOString(), 18, jitteredResetAt],
      [new Date(now - 5 * 60_000).toISOString(), 18, jitteredResetAt],
      [new Date(now).toISOString(), 19, jitteredResetAt],
    ];
    for (const [observedAt, usedPercent, reportedResetAt] of samples) {
      store.insertObservation(
        observation(observedAt, usedPercent, reportedResetAt),
        "command",
        10_000,
      );
    }
    store.recordAttempt(samples.at(-1)![0], "healthy", null, true);
    const collector = new UsageCollector(store, collectorConfig({ mode: "command" }));
    const handler = createRequestHandler(store, collector, join(root, "public"));

    const dashboard = await (await handler(new Request("http://local/api/dashboard"))).json();
    const primaryPoints = store.getHistory("all").points.filter(
      (point) => point.windowKey === "openai-codex:primary",
    );
    expect(store.isWindowPending("openai-codex:primary")).toBe(false);
    expect(dashboard.windows[0]?.observedAt).toBe(samples.at(-1)![0]);
    expect(dashboard.windows[0]?.resetsAt).toBe(jitteredResetAt);
    expect(dashboard.pace.status).toBe("room_to_spend");
    expect(dashboard.pace.recentRatePercentPerHour).not.toBeNull();
    expect(primaryPoints).toHaveLength(samples.length);
    expect(new Set(primaryPoints.map((point) => point.resetsAt))).toEqual(
      new Set([resetAt, jitteredResetAt]),
    );
    store.close();
  });
});

interface SavedResetHarness {
  store: DatabaseStore;
  tokenPath: string;
  credit: { id: string; status: string; expires_at: string };
  usage: Record<string, unknown>;
  now: number;
}

function savedResetHarness(
  at = "2026-09-20T12:00:00.000Z",
  expiryOffsetMilliseconds = 3_600_000,
): SavedResetHarness {
  const now = Date.parse(at);
  setSystemTime(new Date(now));
  const root = scratch();
  const tokenPath = join(root, "token");
  writeFileSync(tokenPath, "opaque-test-token\n", { mode: 0o600 });
  chmodSync(tokenPath, 0o600);
  return {
    store: new DatabaseStore(join(root, "usage.sqlite")),
    tokenPath,
    credit: {
      id: "RateLimitResetCredit_test",
      status: "available",
      expires_at: new Date(now + expiryOffsetMilliseconds).toISOString(),
    },
    usage: {
      plan_type: "pro",
      rate_limit: {
        primary_window: {
          used_percent: 30,
          limit_window_seconds: 18_000,
          reset_at: Math.floor((now + 7_200_000) / 1_000),
        },
      },
      rate_limit_reset_credits: { available_count: 1 },
    },
    now,
  };
}

describe("saved-reset safety", () => {
  test("activates at the exact one-hour boundary, not one millisecond before it", async () => {
    const scenario = savedResetHarness(undefined, 3_600_001);
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        return Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    expect((await collector.collect()).redemptionAudit).toBeNull();
    expect(consumeCalls).toBe(0);
    scenario.credit.expires_at = new Date(scenario.now + 3_600_000).toISOString();
    const atBoundary = await collector.collect();
    expect(atBoundary.redemptionAudit?.state).toBe("final");
    expect(atBoundary.redemptionAudit?.outcome).toBe("reset");
    expect(consumeCalls).toBe(1);
    scenario.store.close();
  });

  test("never sends a consume request at or after the authoritative expiry", async () => {
    const scenario = savedResetHarness(undefined, 0);
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        return Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    expect((await collector.collect()).redemptionAudit).toBeNull();
    expect(consumeCalls).toBe(0);
    scenario.store.close();
  });

  test("retries a transient failure on the polling cadence with the same idempotency key", async () => {
    const scenario = savedResetHarness();
    const requestIds: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        requestIds.push(JSON.parse(String(init?.body)).redeem_request_id);
        return requestIds.length === 1
          ? Response.json({ status: "temporarily_unavailable" }, { status: 503 })
          : Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    const first = await collector.collect();
    expect(first.redemptionAudit?.state).toBe("ambiguous");
    expect(first.redemptionAudit?.nextRetryAt).toBe("2026-09-20T12:05:00.000Z");
    expect((await collector.collect()).redemptionAudit?.state).toBe("ambiguous");
    expect(requestIds).toHaveLength(1);
    setSystemTime(new Date(scenario.now + 300_000));
    const recovered = await collector.collect();
    expect(recovered.redemptionAudit?.outcome).toBe("reset");
    expect(recovered.redemptionAudit?.attemptCount).toBe(2);
    expect(requestIds).toEqual([requestIds[0], requestIds[0]]);
    scenario.store.close();
  });

  test("rechecks a confirmed no-op with a new key and succeeds before expiry", async () => {
    const scenario = savedResetHarness();
    const requestIds: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        requestIds.push(JSON.parse(String(init?.body)).redeem_request_id);
        return Response.json({ status: requestIds.length === 1 ? "nothing_to_reset" : "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    const first = await collector.collect();
    expect(first.redemptionAudit?.state).toBe("planned");
    expect(first.redemptionAudit?.outcome).toBe("nothing_to_reset");
    setSystemTime(new Date(scenario.now + 300_000));
    expect((await collector.collect()).redemptionAudit?.outcome).toBe("reset");
    expect(requestIds).toHaveLength(2);
    expect(requestIds[1]).not.toBe(requestIds[0]);
    scenario.store.close();
  });

  test("reconciles an ambiguous response as redeemed without a duplicate consume", async () => {
    const scenario = savedResetHarness();
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        throw new TypeError("simulated response loss");
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({
          available_count: scenario.credit.status === "available" ? 1 : 0,
          credits: [scenario.credit],
        });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    expect((await collector.collect()).redemptionAudit?.state).toBe("ambiguous");
    scenario.credit.status = "redeemed";
    setSystemTime(new Date(scenario.now + 300_000));
    const reconciled = await collector.collect();
    expect(reconciled.redemptionAudit?.state).toBe("final");
    expect(reconciled.redemptionAudit?.outcome).toBe("already_redeemed");
    expect(consumeCalls).toBe(1);
    scenario.store.close();
  });

  test("honors Retry-After before replaying the same idempotency key", async () => {
    const scenario = savedResetHarness();
    const requestIds: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        requestIds.push(JSON.parse(String(init?.body)).redeem_request_id);
        return requestIds.length === 1
          ? new Response(null, { status: 429, headers: { "Retry-After": "600" } })
          : Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    const limited = await collector.collect();
    expect(limited.redemptionAudit?.nextRetryAt).toBe("2026-09-20T12:10:00.000Z");
    setSystemTime(new Date(scenario.now + 300_000));
    await collector.collect();
    expect(requestIds).toHaveLength(1);
    setSystemTime(new Date(scenario.now + 600_000));
    expect((await collector.collect()).redemptionAudit?.outcome).toBe("reset");
    expect(requestIds).toEqual([requestIds[0], requestIds[0]]);
    scenario.store.close();
  });
  test("does not bypass a Retry-After deadline that extends beyond expiry", async () => {
    const scenario = savedResetHarness(undefined, 50 * 60_000);
    let consumeCalls = 0;
    globalThis.fetch = (async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        consumeCalls += 1;
        return new Response(null, { status: 429, headers: { "Retry-After": "3600" } });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(scenario.store, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    const limited = await collector.collect();
    expect(limited.redemptionAudit?.nextRetryAt).toBe("2026-09-20T13:00:00.000Z");
    setSystemTime(new Date(scenario.now + 45 * 60_000));
    await collector.collect();
    expect(consumeCalls).toBe(1);
    setSystemTime(new Date(scenario.now + 50 * 60_000));
    const expired = await collector.collect();
    expect(expired.redemptionAudit?.outcome).toBe("expired_unresolved");
    expect(consumeCalls).toBe(1);
    scenario.store.close();
  });

  test("waits one polling interval before replaying a crash-interrupted request", async () => {
    const scenario = savedResetHarness();
    const expiry = scenario.credit.expires_at;
    const planned = scenario.store.planRedemption(
      scenario.credit.id,
      "crash-stable-request-id",
      new Date(scenario.now).toISOString(),
      expiry,
    );
    scenario.store.markRedemptionInFlight(planned.id, new Date(scenario.now).toISOString());
    scenario.store.close();
    setSystemTime(new Date(scenario.now + 1_000));
    const recoveredStore = new DatabaseStore(join(dirname(scenario.tokenPath), "usage.sqlite"));
    const requestIds: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/consume")) {
        requestIds.push(JSON.parse(String(init?.body)).redeem_request_id);
        return Response.json({ status: "reset" });
      }
      if (url.endsWith("rate-limit-reset-credits")) {
        return Response.json({ available_count: 1, credits: [scenario.credit] });
      }
      return Response.json(scenario.usage);
    }) as typeof fetch;
    const collector = new UsageCollector(recoveredStore, collectorConfig({
      mode: "live",
      tokenFile: scenario.tokenPath,
      autoRedeem: true,
    }));

    expect((await collector.collect()).redemptionAudit?.state).toBe("ambiguous");
    expect(requestIds).toHaveLength(0);
    setSystemTime(new Date(scenario.now + 300_000));
    expect((await collector.collect()).redemptionAudit?.outcome).toBe("reset");
    expect(requestIds).toEqual(["crash-stable-request-id"]);
    recoveredStore.close();
  });
});

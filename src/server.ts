import { timingSafeEqual } from "node:crypto";
import { mkdirSync } from "node:fs";
import { dirname, extname, resolve, sep } from "node:path";
import { DatabaseStore } from "./db";
import { UsageCollector, loadCollectorConfig } from "./collector";
import {
  PushNotificationService,
  handlePushApiRequest,
  loadVapidConfiguration,
} from "./notifications";
import type {
  BankedResetSummary,
  DashboardResponse,
  HealthResponse,
  HistoryRange,
  PaceSummary,
  SourceMode,
  SourceState,
  SourceStatus,
  UsageWindow,
} from "./types";

const HISTORY_RANGES: Record<string, true> = {
  "24h": true,
  "7d": true,
  "30d": true,
  "90d": true,
  all: true,
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
};

export interface ServerOptions {
  databasePath?: string;
  publicDirectory?: string;
  hostname?: string;
  port?: number;
  startCollector?: boolean;
}

export interface RunningApplication {
  server: Bun.Server<undefined>;
  store: DatabaseStore;
  collector: UsageCollector;
  stop(): void;
}

export function startServer(options: ServerOptions = {}): RunningApplication {
  const projectRoot = resolve(import.meta.dir, "..");
  const databasePath = resolve(options.databasePath ?? process.env.DB_PATH ?? resolve(projectRoot, "data/usage.sqlite"));
  const publicDirectory = resolve(options.publicDirectory ?? resolve(projectRoot, "public"));
  mkdirSync(dirname(databasePath), { recursive: true, mode: 0o700 });

  const vapidConfiguration = loadVapidConfiguration();
  const store = new DatabaseStore(databasePath);
  const collector = new UsageCollector(store, loadCollectorConfig());
  const notifications = new PushNotificationService(
    store,
    vapidConfiguration,
    () => {
      const generatedAt = new Date();
      const observation = store.getLatestObservation();
      return buildPace(
        store,
        observation?.windows ?? [],
        buildSourceStatus(store, generatedAt).state,
        generatedAt,
      );
    },
  );
  notifications.initializeBaseline();
  const handler = createRequestHandler(store, collector, publicDirectory, notifications);
  const liveClients = new Set<Bun.ServerWebSocket<undefined>>();
  let server: Bun.Server<undefined>;
  try {
    server = Bun.serve<undefined>({
      hostname: options.hostname ?? process.env.HOST ?? "0.0.0.0",
      port: options.port ?? parsePort(process.env.PORT),
      fetch(request, bunServer) {
        const url = new URL(request.url);
        if (url.pathname !== "/api/live") return handler(request);
        if (request.method !== "GET") return methodNotAllowed("GET");
        if (bunServer.upgrade(request)) return undefined;
        return new Response("WebSocket upgrade required", {
          status: 426,
          headers: {
            Connection: "Upgrade",
            Upgrade: "websocket",
            "Cache-Control": "no-store",
          },
        });
      },
      websocket: {
        open(client) {
          liveClients.add(client);
          client.send(JSON.stringify({ type: "ready" }));
        },
        message() {},
        close(client) {
          liveClients.delete(client);
        },
      },
    });
  } catch (error) {
    store.close();
    throw error;
  }

  const unsubscribe = collector.onCollectionComplete((result) => {
    const message = JSON.stringify({
      type: "collection",
      state: result.state,
      observedAt: result.observedAt,
    });
    void notifications.handleCollection(result).catch(() => {
      console.error("Web Push transition handling failed.");
    });
    for (const client of liveClients) {
      if (client.readyState !== 1) continue;
      try {
        client.send(message);
      } catch {
        liveClients.delete(client);
      }
    }
  });
  if (options.startCollector !== false) collector.start();
  return {
    server,
    store,
    collector,
    stop() {
      collector.stop();
      unsubscribe();
      for (const client of liveClients) client.close(1001, "Server stopping");
      liveClients.clear();
      server.stop();
      store.close();
    },
  };
}

export function createRequestHandler(
  store: DatabaseStore,
  collector: UsageCollector,
  publicDirectory: string,
  notifications: PushNotificationService | null = null,
): (request: Request) => Promise<Response> {
  const adminToken = process.env.ADMIN_TOKEN?.trim() || null;
  return async (request: Request) => {
    const url = new URL(request.url);
    if (url.pathname.startsWith("/api/")) {
      return handleApiRequest(request, url, store, collector, adminToken, notifications);
    }
    return serveStatic(request, url, publicDirectory);
  };
}

async function handleApiRequest(
  request: Request,
  url: URL,
  store: DatabaseStore,
  collector: UsageCollector,
  adminToken: string | null,
  notifications: PushNotificationService | null,
): Promise<Response> {
  const pushResponse = await handlePushApiRequest(request, url, notifications);
  if (pushResponse) return pushResponse;
  if (url.pathname === "/api/dashboard") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return jsonResponse(buildDashboard(store, collector), request.method === "HEAD");
  }

  if (url.pathname === "/api/history") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const requestedRange = url.searchParams.get("range") ?? "24h";
    if (HISTORY_RANGES[requestedRange] !== true) {
      return jsonResponse(
        { error: "range must be one of 24h, 7d, 30d, 90d, or all" },
        request.method === "HEAD",
        400,
      );
    }
    const range = requestedRange as HistoryRange;
    const history = store.getHistory(range);
    return jsonResponse({ range, ...history }, request.method === "HEAD");
  }

  if (url.pathname === "/api/health") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    const databaseOk = store.isHealthy();
    const source = buildSourceStatus(store);
    const health: HealthResponse = {
      ok: databaseOk,
      generatedAt: new Date().toISOString(),
      database: databaseOk ? "ok" : "error",
      sourceState: source.state,
      schedulerRunning: collector.isRunning(),
    };
    return jsonResponse(health, request.method === "HEAD", databaseOk ? 200 : 503);
  }

  if (url.pathname === "/api/admin/collect") {
    if (!adminToken) return jsonResponse({ error: "not found" }, false, 404);
    if (request.method !== "POST") return methodNotAllowed("POST");
    if (!authorized(request.headers.get("authorization"), adminToken)) {
      return new Response(JSON.stringify({ error: "unauthorized" }), {
        status: 401,
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Cache-Control": "no-store",
          "WWW-Authenticate": 'Bearer realm="usage-observatory"',
        },
      });
    }
    const result = await collector.collect();
    return jsonResponse(result, false, result.ok ? 200 : 503);
  }

  return jsonResponse({ error: "not found" }, request.method === "HEAD", 404);
}

function buildDashboard(store: DatabaseStore, collector: UsageCollector): DashboardResponse {
  const generatedAt = new Date();
  const source = buildSourceStatus(store, generatedAt);
  const latestObservation = store.getLatestObservation();
  const counts = store.getCounts();
  const emptyAccount = {
    planType: null,
    subscriptionExpiresAt: null,
    renewalAt: null,
  };
  const emptyCredits = { hasCredits: null, balance: null };

  return {
    generatedAt: generatedAt.toISOString(),
    source,
    account: latestObservation?.account ?? emptyAccount,
    windows: latestObservation?.windows ?? [],
    credits: latestObservation?.credits ?? emptyCredits,
    pace: buildPace(store, latestObservation?.windows ?? [], source.state, generatedAt),
    bankedReset: buildBankedReset(store, collector, latestObservation),
    latestObservation,
    stats: {
      ...counts,
      retention: "indefinite",
    },
  };
}

function buildSourceStatus(store: DatabaseStore, now = new Date()): SourceStatus {
  const stored = store.getSourceStatus();
  let state = stored.state;
  if (state !== "auth_failed" && stored.lastSuccessAt) {
    const ageSeconds = (now.getTime() - Date.parse(stored.lastSuccessAt)) / 1_000;
    if (Number.isFinite(ageSeconds) && ageSeconds > stored.staleAfterSeconds) state = "stale";
  }

  return {
    provider: "openai-codex",
    displayName: sourceDisplayName(stored.mode),
    coverage: "OpenAI Codex subscription usage only; not general ChatGPT chat usage.",
    state,
    lastAttemptAt: stored.lastAttemptAt,
    lastSuccessAt: stored.lastSuccessAt,
    staleAfterSeconds: stored.staleAfterSeconds,
    error: stored.error,
  };
}

function sourceDisplayName(mode: SourceMode): string {
  switch (mode) {
    case "live":
      return "OpenAI Codex subscription usage (live token-file source; not general ChatGPT chat usage)";
    case "command":
      return "OpenAI Codex subscription usage (local OMP command source; not general ChatGPT chat usage)";
    default:
      return "OpenAI Codex subscription usage (fixture source; not general ChatGPT chat usage)";
  }
}

export function buildPace(
  store: DatabaseStore,
  windows: UsageWindow[],
  sourceState: SourceState,
  now: Date,
): PaceSummary {
  const unavailable = (explanation: string): PaceSummary => ({
    status: "unknown",
    ratio: null,
    recentRatePercentPerHour: null,
    projectedUsedAtReset: null,
    projectedExhaustionAt: null,
    basisHours: null,
    explanation,
  });
  if (sourceState === "stale" || sourceState === "auth_failed" || sourceState === "error") {
    return unavailable("Pace is unknown because the latest OpenAI Codex subscription observation is not fresh and healthy.");
  }

  const window = selectPaceWindow(windows);
  if (!window || !window.resetsAt || !window.windowSeconds) {
    return unavailable("Pace needs a regular Codex window with both a reset timestamp and a window duration.");
  }
  if (store.isWindowPending(window.key)) {
    return unavailable(
      "Pace is unknown while a reported usage decrease or reset-schedule change awaits corroborating observations.",
    );
  }
  const observedMilliseconds = Date.parse(window.observedAt);
  const resetMilliseconds = Date.parse(window.resetsAt);
  if (!Number.isFinite(observedMilliseconds) || !Number.isFinite(resetMilliseconds)) {
    return unavailable("Pace is unknown because the observation or reset timestamp is invalid.");
  }
  const remainingHours = (resetMilliseconds - observedMilliseconds) / 3_600_000;
  const windowStart = resetMilliseconds - window.windowSeconds * 1_000;
  const elapsedSeconds = (observedMilliseconds - windowStart) / 1_000;
  if (remainingHours <= 0 || elapsedSeconds <= 0 || elapsedSeconds > window.windowSeconds) {
    return unavailable("Pace is unknown because the reported reset cycle is outside its stated window.");
  }

  const expectedUsedPercent = (elapsedSeconds / window.windowSeconds) * 100;
  const ratio = expectedUsedPercent > 0 ? roundTo(window.usedPercent / expectedUsedPercent, 2) : null;
  let status: PaceSummary["status"] =
    ratio !== null && ratio < 0.9 ? "room_to_spend" : ratio !== null && ratio <= 1.05 ? "on_track" : "at_risk";
  if (window.usedPercent >= 100) status = "exhausted";

  const historySeconds = Math.min(window.windowSeconds, 24 * 3_600);
  const since = new Date(observedMilliseconds - historySeconds * 1_000).toISOString();
  const points = store.getWindowPacePoints(window.key, window.resetsAt, since);
  let segmentStart = Math.max(0, points.length - 1);
  for (let index = points.length - 1; index > 0; index -= 1) {
    if (points[index - 1].usedPercent > points[index].usedPercent) break;
    segmentStart = index - 1;
  }
  const first = points[segmentStart];
  const last = points.at(-1);
  let recentRate: number | null = null;
  let recentBasisHours: number | null = null;
  let gapIntersectsBasis = false;
  if (first && last) {
    const candidateBasis = (Date.parse(last.observedAt) - Date.parse(first.observedAt)) / 3_600_000;
    if (Number.isFinite(candidateBasis) && candidateBasis >= 5 / 60) {
      gapIntersectsBasis = store.hasObservationGapBetween(first.observedAt, last.observedAt);
      if (!gapIntersectsBasis) {
        recentBasisHours = candidateBasis;
        recentRate = Math.max(0, (last.usedPercent - first.usedPercent) / candidateBasis);
      }
    }
  }

  const projectedUsed =
    recentRate !== null && recentRate > 0
      ? window.usedPercent + recentRate * remainingHours
      : null;
  const hoursToExhaustion =
    recentRate !== null && recentRate > 0
      ? Math.max(0, (100 - window.usedPercent) / recentRate)
      : null;
  const projectedExhaustionAt =
    hoursToExhaustion !== null && hoursToExhaustion <= remainingHours
      ? new Date(observedMilliseconds + hoursToExhaustion * 3_600_000).toISOString()
      : null;
  const roundedRate = recentRate === null ? null : roundTo(recentRate, 2);
  const roundedProjection = projectedUsed === null ? null : roundTo(projectedUsed, 1);
  const roundedBasis = recentBasisHours === null ? null : roundTo(recentBasisHours, 2);
  let forecastExplanation: string;
  if (gapIntersectsBasis) {
    forecastExplanation = "The current-trend forecast is unavailable because an observation gap intersects its recent basis.";
  } else if (roundedRate === null || roundedBasis === null) {
    forecastExplanation =
      "The current-trend forecast needs at least five minutes of recent observations from this same reset cycle.";
  } else if (recentRate === 0) {
    forecastExplanation =
      `Recent usage was flat across ${roundedBasis} hours, so no runout projection is inferred.`;
  } else {
    forecastExplanation =
      `The recent rate is ${roundedRate}% per hour across ${roundedBasis} hours, projecting ${roundedProjection}% used at reset.`;
  }
  return {
    status,
    ratio,
    recentRatePercentPerHour: roundedRate,
    projectedUsedAtReset: roundedProjection,
    projectedExhaustionAt,
    basisHours: roundedBasis,
    explanation: `${roundTo(window.usedPercent, 1)}% is currently used versus ${roundTo(expectedUsedPercent, 1)}% at an even cycle pace. ${forecastExplanation} It is an interval estimate, not a provider guarantee.`,
  };
}

function selectPaceWindow(windows: UsageWindow[]): UsageWindow | null {
  const regular = windows.filter(
    (window) =>
      window.key === "openai-codex:primary" ||
      window.key === "primary" ||
      window.key === "openai-codex:secondary" ||
      window.key === "secondary",
  );
  return regular.toSorted((left, right) => (right.windowSeconds ?? 0) - (left.windowSeconds ?? 0))[0] ?? null;
}

function buildBankedReset(
  store: DatabaseStore,
  collector: UsageCollector,
  observation: DashboardResponse["latestObservation"],
): BankedResetSummary {
  const policy = collector.getRedemptionPolicy();
  const audit = store.getLatestAudit();
  const thresholds = {
    expiryHorizonHours: policy.expiryHorizonHours,
    maximumReportAgeSeconds: policy.maximumReportAgeSeconds,
  };
  const lastActionAt = audit?.finalizedAt ?? audit?.attemptedAt ?? audit?.plannedAt ?? null;

  if (collector.config.mode !== "live") {
    return {
      supported: false,
      thresholds,
      status: "unavailable",
      expiresAt: observation?.resetCredits.earliestExpiresAt ?? null,
      lastActionAt,
      reason:
        "This source can report reset credits but has no credentialed action transport; redemption is unavailable. No public redemption endpoint is exposed.",
      availableCount: observation?.resetCredits.availableCount ?? null,
      autoRedeemEnabled: policy.enabled,
      audit,
    };
  }
  if (audit) {
    return {
      supported: observation?.resetCredits.actionSupported ?? true,
      thresholds,
      status: audit.state,
      expiresAt: observation?.resetCredits.earliestExpiresAt ?? null,
      lastActionAt,
      reason: audit.reason ?? "The latest durable redemption audit has no additional reason.",
      availableCount: observation?.resetCredits.availableCount ?? null,
      autoRedeemEnabled: policy.enabled,
      audit,
    };
  }
  if (!observation || !observation.resetCredits.actionSupported) {
    return {
      supported: false,
      thresholds,
      status: "unavailable",
      expiresAt: observation?.resetCredits.earliestExpiresAt ?? null,
      lastActionAt: null,
      reason: "The live reset-credit listing/action capability is unavailable or has not yet been observed.",
      availableCount: observation?.resetCredits.availableCount ?? null,
      autoRedeemEnabled: policy.enabled,
      audit: null,
    };
  }
  if (observation.resetCredits.availableCount === 0) {
    return {
      supported: true,
      thresholds,
      status: "none",
      expiresAt: null,
      lastActionAt: null,
      reason: "The latest live listing contains no available reset credits.",
      availableCount: 0,
      autoRedeemEnabled: policy.enabled,
      audit: null,
    };
  }

  return {
    supported: true,
    thresholds,
    status: "available",
    expiresAt: observation.resetCredits.earliestExpiresAt,
    lastActionAt: null,
    reason: policy.enabled
      ? `Automatic salvage attempts every live-listed, dated, unexpired credit within ${policy.expiryHorizonHours} hours when the usage report is no older than ${policy.maximumReportAgeSeconds} seconds. Allowance consumption does not suppress an expiring-credit attempt.`
      : "Automatic redemption is disabled by default. Reset credits are observable, but no public redemption endpoint is exposed.",
    availableCount: observation.resetCredits.availableCount,
    autoRedeemEnabled: policy.enabled,
    audit: null,
  };
}

async function serveStatic(request: Request, url: URL, publicDirectory: string): Promise<Response> {
  if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
  let pathname: string;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }
  if (pathname.includes("\0")) return new Response("Bad request", { status: 400 });
  const requested = pathname === "/" ? "index.html" : pathname.slice(1);
  let filePath = resolve(publicDirectory, requested);
  const rootPrefix = publicDirectory.endsWith(sep) ? publicDirectory : `${publicDirectory}${sep}`;
  if (filePath !== publicDirectory && !filePath.startsWith(rootPrefix)) {
    return new Response("Not found", { status: 404 });
  }

  let file = Bun.file(filePath);
  if (!(await file.exists()) && !extname(requested)) {
    filePath = resolve(publicDirectory, "index.html");
    file = Bun.file(filePath);
  }
  if (!(await file.exists())) return new Response("Not found", { status: 404 });

  const extension = extname(filePath).toLowerCase();
  const headers = new Headers({
    "Content-Type": CONTENT_TYPES[extension] ?? "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    "Cache-Control":
      extension === ".html" || requested === "service-worker.js"
        ? "no-cache"
        : "public, max-age=3600",
  });
  if (request.method === "HEAD") return new Response(null, { status: 200, headers });
  return new Response(file, { status: 200, headers });
}

function jsonResponse(value: unknown, head: boolean, status = 200): Response {
  return new Response(head ? null : JSON.stringify(value), {
    status,
    headers: {
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function methodNotAllowed(allow: string): Response {
  return new Response(JSON.stringify({ error: "method not allowed" }), {
    status: 405,
    headers: {
      Allow: allow,
      "Content-Type": "application/json; charset=utf-8",
      "Cache-Control": "no-store",
    },
  });
}

function authorized(header: string | null, expected: string): boolean {
  if (!header?.startsWith("Bearer ")) return false;
  const supplied = Buffer.from(header.slice("Bearer ".length));
  const wanted = Buffer.from(expected);
  return supplied.length === wanted.length && timingSafeEqual(supplied, wanted);
}

function parsePort(value: string | undefined): number {
  if (!value) return 3000;
  const port = Number(value);
  if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) {
    throw new Error("PORT must be an integer from 1 through 65535.");
  }
  return port;
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

if (import.meta.main) {
  const application = startServer();
  const shutdown = () => {
    application.stop();
    process.exit(0);
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
  console.log(`Usage observatory listening on http://${application.server.hostname}:${application.server.port}`);
}

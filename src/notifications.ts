import { constants as fsConstants, closeSync, fstatSync, openSync, readSync } from "node:fs";
import { isAbsolute } from "node:path";
import webPush from "web-push";
import type { DatabaseStore } from "./db";
import type {
  CollectionResult,
  ObservationEvent,
  PaceStatus,
  PaceSummary,
  PushNotificationPayload,
  PushNotificationState,
  PushPreferences,
  PushSubscriptionInput,
  StoredPushSubscription,
  UsageWindow,
} from "./types";

const MAX_VAPID_FILE_BYTES = 4_096;
const MAX_PUSH_JSON_BYTES = 8_192;
const MAX_ENDPOINT_LENGTH = 4_096;
const PUSH_TIMEOUT_MILLISECONDS = 5_000;
const TRANSIENT_RETRY_DELAY_MILLISECONDS = 250;
const WEEKLY_WINDOW_SECONDS = 7 * 24 * 60 * 60;
const SCHEDULED_RESET_TOLERANCE_MILLISECONDS = 10 * 60 * 1_000;
const BASE64URL = /^[A-Za-z0-9_-]+$/;
const SAFE_PACE_BASELINES: Partial<Record<PaceStatus, true>> = {
  room_to_spend: true,
  on_track: true,
};
const OVER_BUDGET_PACE_STATUSES: Partial<Record<PaceStatus, true>> = {
  at_risk: true,
  exhausted: true,
};
const EXACT_PUSH_HOSTS: Record<string, true> = {
  "fcm.googleapis.com": true,
  "push.services.mozilla.com": true,
  "updates.push.services.mozilla.com": true,
};
export const DEFAULT_PUSH_PREFERENCES: PushPreferences = {
  overBudget: true,
  remaining25: false,
  remaining15: false,
  remaining5: false,
  weeklyReset: false,
  unscheduledReset: false,
};


export interface VapidConfiguration {
  subject: string;
  publicKey: string;
  privateKey: string;
}

export interface PublicPushConfiguration {
  enabled: boolean;
  publicKey: string | null;
}

interface PushSendOptions {
  TTL: number;
  timeout: number;
  urgency: "high";
  topic: string;
  vapidDetails: VapidConfiguration;
}

export type PushSender = (
  subscription: Pick<PushSubscriptionInput, "endpoint" | "keys">,
  payload: string,
  options: PushSendOptions,
) => Promise<unknown>;

export interface PushNotificationDependencies {
  send?: PushSender;
  sleep?: (milliseconds: number) => Promise<void>;
}

export function loadVapidConfiguration(env: NodeJS.ProcessEnv = process.env): VapidConfiguration | null {
  const path = env.VAPID_FILE?.trim();
  if (!path) return null;
  if (!isAbsolute(path)) throw new Error("Invalid VAPID_FILE: path must be absolute.");

  let descriptor: number | null = null;
  try {
    descriptor = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = fstatSync(descriptor);
    if (!metadata.isFile()) throw new Error("VAPID_FILE must be a regular file.");
    if ((metadata.mode & 0o777) !== 0o600) throw new Error("VAPID_FILE must have mode 0600.");
    if (typeof process.getuid === "function" && metadata.uid !== process.getuid()) {
      throw new Error("VAPID_FILE must be owned by the service user.");
    }
    if (metadata.size <= 0 || metadata.size > MAX_VAPID_FILE_BYTES) {
      throw new Error(`VAPID_FILE must contain between 1 and ${MAX_VAPID_FILE_BYTES} bytes.`);
    }

    const contents = Buffer.alloc(metadata.size + 1);
    const bytesRead = readSync(descriptor, contents, 0, contents.byteLength, 0);
    if (bytesRead !== metadata.size) throw new Error("VAPID_FILE changed while it was being read.");
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(contents.subarray(0, bytesRead));
    const parsed = JSON.parse(decoded) as unknown;
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      throw new Error("VAPID_FILE must contain a JSON object.");
    }
    const input = parsed as Record<string, unknown>;
    if (!hasExactKeys(input, ["subject", "publicKey", "privateKey"])) {
      throw new Error("VAPID_FILE must contain only subject, publicKey, and privateKey.");
    }
    if (typeof input.subject !== "string" || typeof input.publicKey !== "string" || typeof input.privateKey !== "string") {
      throw new Error("VAPID_FILE fields must be strings.");
    }
    validateVapidSubject(input.subject);
    validateBase64UrlKey(input.publicKey, 65, "VAPID public key", 0x04);
    validateBase64UrlKey(input.privateKey, 32, "VAPID private key");
    return {
      subject: input.subject,
      publicKey: input.publicKey,
      privateKey: input.privateKey,
    };
  } catch (error) {
    const reason = error instanceof Error ? error.message : "VAPID_FILE could not be read.";
    throw new Error(`Invalid VAPID_FILE: ${reason}`);
  } finally {
    if (descriptor !== null) closeSync(descriptor);
  }
}

export function validateVapidSubject(subject: string): void {
  if (subject !== subject.trim() || subject.length === 0 || subject.length > 512) {
    throw new Error("VAPID subject must be a nonempty mailto or HTTPS URI.");
  }
  let url: URL;
  try {
    url = new URL(subject);
  } catch {
    throw new Error("VAPID subject must be a valid mailto or HTTPS URI.");
  }
  if (url.protocol === "mailto:") {
    if (!url.pathname.includes("@") || url.search || url.hash) {
      throw new Error("VAPID mailto subject must contain an email address.");
    }
    return;
  }
  if (url.protocol !== "https:" || url.username || url.password) {
    throw new Error("VAPID subject must use mailto or HTTPS without credentials.");
  }
}

export function isAllowedPushEndpoint(endpoint: string): boolean {
  if (endpoint.length === 0 || endpoint.length > MAX_ENDPOINT_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password || url.port || url.hash) return false;
  const hostname = url.hostname.toLowerCase();
  return (
    EXACT_PUSH_HOSTS[hostname] === true ||
    hostname.endsWith(".push.apple.com") ||
    hostname.endsWith(".notify.windows.com")
  );
}

export function parsePushSubscription(input: unknown): PushSubscriptionInput {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid push subscription.");
  }
  const value = input as Record<string, unknown>;
  if (!hasOnlyKeys(value, ["endpoint", "expirationTime", "keys", "preferences"])) {
    throw new Error("Invalid push subscription.");
  }
  if (typeof value.endpoint !== "string" || !isAllowedPushEndpoint(value.endpoint)) {
    throw new Error("Push endpoint is not an allowed browser service.");
  }
  if (
    value.expirationTime !== undefined &&
    value.expirationTime !== null &&
    (typeof value.expirationTime !== "number" ||
      !Number.isSafeInteger(value.expirationTime) ||
      value.expirationTime < 0)
  ) {
    throw new Error("Invalid push subscription expiration.");
  }
  if (typeof value.keys !== "object" || value.keys === null || Array.isArray(value.keys)) {
    throw new Error("Invalid push subscription keys.");
  }
  const keys = value.keys as Record<string, unknown>;
  if (!hasExactKeys(keys, ["p256dh", "auth"])) {
    throw new Error("Invalid push subscription keys.");
  }
  if (typeof keys.p256dh !== "string" || typeof keys.auth !== "string") {
    throw new Error("Invalid push subscription keys.");
  }
  validateBase64UrlKey(keys.p256dh, 65, "Push p256dh key", 0x04);
  validateBase64UrlKey(keys.auth, 16, "Push auth key");
  const preferences =
    value.preferences === undefined ? undefined : parsePushPreferences(value.preferences);
  return {
    endpoint: value.endpoint,
    expirationTime: value.expirationTime ?? null,
    keys: { p256dh: keys.p256dh, auth: keys.auth },
    ...(preferences ? { preferences } : {}),
  };
}

export function parsePushPreferences(input: unknown): PushPreferences {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid push preferences.");
  }
  const value = input as Record<string, unknown>;
  const keys = [
    "overBudget",
    "remaining25",
    "remaining15",
    "remaining5",
    "weeklyReset",
    "unscheduledReset",
  ];
  if (!hasExactKeys(value, keys) || keys.some((key) => typeof value[key] !== "boolean")) {
    throw new Error("Invalid push preferences.");
  }
  return {
    overBudget: value.overBudget as boolean,
    remaining25: value.remaining25 as boolean,
    remaining15: value.remaining15 as boolean,
    remaining5: value.remaining5 as boolean,
    weeklyReset: value.weeklyReset as boolean,
    unscheduledReset: value.unscheduledReset as boolean,
  };
}

export function parsePushPreferenceUpdate(input: unknown): {
  endpoint: string;
  preferences: PushPreferences;
} {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid push preference update.");
  }
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, ["endpoint", "preferences"]) || typeof value.endpoint !== "string") {
    throw new Error("Invalid push preference update.");
  }
  if (!isAllowedPushEndpoint(value.endpoint)) {
    throw new Error("Push endpoint is not an allowed browser service.");
  }
  return {
    endpoint: value.endpoint,
    preferences: parsePushPreferences(value.preferences),
  };
}

export function parsePushUnsubscribe(input: unknown): string {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new Error("Invalid push unsubscribe request.");
  }
  const value = input as Record<string, unknown>;
  if (!hasExactKeys(value, ["endpoint"]) || typeof value.endpoint !== "string") {
    throw new Error("Invalid push unsubscribe request.");
  }
  if (!isAllowedPushEndpoint(value.endpoint)) {
    throw new Error("Push endpoint is not an allowed browser service.");
  }
  return value.endpoint;
}

export class PushNotificationService {
  private readonly send: PushSender;
  private readonly sleep: (milliseconds: number) => Promise<void>;

  constructor(
    private readonly store: DatabaseStore,
    private readonly configuration: VapidConfiguration | null,
    private readonly currentPace: () => PaceSummary,
    dependencies: PushNotificationDependencies = {},
  ) {
    this.send = dependencies.send ?? ((subscription, payload, options) =>
      webPush.sendNotification(subscription, payload, options));
    this.sleep = dependencies.sleep ?? ((milliseconds) => Bun.sleep(milliseconds));
  }

  publicConfiguration(): PublicPushConfiguration {
    return {
      enabled: this.configuration !== null,
      publicKey: this.configuration?.publicKey ?? null,
    };
  }

  initializeBaseline(): void {
    if (!this.configuration) return;
    for (const subscription of this.store.getPushSubscriptions()) {
      if (!this.store.getPushNotificationState(subscription.endpoint)) {
        this.baselineSubscription(subscription.endpoint);
      }
    }
  }

  subscribe(subscription: PushSubscriptionInput): PushPreferences {
    if (!this.configuration) throw new Error("Push notifications are not configured.");
    const stored = this.store.upsertPushSubscription(subscription, new Date().toISOString());
    this.baselineSubscription(stored.endpoint);
    return stored.preferences;
  }

  updatePreferences(endpoint: string, preferences: PushPreferences): PushPreferences {
    if (!this.configuration) throw new Error("Push notifications are not configured.");
    const stored = this.store.updatePushPreferences(endpoint, preferences, new Date().toISOString());
    if (!stored) throw new MissingPushSubscriptionError();
    this.baselineSubscription(endpoint);
    return stored.preferences;
  }

  unsubscribe(endpoint: string): void {
    this.store.deletePushSubscription(endpoint);
  }

  async handleCollection(result: CollectionResult): Promise<void> {
    if (!this.configuration || !result.ok || result.observationId === null) return;
    const cursor = this.store.getLatestObservationCursor();
    if (!cursor || cursor.id !== result.observationId) return;
    const subscriptions = this.store.getPushSubscriptions();
    if (subscriptions.length === 0) return;

    const pace = this.currentPace();
    const gap = this.store.observationHasGap(cursor.id);
    const weeklyWindow = this.currentWeeklyWindow(cursor.observedAt);
    const confirmedReset = weeklyWindow
      ? confirmedResetEvent(
          this.store.getObservationEvents(cursor.id, weeklyWindow.key),
          weeklyWindow,
        )
      : null;
    const resetType =
      !gap && confirmedReset
        ? classifyReset(confirmedReset, cursor.observedAt)
        : null;
    const deliveries: Array<{
      subscription: StoredPushSubscription;
      payload: PushNotificationPayload;
    }> = [];
    const updatedAt = new Date().toISOString();

    for (const subscription of subscriptions) {
      const prior = this.store.getPushNotificationState(subscription.endpoint);
      if (!prior) {
        this.store.setPushNotificationState(
          this.notificationState(subscription.endpoint, cursor.id, pace, weeklyWindow, updatedAt),
        );
        continue;
      }
      if (prior.lastObservationId >= cursor.id) continue;

      const next: PushNotificationState = {
        ...prior,
        lastObservationId: cursor.id,
        paceStatus: pace.status,
        updatedAt,
      };
      const payloads: PushNotificationPayload[] = [];
      const enteredOverBudget =
        !gap &&
        SAFE_PACE_BASELINES[prior.paceStatus] === true &&
        OVER_BUDGET_PACE_STATUSES[pace.status] === true;
      if (enteredOverBudget && subscription.preferences.overBudget) {
        payloads.push({
          type: "overBudget",
          projectedPercent: pace.projectedUsedAtReset,
        });
      }

      if (confirmedReset && weeklyWindow) {
        next.remainingPercent = weeklyWindow.remainingPercent;
        next.resetAt = weeklyWindow.resetsAt;
        next.remaining25Delivered = weeklyWindow.remainingPercent <= 25;
        next.remaining15Delivered = weeklyWindow.remainingPercent <= 15;
        next.remaining5Delivered = weeklyWindow.remainingPercent <= 5;
        if (resetType === "weeklyReset" && subscription.preferences.weeklyReset) {
          payloads.push({ type: "weeklyReset" });
        } else if (resetType === "unscheduledReset" && subscription.preferences.unscheduledReset) {
          payloads.push({ type: "unscheduledReset" });
        }
      } else if (!gap && weeklyWindow) {
        const crossed: Array<25 | 15 | 5> = [];
        if (
          prior.remainingPercent !== null &&
          prior.remainingPercent > 25 &&
          weeklyWindow.remainingPercent <= 25 &&
          !prior.remaining25Delivered
        ) {
          next.remaining25Delivered = true;
          if (subscription.preferences.remaining25) crossed.push(25);
        }
        if (
          prior.remainingPercent !== null &&
          prior.remainingPercent > 15 &&
          weeklyWindow.remainingPercent <= 15 &&
          !prior.remaining15Delivered
        ) {
          next.remaining15Delivered = true;
          if (subscription.preferences.remaining15) crossed.push(15);
        }
        if (
          prior.remainingPercent !== null &&
          prior.remainingPercent > 5 &&
          weeklyWindow.remainingPercent <= 5 &&
          !prior.remaining5Delivered
        ) {
          next.remaining5Delivered = true;
          if (subscription.preferences.remaining5) crossed.push(5);
        }
        next.remainingPercent = weeklyWindow.remainingPercent;
        next.resetAt = weeklyWindow.resetsAt;
        if (crossed.length > 0) {
          payloads.push({
            type: "remaining",
            thresholds: crossed,
            remainingPercent: weeklyWindow.remainingPercent,
          });
        }
      } else {
        next.remainingPercent = null;
      }

      // Cursor and every crossed-key delivery marker are durable before any network I/O.
      this.store.setPushNotificationState(next);
      for (const payload of payloads) deliveries.push({ subscription, payload });
    }

    await Promise.allSettled(
      deliveries.map(({ subscription, payload }) =>
        this.sendAtMostTwice(subscription, payload)),
    );
  }

  private baselineSubscription(endpoint: string): void {
    const cursor = this.store.getLatestObservationCursor();
    if (!cursor) return;
    const pace = this.currentPace();
    const weeklyWindow = this.currentWeeklyWindow(cursor.observedAt);
    this.store.setPushNotificationState(
      this.notificationState(
        endpoint,
        cursor.id,
        pace,
        weeklyWindow,
        new Date().toISOString(),
      ),
    );
  }

  private notificationState(
    endpoint: string,
    observationId: number,
    pace: PaceSummary,
    weeklyWindow: UsageWindow | null,
    updatedAt: string,
  ): PushNotificationState {
    const remaining = weeklyWindow?.remainingPercent ?? null;
    return {
      endpoint,
      lastObservationId: observationId,
      paceStatus: pace.status,
      remainingPercent: remaining,
      resetAt: weeklyWindow?.resetsAt ?? null,
      remaining25Delivered: remaining !== null && remaining <= 25,
      remaining15Delivered: remaining !== null && remaining <= 15,
      remaining5Delivered: remaining !== null && remaining <= 5,
      updatedAt,
    };
  }

  private currentWeeklyWindow(observedAt: string): UsageWindow | null {
    const observation = this.store.getLatestObservation();
    const weeklyWindow = observation?.windows.find(
      (window) =>
        isRegularWindowKey(window.key) &&
        window.windowSeconds === WEEKLY_WINDOW_SECONDS &&
        window.resetsAt !== null &&
        window.observedAt === observedAt,
    );
    if (!weeklyWindow || this.store.isWindowPending(weeklyWindow.key)) return null;
    return weeklyWindow;
  }

  private async sendAtMostTwice(
    subscription: StoredPushSubscription,
    payload: PushNotificationPayload,
  ): Promise<void> {
    const encoded = JSON.stringify(payload);
    try {
      await this.sendOnce(subscription, encoded, payload.type);
      return;
    } catch (error) {
      const statusCode = pushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        this.store.deletePushSubscriptionIfUnchanged(subscription);
        return;
      }
      if (!isUnambiguousTransientStatus(statusCode)) return;
    }

    await this.sleep(TRANSIENT_RETRY_DELAY_MILLISECONDS);
    try {
      await this.sendOnce(subscription, encoded, payload.type);
    } catch (error) {
      const statusCode = pushStatusCode(error);
      if (statusCode === 404 || statusCode === 410) {
        this.store.deletePushSubscriptionIfUnchanged(subscription);
      }
    }
  }

  private sendOnce(
    subscription: StoredPushSubscription,
    payload: string,
    type: PushNotificationPayload["type"],
  ): Promise<unknown> {
    return this.send(
      { endpoint: subscription.endpoint, keys: subscription.keys },
      payload,
      {
        TTL: 300,
        timeout: PUSH_TIMEOUT_MILLISECONDS,
        urgency: "high",
        topic: notificationTopic(type),
        vapidDetails: this.configuration!,
      },
    );
  }
}

class MissingPushSubscriptionError extends Error {
  constructor() {
    super("Push subscription was not found.");
  }
}

function isRegularWindowKey(key: string): boolean {
  return (
    key === "primary" ||
    key === "secondary" ||
    key === "openai-codex:primary" ||
    key === "openai-codex:secondary"
  );
}

function confirmedResetEvent(
  events: ObservationEvent[],
  weeklyWindow: UsageWindow,
): ObservationEvent | null {
  return events.find((event) => {
    if (
      event.kind !== "reset_timestamp_changed" ||
      event.uncertainty !== "low" ||
      event.previousResetAt === null ||
      event.currentResetAt === null ||
      event.currentResetAt !== weeklyWindow.resetsAt
    ) {
      return false;
    }
    const previous = Date.parse(event.previousResetAt);
    const current = Date.parse(event.currentResetAt);
    return Number.isFinite(previous) && Number.isFinite(current) && current > previous;
  }) ?? null;
}

function classifyReset(
  event: ObservationEvent,
  observedAt: string,
): "weeklyReset" | "unscheduledReset" | null {
  const observed = Date.parse(observedAt);
  const scheduled = Date.parse(event.previousResetAt!);
  if (!Number.isFinite(observed) || !Number.isFinite(scheduled)) return null;
  const offset = observed - scheduled;
  if (Math.abs(offset) <= SCHEDULED_RESET_TOLERANCE_MILLISECONDS) {
    return "weeklyReset";
  }
  return offset < -SCHEDULED_RESET_TOLERANCE_MILLISECONDS
    ? "unscheduledReset"
    : null;
}

function notificationTopic(type: PushNotificationPayload["type"]): string {
  if (type === "overBudget") return "usage-over-budget";
  if (type === "remaining") return "usage-remaining";
  if (type === "weeklyReset") return "usage-weekly-reset";
  return "usage-unscheduled-reset";
}

export async function handlePushApiRequest(
  request: Request,
  url: URL,
  notifications: PushNotificationService | null,
): Promise<Response | null> {
  if (url.pathname === "/api/push/config") {
    if (request.method !== "GET" && request.method !== "HEAD") return methodNotAllowed("GET, HEAD");
    return pushJson(
      notifications?.publicConfiguration() ?? { enabled: false, publicKey: null },
      request.method === "HEAD",
    );
  }

  if (url.pathname !== "/api/push/subscriptions") return null;
  if (
    request.method !== "POST" &&
    request.method !== "PATCH" &&
    request.method !== "DELETE"
  ) {
    return methodNotAllowed("POST, PATCH, DELETE");
  }
  if (!sameOriginMutation(request, url)) {
    return pushJson({ error: "same-origin request required" }, false, 403);
  }
  if (!notifications?.publicConfiguration().enabled) {
    return pushJson({ error: "push notifications are not configured" }, false, 503);
  }

  let body: unknown;
  try {
    body = await readBoundedJson(request);
  } catch (error) {
    const status = error instanceof BodyError ? error.status : 400;
    return pushJson({ error: error instanceof Error ? error.message : "invalid JSON body" }, false, status);
  }

  try {
    if (request.method === "POST") {
      const preferences = notifications.subscribe(parsePushSubscription(body));
      return pushJson({ subscribed: true, preferences }, false, 201);
    }
    if (request.method === "PATCH") {
      const update = parsePushPreferenceUpdate(body);
      const preferences = notifications.updatePreferences(update.endpoint, update.preferences);
      return pushJson({ subscribed: true, preferences }, false);
    }
    notifications.unsubscribe(parsePushUnsubscribe(body));
    return pushJson({ subscribed: false }, false);
  } catch (error) {
    const status = error instanceof MissingPushSubscriptionError ? 404 : 400;
    return pushJson(
      { error: error instanceof Error ? error.message : "invalid push request" },
      false,
      status,
    );
  }
}

class BodyError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

async function readBoundedJson(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (contentType !== "application/json") throw new BodyError(415, "content type must be application/json");
  const suppliedLength = request.headers.get("content-length");
  if (suppliedLength !== null) {
    const length = Number(suppliedLength);
    if (!Number.isSafeInteger(length) || length < 0) throw new BodyError(400, "invalid content length");
    if (length > MAX_PUSH_JSON_BYTES) throw new BodyError(413, "JSON body is too large");
  }

  const reader = request.body?.getReader();
  if (!reader) throw new BodyError(400, "JSON body is required");
  const chunks: Uint8Array[] = [];
  let length = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > MAX_PUSH_JSON_BYTES) {
      await reader.cancel();
      throw new BodyError(413, "JSON body is too large");
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    throw new BodyError(400, "body must contain valid UTF-8 JSON");
  }
}

function sameOriginMutation(request: Request, url: URL): boolean {
  const originHeader = request.headers.get("origin");
  if (!originHeader || originHeader === "null") return false;
  let suppliedOrigin: string;
  try {
    const origin = new URL(originHeader);
    if (origin.origin !== originHeader || origin.username || origin.password) return false;
    suppliedOrigin = origin.origin;
  } catch {
    return false;
  }

  const forwardedHostHeader = request.headers.get("x-forwarded-host");
  const forwardedHost = singleForwardedValue(forwardedHostHeader);
  if (forwardedHostHeader !== null && forwardedHost === null) return false;
  const host = forwardedHost ?? request.headers.get("host") ?? url.host;
  const forwardedProtocolHeader = request.headers.get("x-forwarded-proto");
  const forwardedProtocol = singleForwardedValue(forwardedProtocolHeader);
  if (forwardedProtocolHeader !== null && forwardedProtocol === null) return false;
  const protocol = forwardedProtocol ?? url.protocol.replace(/:$/, "");
  if (protocol !== "http" && protocol !== "https") return false;
  try {
    return suppliedOrigin === new URL(`${protocol}://${host}`).origin;
  } catch {
    return false;
  }
}

function singleForwardedValue(value: string | null): string | null {
  if (!value) return null;
  const trimmed = value.trim().toLowerCase();
  return trimmed && !trimmed.includes(",") ? trimmed : null;
}

function pushJson(value: unknown, head = false, status = 200): Response {
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
      "X-Content-Type-Options": "nosniff",
    },
  });
}

function validateBase64UrlKey(value: string, byteLength: number, label: string, firstByte?: number): void {
  if (!BASE64URL.test(value)) throw new Error(`${label} must use unpadded base64url.`);
  const decoded = Buffer.from(value, "base64url");
  if (decoded.byteLength !== byteLength || decoded.toString("base64url") !== value) {
    throw new Error(`${label} has an invalid length or encoding.`);
  }
  if (firstByte !== undefined && decoded[0] !== firstByte) {
    throw new Error(`${label} is not an uncompressed P-256 key.`);
  }
}

function pushStatusCode(error: unknown): number | null {
  if (typeof error !== "object" || error === null || !("statusCode" in error)) return null;
  const statusCode = error.statusCode;
  return typeof statusCode === "number" && Number.isInteger(statusCode) ? statusCode : null;
}

function isUnambiguousTransientStatus(statusCode: number | null): boolean {
  return statusCode === 408 || statusCode === 425 || statusCode === 429 || (statusCode !== null && statusCode >= 500 && statusCode <= 599);
}

function hasOnlyKeys(value: Record<string, unknown>, allowed: string[]): boolean {
  return Object.keys(value).every((key) => allowed.includes(key));
}

function hasExactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).length === expected.length && expected.every((key) => Object.hasOwn(value, key));
}


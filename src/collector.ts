import { constants as fsConstants } from "node:fs";
import { open, stat } from "node:fs/promises";
import { isAbsolute, resolve } from "node:path";
import type { DatabaseStore } from "./db";
import {
  accessTokenExpiresSoon,
  DEFAULT_OAUTH_CLIENT_ID,
  DEFAULT_OAUTH_ISSUER,
  loadOAuthCredentials,
  refreshOAuthCredentials,
} from "./oauth";
import type {
  CollectionResult,
  NormalizedObservation,
  NormalizedUsagePayload,
  RedemptionAudit,
  ResetCredit,
  SourceMode,
  SourceState,
  UsageWindow,
} from "./types";

const DEFAULT_USAGE_ENDPOINT = "https://chatgpt.com/backend-api/wham/usage";
const MAX_JSON_BYTES = 1_048_576;
const MAX_PROTECTED_FILE_BYTES = 16_384;
const MAX_COMMAND_OUTPUT_BYTES = 1_048_576;
const REGULAR_CODEX_WINDOW_KEYS: Record<string, true> = {
  primary: true,
  secondary: true,
  "openai-codex:primary": true,
  "openai-codex:secondary": true,
};
const ALLOWED_CODEX_LIMIT_KEYS: Record<string, true> = {
  ...REGULAR_CODEX_WINDOW_KEYS,
  "openai-codex:spark:primary": true,
  "openai-codex:spark:secondary": true,
};
const FINAL_REDEMPTION_OUTCOMES: Record<string, true> = {
  reset: true,
  already_redeemed: true,
  no_credit: true,
  nothing_to_reset: true,
};

export interface CollectorConfig {
  mode: SourceMode;
  usageEndpoint: string;
  tokenFile: string | null;
  accountIdFile: string | null;
  oauthFile: string | null;
  oauthIssuer: string;
  oauthClientId: string;
  usageCommand: string[];
  intervalSeconds: number;
  staleAfterSeconds: number;
  requestTimeoutMilliseconds: number;
  backoffBaseSeconds: number;
  backoffMaximumSeconds: number;
  autoRedeem: boolean;
  autoRedeemHorizonHours: number;
  maximumReportAgeSeconds: number;
}

interface LiveAuth {
  token: string;
  accountId: string | null;
  refreshToken: string | null;
  credentialPath: string | null;
  refreshed: boolean;
}

interface CreditListing {
  supported: boolean;
  known: boolean;
  credits: ResetCredit[];
}

interface ParsedPayload {
  payload: NormalizedUsagePayload;
  embeddedCredits: ResetCredit[];
}
type CollectionListener = (result: CollectionResult) => void;


class CollectorFailure extends Error {
  readonly state: SourceState;

  constructor(state: SourceState, message: string) {
    super(message);
    this.name = "CollectorFailure";
    this.state = state;
  }
}

export function loadCollectorConfig(env: NodeJS.ProcessEnv = process.env): CollectorConfig {
  const modeValue = env.USAGE_SOURCE_MODE?.trim() || "command";
  if (modeValue !== "live" && modeValue !== "command" && modeValue !== "fixture") {
    throw new Error("USAGE_SOURCE_MODE must be live, command, or fixture.");
  }

  return {
    mode: modeValue,
    usageEndpoint: env.USAGE_ENDPOINT?.trim() || DEFAULT_USAGE_ENDPOINT,
    tokenFile: nonEmpty(env.USAGE_TOKEN_FILE),
    accountIdFile: nonEmpty(env.USAGE_ACCOUNT_ID_FILE),
    oauthFile: nonEmpty(env.USAGE_OAUTH_FILE),
    oauthIssuer: env.CODEX_OAUTH_ISSUER?.trim() || DEFAULT_OAUTH_ISSUER,
    oauthClientId: env.CODEX_OAUTH_CLIENT_ID?.trim() || DEFAULT_OAUTH_CLIENT_ID,
    usageCommand: parseCommand(env.USAGE_COMMAND?.trim() || "omp usage --json"),
    intervalSeconds: boundedNumber(env.COLLECT_INTERVAL_SECONDS, 300, 30, 86_400),
    staleAfterSeconds: boundedNumber(env.STALE_AFTER_SECONDS, 900, 60, 604_800),
    requestTimeoutMilliseconds: boundedNumber(env.USAGE_REQUEST_TIMEOUT_MS, 15_000, 1_000, 120_000),
    backoffBaseSeconds: boundedNumber(env.COLLECT_BACKOFF_BASE_SECONDS, 30, 1, 3_600),
    backoffMaximumSeconds: boundedNumber(env.COLLECT_BACKOFF_MAX_SECONDS, 900, 1, 86_400),
    autoRedeem: parseBoolean(env.AUTO_REDEEM, false),
    autoRedeemHorizonHours: boundedNumber(env.AUTO_REDEEM_HORIZON_HOURS, 12, 1, 168),
    maximumReportAgeSeconds: 600,
  };
}

export class UsageCollector {
  readonly config: CollectorConfig;
  private readonly store: DatabaseStore;
  private timer: NodeJS.Timeout | null = null;
  private activeCollection: Promise<CollectionResult> | null = null;
  private consecutiveFailures = 0;
  private running = false;
  private nextAttemptAt: string | null = null;
  private readonly collectionListeners = new Set<CollectionListener>();


  constructor(store: DatabaseStore, config = loadCollectorConfig()) {
    this.store = store;
    this.config = config;
    this.store.configureSource(config.mode, config.staleAfterSeconds);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.schedule(0);
  }

  stop(): void {
    this.running = false;
    this.nextAttemptAt = null;
    clearTimeout(this.timer);
    this.timer = null;
  }

  isRunning(): boolean {
    return this.running;
  }

  getNextAttemptAt(): string | null {
    return this.nextAttemptAt;
  }

  getRedemptionPolicy(): {
    enabled: boolean;
    expiryHorizonHours: number;
    maximumReportAgeSeconds: number;
  } {
    return {
      enabled: this.config.autoRedeem,
      expiryHorizonHours: this.config.autoRedeemHorizonHours,
      maximumReportAgeSeconds: this.config.maximumReportAgeSeconds,
    };
  }

  collect(): Promise<CollectionResult> {
    if (this.activeCollection) return this.activeCollection;
    this.activeCollection = this.runCollection()
      .then((result) => {
        for (const listener of this.collectionListeners) {
          try {
            listener(result);
          } catch {
            // A live-update client must never affect collection or persistence.
          }
        }
        return result;
      })
      .finally(() => {
        this.activeCollection = null;
      });
    return this.activeCollection;
  }

  onCollectionComplete(listener: CollectionListener): () => void {
    this.collectionListeners.add(listener);
    return () => this.collectionListeners.delete(listener);
  }

  private schedule(delaySeconds: number): void {
    if (!this.running) return;
    clearTimeout(this.timer);
    const delayMilliseconds = Math.max(0, delaySeconds * 1_000);
    this.nextAttemptAt = new Date(Date.now() + delayMilliseconds).toISOString();
    this.timer = setTimeout(async () => {
      this.timer = null;
      const result = await this.collect();
      if (!this.running) return;
      if (result.ok) {
        this.consecutiveFailures = 0;
        this.schedule(this.config.intervalSeconds);
        return;
      }
      this.consecutiveFailures += 1;
      const exponent = Math.min(this.consecutiveFailures - 1, 20);
      const delay = Math.min(
        this.config.backoffMaximumSeconds,
        this.config.backoffBaseSeconds * 2 ** exponent,
      );
      this.schedule(delay);
    }, delayMilliseconds);
    this.timer.unref?.();
  }

  private async runCollection(): Promise<CollectionResult> {
    const attemptedAt = new Date().toISOString();
    try {
      let parsed: ParsedPayload;
      let listing: CreditListing;
      let auth: LiveAuth | null = null;

      if (this.config.mode === "live") {
        auth = await this.readLiveAuth();
        try {
          parsed = await this.fetchLiveUsage(auth);
        } catch (error) {
          if (!(error instanceof CollectorFailure) || error.state !== "auth_failed" || !auth.credentialPath || auth.refreshed) {
            throw error;
          }
          auth = await this.refreshLiveAuth(auth);
          parsed = await this.fetchLiveUsage(auth);
        }
        listing = await this.fetchResetCreditListing(auth);
      } else if (this.config.mode === "command") {
        const report = await this.runUsageCommand();
        parsed = normalizeUsagePayload(report, attemptedAt, true);
        listing = { supported: false, known: true, credits: parsed.embeddedCredits };
      } else {
        const fixture = await this.readFixture();
        parsed = normalizeUsagePayload(fixture, attemptedAt, false);
        listing = { supported: false, known: true, credits: parsed.embeddedCredits };
      }

      let redemptionAudit: RedemptionAudit | null = null;
      if (
        this.config.mode === "live" &&
        this.config.autoRedeem &&
        auth &&
        listing.supported &&
        listing.known
      ) {
        const redemption = await this.tryAutomaticRedemption(parsed, listing.credits, auth);
        parsed = redemption.parsed;
        listing = redemption.listing;
        redemptionAudit = redemption.audit;
      }

      const observedAt = parsed.payload.observedAt ?? attemptedAt;
      const availableCredits = listing.known ? listing.credits : parsed.embeddedCredits;
      const availableCount = listing.known
        ? availableCredits.filter((credit) => credit.status === "available").length
        : parsed.payload.resetCreditsAvailableCount;
      const earliestExpiresAt = earliestAvailableExpiry(availableCredits, observedAt);
      const observation: NormalizedObservation = {
        observedAt,
        account: parsed.payload.account,
        windows: parsed.payload.windows.map((window) => ({ ...window, observedAt })),
        credits: parsed.payload.credits,
        resetCredits: {
          availableCount,
          earliestExpiresAt,
          actionSupported: this.config.mode === "live" && listing.supported,
        },
      };

      const observationId = this.store.insertObservation(
        observation,
        this.config.mode,
        Math.max(this.config.staleAfterSeconds * 2, this.config.intervalSeconds * 3),
      );
      if (listing.known) this.store.replaceResetCreditInventory(listing.credits, observedAt);
      const successState: SourceState = this.config.mode === "fixture" ? "fixture" : "healthy";
      this.store.recordAttempt(attemptedAt, successState, null, true);
      return {
        ok: true,
        state: successState,
        observedAt,
        observationId,
        error: null,
        nextAttemptAt: this.nextAttemptAt,
        redemptionAudit,
      };
    } catch (error) {
      const failure =
        error instanceof CollectorFailure
          ? error
          : new CollectorFailure("error", "Usage collection failed before a normalized observation was available.");
      this.store.recordAttempt(attemptedAt, failure.state, failure.message, false);
      return {
        ok: false,
        state: failure.state,
        observedAt: null,
        observationId: null,
        error: failure.message,
        nextAttemptAt: this.nextAttemptAt,
        redemptionAudit: null,
      };
    }
  }

  async retryRedemption(auditId: number): Promise<RedemptionAudit> {
    if (this.config.mode !== "live") {
      throw new Error("Explicit redemption retry is available only with live token-file transport.");
    }
    const audit = this.store.getAuditById(auditId);
    if (!audit || (audit.state !== "ambiguous" && audit.state !== "planned")) {
      throw new Error("Only a planned or ambiguous redemption can be explicitly retried.");
    }

    const auth = await this.readLiveAuth();
    const listing = await this.fetchResetCreditListing(auth);
    if (!listing.supported || !listing.known) {
      throw new Error("A fresh reset-credit listing is required before explicit retry.");
    }
    const credit = listing.credits.find(
      (item) => item.id === audit.creditId && item.status === "available",
    );
    if (!credit) {
      return this.store.finishRedemption(
        audit.id,
        "final",
        new Date().toISOString(),
        "not_available",
        "A fresh listing no longer reports this credit as available; no consume request was sent.",
      );
    }

    const parsed = await this.fetchLiveUsage(auth);
    const eligibility = this.checkRedemptionEligibility(parsed.payload, credit, new Date());
    if (!eligibility.eligible) {
      throw new Error(`Explicit retry refused: ${eligibility.reason}`);
    }
    return this.consumeCredit(audit, auth);
  }

  private async tryAutomaticRedemption(
    parsed: ParsedPayload,
    credits: ResetCredit[],
    auth: LiveAuth,
  ): Promise<{ parsed: ParsedPayload; listing: CreditListing; audit: RedemptionAudit | null }> {
    const candidate = selectEarliestAvailableCredit(credits, new Date());
    if (!candidate) {
      return { parsed, listing: { supported: true, known: true, credits }, audit: null };
    }
    const initialEligibility = this.checkRedemptionEligibility(parsed.payload, candidate, new Date());
    if (!initialEligibility.eligible) {
      return { parsed, listing: { supported: true, known: true, credits }, audit: null };
    }

    const priorAudit = this.store.getAuditByCreditId(candidate.id);
    if (priorAudit && priorAudit.state !== "planned") {
      return { parsed, listing: { supported: true, known: true, credits }, audit: priorAudit };
    }

    const freshListing = await this.fetchResetCreditListing(auth);
    if (!freshListing.supported || !freshListing.known) {
      return { parsed, listing: freshListing, audit: priorAudit };
    }
    const freshlyListedCredit = freshListing.credits.find(
      (credit) => credit.id === candidate.id && credit.status === "available",
    );
    if (!freshlyListedCredit) {
      return { parsed, listing: freshListing, audit: priorAudit };
    }

    const freshParsed = await this.fetchLiveUsage(auth);
    const finalEligibility = this.checkRedemptionEligibility(
      freshParsed.payload,
      freshlyListedCredit,
      new Date(),
    );
    if (!finalEligibility.eligible) {
      return { parsed: freshParsed, listing: freshListing, audit: priorAudit };
    }

    const planned =
      priorAudit ??
      this.store.planRedemption(candidate.id, crypto.randomUUID(), new Date().toISOString());
    const audit = await this.consumeCredit(planned, auth);
    return { parsed: freshParsed, listing: freshListing, audit };
  }

  private checkRedemptionEligibility(
    payload: NormalizedUsagePayload,
    credit: ResetCredit,
    now: Date,
  ): { eligible: boolean; reason: string } {
    if (credit.status !== "available") {
      return { eligible: false, reason: "The reset credit is not listed as available." };
    }
    if (!credit.expiresAt) {
      return { eligible: false, reason: "The reset credit has no parseable expiry." };
    }
    const expiresAt = Date.parse(credit.expiresAt);
    if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
      return { eligible: false, reason: "The reset credit is expired or its expiry is invalid." };
    }
    if (expiresAt - now.getTime() > this.config.autoRedeemHorizonHours * 3_600_000) {
      return {
        eligible: false,
        reason: `The reset credit expires outside the ${this.config.autoRedeemHorizonHours}-hour salvage horizon.`,
      };
    }
    if (!payload.observedAt) {
      return { eligible: false, reason: "The usage report has no trustworthy observation time." };
    }
    const reportAgeSeconds = (now.getTime() - Date.parse(payload.observedAt)) / 1_000;
    if (
      !Number.isFinite(reportAgeSeconds) ||
      reportAgeSeconds < -60 ||
      reportAgeSeconds > this.config.maximumReportAgeSeconds
    ) {
      return {
        eligible: false,
        reason: `The usage report is not within the required ${this.config.maximumReportAgeSeconds}-second freshness limit.`,
      };
    }

    return {
      eligible: true,
      reason: "A live-listed, unexpired credit and a fresh usage report are eligible regardless of allowance consumption.",
    };
  }

  private async consumeCredit(audit: RedemptionAudit, auth: LiveAuth): Promise<RedemptionAudit> {
    const attemptedAt = new Date().toISOString();
    const inFlight = this.store.markRedemptionInFlight(audit.id, attemptedAt);
    const endpoint = deriveCreditEndpoint(this.config.usageEndpoint, true);
    const headers = buildAuthHeaders(auth);
    headers.set("Content-Type", "application/json");
    headers.set("Idempotency-Key", inFlight.redeemRequestId);
    const body: Record<string, string> = {
      credit_id: inFlight.creditId,
      redeem_request_id: inFlight.redeemRequestId,
    };
    if (auth.accountId) body.account_id = auth.accountId;

    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.config.requestTimeoutMilliseconds),
      });
    } catch {
      return this.store.finishRedemption(
        inFlight.id,
        "ambiguous",
        new Date().toISOString(),
        "unknown",
        "The consume request had a transport failure or timeout, so its result is ambiguous and automatic retry is prohibited.",
      );
    }

    const responsePayload = await readOptionalJson(response);
    const outcome = redemptionOutcome(responsePayload);
    if (outcome && FINAL_REDEMPTION_OUTCOMES[outcome] === true) {
      return this.store.finishRedemption(
        inFlight.id,
        "final",
        new Date().toISOString(),
        outcome,
        redemptionOutcomeReason(outcome),
      );
    }
    if (response.status === 401 || response.status === 403) {
      return this.store.finishRedemption(
        inFlight.id,
        "final",
        new Date().toISOString(),
        "auth_failed",
        "The provider rejected authorization; no automatic retry will be attempted.",
      );
    }
    if (response.status >= 500 || response.ok) {
      return this.store.finishRedemption(
        inFlight.id,
        "ambiguous",
        new Date().toISOString(),
        "unknown",
        "The provider response did not prove whether the credit was consumed; automatic retry is prohibited.",
      );
    }
    return this.store.finishRedemption(
      inFlight.id,
      "final",
      new Date().toISOString(),
      "rejected",
      `The provider rejected the consume request with HTTP ${response.status}; no automatic retry will be attempted.`,
    );
  }

  private async readLiveAuth(): Promise<LiveAuth> {
    validateCredentialEndpoint(this.config.usageEndpoint);
    if (this.config.oauthFile) {
      try {
        let credentials = await loadOAuthCredentials(this.config.oauthFile);
        let refreshed = false;
        if (accessTokenExpiresSoon(credentials.accessToken)) {
          credentials = await refreshOAuthCredentials(this.config.oauthFile, credentials, {
            issuer: this.config.oauthIssuer,
            clientId: this.config.oauthClientId,
            requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
          });
          refreshed = true;
        }
        return {
          token: credentials.accessToken,
          accountId: credentials.accountId,
          refreshToken: credentials.refreshToken,
          credentialPath: this.config.oauthFile,
          refreshed,
        };
      } catch (error) {
        const reason = error instanceof Error ? error.message : "OAuth credentials could not be loaded.";
        throw new CollectorFailure("auth_failed", reason);
      }
    }
    if (!this.config.tokenFile) {
      throw new CollectorFailure(
        "auth_failed",
        "Live collection requires a dedicated USAGE_OAUTH_FILE or an operator-supplied USAGE_TOKEN_FILE.",
      );
    }
    const token = await readProtectedValue(this.config.tokenFile, "usage token");
    if (!token || /\s/.test(token)) {
      throw new CollectorFailure("auth_failed", "The usage token file is empty or malformed.");
    }
    const accountId = this.config.accountIdFile
      ? await readProtectedValue(this.config.accountIdFile, "account identifier")
      : null;
    if (accountId && (!/^[A-Za-z0-9_-]{1,256}$/.test(accountId) || /\s/.test(accountId))) {
      throw new CollectorFailure("auth_failed", "The account identifier file is malformed.");
    }
    return {
      token,
      accountId,
      refreshToken: null,
      credentialPath: null,
      refreshed: false,
    };
  }

  private async refreshLiveAuth(auth: LiveAuth): Promise<LiveAuth> {
    if (!auth.credentialPath || !auth.refreshToken || !auth.accountId) {
      throw new CollectorFailure("auth_failed", "The dedicated OAuth credential cannot be refreshed.");
    }
    try {
      const credentials = await refreshOAuthCredentials(auth.credentialPath, {
        accessToken: auth.token,
        refreshToken: auth.refreshToken,
        accountId: auth.accountId,
      }, {
        issuer: this.config.oauthIssuer,
        clientId: this.config.oauthClientId,
        requestTimeoutMilliseconds: this.config.requestTimeoutMilliseconds,
      });
      return {
        token: credentials.accessToken,
        accountId: credentials.accountId,
        refreshToken: credentials.refreshToken,
        credentialPath: auth.credentialPath,
        refreshed: true,
      };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "OAuth refresh failed.";
      throw new CollectorFailure("auth_failed", reason);
    }
  }

  private async fetchLiveUsage(auth: LiveAuth): Promise<ParsedPayload> {
    const payload = await fetchRequiredJson(
      this.config.usageEndpoint,
      buildAuthHeaders(auth),
      this.config.requestTimeoutMilliseconds,
    );
    return normalizeUsagePayload(payload, new Date().toISOString(), false);
  }

  private async fetchResetCreditListing(auth: LiveAuth): Promise<CreditListing> {
    const endpoint = deriveCreditEndpoint(this.config.usageEndpoint, false);
    let response: Response;
    try {
      response = await fetch(endpoint, {
        headers: buildAuthHeaders(auth),
        signal: AbortSignal.timeout(this.config.requestTimeoutMilliseconds),
      });
    } catch {
      return { supported: true, known: false, credits: [] };
    }
    if (response.status === 404 || response.status === 405) {
      return { supported: false, known: true, credits: [] };
    }
    if (response.status === 401 || response.status === 403) {
      return { supported: false, known: false, credits: [] };
    }
    if (!response.ok) return { supported: true, known: false, credits: [] };
    try {
      const payload = await readRequiredJson(response);
      return { supported: true, known: true, credits: normalizeResetCredits(payload) };
    } catch {
      return { supported: true, known: false, credits: [] };
    }
  }

  private async runUsageCommand(): Promise<unknown> {
    if (this.config.usageCommand.length === 0) {
      throw new CollectorFailure("unconfigured", "USAGE_COMMAND has no executable.");
    }
    const childEnvironment: Record<string, string> = {};
    for (const key of ["HOME", "PATH", "TMPDIR", "LANG", "LC_ALL", "TERM", "OMP_CONFIG_HOME"]) {
      const value = process.env[key];
      if (value) childEnvironment[key] = value;
    }

    let child: Bun.Subprocess<"ignore", "pipe", "ignore">;
    try {
      child = Bun.spawn(this.config.usageCommand, {
        stdin: "ignore",
        stdout: "pipe",
        stderr: "ignore",
        env: childEnvironment,
      });
    } catch {
      throw new CollectorFailure("error", "The configured usage command could not be started.");
    }
    const timeout = setTimeout(() => child.kill(), this.config.requestTimeoutMilliseconds);
    try {
      const output = await readLimitedStream(child.stdout, MAX_COMMAND_OUTPUT_BYTES);
      const exitCode = await child.exited;
      if (exitCode !== 0) {
        throw new CollectorFailure("error", "The configured usage command exited unsuccessfully.");
      }
      let envelope: unknown;
      try {
        envelope = JSON.parse(output);
      } catch {
        throw new CollectorFailure("error", "The configured usage command did not return valid JSON.");
      }
      return selectOpenAiCodexReport(envelope);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async readFixture(): Promise<unknown> {
    const fixturePath = nonEmpty(process.env.FIXTURE_PATH);
    if (!fixturePath) {
      throw new CollectorFailure("unconfigured", "Fixture mode requires FIXTURE_PATH.");
    }
    if (!isAbsolute(fixturePath)) {
      throw new CollectorFailure("unconfigured", "FIXTURE_PATH must be absolute.");
    }
    let fileStats;
    try {
      fileStats = await stat(fixturePath);
    } catch {
      throw new CollectorFailure("error", "The configured fixture file is unavailable.");
    }
    if (!fileStats.isFile() || fileStats.size > MAX_JSON_BYTES) {
      throw new CollectorFailure("error", "The configured fixture must be a regular JSON file no larger than 1 MiB.");
    }
    let text: string;
    try {
      text = await Bun.file(fixturePath).text();
    } catch {
      throw new CollectorFailure("error", "The configured fixture file could not be read.");
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new CollectorFailure("error", "The configured fixture file is not valid JSON.");
    }
  }
}

export function normalizeUsagePayload(
  input: unknown,
  collectedAt: string,
  requireCodexReport: boolean,
): ParsedPayload {
  if (!isRecord(input)) {
    throw new CollectorFailure("error", "The usage source returned an unsupported JSON shape.");
  }
  if (requireCodexReport && input.provider !== "openai-codex") {
    throw new CollectorFailure("error", "The usage command did not contain an OpenAI Codex report.");
  }

  const observedAt = normalizeTimestamp(input.fetchedAt ?? input.fetched_at ?? input.observedAt) ?? collectedAt;
  const windows = normalizeWindows(input, observedAt);
  if (windows.length === 0) {
    throw new CollectorFailure("error", "The OpenAI Codex report contained no recognized usage windows.");
  }

  const creditObject = isRecord(input.credits) ? input.credits : null;
  const accountObject = isRecord(input.account) ? input.account : null;
  const metadataObject = isRecord(input.metadata) ? input.metadata : null;
  const resetCreditObject = isRecord(input.resetCredits)
    ? input.resetCredits
    : isRecord(input.rate_limit_reset_credits)
      ? input.rate_limit_reset_credits
      : null;
  const embeddedCredits = resetCreditObject ? normalizeResetCredits(resetCreditObject, true) : [];

  return {
    payload: {
      observedAt,
      account: {
        planType: safeMetadataString(input.plan_type ?? input.planType ?? accountObject?.planType ?? metadataObject?.planType),
        subscriptionExpiresAt: normalizeTimestamp(
          input.subscription_expires_at ??
            input.subscriptionExpiresAt ??
            accountObject?.subscriptionExpiresAt,
        ),
        renewalAt: normalizeTimestamp(input.renewal_at ?? input.renewalAt ?? accountObject?.renewalAt),
      },
      windows,
      credits: {
        hasCredits: strictBoolean(creditObject?.has_credits ?? creditObject?.hasCredits),
        balance: finiteNonnegativeNumber(creditObject?.balance),
      },
      resetCreditsAvailableCount:
        nonnegativeInteger(resetCreditObject?.available_count ?? resetCreditObject?.availableCount) ??
        (embeddedCredits.length > 0 ? embeddedCredits.filter((credit) => credit.status === "available").length : null),
    },
    embeddedCredits,
  };
}

function normalizeWindows(input: Record<string, unknown>, observedAt: string): Array<Omit<UsageWindow, "observedAt">> {
  const windows: Array<Omit<UsageWindow, "observedAt">> = [];
  const limits = input.limits;
  if (Array.isArray(limits)) {
    for (const value of limits) {
      if (!isRecord(value)) continue;
      const key = typeof value.id === "string" ? value.id : typeof value.key === "string" ? value.key : null;
      if (!key || ALLOWED_CODEX_LIMIT_KEYS[key] !== true) continue;
      const normalized = normalizeWindow(value, key, observedAt);
      if (normalized) windows.push(normalized);
    }
  } else if (isRecord(limits)) {
    for (const [rawKey, value] of Object.entries(limits)) {
      if (!isRecord(value) || ALLOWED_CODEX_LIMIT_KEYS[rawKey] !== true) continue;
      const normalized = normalizeWindow(value, rawKey, observedAt);
      if (normalized) windows.push(normalized);
    }
  }

  const rateLimit = isRecord(input.rate_limit)
    ? input.rate_limit
    : isRecord(input.rateLimit)
      ? input.rateLimit
      : null;
  if (rateLimit) {
    for (const [field, key] of [
      ["primary_window", "openai-codex:primary"],
      ["secondary_window", "openai-codex:secondary"],
      ["primaryWindow", "openai-codex:primary"],
      ["secondaryWindow", "openai-codex:secondary"],
    ] as const) {
      if (!isRecord(rateLimit[field])) continue;
      const normalized = normalizeWindow(rateLimit[field], key, observedAt);
      if (normalized) windows.push(normalized);
    }
  }

  const additional = Array.isArray(input.additional_rate_limits)
    ? input.additional_rate_limits
    : Array.isArray(input.additionalRateLimits)
      ? input.additionalRateLimits
      : [];
  for (const item of additional) {
    if (!isRecord(item)) continue;
    const feature = item.metered_feature ?? item.meteredFeature ?? item.limit_name ?? item.limitName;
    if (feature !== "codex_bengalfox" && feature !== "bengalfox" && feature !== "spark") continue;
    const nested = isRecord(item.rate_limit) ? item.rate_limit : isRecord(item.rateLimit) ? item.rateLimit : item;
    for (const [field, key] of [
      ["primary_window", "openai-codex:spark:primary"],
      ["secondary_window", "openai-codex:spark:secondary"],
      ["primaryWindow", "openai-codex:spark:primary"],
      ["secondaryWindow", "openai-codex:spark:secondary"],
    ] as const) {
      if (!isRecord(nested[field])) continue;
      const normalized = normalizeWindow(nested[field], key, observedAt);
      if (normalized) windows.push(normalized);
    }
  }

  const unique = new Map<string, Omit<UsageWindow, "observedAt">>();
  for (const window of windows) unique.set(window.key, window);
  return [...unique.values()];
}

function normalizeWindow(
  input: Record<string, unknown>,
  key: string,
  observedAt: string,
): Omit<UsageWindow, "observedAt"> | null {
  const amount = isRecord(input.amount) ? input.amount : null;
  const window = isRecord(input.window) ? input.window : null;
  let usedPercent = finitePercent(input.used_percent ?? input.usedPercent ?? amount?.used);
  if (usedPercent === null) {
    const usedFraction = finiteFraction(
      input.used_fraction ?? input.usedFraction ?? amount?.usedFraction,
    );
    if (usedFraction !== null) usedPercent = usedFraction * 100;
  }
  if (usedPercent === null) {
    const remainingPercent = finitePercent(
      input.remaining_percent ?? input.remainingPercent ?? amount?.remaining,
    );
    if (remainingPercent !== null) usedPercent = 100 - remainingPercent;
  }
  if (usedPercent === null) return null;

  const durationMilliseconds = finiteNonnegativeNumber(window?.durationMs);
  const windowSeconds =
    positiveInteger(input.limit_window_seconds ?? input.window_seconds ?? input.windowSeconds) ??
    (durationMilliseconds && durationMilliseconds >= 1_000
      ? Math.round(durationMilliseconds / 1_000)
      : null);
  let resetsAt = normalizeTimestamp(
    input.reset_at ?? input.resets_at ?? input.resetsAt ?? window?.resetsAt,
  );
  const resetAfterSeconds = nonnegativeInteger(
    input.reset_after_seconds ?? input.resetAfterSeconds,
  );
  if (!resetsAt && resetAfterSeconds !== null) {
    const observedMilliseconds = Date.parse(observedAt);
    if (Number.isFinite(observedMilliseconds)) {
      resetsAt = new Date(observedMilliseconds + resetAfterSeconds * 1_000).toISOString();
    }
  }

  const roundedUsed = roundTo(usedPercent, 4);
  return {
    key,
    label:
      safeMetadataString(input.label ?? window?.label) ??
      windowLabel(key, windowSeconds),
    usedPercent: roundedUsed,
    remainingPercent: roundTo(100 - roundedUsed, 4),
    resetsAt,
    windowSeconds,
  };
}

function normalizeResetCredits(input: unknown, allowSyntheticIds = false): ResetCredit[] {
  if (!isRecord(input)) return [];
  const values = Array.isArray(input.credits) ? input.credits : [];
  const credits: ResetCredit[] = [];
  for (const [index, value] of values.entries()) {
    if (!isRecord(value)) continue;
    const explicitId = typeof value.id === "string" ? value.id.trim() : "";
    const expiresAt = normalizeTimestamp(value.expires_at ?? value.expiresAt);
    const id =
      explicitId ||
      (allowSyntheticIds && expiresAt ? `reported-expiry:${expiresAt}:${index}` : "");
    if (!id || id.length > 256 || !/^[A-Za-z0-9_.:-]+$/.test(id)) continue;
    const statusValue = typeof value.status === "string" ? value.status.toLowerCase() : "unknown";
    const status = ["available", "redeemed", "expired", "consuming"].includes(statusValue)
      ? statusValue
      : "unknown";
    credits.push({
      id,
      status,
      expiresAt,
    });
  }
  return credits;
}

function selectOpenAiCodexReport(envelope: unknown): unknown {
  const candidates: unknown[] = [];
  if (Array.isArray(envelope)) candidates.push(...envelope);
  if (isRecord(envelope)) {
    if (envelope.provider === "openai-codex") candidates.push(envelope);
    for (const key of ["reports", "usageReports", "data"] as const) {
      const value = envelope[key];
      if (Array.isArray(value)) candidates.push(...value);
    }
  }
  const reports = candidates.filter(
    (candidate): candidate is Record<string, unknown> =>
      isRecord(candidate) && candidate.provider === "openai-codex",
  );
  if (reports.length !== 1) {
    throw new CollectorFailure(
      "error",
      reports.length === 0
        ? "The usage command returned no OpenAI Codex report."
        : "The usage command returned multiple OpenAI Codex reports, so selection is ambiguous.",
    );
  }
  return reports[0];
}

async function readProtectedValue(path: string, description: string): Promise<string> {
  if (!isAbsolute(path)) {
    throw new CollectorFailure("auth_failed", `The ${description} file path must be absolute.`);
  }
  let handle;
  try {
    handle = await open(resolve(path), fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const fileStats = await handle.stat();
    const processUid = process.getuid?.();
    if (!fileStats.isFile() || fileStats.size > MAX_PROTECTED_FILE_BYTES) {
      throw new CollectorFailure("auth_failed", `The ${description} file is not a small regular file.`);
    }
    if ((fileStats.mode & 0o077) !== 0) {
      throw new CollectorFailure("auth_failed", `The ${description} file must not be accessible by group or other users.`);
    }
    if (processUid !== undefined && fileStats.uid !== processUid) {
      throw new CollectorFailure("auth_failed", `The ${description} file must be owned by the service user.`);
    }
    const value = (await handle.readFile("utf8")).trim();
    if (!value || value.length > 8_192 || /[\r\n\0]/.test(value)) {
      throw new CollectorFailure("auth_failed", `The ${description} file is empty or malformed.`);
    }
    return value;
  } catch (error) {
    if (error instanceof CollectorFailure) throw error;
    throw new CollectorFailure("auth_failed", `The protected ${description} file could not be opened safely.`);
  } finally {
    await handle?.close();
  }
}

async function fetchRequiredJson(
  endpoint: string,
  headers: Headers,
  timeoutMilliseconds: number,
): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(endpoint, {
      headers,
      signal: AbortSignal.timeout(timeoutMilliseconds),
    });
  } catch {
    throw new CollectorFailure("error", "The OpenAI Codex usage request failed or timed out.");
  }
  if (response.status === 401 || response.status === 403) {
    throw new CollectorFailure("auth_failed", "OpenAI rejected the usage token or account context.");
  }
  if (!response.ok) {
    throw new CollectorFailure("error", `The OpenAI Codex usage endpoint returned HTTP ${response.status}.`);
  }
  return readRequiredJson(response);
}

async function readRequiredJson(response: Response): Promise<unknown> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_JSON_BYTES) {
    throw new CollectorFailure("error", "The usage source response exceeded the 1 MiB safety limit.");
  }
  const text = await readLimitedStream(response.body, MAX_JSON_BYTES);
  try {
    return JSON.parse(text);
  } catch {
    throw new CollectorFailure("error", "The usage source returned invalid JSON.");
  }
}

async function readOptionalJson(response: Response): Promise<unknown> {
  try {
    const text = await readLimitedStream(response.body, MAX_JSON_BYTES);
    if (!text) return null;
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function readLimitedStream(
  stream: ReadableStream<Uint8Array> | null,
  maximumBytes: number,
): Promise<string> {
  if (!stream) return "";
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let byteCount = 0;
  let text = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      byteCount += value.byteLength;
      if (byteCount > maximumBytes) {
        throw new CollectorFailure("error", "The usage source response exceeded its safety limit.");
      }
      text += decoder.decode(value, { stream: true });
    }
    text += decoder.decode();
    return text;
  } finally {
    reader.releaseLock();
  }
}

function buildAuthHeaders(auth: LiveAuth): Headers {
  const headers = new Headers({
    Accept: "application/json",
    Authorization: `Bearer ${auth.token}`,
  });
  if (auth.accountId) headers.set("ChatGPT-Account-Id", auth.accountId);
  return headers;
}

function validateCredentialEndpoint(endpoint: string): void {
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    throw new CollectorFailure("unconfigured", "USAGE_ENDPOINT is not a valid URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new CollectorFailure(
      "unconfigured",
      "USAGE_ENDPOINT must not contain credentials, query parameters, or a fragment.",
    );
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) {
    throw new CollectorFailure(
      "unconfigured",
      "Credential-bearing usage requests require HTTPS, except for an explicit loopback endpoint.",
    );
  }
  if (!url.pathname.endsWith("/usage")) {
    throw new CollectorFailure(
      "unconfigured",
      "USAGE_ENDPOINT must end in /usage so reset-credit endpoints can be derived safely.",
    );
  }
}

function deriveCreditEndpoint(usageEndpoint: string, consume: boolean): string {
  validateCredentialEndpoint(usageEndpoint);
  const url = new URL(usageEndpoint);
  url.pathname = `${url.pathname.slice(0, -"usage".length)}rate-limit-reset-credits${consume ? "/consume" : ""}`;
  return url.toString();
}

function redemptionOutcome(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  for (const value of [payload.code, payload.status, payload.result]) {
    if (typeof value === "string") return value.toLowerCase();
    if (isRecord(value) && typeof value.code === "string") return value.code.toLowerCase();
  }
  return null;
}

function redemptionOutcomeReason(outcome: string): string {
  switch (outcome) {
    case "reset":
      return "OpenAI confirmed that the reset credit was consumed and the eligible Codex limit was reset.";
    case "already_redeemed":
      return "OpenAI confirmed that this reset credit had already been redeemed.";
    case "no_credit":
      return "OpenAI confirmed that no consumable reset credit was available.";
    default:
      return "OpenAI confirmed that there was no eligible usage to reset.";
  }
}

function selectEarliestAvailableCredit(credits: ResetCredit[], now: Date): ResetCredit | null {
  let selected: ResetCredit | null = null;
  let selectedTime = Number.POSITIVE_INFINITY;
  for (const credit of credits) {
    if (credit.status !== "available" || !credit.expiresAt) continue;
    const expiry = Date.parse(credit.expiresAt);
    if (!Number.isFinite(expiry) || expiry <= now.getTime()) continue;
    if (expiry < selectedTime) {
      selected = credit;
      selectedTime = expiry;
    }
  }
  return selected;
}

function earliestAvailableExpiry(credits: ResetCredit[], observedAt: string): string | null {
  const selected = selectEarliestAvailableCredit(credits, new Date(observedAt));
  return selected?.expiresAt ?? null;
}

function windowLabel(key: string, windowSeconds: number | null): string {
  if (key === "primary" || key === "openai-codex:primary") {
    return windowSeconds === 18_000 ? "OpenAI Codex 5-hour window" : "OpenAI Codex primary window";
  }
  if (key === "secondary" || key === "openai-codex:secondary") {
    return windowSeconds === 604_800 ? "OpenAI Codex weekly window" : "OpenAI Codex secondary window";
  }
  if (key === "openai-codex:spark:primary") return "OpenAI Codex Spark primary window";
  return "OpenAI Codex Spark secondary window";
}

function normalizeTimestamp(value: unknown): string | null {
  let milliseconds: number;
  if (typeof value === "number" && Number.isFinite(value)) {
    milliseconds = value < 100_000_000_000 ? value * 1_000 : value;
  } else if (typeof value === "string" && value.trim()) {
    const numeric = Number(value);
    milliseconds = Number.isFinite(numeric)
      ? numeric < 100_000_000_000
        ? numeric * 1_000
        : numeric
      : Date.parse(value);
  } else {
    return null;
  }
  if (!Number.isFinite(milliseconds)) return null;
  try {
    return new Date(milliseconds).toISOString();
  } catch {
    return null;
  }
}

function safeMetadataString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed && trimmed.length <= 64 && /^[A-Za-z0-9 ()/:+_.-]+$/.test(trimmed) ? trimmed : null;
}

function strictBoolean(value: unknown): boolean | null {
  return typeof value === "boolean" ? value : null;
}

function finiteNonnegativeNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
}

function finitePercent(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 100
    ? value
    : null;
}

function finiteFraction(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1
    ? value
    : null;
}

function positiveInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 ? value : null;
}

function nonnegativeInteger(value: unknown): number | null {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0 ? value : null;
}

function roundTo(value: number, digits: number): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function parseBoolean(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") return fallback;
  if (value === "true" || value === "1") return true;
  if (value === "false" || value === "0") return false;
  throw new Error("Boolean configuration values must be true, false, 1, or 0.");
}

function boundedNumber(
  value: string | undefined,
  fallback: number,
  minimum: number,
  maximum: number,
): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`Numeric configuration must be between ${minimum} and ${maximum}.`);
  }
  return parsed;
}

function nonEmpty(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function parseCommand(value: string): string[] {
  if (value.startsWith("[")) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(value);
    } catch {
      throw new Error("USAGE_COMMAND JSON must be an array of argument strings.");
    }
    if (!Array.isArray(parsed) || parsed.length === 0 || parsed.some((item) => typeof item !== "string" || !item)) {
      throw new Error("USAGE_COMMAND JSON must be a non-empty array of non-empty argument strings.");
    }
    return parsed;
  }

  const parts: string[] = [];
  let current = "";
  let quote: "'" | '"' | null = null;
  let escaped = false;
  for (const character of value) {
    if (escaped) {
      current += character;
      escaped = false;
    } else if (character === "\\" && quote !== "'") {
      escaped = true;
    } else if (quote) {
      if (character === quote) quote = null;
      else current += character;
    } else if (character === "'" || character === '"') {
      quote = character;
    } else if (/\s/.test(character)) {
      if (current) {
        parts.push(current);
        current = "";
      }
    } else {
      current += character;
    }
  }
  if (escaped || quote) throw new Error("USAGE_COMMAND contains an unfinished escape or quote.");
  if (current) parts.push(current);
  if (parts.length === 0) throw new Error("USAGE_COMMAND must name an executable.");
  return parts;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

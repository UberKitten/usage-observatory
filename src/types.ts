export type SourceMode = "live" | "command" | "fixture";
export type SourceState =
  | "unconfigured"
  | "healthy"
  | "fixture"
  | "stale"
  | "auth_failed"
  | "error";

export type PaceStatus = "unknown" | "room_to_spend" | "on_track" | "at_risk" | "exhausted";
export type EventUncertainty = "low" | "medium" | "high";
export type RedemptionAuditState = "planned" | "in_flight" | "final" | "ambiguous";

export interface AccountSummary {
  planType: string | null;
  subscriptionExpiresAt: string | null;
  renewalAt: string | null;
}

export interface UsageWindow {
  key: string;
  label: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
  windowSeconds: number | null;
  observedAt: string;
}

export interface CreditsSummary {
  hasCredits: boolean | null;
  balance: number | null;
}

export interface ResetCreditSummary {
  availableCount: number | null;
  earliestExpiresAt: string | null;
  actionSupported: boolean;
}

export interface NormalizedObservation {
  observedAt: string;
  account: AccountSummary;
  windows: UsageWindow[];
  credits: CreditsSummary;
  resetCredits: ResetCreditSummary;
}

export interface SourceStatus {
  provider: "openai-codex";
  displayName: string;
  coverage: string;
  state: SourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  staleAfterSeconds: number;
  error: string | null;
}

export interface PaceSummary {
  status: PaceStatus;
  ratio: number | null;
  recentRatePercentPerHour: number | null;
  projectedUsedAtReset: number | null;
  projectedExhaustionAt: string | null;
  basisHours: number | null;
  explanation: string;
}

export interface RedemptionAudit {
  id: number;
  creditId: string;
  redeemRequestId: string;
  state: RedemptionAuditState;
  plannedAt: string;
  attemptedAt: string | null;
  finalizedAt: string | null;
  outcome: string | null;
  reason: string | null;
}

export interface BankedResetSummary {
  supported: boolean;
  thresholds: {
    expiryHorizonHours: number;
    minimumUsedPercent: number;
    maximumReportAgeSeconds: number;
    eligibleWindows: string[];
  };
  status: "unavailable" | "none" | "available" | RedemptionAuditState;
  expiresAt: string | null;
  lastActionAt: string | null;
  reason: string;
  availableCount: number | null;
  autoRedeemEnabled: boolean;
  audit: RedemptionAudit | null;
}

export interface ObservationEvent {
  id: number;
  kind: "observation_gap" | "reset_timestamp_changed" | "usage_decreased";
  windowKey: string | null;
  observedAt: string;
  previousResetAt: string | null;
  currentResetAt: string | null;
  deltaUsedPercent: number | null;
  uncertainty: EventUncertainty;
  detail: string;
}

export interface HistoryPoint {
  observedAt: string;
  windowKey: string;
  usedPercent: number;
  remainingPercent: number;
  resetsAt: string | null;
}

export type HistoryRange = "24h" | "7d" | "30d" | "90d" | "all";

export interface HistoryResponse {
  range: HistoryRange;
  points: HistoryPoint[];
  events: ObservationEvent[];
}

export interface DashboardResponse {
  generatedAt: string;
  source: SourceStatus;
  account: AccountSummary;
  windows: UsageWindow[];
  credits: CreditsSummary;
  pace: PaceSummary;
  bankedReset: BankedResetSummary;
  latestObservation: NormalizedObservation | null;
  stats: {
    observationCount: number;
    eventCount: number;
    retention: "indefinite";
  };
}

export interface HealthResponse {
  ok: boolean;
  generatedAt: string;
  database: "ok" | "error";
  sourceState: SourceState;
  schedulerRunning: boolean;
}

export interface ResetCredit {
  id: string;
  status: string;
  expiresAt: string | null;
}

export interface NormalizedUsagePayload {
  observedAt: string | null;
  account: AccountSummary;
  windows: Array<Omit<UsageWindow, "observedAt">>;
  credits: CreditsSummary;
  resetCreditsAvailableCount: number | null;
}

export interface CollectionResult {
  ok: boolean;
  state: SourceState;
  observedAt: string | null;
  error: string | null;
  nextAttemptAt: string | null;
  redemptionAudit: RedemptionAudit | null;
}

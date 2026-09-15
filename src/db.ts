import { Database } from "bun:sqlite";
import type {
  HistoryPoint,
  HistoryRange,
  NormalizedObservation,
  ObservationEvent,
  PaceStatus,
  PushNotificationState,
  PushPreferences,
  PushSubscriptionInput,
  RedemptionAuditState,
  ResetCredit,
  SourceMode,
  SourceState,
  StoredPushSubscription,
} from "./types";

const MIGRATIONS = [
  `
    CREATE TABLE source_status (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      mode TEXT NOT NULL,
      state TEXT NOT NULL,
      last_attempt_at TEXT,
      last_success_at TEXT,
      stale_after_seconds INTEGER NOT NULL,
      error TEXT
    );
    INSERT INTO source_status(singleton, mode, state, stale_after_seconds)
      VALUES (1, 'live', 'unconfigured', 900);

    CREATE TABLE observations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      observed_at TEXT NOT NULL,
      source_mode TEXT NOT NULL,
      plan_type TEXT,
      subscription_expires_at TEXT,
      renewal_at TEXT,
      has_credits INTEGER,
      credits_balance REAL,
      reset_credits_available_count INTEGER,
      earliest_reset_credit_expires_at TEXT,
      reset_action_supported INTEGER NOT NULL DEFAULT 0
    );

    CREATE TABLE usage_windows (
      observation_id INTEGER NOT NULL REFERENCES observations(id) ON DELETE CASCADE,
      window_key TEXT NOT NULL,
      label TEXT NOT NULL,
      used_percent REAL NOT NULL,
      remaining_percent REAL NOT NULL,
      resets_at TEXT,
      window_seconds INTEGER,
      PRIMARY KEY (observation_id, window_key)
    );

    CREATE TABLE observation_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      kind TEXT NOT NULL,
      window_key TEXT,
      observed_at TEXT NOT NULL,
      previous_reset_at TEXT,
      current_reset_at TEXT,
      delta_used_percent REAL,
      uncertainty TEXT NOT NULL,
      detail TEXT NOT NULL
    );

    CREATE TABLE reset_credit_inventory (
      credit_id TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      expires_at TEXT,
      last_seen_at TEXT NOT NULL
    );

    CREATE TABLE redemption_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      credit_id TEXT NOT NULL UNIQUE,
      redeem_request_id TEXT NOT NULL UNIQUE,
      state TEXT NOT NULL,
      planned_at TEXT NOT NULL,
      attempted_at TEXT,
      finalized_at TEXT,
      outcome TEXT,
      reason TEXT
    );
  `,
  `
    CREATE INDEX observations_observed_at_idx ON observations(observed_at);
    CREATE INDEX usage_windows_key_observation_idx
      ON usage_windows(window_key, observation_id);
    CREATE INDEX observation_events_observed_at_idx
      ON observation_events(observed_at);
    CREATE INDEX reset_credit_inventory_expiry_idx
      ON reset_credit_inventory(status, expires_at);
    CREATE INDEX redemption_audit_state_idx
      ON redemption_audit(state, id);
  `,
  `
    ALTER TABLE observation_events
      ADD COLUMN observation_id INTEGER REFERENCES observations(id);
    CREATE INDEX observation_events_observation_idx
      ON observation_events(observation_id, kind);

    CREATE TABLE web_push_subscriptions (
      endpoint TEXT PRIMARY KEY,
      expiration_time INTEGER,
      p256dh TEXT NOT NULL,
      auth TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );

    CREATE TABLE web_push_transition_state (
      singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
      last_observation_id INTEGER NOT NULL REFERENCES observations(id),
      pace_status TEXT NOT NULL CHECK (
        pace_status IN ('unknown', 'room_to_spend', 'on_track', 'at_risk', 'exhausted')
      ),
      updated_at TEXT NOT NULL
    );
  `,
  `
    ALTER TABLE web_push_subscriptions
      ADD COLUMN over_budget INTEGER NOT NULL DEFAULT 1 CHECK (over_budget IN (0, 1));
    ALTER TABLE web_push_subscriptions
      ADD COLUMN remaining_25 INTEGER NOT NULL DEFAULT 0 CHECK (remaining_25 IN (0, 1));
    ALTER TABLE web_push_subscriptions
      ADD COLUMN remaining_15 INTEGER NOT NULL DEFAULT 0 CHECK (remaining_15 IN (0, 1));
    ALTER TABLE web_push_subscriptions
      ADD COLUMN remaining_5 INTEGER NOT NULL DEFAULT 0 CHECK (remaining_5 IN (0, 1));
    ALTER TABLE web_push_subscriptions
      ADD COLUMN weekly_reset INTEGER NOT NULL DEFAULT 0 CHECK (weekly_reset IN (0, 1));
    ALTER TABLE web_push_subscriptions
      ADD COLUMN unscheduled_reset INTEGER NOT NULL DEFAULT 0 CHECK (unscheduled_reset IN (0, 1));

    CREATE TABLE web_push_notification_state (
      endpoint TEXT PRIMARY KEY
        REFERENCES web_push_subscriptions(endpoint) ON DELETE CASCADE,
      last_observation_id INTEGER NOT NULL
        REFERENCES observations(id) ON DELETE CASCADE,
      pace_status TEXT NOT NULL CHECK (
        pace_status IN ('unknown', 'room_to_spend', 'on_track', 'at_risk', 'exhausted')
      ),
      remaining_percent REAL,
      reset_at TEXT,
      remaining_25_delivered INTEGER NOT NULL CHECK (remaining_25_delivered IN (0, 1)),
      remaining_15_delivered INTEGER NOT NULL CHECK (remaining_15_delivered IN (0, 1)),
      remaining_5_delivered INTEGER NOT NULL CHECK (remaining_5_delivered IN (0, 1)),
      updated_at TEXT NOT NULL
    );
  `,
] as const;

interface SourceStatusRow {
  mode: SourceMode;
  state: SourceState;
  last_attempt_at: string | null;
  last_success_at: string | null;
  stale_after_seconds: number;
  error: string | null;
}
export interface PersistedSourceStatus {
  mode: SourceMode;
  state: SourceState;
  lastAttemptAt: string | null;
  lastSuccessAt: string | null;
  staleAfterSeconds: number;
  error: string | null;
}

interface ObservationRow {
  id: number;
  observed_at: string;
  plan_type: string | null;
  subscription_expires_at: string | null;
  renewal_at: string | null;
  has_credits: number | null;
  credits_balance: number | null;
  reset_credits_available_count: number | null;
  earliest_reset_credit_expires_at: string | null;
  reset_action_supported: number;
}

interface WindowRow {
  window_key: string;
  label: string;
  used_percent: number;
  remaining_percent: number;
  resets_at: string | null;
  window_seconds: number | null;
}

interface PriorWindowRow extends WindowRow {
  observed_at: string;
}

interface DerivedWindowRow extends WindowRow {
  observation_id: number;
  observed_at: string;
}

type DerivedTransition = Omit<ObservationEvent, "id">;

interface DerivedSeries {
  rows: DerivedWindowRow[];
  pendingWindowKeys: Set<string>;
  transitions: DerivedTransition[];
}

interface EventRow {
  id: number;
  kind: ObservationEvent["kind"];
  window_key: string | null;
  observed_at: string;
  previous_reset_at: string | null;
  current_reset_at: string | null;
  delta_used_percent: number | null;
  uncertainty: ObservationEvent["uncertainty"];
  detail: string;
}


interface AuditRow {
  id: number;
  credit_id: string;
  redeem_request_id: string;
  state: RedemptionAuditState;
  planned_at: string;
  attempted_at: string | null;
  finalized_at: string | null;
  outcome: string | null;
  reason: string | null;
}

interface PushSubscriptionRow {
  endpoint: string;
  expiration_time: number | null;
  p256dh: string;
  auth: string;
  created_at: string;
  updated_at: string;
  over_budget: number;
  remaining_25: number;
  remaining_15: number;
  remaining_5: number;
  weekly_reset: number;
  unscheduled_reset: number;
}

interface PushNotificationStateRow {
  endpoint: string;
  last_observation_id: number;
  pace_status: PaceStatus;
  remaining_percent: number | null;
  reset_at: string | null;
  remaining_25_delivered: number;
  remaining_15_delivered: number;
  remaining_5_delivered: number;
  updated_at: string;
}

const RANGE_MILLISECONDS: Record<Exclude<HistoryRange, "all">, number> = {
  "24h": 24 * 60 * 60 * 1_000,
  "7d": 7 * 24 * 60 * 60 * 1_000,
  "30d": 30 * 24 * 60 * 60 * 1_000,
  "90d": 90 * 24 * 60 * 60 * 1_000,
};
const MAX_HISTORY_EVENTS = 100;
const RESET_SHIFT_TOLERANCE_MILLISECONDS = 10_000;
const MATERIAL_RESET_SHIFT_MILLISECONDS = 60_000;
const USAGE_DECREASE_EPSILON = 0.000_001;
const SUSTAINED_CORRECTION_SAMPLES = 4;
const SUSTAINED_CORRECTION_MILLISECONDS = 30 * 60 * 1_000;

interface ResetTransition {
  changed: boolean;
  crossedScheduledBoundary: boolean;
  rollsWithObservation: boolean;
  materiallyShifted: boolean;
}

function analyzeResetTransition(
  previousObservedAt: string,
  currentObservedAt: string,
  previousResetAt: string | null,
  currentResetAt: string | null,
): ResetTransition {
  if (previousResetAt === null || currentResetAt === null || previousResetAt === currentResetAt) {
    return {
      changed: false,
      crossedScheduledBoundary: false,
      rollsWithObservation: false,
      materiallyShifted: false,
    };
  }

  const previousObservedMilliseconds = Date.parse(previousObservedAt);
  const currentObservedMilliseconds = Date.parse(currentObservedAt);
  const previousResetMilliseconds = Date.parse(previousResetAt);
  const currentResetMilliseconds = Date.parse(currentResetAt);
  if (
    !Number.isFinite(previousObservedMilliseconds) ||
    !Number.isFinite(currentObservedMilliseconds) ||
    !Number.isFinite(previousResetMilliseconds) ||
    !Number.isFinite(currentResetMilliseconds)
  ) {
    return {
      changed: true,
      crossedScheduledBoundary: false,
      rollsWithObservation: false,
      materiallyShifted: true,
    };
  }

  const observationShift = currentObservedMilliseconds - previousObservedMilliseconds;
  const resetShift = currentResetMilliseconds - previousResetMilliseconds;
  const rollsWithObservation =
    observationShift > 0 &&
    resetShift > 0 &&
    Math.abs(resetShift - observationShift) <= RESET_SHIFT_TOLERANCE_MILLISECONDS;

  return {
    changed: true,
    crossedScheduledBoundary:
      previousObservedMilliseconds < previousResetMilliseconds &&
      currentObservedMilliseconds >= previousResetMilliseconds,
    rollsWithObservation,
    materiallyShifted:
      !rollsWithObservation && Math.abs(resetShift) >= MATERIAL_RESET_SHIFT_MILLISECONDS,
  };
}

function resetAdvanced(previousResetAt: string | null, currentResetAt: string | null): boolean {
  if (previousResetAt === null || currentResetAt === null) return false;
  const previous = Date.parse(previousResetAt);
  const current = Date.parse(currentResetAt);
  return Number.isFinite(previous) && Number.isFinite(current) && current > previous;
}

function resetTimestampsEquivalent(left: string | null, right: string | null): boolean {
  if (left === right) return true;
  if (left === null || right === null) return false;
  const leftMilliseconds = Date.parse(left);
  const rightMilliseconds = Date.parse(right);
  return (
    Number.isFinite(leftMilliseconds) &&
    Number.isFinite(rightMilliseconds) &&
    Math.abs(leftMilliseconds - rightMilliseconds) < MATERIAL_RESET_SHIFT_MILLISECONDS
  );
}

function isConfirmedReset(previous: DerivedWindowRow, current: DerivedWindowRow): boolean {
  if (!resetAdvanced(previous.resets_at, current.resets_at)) return false;
  const reset = analyzeResetTransition(
    previous.observed_at,
    current.observed_at,
    previous.resets_at,
    current.resets_at,
  );
  const reachedZero = previous.used_percent > USAGE_DECREASE_EPSILON && current.used_percent <= USAGE_DECREASE_EPSILON;
  return reachedZero || reset.crossedScheduledBoundary;
}

function sameSample(left: DerivedWindowRow, right: DerivedWindowRow): boolean {
  return (
    left.observed_at === right.observed_at &&
    left.used_percent === right.used_percent &&
    left.resets_at === right.resets_at
  );
}

function deriveWindowSeries(rows: DerivedWindowRow[]): {
  rows: DerivedWindowRow[];
  pending: boolean;
  transitions: DerivedTransition[];
} {
  const deduplicated: DerivedWindowRow[] = [];
  for (const row of rows) {
    if (!deduplicated.some((candidate) => sameSample(candidate, row))) deduplicated.push(row);
  }
  if (deduplicated.length === 0) return { rows: [], pending: false, transitions: [] };

  const accepted: DerivedWindowRow[] = [];
  const transitions: DerivedTransition[] = [];
  const accept = (row: DerivedWindowRow): void => {
    const previous = accepted.at(-1);
    if (previous) {
      const delta = row.used_percent - previous.used_percent;
      if (isConfirmedReset(previous, row)) {
        transitions.push({
          kind: "reset_timestamp_changed",
          windowKey: row.window_key,
          observedAt: row.observed_at,
          previousResetAt: previous.resets_at,
          currentResetAt: row.resets_at,
          deltaUsedPercent: delta,
          uncertainty: "low",
          detail:
            "The prior scheduled boundary was crossed or zero usage was observed, and the next reset advanced.",
        });
      } else if (delta < -USAGE_DECREASE_EPSILON) {
        transitions.push({
          kind: "usage_decreased",
          windowKey: row.window_key,
          observedAt: row.observed_at,
          previousResetAt: previous.resets_at,
          currentResetAt: row.resets_at,
          deltaUsedPercent: delta,
          uncertainty: "high",
          detail:
            "Repeated observations confirmed a sustained provider-side usage correction; this is not treated as a reset.",
        });
      }
    }
    accepted.push(row);
  };

  accept(deduplicated[0]);
  let index = 1;
  while (index < deduplicated.length) {
    const previous = accepted.at(-1)!;
    const current = deduplicated[index];
    const delta = current.used_percent - previous.used_percent;
    const reset = analyzeResetTransition(
      previous.observed_at,
      current.observed_at,
      previous.resets_at,
      current.resets_at,
    );

    if (isConfirmedReset(previous, current)) {
      accept(current);
      index += 1;
      continue;
    }

    const suspicious =
      delta < -USAGE_DECREASE_EPSILON ||
      reset.materiallyShifted;
    if (!suspicious) {
      accept(current);
      index += 1;
      continue;
    }

    let runResetAt: string | null | undefined;
    let runStartAt = 0;
    let runLastUsed = 0;
    let runSamples = 0;
    let resolution:
      | { kind: "rebound" | "reset" | "sustained"; index: number }
      | null = null;

    for (let candidateIndex = index; candidateIndex < deduplicated.length; candidateIndex += 1) {
      const candidate = deduplicated[candidateIndex];
      if (isConfirmedReset(previous, candidate)) {
        resolution = { kind: "reset", index: candidateIndex };
        break;
      }
      if (
        candidate.resets_at === previous.resets_at &&
        candidate.used_percent >= previous.used_percent - USAGE_DECREASE_EPSILON
      ) {
        resolution = { kind: "rebound", index: candidateIndex };
        break;
      }

      const candidateAt = Date.parse(candidate.observed_at);
      const continuesRun =
        runSamples > 0 &&
        candidate.resets_at === runResetAt &&
        candidate.used_percent >= runLastUsed - USAGE_DECREASE_EPSILON;
      if (!continuesRun) {
        runResetAt = candidate.resets_at;
        runStartAt = candidateAt;
        runSamples = 1;
      } else {
        runSamples += 1;
      }
      runLastUsed = candidate.used_percent;

      if (
        runSamples >= SUSTAINED_CORRECTION_SAMPLES &&
        Number.isFinite(candidateAt) &&
        Number.isFinite(runStartAt) &&
        candidateAt - runStartAt >= SUSTAINED_CORRECTION_MILLISECONDS
      ) {
        resolution = { kind: "sustained", index: candidateIndex };
        break;
      }
    }

    if (resolution === null) return { rows: accepted, pending: true, transitions };
    if (resolution.kind === "sustained") {
      for (let acceptedIndex = index; acceptedIndex <= resolution.index; acceptedIndex += 1) {
        accept(deduplicated[acceptedIndex]);
      }
    } else {
      accept(deduplicated[resolution.index]);
    }
    index = resolution.index + 1;
  }

  return { rows: accepted, pending: false, transitions };
}

export class DatabaseStore {
  readonly database: Database;
  private derivedSeriesCache: DerivedSeries | null = null;

  constructor(path: string) {
    this.database = new Database(path, { create: true, strict: true });
    this.database.exec("PRAGMA journal_mode = WAL");
    this.database.exec("PRAGMA foreign_keys = ON");
    this.database.exec("PRAGMA busy_timeout = 5000");
    this.migrate();
    this.markInterruptedRedemptionsAmbiguous();
  }

  close(): void {
    this.database.close();
  }

  private migrate(): void {
    const row = this.database.query<{ user_version: number }, []>("PRAGMA user_version").get();
    let version = row?.user_version ?? 0;
    if (version > MIGRATIONS.length) {
      throw new Error(`Database schema version ${version} is newer than this application supports.`);
    }

    while (version < MIGRATIONS.length) {
      this.database.exec("BEGIN IMMEDIATE");
      try {
        this.database.exec(MIGRATIONS[version]);
        version += 1;
        this.database.exec(`PRAGMA user_version = ${version}`);
        this.database.exec("COMMIT");
      } catch (error) {
        this.database.exec("ROLLBACK");
        throw error;
      }
    }
  }

  configureSource(mode: SourceMode, staleAfterSeconds: number): void {
    this.database
      .query("UPDATE source_status SET mode = ?, stale_after_seconds = ? WHERE singleton = 1")
      .run(mode, staleAfterSeconds);
  }

  recordAttempt(at: string, state: SourceState, error: string | null, succeeded: boolean): void {
    if (succeeded) {
      this.database
        .query(
          `UPDATE source_status
             SET state = ?, last_attempt_at = ?, last_success_at = ?, error = NULL
           WHERE singleton = 1`,
        )
        .run(state, at, at);
      return;
    }

    this.database
      .query(
        `UPDATE source_status
           SET state = ?, last_attempt_at = ?, error = ?
         WHERE singleton = 1`,
      )
      .run(state, at, error);
  }

  getSourceStatus(): PersistedSourceStatus {
    const row = this.database.query<SourceStatusRow, []>("SELECT * FROM source_status WHERE singleton = 1").get();
    if (!row) throw new Error("Source status row is missing.");
    return {
      mode: row.mode,
      state: row.state,
      lastAttemptAt: row.last_attempt_at,
      lastSuccessAt: row.last_success_at,
      staleAfterSeconds: row.stale_after_seconds,
      error: row.error,
    };
  }

  insertObservation(
    observation: NormalizedObservation,
    mode: SourceMode,
    gapThresholdSeconds: number,
  ): number {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      const previous = this.database
        .query<{ id: number; observed_at: string }, []>(
          "SELECT id, observed_at FROM observations ORDER BY observed_at DESC, id DESC LIMIT 1",
        )
        .get();

      const inserted = this.database
        .query(
          `INSERT INTO observations (
             observed_at, source_mode, plan_type, subscription_expires_at, renewal_at,
             has_credits, credits_balance, reset_credits_available_count,
             earliest_reset_credit_expires_at, reset_action_supported
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          observation.observedAt,
          mode,
          observation.account.planType,
          observation.account.subscriptionExpiresAt,
          observation.account.renewalAt,
          observation.credits.hasCredits === null ? null : observation.credits.hasCredits ? 1 : 0,
          observation.credits.balance,
          observation.resetCredits.availableCount,
          observation.resetCredits.earliestExpiresAt,
          observation.resetCredits.actionSupported ? 1 : 0,
        );
      const observationId = Number(inserted.lastInsertRowid);

      if (previous) {
        const gapSeconds =
          (Date.parse(observation.observedAt) - Date.parse(previous.observed_at)) / 1_000;
        if (Number.isFinite(gapSeconds) && gapSeconds > gapThresholdSeconds) {
          this.insertEvent({
            kind: "observation_gap",
            windowKey: null,
            observedAt: observation.observedAt,
            previousResetAt: null,
            currentResetAt: null,
            deltaUsedPercent: null,
            uncertainty: "high",
            detail: `No observations were recorded for ${Math.round(gapSeconds)} seconds; activity during the gap is unknown.`,
          },
          observationId,
          );
        }
      }

      for (const window of observation.windows) {
        const prior = this.database
          .query<PriorWindowRow, [string]>(
            `SELECT o.observed_at, w.window_key, w.label, w.used_percent, w.remaining_percent,
                    w.resets_at, w.window_seconds
               FROM usage_windows w
               JOIN observations o ON o.id = w.observation_id
              WHERE w.window_key = ?
              ORDER BY o.observed_at DESC, o.id DESC
              LIMIT 1`,
          )
          .get(window.key);

        this.database
          .query(
            `INSERT INTO usage_windows (
               observation_id, window_key, label, used_percent, remaining_percent,
               resets_at, window_seconds
             ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            observationId,
            window.key,
            window.label,
            window.usedPercent,
            window.remainingPercent,
            window.resetsAt,
            window.windowSeconds,
          );

        if (!prior) continue;
        const delta = window.usedPercent - prior.used_percent;
        const reset = analyzeResetTransition(
          prior.observed_at,
          observation.observedAt,
          prior.resets_at,
          window.resetsAt,
        );

        const currentRow: DerivedWindowRow = {
          observation_id: observationId,
          observed_at: observation.observedAt,
          window_key: window.key,
          label: window.label,
          used_percent: window.usedPercent,
          remaining_percent: window.remainingPercent,
          resets_at: window.resetsAt,
          window_seconds: window.windowSeconds,
        };
        const previousRow: DerivedWindowRow = {
          observation_id: 0,
          observed_at: prior.observed_at,
          window_key: prior.window_key,
          label: prior.label,
          used_percent: prior.used_percent,
          remaining_percent: prior.remaining_percent,
          resets_at: prior.resets_at,
          window_seconds: prior.window_seconds,
        };
        if (isConfirmedReset(previousRow, currentRow)) {
          this.insertEvent({
            kind: "reset_timestamp_changed",
            windowKey: window.key,
            observedAt: observation.observedAt,
            previousResetAt: prior.resets_at,
            currentResetAt: window.resetsAt,
            deltaUsedPercent: delta,
            uncertainty: "low",
            detail:
              "The prior scheduled boundary was crossed or zero usage was observed, and the next reset advanced.",
          },
          observationId,
          );
          continue;
        }

        if (delta < -USAGE_DECREASE_EPSILON) {
          this.insertEvent({
            kind: "usage_decreased",
            windowKey: window.key,
            observedAt: observation.observedAt,
            previousResetAt: prior.resets_at,
            currentResetAt: window.resetsAt,
            deltaUsedPercent: delta,
            uncertainty: "high",
            detail:
              "Used percentage decreased without confirmed reset evidence; the derived view will keep it pending until later observations resolve it.",
          },
          observationId,
          );
          continue;
        }

        const meaningfulResetChange =
          reset.changed &&
          (
            delta !== 0 ||
            reset.crossedScheduledBoundary ||
            reset.materiallyShifted
          );
        if (!meaningfulResetChange) continue;

        this.insertEvent({
          kind: "reset_timestamp_changed",
          windowKey: window.key,
          observedAt: observation.observedAt,
          previousResetAt: prior.resets_at,
          currentResetAt: window.resetsAt,
          deltaUsedPercent: delta,
          uncertainty: reset.crossedScheduledBoundary ? "low" : "medium",
          detail: reset.crossedScheduledBoundary
            ? "The reported reset timestamp changed after its scheduled boundary was crossed; this is consistent with a reset but is not proof of cause."
            : delta !== 0
              ? "The reported reset timestamp changed alongside nonzero usage movement; the provider did not state why."
              : "The reported reset schedule shifted materially; the provider did not state why.",
        },
        observationId,
      );
      }

      this.database.exec("COMMIT");
      this.derivedSeriesCache = null;
      return observationId;
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private insertEvent(event: Omit<ObservationEvent, "id">, observationId: number): void {
    this.database
      .query(
        `INSERT INTO observation_events (
           kind, window_key, observed_at, previous_reset_at, current_reset_at,
           delta_used_percent, uncertainty, detail, observation_id
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        event.kind,
        event.windowKey,
        event.observedAt,
        event.previousResetAt,
        event.currentResetAt,
        event.deltaUsedPercent,
        event.uncertainty,
        event.detail,
        observationId,
      );
  }

  replaceResetCreditInventory(credits: ResetCredit[], observedAt: string): void {
    this.database.exec("BEGIN IMMEDIATE");
    try {
      this.database.query("DELETE FROM reset_credit_inventory").run();
      const insert = this.database.query(
        `INSERT INTO reset_credit_inventory(credit_id, status, expires_at, last_seen_at)
         VALUES (?, ?, ?, ?)`,
      );
      for (const credit of credits) {
        insert.run(credit.id, credit.status, credit.expiresAt, observedAt);
      }
      this.database.exec("COMMIT");
    } catch (error) {
      this.database.exec("ROLLBACK");
      throw error;
    }
  }

  private getDerivedSeries(): DerivedSeries {
    if (this.derivedSeriesCache) return this.derivedSeriesCache;

    const rawRows = this.database
      .query<DerivedWindowRow, []>(
        `SELECT o.id AS observation_id, o.observed_at, w.window_key, w.label,
                w.used_percent, w.remaining_percent, w.resets_at, w.window_seconds
           FROM usage_windows w
           JOIN observations o ON o.id = w.observation_id
          ORDER BY w.window_key, o.observed_at, o.id, w.rowid`,
      )
      .all();
    const rowsByWindow = new Map<string, DerivedWindowRow[]>();
    for (const row of rawRows) {
      const rows = rowsByWindow.get(row.window_key);
      if (rows) rows.push(row);
      else rowsByWindow.set(row.window_key, [row]);
    }

    const rows: DerivedWindowRow[] = [];
    const pendingWindowKeys = new Set<string>();
    const transitions: DerivedTransition[] = [];
    for (const [windowKey, windowRows] of rowsByWindow) {
      const derived = deriveWindowSeries(windowRows);
      rows.push(...derived.rows);
      transitions.push(...derived.transitions);
      if (derived.pending) pendingWindowKeys.add(windowKey);
    }
    rows.sort(
      (left, right) =>
        left.observed_at.localeCompare(right.observed_at) ||
        left.observation_id - right.observation_id ||
        left.window_key.localeCompare(right.window_key),
    );
    transitions.sort((left, right) => left.observedAt.localeCompare(right.observedAt));
    this.derivedSeriesCache = { rows, pendingWindowKeys, transitions };
    return this.derivedSeriesCache;
  }

  getLatestObservation(): NormalizedObservation | null {
    const derived = this.getDerivedSeries();
    const latestDerivedRow = derived.rows.at(-1);
    const row = latestDerivedRow
      ? this.database.query<ObservationRow, [number]>("SELECT * FROM observations WHERE id = ?").get(
          latestDerivedRow.observation_id,
        )
      : this.database
          .query<ObservationRow, []>("SELECT * FROM observations ORDER BY observed_at DESC, id DESC LIMIT 1")
          .get();
    if (!row) return null;

    const latestByWindow = new Map<string, DerivedWindowRow>();
    for (const window of derived.rows) latestByWindow.set(window.window_key, window);
    const windows = [...latestByWindow.values()].toSorted((left, right) =>
      left.window_key.localeCompare(right.window_key),
    );

    return {
      observedAt: latestDerivedRow?.observed_at ?? row.observed_at,
      account: {
        planType: row.plan_type,
        subscriptionExpiresAt: row.subscription_expires_at,
        renewalAt: row.renewal_at,
      },
      windows: windows.map((window) => ({
        key: window.window_key,
        label: window.label,
        usedPercent: window.used_percent,
        remainingPercent: window.remaining_percent,
        resetsAt: window.resets_at,
        windowSeconds: window.window_seconds,
        observedAt: window.observed_at,
      })),
      credits: {
        hasCredits: row.has_credits === null ? null : row.has_credits === 1,
        balance: row.credits_balance,
      },
      resetCredits: {
        availableCount: row.reset_credits_available_count,
        earliestExpiresAt: row.earliest_reset_credit_expires_at,
        actionSupported: row.reset_action_supported === 1,
      },
    };
  }

  isWindowPending(windowKey: string): boolean {
    return this.getDerivedSeries().pendingWindowKeys.has(windowKey);
  }

  getHistory(range: HistoryRange, now = new Date()): { points: HistoryPoint[]; events: ObservationEvent[] } {
    const cutoff = range === "all" ? null : new Date(now.getTime() - RANGE_MILLISECONDS[range]).toISOString();
    const derived = this.getDerivedSeries();
    const pointRows = cutoff
      ? derived.rows.filter((row) => row.observed_at >= cutoff)
      : derived.rows;
    const rawEvents = this.database
      .query<EventRow, []>("SELECT * FROM observation_events ORDER BY observed_at, id")
      .all();
    const transitionIds = new Map<string, number>();
    const gapEvents: ObservationEvent[] = [];
    for (const event of rawEvents) {
      if (event.kind === "observation_gap") {
        if (cutoff === null || event.observed_at >= cutoff) gapEvents.push(mapEvent(event));
        continue;
      }
      if (event.window_key === null) continue;
      const key = `${event.window_key}\u0000${event.observed_at}`;
      if (!transitionIds.has(key)) transitionIds.set(key, event.id);
    }
    const derivedEvents = derived.transitions
      .filter((event) => cutoff === null || event.observedAt >= cutoff)
      .map((event) => ({
        id: transitionIds.get(`${event.windowKey}\u0000${event.observedAt}`) ?? 0,
        ...event,
      }));
    const events = [...gapEvents, ...derivedEvents]
      .toSorted(
        (left, right) =>
          left.observedAt.localeCompare(right.observedAt) ||
          left.id - right.id,
      )
      .slice(-MAX_HISTORY_EVENTS);

    return {
      points: pointRows.map((row) => ({
        observedAt: row.observed_at,
        windowKey: row.window_key,
        usedPercent: row.used_percent,
        remainingPercent: row.remaining_percent,
        resetsAt: row.resets_at,
      })),
      events,
    };
  }

  getWindowPacePoints(windowKey: string, resetAt: string | null, since: string): HistoryPoint[] {
    return this.getDerivedSeries().rows
      .filter(
        (row) =>
          row.window_key === windowKey &&
          resetTimestampsEquivalent(row.resets_at, resetAt) &&
          row.observed_at >= since,
      )
      .map((row) => ({
        observedAt: row.observed_at,
        windowKey: row.window_key,
        usedPercent: row.used_percent,
        remainingPercent: row.remaining_percent,
        resetsAt: row.resets_at,
      }));
  }

  getCounts(): { observationCount: number; eventCount: number } {
    const observations = this.database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM observations")
      .get()?.count ?? 0;
    const events = this.database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM observation_events")
      .get()?.count ?? 0;
    return { observationCount: observations, eventCount: events };
  }

  getLatestObservationCursor(): { id: number; observedAt: string } | null {
    const row = this.database
      .query<{ id: number; observed_at: string }, []>(
        "SELECT id, observed_at FROM observations ORDER BY observed_at DESC, id DESC LIMIT 1",
      )
      .get();
    return row ? { id: row.id, observedAt: row.observed_at } : null;
  }

  observationHasGap(observationId: number): boolean {
    return this.database
      .query<{ present: number }, [number]>(
        `SELECT 1 AS present
           FROM observation_events
          WHERE observation_id = ? AND kind = 'observation_gap'
          LIMIT 1`,
      )
      .get(observationId)?.present === 1;
  }
  hasObservationGapBetween(startExclusive: string, endInclusive: string): boolean {
    return this.database
      .query<{ present: number }, [string, string]>(
        `SELECT 1 AS present
           FROM observation_events
          WHERE kind = 'observation_gap'
            AND observed_at > ?
            AND observed_at <= ?
          LIMIT 1`,
      )
      .get(startExclusive, endInclusive)?.present === 1;
  }

  getObservationEvents(observationId: number, windowKey: string): ObservationEvent[] {
    return this.database
      .query<EventRow, [number, string]>(
        `SELECT *
           FROM observation_events
          WHERE observation_id = ? AND window_key = ?
          ORDER BY id`,
      )
      .all(observationId, windowKey)
      .map(mapEvent);
  }


  upsertPushSubscription(subscription: PushSubscriptionInput, at: string): StoredPushSubscription {
    const preferences = subscription.preferences;
    if (preferences) {
      this.database
        .query(
          `INSERT INTO web_push_subscriptions(
             endpoint, expiration_time, p256dh, auth, created_at, updated_at,
             over_budget, remaining_25, remaining_15, remaining_5,
             weekly_reset, unscheduled_reset
           ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             expiration_time = excluded.expiration_time,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             updated_at = excluded.updated_at,
             over_budget = excluded.over_budget,
             remaining_25 = excluded.remaining_25,
             remaining_15 = excluded.remaining_15,
             remaining_5 = excluded.remaining_5,
             weekly_reset = excluded.weekly_reset,
             unscheduled_reset = excluded.unscheduled_reset`,
        )
        .run(
          subscription.endpoint,
          subscription.expirationTime,
          subscription.keys.p256dh,
          subscription.keys.auth,
          at,
          at,
          booleanInteger(preferences.overBudget),
          booleanInteger(preferences.remaining25),
          booleanInteger(preferences.remaining15),
          booleanInteger(preferences.remaining5),
          booleanInteger(preferences.weeklyReset),
          booleanInteger(preferences.unscheduledReset),
        );
    } else {
      this.database
        .query(
          `INSERT INTO web_push_subscriptions(
             endpoint, expiration_time, p256dh, auth, created_at, updated_at
           ) VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(endpoint) DO UPDATE SET
             expiration_time = excluded.expiration_time,
             p256dh = excluded.p256dh,
             auth = excluded.auth,
             updated_at = excluded.updated_at`,
        )
        .run(
          subscription.endpoint,
          subscription.expirationTime,
          subscription.keys.p256dh,
          subscription.keys.auth,
          at,
          at,
        );
    }
    return this.getPushSubscription(subscription.endpoint)!;
  }

  updatePushPreferences(endpoint: string, preferences: PushPreferences, at: string): StoredPushSubscription | null {
    const changed = this.database
      .query(
        `UPDATE web_push_subscriptions
            SET over_budget = ?,
                remaining_25 = ?,
                remaining_15 = ?,
                remaining_5 = ?,
                weekly_reset = ?,
                unscheduled_reset = ?,
                updated_at = ?
          WHERE endpoint = ?`,
      )
      .run(
        booleanInteger(preferences.overBudget),
        booleanInteger(preferences.remaining25),
        booleanInteger(preferences.remaining15),
        booleanInteger(preferences.remaining5),
        booleanInteger(preferences.weeklyReset),
        booleanInteger(preferences.unscheduledReset),
        at,
        endpoint,
      ).changes;
    return changed > 0 ? this.getPushSubscription(endpoint) : null;
  }

  deletePushSubscription(endpoint: string): boolean {
    return this.database
      .query("DELETE FROM web_push_subscriptions WHERE endpoint = ?")
      .run(endpoint).changes > 0;
  }

  deletePushSubscriptionIfUnchanged(subscription: PushSubscriptionInput): boolean {
    return this.database
      .query(
        `DELETE FROM web_push_subscriptions
          WHERE endpoint = ? AND p256dh = ? AND auth = ?`,
      )
      .run(subscription.endpoint, subscription.keys.p256dh, subscription.keys.auth).changes > 0;
  }

  getPushSubscription(endpoint: string): StoredPushSubscription | null {
    const row = this.database
      .query<PushSubscriptionRow, [string]>(
        `SELECT endpoint, expiration_time, p256dh, auth, created_at, updated_at,
                over_budget, remaining_25, remaining_15, remaining_5,
                weekly_reset, unscheduled_reset
           FROM web_push_subscriptions
          WHERE endpoint = ?`,
      )
      .get(endpoint);
    return row ? mapPushSubscription(row) : null;
  }

  getPushSubscriptions(nowMilliseconds = Date.now()): StoredPushSubscription[] {
    this.database
      .query(
        `DELETE FROM web_push_subscriptions
          WHERE expiration_time IS NOT NULL AND expiration_time <= ?`,
      )
      .run(nowMilliseconds);
    return this.database
      .query<PushSubscriptionRow, []>(
        `SELECT endpoint, expiration_time, p256dh, auth, created_at, updated_at,
                over_budget, remaining_25, remaining_15, remaining_5,
                weekly_reset, unscheduled_reset
           FROM web_push_subscriptions
          ORDER BY created_at, endpoint`,
      )
      .all()
      .map(mapPushSubscription);
  }

  getPushSubscriptionCount(): number {
    return this.database
      .query<{ count: number }, []>("SELECT count(*) AS count FROM web_push_subscriptions")
      .get()?.count ?? 0;
  }

  getPushNotificationState(endpoint: string): PushNotificationState | null {
    const row = this.database
      .query<PushNotificationStateRow, [string]>(
        `SELECT endpoint, last_observation_id, pace_status, remaining_percent,
                reset_at, remaining_25_delivered, remaining_15_delivered,
                remaining_5_delivered, updated_at
           FROM web_push_notification_state
          WHERE endpoint = ?`,
      )
      .get(endpoint);
    return row ? mapPushNotificationState(row) : null;
  }

  setPushNotificationState(state: PushNotificationState): void {
    this.database
      .query(
        `INSERT INTO web_push_notification_state(
           endpoint, last_observation_id, pace_status, remaining_percent,
           reset_at, remaining_25_delivered, remaining_15_delivered,
           remaining_5_delivered, updated_at
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(endpoint) DO UPDATE SET
           last_observation_id = excluded.last_observation_id,
           pace_status = excluded.pace_status,
           remaining_percent = excluded.remaining_percent,
           reset_at = excluded.reset_at,
           remaining_25_delivered = excluded.remaining_25_delivered,
           remaining_15_delivered = excluded.remaining_15_delivered,
           remaining_5_delivered = excluded.remaining_5_delivered,
           updated_at = excluded.updated_at`,
      )
      .run(
        state.endpoint,
        state.lastObservationId,
        state.paceStatus,
        state.remainingPercent,
        state.resetAt,
        booleanInteger(state.remaining25Delivered),
        booleanInteger(state.remaining15Delivered),
        booleanInteger(state.remaining5Delivered),
        state.updatedAt,
      );
  }

  planRedemption(creditId: string, redeemRequestId: string, plannedAt: string): RedemptionAudit {
    const existing = this.database
      .query<AuditRow, [string]>("SELECT * FROM redemption_audit WHERE credit_id = ?")
      .get(creditId);
    if (existing) return mapAudit(existing);

    this.database
      .query(
        `INSERT INTO redemption_audit(
           credit_id, redeem_request_id, state, planned_at, reason
         ) VALUES (?, ?, 'planned', ?, ?)`,
      )
      .run(creditId, redeemRequestId, plannedAt, "Eligibility was established; no consume request has been sent yet.");
    return this.getAuditByCreditId(creditId)!;
  }

  markRedemptionInFlight(id: number, attemptedAt: string): RedemptionAudit {
    this.database
      .query(
        `UPDATE redemption_audit
            SET state = 'in_flight', attempted_at = ?, outcome = NULL,
                reason = 'Consume request may have been sent; completion is not yet known.'
          WHERE id = ? AND state IN ('planned', 'ambiguous')`,
      )
      .run(attemptedAt, id);
    return this.getAuditById(id)!;
  }

  finishRedemption(
    id: number,
    state: Extract<RedemptionAuditState, "final" | "ambiguous">,
    finalizedAt: string,
    outcome: string,
    reason: string,
  ): RedemptionAudit {
    this.database
      .query(
        `UPDATE redemption_audit
            SET state = ?, finalized_at = ?, outcome = ?, reason = ?
          WHERE id = ?`,
      )
      .run(state, finalizedAt, outcome, reason, id);
    return this.getAuditById(id)!;
  }

  getAuditById(id: number): RedemptionAudit | null {
    const row = this.database
      .query<AuditRow, [number]>("SELECT * FROM redemption_audit WHERE id = ?")
      .get(id);
    return row ? mapAudit(row) : null;
  }

  getAuditByCreditId(creditId: string): RedemptionAudit | null {
    const row = this.database
      .query<AuditRow, [string]>("SELECT * FROM redemption_audit WHERE credit_id = ?")
      .get(creditId);
    return row ? mapAudit(row) : null;
  }

  getLatestAudit(): RedemptionAudit | null {
    const row = this.database
      .query<AuditRow, []>("SELECT * FROM redemption_audit ORDER BY id DESC LIMIT 1")
      .get();
    return row ? mapAudit(row) : null;
  }

  private markInterruptedRedemptionsAmbiguous(): void {
    const at = new Date().toISOString();
    this.database
      .query(
        `UPDATE redemption_audit
            SET state = 'ambiguous', finalized_at = ?, outcome = 'unknown',
                reason = 'The process stopped while the consume request was in flight; automatic retry is prohibited.'
          WHERE state = 'in_flight'`,
      )
      .run(at);
  }

  isHealthy(): boolean {
    try {
      return this.database.query<{ value: number }, []>("SELECT 1 AS value").get()?.value === 1;
    } catch {
      return false;
    }
  }
}


function booleanInteger(value: boolean): number {
  return value ? 1 : 0;
}

function mapPushSubscription(row: PushSubscriptionRow): StoredPushSubscription {
  return {
    endpoint: row.endpoint,
    expirationTime: row.expiration_time,
    keys: { p256dh: row.p256dh, auth: row.auth },
    preferences: {
      overBudget: row.over_budget === 1,
      remaining25: row.remaining_25 === 1,
      remaining15: row.remaining_15 === 1,
      remaining5: row.remaining_5 === 1,
      weeklyReset: row.weekly_reset === 1,
      unscheduledReset: row.unscheduled_reset === 1,
    },
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function mapPushNotificationState(row: PushNotificationStateRow): PushNotificationState {
  return {
    endpoint: row.endpoint,
    lastObservationId: row.last_observation_id,
    paceStatus: row.pace_status,
    remainingPercent: row.remaining_percent,
    resetAt: row.reset_at,
    remaining25Delivered: row.remaining_25_delivered === 1,
    remaining15Delivered: row.remaining_15_delivered === 1,
    remaining5Delivered: row.remaining_5_delivered === 1,
    updatedAt: row.updated_at,
  };
}

function mapEvent(row: EventRow): ObservationEvent {
  return {
    id: row.id,
    kind: row.kind,
    windowKey: row.window_key,
    observedAt: row.observed_at,
    previousResetAt: row.previous_reset_at,
    currentResetAt: row.current_reset_at,
    deltaUsedPercent: row.delta_used_percent,
    uncertainty: row.uncertainty,
    detail: row.detail,
  };
}

function mapAudit(row: AuditRow): RedemptionAudit {
  return {
    id: row.id,
    creditId: row.credit_id,
    redeemRequestId: row.redeem_request_id,
    state: row.state,
    plannedAt: row.planned_at,
    attemptedAt: row.attempted_at,
    finalizedAt: row.finalized_at,
    outcome: row.outcome,
    reason: row.reason,
  };
}

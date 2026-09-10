# Usage Observatory

A private, self-hosted observatory for **OpenAI Codex subscription usage**. It continuously samples the Codex allowance windows exposed to supported ChatGPT OAuth clients, retains normalized observations in SQLite indefinitely, explains resets and gaps, and projects whether the weekly allowance is trending over or under pace.

This project does **not** report general ChatGPT message, Voice, image, or tool-specific limits. OpenAI documents those as separate from Codex's shared agentic allowance. It also does not treat OpenAI API organization usage as subscription usage.

## What it shows

- The regular Codex allowance at a glance; additional meters appear in history when they carry nonzero usage
- Remaining/consumed percentage and countdown to each allowance-window reset
- Corroborated historical observations, confirmed resets, collection gaps, and uncertainty labels
- Recent local consumption velocity plus a cycle-to-date weekly end-of-window projection with its elapsed-window basis and assumptions
- Collector freshness, stale/auth-failed/offline states, and the last successful observation
- Saved Codex rate-limit resets, their expiries, and a durable redemption audit
- Optional per-browser Web Push alerts for a fresh transition from under/on budget into `at_risk`
- A responsive, reduced-motion-aware space UI with under-budget warp travel, calibrated on-track drift, slower over-budget motion, and static visible stars for reduced motion

Subscription renewal or cancellation-effective dates are shown only when a source actually provides them. The Codex usage interface currently does not, so the UI omits them rather than confusing them with allowance reset times.

## Architecture

One Bun application process serves the UI and API, runs the collector, pushes committed collection outcomes to connected browsers over a same-origin WebSocket, dispatches optional Web Push alerts, and stores normalized observations in one SQLite database. There is no Redis, external database, queue, or analytics service. Collection remains server-scheduled at 300 seconds by default; browser and WebSocket clients trigger no provider request. The browser immediately refetches the dashboard and its currently selected history range after a pushed outcome or reconnect, with a 60-second dashboard refetch retained as a transport-independent fallback.

The database stores timestamps, meter names, percentages, reset times, source state, credit expiry/status, redemption audit outcomes, opted-in browser subscriptions, and the last processed push-transition cursor. A browser subscription's endpoint and standard `p256dh`/`auth` delivery values are capability secrets: they are never returned by an API or logged. The app never stores notification payload history, OAuth access/refresh tokens, cookies, raw provider responses, email addresses, or account identifiers.

## Authentication boundary

Live mode uses a **dedicated OAuth device authorization created for this application**. It does not copy `~/.codex/auth.json`, OMP credentials, browser cookies, or another client's rotating refresh-token chain. The included login command follows the official Codex device flow and writes only `access_token`, `refresh_token`, and the selected ChatGPT account identifier to one owner-only file. The collector refreshes that chain atomically in place, refuses an account-context change, and reports `auth_failed` when explicit reauthorization is required.

The credential is read only for upstream requests and is never returned by the API, written to SQLite, embedded in browser assets, or logged. The device code and verification URL are safe to show to the operator; authorization codes and tokens are not. Keep the credential file mode `0600`, make its directory accessible only to the service user, and never share it with another refreshing client.

For local review on a trusted workstation, `USAGE_SOURCE_MODE=command` can consume the sanitized output of `omp usage --json`. This keeps OAuth refresh and storage inside OMP and imports only the `openai-codex` report. Do not expose a command-mode process to a network.

The observatory itself contains private account metadata. Keep the existing Pomerium/authenticated reverse-proxy route authoritative for the UI and every API, including push subscription APIs; do not add a public notification route. Keep the container listener private. The supplied Compose file binds only to `127.0.0.1`; change that only when a protected ingress network requires it. Subscription mutations additionally require an exact same-origin `Origin`, bounded schema-checked JSON, and an HTTPS endpoint from an allowlisted browser push vendor.

## Run locally

Requires Bun 1.2 or newer.

```sh
mkdir -p data
USAGE_SOURCE_MODE=command \
USAGE_COMMAND='omp usage --json' \
DB_PATH="$PWD/data/usage.sqlite" \
PORT=3000 \
bun run src/server.ts
```

Open `http://127.0.0.1:3000`. Command mode is intended only for local trusted review.

To exercise a labeled fixture without contacting an account:

```sh
USAGE_SOURCE_MODE=fixture FIXTURE_PATH=/absolute/path/to/fixture.json \
DB_PATH="$PWD/data/fixture.sqlite" bun run src/server.ts
```

Fixture mode stays visibly labeled and cannot redeem saved resets.

## Run with Docker Compose

1. Copy `.env.example` to `.env`.
2. Create the persistent directory and give the container user exclusive access: `mkdir -p data && chmod 0700 data && chown 1000:1000 data`.
3. Pull the published multi-architecture image: `docker compose pull`.
4. Create a new app-owned OAuth grant: `docker compose run --rm usage-observatory bun run auth:login -- /data/oauth.json`. Open the printed verification URL, enter its device code, and approve the intended account. The command refuses to replace an existing credential chain.
5. Optional: create one owner-only VAPID file with `docker compose run --rm --no-deps usage-observatory bun run push:keygen -- /data/vapid.json mailto:operator@example.com`, then set `VAPID_FILE=/data/vapid.json` in `.env`. The command uses `web-push`, creates the file with mode `0600`, never prints the private key, and refuses to replace any existing path.
6. Keep `AUTO_REDEEM=false` for initial observation, then run `docker compose up -d`.
7. Verify `http://127.0.0.1:3000/api/health`, then publish only through the existing authenticated reverse proxy.

The bind-mounted `data` directory contains the indefinite SQLite history, the owner-only rotating OAuth credential, and (when enabled) the owner-only VAPID key file. Back it up while preserving mode `0600` for `oauth.json` and `vapid.json`; use a SQLite-aware snapshot or stop the container while copying. Restoring the directory restores observations, redemption audit, push subscriptions and transition cursor, this application's refresh chain, and the stable VAPID identity together.

## Configuration

| Variable | Default | Purpose |
|---|---:|---|
| `PORT` | `3000` | HTTP listener port |
| `DB_PATH` | `/data/usage.sqlite` | SQLite path |
| `COLLECT_INTERVAL_SECONDS` | `300` | Normal collection cadence |
| `STALE_AFTER_SECONDS` | `900` | Age after which the UI reports stale data |
| `USAGE_SOURCE_MODE` | `command` | `live`, `command`, or labeled `fixture` |
| `USAGE_OAUTH_FILE` | — | Preferred app-owned JSON credential path for `live` mode; device login creates it and the collector rotates it atomically |
| `CODEX_OAUTH_ISSUER` | `https://auth.openai.com` | OAuth issuer; override is intended only for controlled testing |
| `CODEX_OAUTH_CLIENT_ID` | official Codex public client | OAuth public client identifier; normally leave unchanged |
| `USAGE_TOKEN_FILE` | — | Legacy non-refreshing access-token path for tightly managed deployments |
| `USAGE_ACCOUNT_ID_FILE` | — | Optional legacy account selector sent only as the upstream `ChatGPT-Account-Id` header |
| `USAGE_COMMAND` | `omp usage --json` | Trusted local command used only in `command` mode |
| `FIXTURE_PATH` | — | Absolute fixture path used only in `fixture` mode |
| `ADMIN_TOKEN` | unset | Server-only bearer for an explicit collection trigger; unset disables it |
| `VAPID_FILE` | unset | Optional owner-only (`0600`), service-user-owned JSON VAPID key file; unset disables Web Push |
| `AUTO_REDEEM` | `false` | Enable expiry-salvage evaluation and consumption |
| `AUTO_REDEEM_HORIZON_HOURS` | `12` | Credit must expire within this horizon |

Collection failures use bounded exponential backoff and never erase the last good observation. With a dedicated OAuth file, an expiring token is refreshed proactively and a 401/403 receives exactly one refresh-and-retry attempt. Invalid grants or account-context changes become `auth_failed` and require a new dedicated device authorization; transient failures become `error` and eventually `stale` while history remains available.

## Browser alerts

Browser alerts are optional and configured separately in each browser from the collapsed **Alerts** control. **Over budget** is selected by default; **25% remaining**, **15% remaining**, **5% remaining**, **Weekly reset**, and **Unscheduled reset** are off by default. Changing options while unsubscribed only updates that browser's draft. Notification permission is requested only when **Enable alerts** is pressed. On iOS or iPadOS 16.4 and newer, first add the site to the Home Screen and enable alerts from the installed web app.

Alerts cover a fresh safe-to-over-budget transition (including exhausted usage), selected downward remaining-threshold crossings, a confirmed reset at the regular weekly boundary, and a materially early confirmed reset. Thresholds crossed by one observation are coalesced into one notification. Enabling or re-enabling records the current trustworthy state as the baseline, so there are no historical or catch-up alerts; gaps, ambiguous resets, anomaly rebounds, unknown pace, repeated over-budget samples, and restarts do not invent alerts.

Preferences, per-cycle baselines, and delivery cursors are durable per subscription. Gone endpoints (`404`/`410`) are pruned, an explicit transient HTTP rejection gets at most one bounded retry, and ambiguous transport errors are not retried. Payloads contain only the alert type and the minimal percentage or crossed-threshold values needed for display—no account, plan, endpoint, or history—and notification clicks open the protected `/` route. The implementation follows [MDN's Push API guidance](https://developer.mozilla.org/en-US/docs/Web/API/Push_API), [MDN's service-worker notification API](https://developer.mozilla.org/en-US/docs/Web/API/ServiceWorkerRegistration/showNotification), [WebKit's iOS/iPadOS Home Screen requirements](https://webkit.org/blog/13878/web-push-for-web-apps-on-ios-and-ipados/), and the vetted [`web-push` library](https://github.com/web-push-libs/web-push).

## Saved-reset safety

Automatic redemption is off by default. When enabled, the collector:

1. requires a fresh live usage report no more than ten minutes old;
2. live-lists credits and selects the available one with the earliest parseable expiry;
3. requires the credit to expire within the configured horizon, regardless of whether any regular or Spark allowance has been consumed;
4. re-fetches both the credit listing and usage report immediately before the attempt;
5. commits a durable credit-specific idempotency key before sending exactly one consume request;
6. records `reset`, provider no-op such as `nothing_to_reset`, failure, or ambiguous transport state; and
7. never automatically retries an ambiguous consume.

This follows the provider's `redeem_request_id` idempotency contract while preferring duplicate safety. It never buys credits, enables auto-reload, changes a plan, or spends a reset merely for testing. The browser has no unauthenticated redemption endpoint and receives no operator token.

## Data semantics and limitations

Consumption changes are interval estimates between polls, not message-level timings. Raw observations are retained indefinitely, but duplicate timestamps do not weight pace and transient drops are quarantined from derived history, summaries, events, and projection. A reset is confirmed only by usage reaching zero with an advanced target, or by a missed-zero observation after crossing the scheduled boundary with an advanced target; a sustained correction is admitted after corroboration and remains explicitly uncertain.

The weekly projection compares usage so far with elapsed time in the reported weekly cycle and extrapolates that cycle-to-date pace through reset. This avoids treating a newly observed one-percent provider step as a precise instantaneous rate. Recent local velocity is shown separately once at least five minutes of same-cycle observations exist. Both are descriptive interval estimates, not provider guarantees.

The upstream interfaces used by current Codex clients are:

- `GET https://chatgpt.com/backend-api/wham/usage`
- `GET https://chatgpt.com/backend-api/wham/rate-limit-reset-credits`
- `POST https://chatgpt.com/backend-api/wham/rate-limit-reset-credits/consume`

The dedicated login and rotation behavior follows the open-source Codex client's [device authorization flow](https://github.com/openai/codex/blob/main/codex-rs/login/src/device_code_auth.rs), [OAuth callback exchange](https://github.com/openai/codex/blob/main/codex-rs/login/src/server.rs), and [refresh-token manager](https://github.com/openai/codex/blob/main/codex-rs/login/src/auth/manager.rs). OpenAI documents Codex limits and `/status` in its [Codex usage help](https://help.openai.com/en/articles/11369540) and documents one-time [banked Codex resets](https://help.openai.com/en/articles/20001498). These personal subscription interfaces are not the public [organization API Usage API](https://developers.openai.com/api/reference/resources/admin/subresources/organization/subresources/usage). Treat upstream shapes as provider-controlled and monitor collector errors after client or account changes.

## API

- `GET /api/health` — process, database, and collector state
- `GET /api/dashboard` — latest normalized state, pace, saved resets, and summary counts
- `GET /api/history?range=24h|7d|30d|90d|all` — chart points and reset/gap events
- `GET /api/live` with a WebSocket upgrade — same-origin committed-collection notifications; clients refetch current allowlisted API views
- `POST /api/admin/collect` — optional server-token-protected immediate collection
- `GET /api/push/config` — whether Web Push is configured and, only when enabled, the public VAPID key
- `POST /api/push/subscriptions` — exact-same-origin opt-in/update with a validated browser subscription
- `DELETE /api/push/subscriptions` — exact-same-origin opt-out for the calling browser's submitted endpoint

All API responses are `Cache-Control: no-store`. Static browser assets contain no account credential or server secret; HTML and the service worker are served with revalidation.

## License

MIT. See [LICENSE](LICENSE).

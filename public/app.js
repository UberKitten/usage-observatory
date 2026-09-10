(() => {
  "use strict";

  const SVG_NS = "http://www.w3.org/2000/svg";
  const CHART = {
    width: 720,
    height: 390,
    plot: { left: 54, right: 700, top: 24, bottom: 338 }
  };
  const SERIES_COLORS = ["#64e8c7", "#bd98ff", "#78caff", "#ffc56f", "#ff9a78", "#e58bff"];
  const RANGE_MILLISECONDS = {
    "24h": 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
    "30d": 30 * 24 * 60 * 60 * 1000,
    "90d": 90 * 24 * 60 * 60 * 1000
  };

  const state = {
    dashboard: null,
    history: null,
    weeklyHistory: null,
    range: "24h",
    dashboardError: null,
    historyError: null,
    weeklyHistoryError: null,
    dashboardLoading: true,
    historyLoading: true,
    historyRequest: 0,
    offline: typeof navigator !== "undefined" && navigator.onLine === false,
    freshnessMode: null,
    pushConfig: null,
    pushRegistration: null,
    pushSubscription: null,
    pushBusy: false
  };

  const elements = {};
  const ids = [
    "starfield", "header-status", "header-status-text", "banner-stack",
    "remaining-value", "remaining-label", "usage-title", "reset-countdown",
    "pace-readout", "pace-icon", "pace-text", "pace-rate-item", "pace-rate",
    "pace-projection-item", "pace-projection",
    "range-picker", "history-key", "history-wrap", "history-loading", "history-chart",
    "history-svg-description", "history-grid", "history-series", "history-tooltip",
    "history-empty", "history-error", "retry-history", "weekly-wrap",
    "weekly-loading", "weekly-chart", "weekly-svg-description", "weekly-grid", "weekly-series",
    "weekly-tooltip", "weekly-empty", "freshness-card", "freshness-value",
    "freshness-time", "bank-card", "bank-count", "bank-expiry", "resets-panel",
    "notable-events", "push-toggle"
  ];
  let liveSocket = null;
  let liveReconnectTimer = null;
  let liveReconnectDelay = 1000;
  let refreshRunning = false;
  let refreshQueued = false;


  function cacheElements() {
    for (const id of ids) elements[id] = document.getElementById(id);
  }

  function finiteNumber(value) {
    if (value === null || value === undefined || value === "") return null;
    const number = typeof value === "number" ? value : Number(value);
    return Number.isFinite(number) ? number : null;
  }

  function nonempty(value) {
    return typeof value === "string" && value.trim() ? value.trim() : null;
  }

  function timestamp(value) {
    if (!value) return null;
    const time = new Date(value).getTime();
    return Number.isFinite(time) ? time : null;
  }

  function clamp(value, minimum, maximum) {
    return Math.min(maximum, Math.max(minimum, value));
  }

  function formatPercent(value) {
    const number = finiteNumber(value);
    if (number === null) return null;
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(number)}%`;
  }

  function formatInstant(value) {
    const time = timestamp(value);
    if (time === null) return null;
    return new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(new Date(time));
  }
  function formatResetInstant(value) {
    const time = timestamp(value);
    if (time === null) return null;
    return new Intl.DateTimeFormat(undefined, {
      month: "short",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit"
    }).format(new Date(time));
  }


  function formatAxisTime(value, range) {
    const date = new Date(value);
    if (range === "24h") {
      return new Intl.DateTimeFormat(undefined, { hour: "numeric", minute: "2-digit" }).format(date);
    }
    if (range === "7d") {
      return new Intl.DateTimeFormat(undefined, { weekday: "short", hour: "numeric" }).format(date);
    }
    if (range === "all") {
      return new Intl.DateTimeFormat(undefined, { month: "short", year: "2-digit" }).format(date);
    }
    return new Intl.DateTimeFormat(undefined, { month: "short", day: "numeric" }).format(date);
  }

  function formatRelative(value) {
    const time = timestamp(value);
    if (time === null) return null;
    const seconds = Math.round((time - Date.now()) / 1000);
    const absolute = Math.abs(seconds);
    const formatter = new Intl.RelativeTimeFormat(undefined, { numeric: "auto" });
    if (absolute < 60) return formatter.format(seconds, "second");
    if (absolute < 3600) return formatter.format(Math.round(seconds / 60), "minute");
    if (absolute < 86400) return formatter.format(Math.round(seconds / 3600), "hour");
    return formatter.format(Math.round(seconds / 86400), "day");
  }


  function formatCountdown(value) {
    const time = timestamp(value);
    if (time === null) return null;
    const delta = Math.floor((time - Date.now()) / 1000);
    if (delta <= 0) return "Reset reached";
    const days = Math.floor(delta / 86400);
    const hours = Math.floor((delta % 86400) / 3600);
    const minutes = Math.floor((delta % 3600) / 60);
    return [
      days ? `${days}d` : null,
      `${String(hours).padStart(2, "0")}h`,
      `${String(minutes).padStart(2, "0")}m`
    ].filter(Boolean).join(" ");
  }

  function formatSignedPercent(value) {
    const number = finiteNumber(value);
    if (number === null) return null;
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1, signDisplay: "always" }).format(number)}% used`;
  }

  function create(tag, className, text) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function createSvg(tag, attributes = {}) {
    const node = document.createElementNS(SVG_NS, tag);
    for (const [name, value] of Object.entries(attributes)) node.setAttribute(name, String(value));
    return node;
  }

  function replaceChildren(node, children) {
    node.replaceChildren(...children.filter(Boolean));
  }

  function setupStarfield() {
    const narrow = window.matchMedia("(max-width: 600px)").matches;
    const count = narrow ? 90 : 180;
    const stars = [];
    for (let index = 0; index < count; index += 1) {
      const star = create("span", "star");
      const isBeacon = index % 11 === 0;
      const size = isBeacon ? 3.5 + Math.random() * 2 : 1.1 + Math.random() * 1.3;
      const x = Math.random() * 100;
      const y = Math.random() * 100;
      const warpX = (x - 50) * 1.6;
      const warpY = (y - 50) * 1.6;
      const warpAngle = Math.atan2(warpY, warpX) * 180 / Math.PI - 90;
      star.style.setProperty("--x", `${x.toFixed(2)}%`);
      star.style.setProperty("--y", `${y.toFixed(2)}%`);
      star.style.setProperty("--warp-x", `${warpX.toFixed(2)}vw`);
      star.style.setProperty("--warp-y", `${warpY.toFixed(2)}vh`);
      star.style.setProperty("--warp-start-x", `${(warpX * 0.04).toFixed(2)}vw`);
      star.style.setProperty("--warp-start-y", `${(warpY * 0.04).toFixed(2)}vh`);
      star.style.setProperty("--warp-angle", `${warpAngle.toFixed(2)}deg`);
      star.style.setProperty("--size", `${size.toFixed(2)}px`);
      star.style.setProperty("--alpha", `${(isBeacon ? 0.95 : 0.58 + Math.random() * 0.34).toFixed(2)}`);
      star.style.setProperty("--duration", `${(16 + Math.random() * 26).toFixed(2)}s`);
      star.style.setProperty("--delay", `${(-Math.random() * 34).toFixed(2)}s`);
      if (isBeacon) star.classList.add("star-beacon");
      stars.push(star);
    }
    replaceChildren(elements.starfield, stars);
  }

  async function fetchJSON(path) {
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12000);
    try {
      const response = await fetch(path, {
        method: "GET",
        headers: { Accept: "application/json" },
        cache: "no-store",
        signal: controller.signal
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const payload = await response.json();
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new Error("Invalid JSON response");
      return payload;
    } catch (error) {
      if (error && error.name === "AbortError") throw new Error("Request timed out");
      throw error;
    } finally {
      window.clearTimeout(timeout);
    }
  }

  async function mutatePush(method, body) {
    const response = await fetch("/api/push/subscriptions", {
      method,
      credentials: "same-origin",
      cache: "no-store",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json"
      },
      body: JSON.stringify(body)
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
  }

  function pushCapability() {
    const ios = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
      (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
    const standalone = window.matchMedia("(display-mode: standalone)").matches ||
      window.navigator.standalone === true;
    if (ios && !standalone) {
      return { supported: false, tooltip: "Add this site to the Home Screen to enable alerts." };
    }
    if (!window.isSecureContext) {
      return { supported: false, tooltip: "Alerts require HTTPS." };
    }
    if (!("serviceWorker" in navigator) || !("PushManager" in window) || !("Notification" in window)) {
      return { supported: false, tooltip: "Alerts are not supported by this browser." };
    }
    return { supported: true, tooltip: "" };
  }

  function renderPushControl(action, disabled = false, tooltip = "") {
    const button = elements["push-toggle"];
    const label = action === "disable" ? "Disable alerts" : "Enable alerts";
    button.textContent = label;
    button.disabled = state.pushBusy || disabled;
    button.title = tooltip;
    button.setAttribute("aria-pressed", action === "disable" ? "true" : "false");
    button.setAttribute("aria-label", tooltip ? `${label}. ${tooltip}` : label);
  }

  function renderCurrentPushControl() {
    renderPushControl(state.pushSubscription ? "disable" : "enable");
  }

  function decodeVapidPublicKey(value) {
    const padding = "=".repeat((4 - value.length % 4) % 4);
    const decoded = atob((value + padding).replace(/-/g, "+").replace(/_/g, "/"));
    const bytes = new Uint8Array(decoded.length);
    for (let index = 0; index < decoded.length; index += 1) bytes[index] = decoded.charCodeAt(index);
    return bytes;
  }

  async function initializePushControls() {
    renderPushControl("enable", true);
    let config;
    try {
      config = await fetchJSON("/api/push/config");
    } catch {
      renderPushControl("enable", true, "Alerts are unavailable.");
      return;
    }
    if (config.enabled !== true || typeof config.publicKey !== "string") {
      renderPushControl("enable", true, "Alerts are not configured.");
      return;
    }
    state.pushConfig = config;
    const capability = pushCapability();
    if (!capability.supported) {
      renderPushControl("enable", true, capability.tooltip);
      return;
    }

    try {
      await navigator.serviceWorker.register("/service-worker.js", {
        scope: "/",
        updateViaCache: "none"
      });
      state.pushRegistration = await navigator.serviceWorker.ready;
      state.pushSubscription = await state.pushRegistration.pushManager.getSubscription();
      if (Notification.permission === "denied") {
        if (state.pushSubscription) {
          const subscription = state.pushSubscription;
          await mutatePush("DELETE", { endpoint: subscription.endpoint });
          await subscription.unsubscribe();
          state.pushSubscription = null;
        }
        renderCurrentPushControl();
        return;
      }
      if (state.pushSubscription) {
        await mutatePush("POST", state.pushSubscription.toJSON());
      }
      renderCurrentPushControl();
    } catch {
      renderPushControl("enable", true, "Alerts are unavailable.");
    }
  }

  async function togglePush() {
    if (state.pushBusy || !state.pushConfig || !state.pushRegistration) return;
    state.pushBusy = true;
    elements["push-toggle"].disabled = true;
    try {
      if (state.pushSubscription) {
        const subscription = state.pushSubscription;
        await mutatePush("DELETE", { endpoint: subscription.endpoint });
        const unsubscribed = await subscription.unsubscribe();
        if (!unsubscribed) throw new Error("Browser push subscription remained active.");
        state.pushSubscription = null;
        renderCurrentPushControl();
        return;
      }

      const permission = Notification.permission === "default"
        ? await Notification.requestPermission()
        : Notification.permission;
      if (permission !== "granted") {
        if (permission === "denied") window.alert("Notifications are blocked in browser settings.");
        return;
      }
      const subscription = await state.pushRegistration.pushManager.subscribe({
        userVisibleOnly: true,
        applicationServerKey: decodeVapidPublicKey(state.pushConfig.publicKey)
      });
      try {
        await mutatePush("POST", subscription.toJSON());
      } catch (error) {
        await subscription.unsubscribe().catch(() => {});
        throw error;
      }
      state.pushSubscription = subscription;
      renderCurrentPushControl();
    } catch {
      window.alert("Alert setting could not be changed.");
    } finally {
      state.pushBusy = false;
      renderCurrentPushControl();
    }
  }

  function latestObservationAt(dashboard) {
    if (!dashboard) return null;
    if (typeof dashboard.latestObservation === "string") return dashboard.latestObservation;
    if (dashboard.latestObservation && typeof dashboard.latestObservation === "object") {
      return dashboard.latestObservation.observedAt || null;
    }
    const windows = Array.isArray(dashboard.windows) ? dashboard.windows : [];
    let latest = null;
    for (const windowData of windows) {
      const candidate = timestamp(windowData?.observedAt);
      if (candidate !== null && (latest === null || candidate > latest)) latest = candidate;
    }
    return latest === null ? null : new Date(latest).toISOString();
  }

  function isFirstRun(dashboard) {
    const count = finiteNumber(dashboard?.stats?.observationCount);
    return count === 0 || (count === null && !dashboard?.latestObservation && !dashboard?.windows?.length);
  }

  function sourceMode(dashboard) {
    if (!dashboard) return "offline";
    const source = dashboard.source && typeof dashboard.source === "object" ? dashboard.source : {};
    const raw = String(source.state || "unknown").toLowerCase();
    if (raw.includes("auth") || raw.includes("forbidden")) return "auth_failed";
    if (raw.includes("offline") || raw.includes("error") || raw.includes("failed") || raw.includes("unreachable")) return "error";
    if (raw.includes("stale")) return "stale";
    const staleAfter = finiteNumber(source.staleAfterSeconds);
    const latest = timestamp(source.lastSuccessAt || latestObservationAt(dashboard));
    if (staleAfter !== null && latest !== null && Date.now() - latest > staleAfter * 1000) return "stale";
    if (["healthy", "fresh", "ready", "connected", "fixture", "ok"].some((word) => raw.includes(word))) return "fresh";
    return "unknown";
  }

  function isFixtureSource(dashboard) {
    const source = dashboard?.source || {};
    return `${source.state || ""} ${source.displayName || ""}`.toLowerCase().includes("fixture");
  }

  function renderBanners() {
    const banners = [];
    const add = (tone, icon, title, detail) => {
      const banner = create("div", `banner ${tone}`);
      banner.setAttribute("role", tone === "error" ? "alert" : "status");
      const iconNode = create("span", "banner-icon", icon);
      iconNode.setAttribute("aria-hidden", "true");
      const copy = create("div");
      copy.append(create("strong", "", title));
      if (detail) copy.append(create("span", "", detail));
      banner.append(iconNode, copy);
      banners.push(banner);
    };

    if (state.offline || state.dashboardError) {
      add("error", "!", state.dashboard ? "Using the last snapshot" : "Dashboard offline");
    } else if (state.dashboard) {
      const mode = sourceMode(state.dashboard);
      if (mode === "auth_failed") add("error", "!", "Collector authorization failed");
      else if (mode === "error") add("error", "!", "Collector error");
      else if (mode === "stale") add("warning", "△", "Telemetry is stale");
      else if (mode === "unknown") add("warning", "?", "Freshness unknown");
      if (isFixtureSource(state.dashboard)) add("info", "i", "Preview data");
      if (isFirstRun(state.dashboard)) add("info", "i", "Awaiting the first observation");
    }
    replaceChildren(elements["banner-stack"], banners);
  }

  function canonicalPace(status) {
    const raw = String(status || "").toLowerCase().replace(/[\s-]+/g, "_");
    if (["fast", "room_to_spend", "under_pace", "full_speed_ahead"].includes(raw)) return "fast";
    if (["slow", "slow_down", "over_pace", "at_risk", "too_fast", "exhausted"].includes(raw)) return "slow";
    if (["steady", "on_track", "on_pace", "balanced", "normal"].includes(raw)) return "steady";
    return "unknown";
  }

  function currentWeeklyWindow(dashboard) {
    const windows = Array.isArray(dashboard?.windows) ? dashboard.windows : [];
    const candidates = windows.filter((windowData) => {
      return finiteNumber(windowData?.usedPercent) !== null && timestamp(windowData?.observedAt) !== null;
    });
    if (!candidates.length) return null;
    const weekly = candidates.filter((windowData) => {
      const seconds = finiteNumber(windowData?.windowSeconds);
      return seconds !== null && seconds >= 5 * 86400 && seconds <= 9 * 86400;
    });
    const pool = weekly.length ? weekly : candidates;
    return [...pool].sort((left, right) => {
      return (finiteNumber(right.windowSeconds) || 0) - (finiteNumber(left.windowSeconds) || 0);
    })[0];
  }

  function windowLabel(windowKey) {
    const windows = Array.isArray(state.dashboard?.windows) ? state.dashboard.windows : [];
    const match = windows.find((windowData) => windowData?.key === windowKey);
    const supplied = nonempty(match?.label);
    if (supplied) return supplied;
    const key = nonempty(windowKey);
    if (!key) return "Allowance";
    const tail = key.split(":").at(-1) || key;
    return tail.replace(/[_-]+/g, " ").replace(/\b\w/g, (letter) => letter.toUpperCase());
  }

  function setOptionalMetric(item, valueNode, value) {
    item.hidden = value === null;
    valueNode.textContent = value || "";
  }

  function renderPrimary(dashboard) {
    const windowData = currentWeeklyWindow(dashboard);
    const remaining = finiteNumber(windowData?.remainingPercent);
    const remainingContainer = elements["remaining-value"].parentElement;
    remainingContainer.hidden = remaining === null;
    elements["remaining-value"].textContent = formatPercent(remaining) || "";
    elements["remaining-label"].hidden = remaining === null;

    elements["usage-title"].textContent = "Weekly usage";

    const resetTime = timestamp(windowData?.resetsAt);
    elements["reset-countdown"].hidden = resetTime === null;
    elements["reset-countdown"].dataset.resetAt = resetTime === null ? "" : new Date(resetTime).toISOString();

    const pace = dashboard?.pace && typeof dashboard.pace === "object" ? dashboard.pace : {};
    const paceMode = canonicalPace(pace.status);
    document.body.dataset.pace = paceMode;
    elements["pace-readout"].hidden = false;
    const paceCopy = {
      fast: { icon: "↗", text: "Under budget" },
      steady: { icon: "→", text: "On track" },
      slow: { icon: "↘", text: "Over budget" },
      unknown: { icon: "◇", text: "Unknown" }
    }[paceMode];
    elements["pace-icon"].textContent = paceCopy.icon;
    elements["pace-text"].textContent = paceCopy.text;

    const rate = finiteNumber(pace.recentRatePercentPerHour);
    const projection = finiteNumber(pace.projectedUsedAtReset);
    setOptionalMetric(
      elements["pace-rate-item"],
      elements["pace-rate"],
      rate === null ? null : `${formatPercent(rate)} / hour`
    );
    setOptionalMetric(
      elements["pace-projection-item"],
      elements["pace-projection"],
      projection === null ? null : formatPercent(projection)
    );
    updateCountdowns();
  }

  function updateCountdowns() {
    const node = elements["reset-countdown"];
    if (!node || node.hidden) return;
    const countdown = formatCountdown(node.dataset.resetAt);
    if (countdown === null) {
      node.hidden = true;
      return;
    }
    node.textContent = `Resets in ${countdown} · ${formatResetInstant(node.dataset.resetAt)}`;
    node.setAttribute("aria-label", node.textContent);
  }

  function renderFreshness(dashboard) {
    const mode = state.offline || state.dashboardError ? "offline" : sourceMode(dashboard);
    const labels = {
      fresh: "Fresh",
      stale: "Stale",
      auth_failed: "Authorization failed",
      error: "Collector error",
      unknown: "Unknown",
      offline: state.dashboard ? "Cached snapshot" : "Offline"
    };
    elements["freshness-value"].textContent = labels[mode] || "Unknown";
    const latest = latestObservationAt(dashboard);
    elements["freshness-time"].hidden = timestamp(latest) === null;
    if (timestamp(latest) !== null) {
      elements["freshness-time"].dateTime = new Date(timestamp(latest)).toISOString();
      elements["freshness-time"].textContent = `${formatRelative(latest)} · ${formatInstant(latest)}`;
    }

    const header = elements["header-status"];
    header.classList.remove("is-fresh", "is-warning", "is-error");
    if (state.dashboardLoading && !state.dashboard) {
      elements["header-status-text"].textContent = "Connecting…";
      elements["freshness-value"].textContent = "Connecting…";
      state.freshnessMode = "loading";
      return;
    }
    if (mode === "fresh") header.classList.add("is-fresh");
    else if (mode === "stale" || mode === "unknown") header.classList.add("is-warning");
    else header.classList.add("is-error");
    const relative = formatRelative(latest);
    elements["header-status-text"].textContent = mode === "fresh" && relative ? `Fresh · ${relative}` : labels[mode] || "Unknown";
    state.freshnessMode = mode;
  }

  function renderBank(dashboard) {
    const banked = dashboard?.bankedReset && typeof dashboard.bankedReset === "object" ? dashboard.bankedReset : null;
    const supported = banked?.supported === true;
    const count = finiteNumber(banked?.availableCount);
    const expiry = timestamp(banked?.expiresAt);
    elements["bank-card"].hidden = !supported || (count === null && expiry === null);
    elements["bank-count"].hidden = count === null;
    elements["bank-count"].textContent = count === null ? "" : `${Math.max(0, Math.round(count))} available`;
    elements["bank-expiry"].hidden = expiry === null;
    if (expiry !== null) {
      elements["bank-expiry"].dateTime = new Date(expiry).toISOString();
      elements["bank-expiry"].textContent = `Earliest expiry ${formatInstant(expiry)}`;
    } else {
      elements["bank-expiry"].removeAttribute("datetime");
      elements["bank-expiry"].textContent = "";
    }
  }


  function renderDashboard(dashboard) {
    renderPrimary(dashboard);
    renderFreshness(dashboard);
    renderBank(dashboard);
    renderBanners();
    renderWeeklyChart(dashboard, state.weeklyHistory);
  }

  function renderDashboardFailure() {
    document.body.dataset.pace = "unknown";
    elements["remaining-value"].parentElement.hidden = true;
    elements["reset-countdown"].hidden = true;
    elements["pace-readout"].hidden = false;
    elements["pace-icon"].textContent = "◇";
    elements["pace-text"].textContent = "Unknown";
    elements["bank-card"].hidden = true;
    renderFreshness(null);
    renderBanners();
    renderWeeklyChart(null, state.weeklyHistory);
  }

  async function loadDashboard() {
    if (!state.dashboard) state.dashboardLoading = true;
    renderFreshness(state.dashboard);
    try {
      const dashboard = await fetchJSON("/api/dashboard");
      state.dashboard = dashboard;
      state.dashboardError = null;
      state.offline = false;
      state.dashboardLoading = false;
      renderDashboard(dashboard);
    } catch (error) {
      state.dashboardError = error instanceof Error ? error.message : "Dashboard request failed";
      state.offline = navigator.onLine === false;
      state.dashboardLoading = false;
      if (state.dashboard) {
        renderFreshness(state.dashboard);
        renderBanners();
      } else {
        renderDashboardFailure();
      }
    }
  }

  function validPoint(point) {
    return point && timestamp(point.observedAt) !== null && finiteNumber(point.usedPercent) !== null;
  }

  function downsample(points, limit) {
    if (points.length <= limit) return points;
    const bucketCount = Math.max(1, Math.floor((limit - 2) / 2));
    const bucketSize = (points.length - 2) / bucketCount;
    const selected = [points[0]];
    for (let bucketIndex = 0; bucketIndex < bucketCount; bucketIndex += 1) {
      const start = 1 + Math.floor(bucketIndex * bucketSize);
      const end = Math.min(points.length - 1, 1 + Math.floor((bucketIndex + 1) * bucketSize));
      const bucket = points.slice(start, Math.max(start + 1, end));
      let minimum = bucket[0];
      let maximum = bucket[0];
      for (const point of bucket) {
        if (finiteNumber(point.usedPercent) < finiteNumber(minimum.usedPercent)) minimum = point;
        if (finiteNumber(point.usedPercent) > finiteNumber(maximum.usedPercent)) maximum = point;
      }
      const ordered = timestamp(minimum.observedAt) <= timestamp(maximum.observedAt) ? [minimum, maximum] : [maximum, minimum];
      for (const point of ordered) {
        if (selected.at(-1) !== point) selected.push(point);
      }
    }
    if (selected.at(-1) !== points.at(-1)) selected.push(points.at(-1));
    return selected.slice(0, limit - 1).concat(points.at(-1));
  }

  function historyBounds(points) {
    const times = points.map((point) => timestamp(point.observedAt));
    const minimumPoint = Math.min(...times);
    const maximumPoint = Math.max(...times);
    const duration = RANGE_MILLISECONDS[state.range];
    if (duration) {
      const maximum = Math.max(Date.now(), maximumPoint);
      return { minimum: Math.min(maximum - duration, minimumPoint), maximum };
    }
    if (minimumPoint === maximumPoint) {
      return { minimum: minimumPoint - 12 * 60 * 60 * 1000, maximum: maximumPoint + 12 * 60 * 60 * 1000 };
    }
    return { minimum: minimumPoint, maximum: maximumPoint };
  }

  function xPosition(time, minimum, maximum) {
    const { left, right } = CHART.plot;
    return left + ((time - minimum) / (maximum - minimum)) * (right - left);
  }

  function yPosition(value, maximum = 100) {
    const { top, bottom } = CHART.plot;
    return bottom - (clamp(value, 0, maximum) / maximum) * (bottom - top);
  }

  function horizontalGrid(maximum, step) {
    const nodes = [];
    for (let value = 0; value <= maximum; value += step) {
      const y = yPosition(value, maximum);
      nodes.push(createSvg("line", {
        x1: CHART.plot.left,
        y1: y,
        x2: CHART.plot.right,
        y2: y,
        stroke: "#342744",
        "stroke-width": 1,
        class: "graph-grid-line"
      }));
      const label = createSvg("text", {
        x: CHART.plot.left - 9,
        y: y + 4,
        "text-anchor": "end",
        fill: "#ad9fbe",
        class: "graph-axis-label"
      });
      label.textContent = `${value}%`;
      nodes.push(label);
    }
    return nodes;
  }

  function timeGrid(minimum, maximum, range) {
    const nodes = [];
    const tickCount = 5;
    for (let index = 0; index < tickCount; index += 1) {
      const ratio = index / (tickCount - 1);
      const time = minimum + ratio * (maximum - minimum);
      const x = xPosition(time, minimum, maximum);
      nodes.push(createSvg("line", {
        x1: x,
        y1: CHART.plot.top,
        x2: x,
        y2: CHART.plot.bottom,
        stroke: "#2d223c",
        "stroke-width": 1,
        class: "graph-grid-line"
      }));
      const label = createSvg("text", {
        x,
        y: 367,
        "text-anchor": index === 0 ? "start" : index === tickCount - 1 ? "end" : "middle",
        fill: "#ad9fbe",
        class: "graph-axis-label"
      });
      label.textContent = formatAxisTime(time, range);
      nodes.push(label);
    }
    return nodes;
  }

  function positionTooltip(tooltip, wrap, svg, x, y) {
    tooltip.hidden = false;
    const wrapRect = wrap.getBoundingClientRect();
    const svgRect = svg.getBoundingClientRect();
    const displayedX = svgRect.left - wrapRect.left + (x / CHART.width) * svgRect.width;
    const displayedY = svgRect.top - wrapRect.top + (y / CHART.height) * svgRect.height;
    const left = clamp(displayedX + 10, 7, Math.max(7, wrapRect.width - tooltip.offsetWidth - 7));
    const top = clamp(displayedY - tooltip.offsetHeight - 9, 7, Math.max(7, wrapRect.height - tooltip.offsetHeight - 7));
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function hideTooltip(tooltip, svg) {
    tooltip.hidden = true;
    for (const node of svg.querySelectorAll(".is-selected")) node.classList.remove("is-selected");
  }

  function bindInteractivePoint(node, options) {
    const { tooltip, wrap, svg, x, y, content } = options;
    const activate = () => {
      for (const selected of svg.querySelectorAll(".is-selected")) selected.classList.remove("is-selected");
      node.classList.add("is-selected");
      replaceChildren(tooltip, content());
      positionTooltip(tooltip, wrap, svg, x, y);
    };
    node.addEventListener("pointerenter", (event) => {
      if (event.pointerType !== "touch") activate();
    });
    node.addEventListener("pointerleave", (event) => {
      if (event.pointerType !== "touch" && document.activeElement !== node) hideTooltip(tooltip, svg);
    });
    node.addEventListener("pointerdown", activate);
    node.addEventListener("focus", activate);
    node.addEventListener("blur", () => hideTooltip(tooltip, svg));
  }

  function sampleTooltipContent(label, point) {
    const used = formatPercent(point.usedPercent);
    const content = [create("strong", "", `${label} · ${used} used`), create("span", "", formatInstant(point.observedAt))];
    const remaining = formatPercent(point.remainingPercent);
    if (remaining) content.push(create("span", "", `${remaining} remaining`));
    return content;
  }

  function renderHistoryChart(history) {
    elements["history-loading"].hidden = true;
    elements["history-error"].hidden = true;
    elements["history-empty"].hidden = true;
    elements["history-chart"].toggleAttribute("hidden", true);
    hideTooltip(elements["history-tooltip"], elements["history-chart"]);

    const allPoints = Array.isArray(history?.points) ? history.points : [];
    const points = allPoints.filter(validPoint).sort((left, right) => timestamp(left.observedAt) - timestamp(right.observedAt));
    if (!points.length) {
      elements["history-empty"].hidden = false;
      elements["history-key"].replaceChildren();
      return;
    }

    const bounds = historyBounds(points);
    const grid = horizontalGrid(100, 25).concat(timeGrid(bounds.minimum, bounds.maximum, state.range));
    replaceChildren(elements["history-grid"], grid);

    const grouped = new Map();
    for (const point of points) {
      const key = nonempty(point.windowKey) || "Allowance";
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(point);
    }
    for (const [key, series] of grouped) {
      if (/spark/i.test(key) && series.every((point) => finiteNumber(point.usedPercent) === 0)) grouped.delete(key);
    }

    const seriesNodes = [];
    const keyNodes = [];
    [...grouped.entries()].sort(([left], [right]) => left.localeCompare(right)).forEach(([key, rawSeries], seriesIndex) => {
      const color = SERIES_COLORS[seriesIndex % SERIES_COLORS.length];
      const sampled = downsample(rawSeries, 420);
      const pathData = sampled.map((point, index) => {
        const x = xPosition(timestamp(point.observedAt), bounds.minimum, bounds.maximum);
        const y = yPosition(finiteNumber(point.usedPercent));
        return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
      }).join(" ");
      seriesNodes.push(createSvg("path", {
        d: pathData,
        fill: "none",
        stroke: color,
        "stroke-width": 3,
        class: "history-path",
        "aria-hidden": "true"
      }));

      for (const point of sampled) {
        const x = xPosition(timestamp(point.observedAt), bounds.minimum, bounds.maximum);
        const y = yPosition(finiteNumber(point.usedPercent));
        const label = windowLabel(key);
        const circle = createSvg("circle", {
          cx: x,
          cy: y,
          r: sampled.length === 1 ? 7 : 4.2,
          fill: "#140a22",
          stroke: color,
          "stroke-width": 2.5,
          class: "graph-point",
          tabindex: 0,
          role: "img",
          "aria-label": `${label}, ${formatPercent(point.usedPercent)} used, ${formatInstant(point.observedAt)}`
        });
        bindInteractivePoint(circle, {
          tooltip: elements["history-tooltip"],
          wrap: elements["history-wrap"],
          svg: elements["history-chart"],
          x,
          y,
          content: () => sampleTooltipContent(label, point)
        });
        seriesNodes.push(circle);
      }

      if (grouped.size > 1) {
        const keyNode = create("span");
        const swatch = create("i");
        swatch.style.borderColor = color;
        keyNode.append(swatch, document.createTextNode(windowLabel(key)));
        keyNodes.push(keyNode);
      }
    });

    replaceChildren(elements["history-series"], seriesNodes);
    replaceChildren(elements["history-key"], keyNodes);
    elements["history-svg-description"].textContent = "Recorded allowance percentages over the selected range.";
    elements["history-chart"].toggleAttribute("hidden", false);
  }

  function weeklyActualPoints(windowData, history) {
    const start = timestamp(windowData.resetsAt) - finiteNumber(windowData.windowSeconds) * 1000;
    const reset = timestamp(windowData.resetsAt);
    const resetKey = timestamp(windowData.resetsAt);
    const points = Array.isArray(history?.points) ? history.points : [];
    const matching = points.filter((point) => {
      const observed = timestamp(point?.observedAt);
      const pointReset = timestamp(point?.resetsAt);
      return validPoint(point)
        && point.windowKey === windowData.key
        && observed >= start
        && observed <= reset
        && (pointReset === null || pointReset === resetKey);
    });
    matching.push({
      observedAt: windowData.observedAt,
      windowKey: windowData.key,
      usedPercent: windowData.usedPercent,
      remainingPercent: windowData.remainingPercent,
      resetsAt: windowData.resetsAt
    });
    const byTime = new Map();
    for (const point of matching) byTime.set(timestamp(point.observedAt), point);
    return [...byTime.values()].sort((left, right) => timestamp(left.observedAt) - timestamp(right.observedAt));
  }

  function weeklyYScale(points, projection) {
    const values = points.map((point) => finiteNumber(point.usedPercent)).filter((value) => value !== null);
    if (projection !== null) values.push(projection);
    const maximumValue = Math.max(100, ...values);
    const step = maximumValue <= 100 ? 25 : maximumValue <= 200 ? 50 : Math.max(50, Math.ceil(maximumValue / 4 / 25) * 25);
    return { maximum: Math.ceil(maximumValue / step) * step, step };
  }

  function renderWeeklyChart(dashboard, history) {
    if (state.dashboardLoading && !dashboard) return;
    if (state.historyLoading && !history) return;
    elements["weekly-loading"].hidden = true;
    elements["weekly-empty"].hidden = true;
    elements["weekly-chart"].toggleAttribute("hidden", true);
    hideTooltip(elements["weekly-tooltip"], elements["weekly-chart"]);

    const windowData = currentWeeklyWindow(dashboard);
    const reset = timestamp(windowData?.resetsAt);
    const seconds = finiteNumber(windowData?.windowSeconds);
    if (!windowData || reset === null || seconds === null || seconds <= 0) {
      elements["weekly-empty"].hidden = false;
      return;
    }

    const start = reset - seconds * 1000;
    if (!Number.isFinite(start) || start >= reset) {
      elements["weekly-empty"].hidden = false;
      return;
    }

    const actualPoints = weeklyActualPoints(windowData, history).filter((point) => {
      const observed = timestamp(point.observedAt);
      return observed !== null && observed >= start && observed <= reset;
    });
    if (!actualPoints.length) {
      elements["weekly-empty"].hidden = false;
      return;
    }

    const projection = finiteNumber(dashboard?.pace?.projectedUsedAtReset);
    const yScale = weeklyYScale(actualPoints, projection);
    const grid = horizontalGrid(yScale.maximum, yScale.step).concat(timeGrid(start, reset, "7d"));
    replaceChildren(elements["weekly-grid"], grid);

    const seriesNodes = [];
    const evenStartY = yPosition(0, yScale.maximum);
    const evenResetY = yPosition(100, yScale.maximum);
    seriesNodes.push(createSvg("path", {
      d: `M${CHART.plot.left},${evenStartY.toFixed(2)} L${CHART.plot.right},${evenResetY.toFixed(2)}`,
      fill: "none",
      stroke: "#88799b",
      "stroke-width": 2.5,
      opacity: 0.9,
      class: "even-path",
      "aria-label": "Even budget from zero percent at cycle start to one hundred percent at reset"
    }));

    const actualPath = actualPoints.map((point, index) => {
      const x = xPosition(timestamp(point.observedAt), start, reset);
      const y = yPosition(finiteNumber(point.usedPercent), yScale.maximum);
      return `${index === 0 ? "M" : "L"}${x.toFixed(2)},${y.toFixed(2)}`;
    }).join(" ");
    seriesNodes.push(createSvg("path", {
      d: actualPath,
      fill: "none",
      stroke: "#64e8c7",
      "stroke-width": 4,
      class: "weekly-path",
      "aria-hidden": "true"
    }));

    for (const point of actualPoints) {
      const x = xPosition(timestamp(point.observedAt), start, reset);
      const y = yPosition(finiteNumber(point.usedPercent), yScale.maximum);
      const circle = createSvg("circle", {
        cx: x,
        cy: y,
        r: actualPoints.length === 1 ? 7 : 4.5,
        fill: "#140a22",
        stroke: "#64e8c7",
        "stroke-width": 2.7,
        class: "graph-point",
        tabindex: 0,
        role: "img",
        "aria-label": `Actual, ${formatPercent(point.usedPercent)} used, ${formatInstant(point.observedAt)}`
      });
      bindInteractivePoint(circle, {
        tooltip: elements["weekly-tooltip"],
        wrap: elements["weekly-wrap"],
        svg: elements["weekly-chart"],
        x,
        y,
        content: () => sampleTooltipContent("Actual", point)
      });
      seriesNodes.push(circle);
    }

    const latest = actualPoints.at(-1);
    const latestTime = timestamp(latest.observedAt);
    if (projection !== null && latestTime < reset) {
      const startX = xPosition(latestTime, start, reset);
      const startY = yPosition(finiteNumber(latest.usedPercent), yScale.maximum);
      const projectionY = yPosition(projection, yScale.maximum);
      seriesNodes.push(createSvg("path", {
        d: `M${startX.toFixed(2)},${startY.toFixed(2)} L${CHART.plot.right},${projectionY.toFixed(2)}`,
        fill: "none",
        stroke: "#ffc56f",
        "stroke-width": 3.5,
        "stroke-dasharray": "9 7",
        class: "projection-path",
        "aria-hidden": "true"
      }));
      const projectionPoint = createSvg("circle", {
        cx: CHART.plot.right,
        cy: projectionY,
        r: 5.5,
        fill: "#ffc56f",
        stroke: "#140a22",
        "stroke-width": 2.5,
        class: "projection-point",
        tabindex: 0,
        role: "img",
        "aria-label": `Projected, ${formatPercent(projection)} used at reset`
      });
      bindInteractivePoint(projectionPoint, {
        tooltip: elements["weekly-tooltip"],
        wrap: elements["weekly-wrap"],
        svg: elements["weekly-chart"],
        x: CHART.plot.right,
        y: projectionY,
        content: () => [
          create("strong", "", `Projected · ${formatPercent(projection)} used`),
          create("span", "", "At reset")
        ]
      });
      seriesNodes.push(projectionPoint);
    }

    replaceChildren(elements["weekly-series"], seriesNodes);
    elements["weekly-svg-description"].textContent = `Actual usage and an even budget line${projection === null ? "" : ", with a projection to reset"}.`;
    elements["weekly-chart"].toggleAttribute("hidden", false);
  }

  function eventGroups(history) {
    const events = Array.isArray(history?.events) ? history.events : [];
    const groups = new Map();
    for (const event of events) {
      const kind = String(event?.kind || "").toLowerCase();
      if (kind.includes("gap") || (!kind.includes("reset") && !kind.includes("decrease"))) continue;
      const previous = timestamp(event.previousResetAt);
      const current = timestamp(event.currentResetAt);
      const windowKey = nonempty(event.windowKey) || "";
      const eventTime = timestamp(event.observedAt);
      const delta = finiteNumber(event.deltaUsedPercent);
      const key = previous !== null || current !== null
        ? `transition|${windowKey}|${previous || ""}|${current || ""}`
        : `${kind}|${windowKey}|${eventTime || ""}|${delta === null ? "" : delta.toFixed(2)}`;
      if (!groups.has(key)) {
        groups.set(key, { events: [], latest: event, kinds: new Set() });
      }
      const group = groups.get(key);
      group.events.push(event);
      group.kinds.add(kind);
      if ((timestamp(event.observedAt) || 0) > (timestamp(group.latest.observedAt) || 0)) group.latest = event;
    }
    return [...groups.values()].sort((left, right) => {
      return (timestamp(right.latest.observedAt) || 0) - (timestamp(left.latest.observedAt) || 0);
    });
  }

  function renderResetSummary(history) {
    const groups = eventGroups(history);
    elements["resets-panel"].hidden = groups.length === 0;
    if (!groups.length) {
      elements["notable-events"].replaceChildren();
      return;
    }

    const nodes = groups.slice(0, 5).map((group) => {
      const event = group.latest;
      const hasReset = [...group.kinds].some((kind) => kind.includes("reset"));
      const hasDecrease = [...group.kinds].some((kind) => kind.includes("decrease"));
      const article = create("article", "notable-event");
      const uncertainty = String(event.uncertainty || "").toLowerCase();
      const color = hasReset && hasDecrease && uncertainty === "low" ? "#64e8c7" : hasDecrease ? "#ff9a78" : "#ffc56f";
      article.style.setProperty("--event-color", color);
      const title = hasReset && hasDecrease ? "Reset observed" : hasReset ? "Reset target changed" : "Usage decreased";
      const time = create("time", "", formatInstant(event.observedAt) || "");
      if (timestamp(event.observedAt) !== null) time.dateTime = new Date(timestamp(event.observedAt)).toISOString();
      const meta = [];
      if (nonempty(event.windowKey)) meta.push(windowLabel(event.windowKey));
      const deltas = group.events.map((item) => finiteNumber(item.deltaUsedPercent)).filter((value) => value !== null);
      if (deltas.length) meta.push(formatSignedPercent(Math.min(...deltas)));
      article.append(create("strong", "", title), time);
      if (meta.length) article.append(create("span", "event-meta", meta.join(" · ")));
      return article;
    });
    replaceChildren(elements["notable-events"], nodes);
  }

  function setHistoryLoading() {
    state.historyLoading = true;
    for (const button of elements["range-picker"].querySelectorAll("button")) button.disabled = true;
    elements["history-loading"].hidden = false;
    elements["history-error"].hidden = true;
    elements["history-empty"].hidden = true;
    elements["history-chart"].toggleAttribute("hidden", true);
    elements["weekly-loading"].hidden = false;
    elements["weekly-empty"].hidden = true;
    elements["weekly-chart"].toggleAttribute("hidden", true);
    elements["notable-events"].replaceChildren();
  }

  function finishHistoryLoading() {
    state.historyLoading = false;
    for (const button of elements["range-picker"].querySelectorAll("button")) button.disabled = false;
  }

  function renderHistoryFailure() {
    elements["history-loading"].hidden = true;
    elements["history-chart"].toggleAttribute("hidden", true);
    elements["history-empty"].hidden = true;
    elements["history-error"].hidden = false;
    elements["history-key"].replaceChildren();
    elements["notable-events"].replaceChildren();
  }

  async function loadHistory() {
    const request = ++state.historyRequest;
    setHistoryLoading();
    const selectedPromise = fetchJSON(`/api/history?range=${encodeURIComponent(state.range)}`);
    const weeklyPromise = state.range === "7d" ? selectedPromise : fetchJSON("/api/history?range=7d");
    const [selectedResult, weeklyResult] = await Promise.allSettled([selectedPromise, weeklyPromise]);
    if (request !== state.historyRequest) return;
    finishHistoryLoading();

    if (selectedResult.status === "fulfilled") {
      state.history = selectedResult.value;
      state.historyError = null;
      renderHistoryChart(state.history);
      renderResetSummary(state.history);
    } else {
      state.history = null;
      state.historyError = selectedResult.reason instanceof Error ? selectedResult.reason.message : "History request failed";
      renderHistoryFailure();
    }

    if (weeklyResult.status === "fulfilled") {
      state.weeklyHistory = weeklyResult.value;
      state.weeklyHistoryError = null;
    } else {
      state.weeklyHistory = null;
      state.weeklyHistoryError = weeklyResult.reason instanceof Error ? weeklyResult.reason.message : "Weekly history request failed";
    }
    renderWeeklyChart(state.dashboard, state.weeklyHistory);
  }

  function selectRange(range) {
    if ((range !== "all" && !Object.prototype.hasOwnProperty.call(RANGE_MILLISECONDS, range)) || range === state.range || state.historyLoading) return;
    state.range = range;
    for (const button of elements["range-picker"].querySelectorAll("button")) {
      button.setAttribute("aria-pressed", button.dataset.range === range ? "true" : "false");
    }
    loadHistory();
  }

  async function requestFullRefresh() {
    refreshQueued = true;
    if (refreshRunning) return;
    refreshRunning = true;
    try {
      while (refreshQueued) {
        refreshQueued = false;
        await Promise.all([loadDashboard(), loadHistory()]);
      }
    } finally {
      refreshRunning = false;
    }
  }

  function scheduleLiveReconnect() {
    if (state.offline || liveReconnectTimer !== null) return;
    liveReconnectTimer = window.setTimeout(() => {
      liveReconnectTimer = null;
      connectLiveUpdates();
    }, liveReconnectDelay);
    liveReconnectDelay = Math.min(liveReconnectDelay * 2, 30000);
  }

  function connectLiveUpdates() {
    if (state.offline || liveSocket) return;
    const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
    const socket = new WebSocket(`${protocol}//${window.location.host}/api/live`);
    liveSocket = socket;
    socket.addEventListener("open", () => {
      liveReconnectDelay = 1000;
    });
    socket.addEventListener("message", (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (message?.type === "ready" || message?.type === "collection") requestFullRefresh();
    });
    socket.addEventListener("close", () => {
      if (liveSocket === socket) liveSocket = null;
      scheduleLiveReconnect();
    });
    socket.addEventListener("error", () => socket.close());
  }

  function stopLiveUpdates() {
    if (liveReconnectTimer !== null) window.clearTimeout(liveReconnectTimer);
    liveReconnectTimer = null;
    const socket = liveSocket;
    liveSocket = null;
    socket?.close();
  }

  function bindEvents() {
    elements["range-picker"].addEventListener("click", (event) => {
      const button = event.target.closest("button[data-range]");
      if (button) selectRange(button.dataset.range);
    });
    elements["retry-history"].addEventListener("click", loadHistory);
    elements["push-toggle"].addEventListener("click", togglePush);
    window.addEventListener("offline", () => {
      state.offline = true;
      stopLiveUpdates();
      renderFreshness(state.dashboard);
      renderBanners();
    });
    window.addEventListener("online", () => {
      state.offline = false;
      requestFullRefresh();
      connectLiveUpdates();
    });
    window.addEventListener("beforeunload", stopLiveUpdates);
  }

  function startClocks() {
    window.setInterval(() => {
      const previous = state.freshnessMode;
      updateCountdowns();
      renderFreshness(state.dashboard);
      if (previous !== state.freshnessMode) renderBanners();
    }, 1000);
    window.setInterval(() => {
      if (!document.hidden) loadDashboard();
    }, 60000);
  }

  function initialize() {
    cacheElements();
    setupStarfield();
    bindEvents();
    startClocks();
    requestFullRefresh();
    connectLiveUpdates();
    void initializePushControls();
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", initialize, { once: true });
  else initialize();
})();

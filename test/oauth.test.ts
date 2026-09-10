import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UsageCollector, type CollectorConfig } from "../src/collector";
import { DatabaseStore } from "../src/db";
import {
  completeDeviceLogin,
  loadOAuthCredentials,
  refreshOAuthCredentials,
  requestDeviceCode,
} from "../src/oauth";

const roots: string[] = [];
const realFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = realFetch;
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function scratch(): string {
  const root = mkdtempSync(join(tmpdir(), "usage-observatory-oauth-test-"));
  roots.push(root);
  return root;
}

function jwt(accountId: string, expiresAt: number): string {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  return `${encode({ alg: "none" })}.${encode({ exp: expiresAt, "https://api.openai.com/auth": { chatgpt_account_id: accountId } })}.test`;
}

function liveConfig(oauthFile: string, issuer: string): CollectorConfig {
  return {
    mode: "live",
    usageEndpoint: "http://127.0.0.1/usage",
    tokenFile: null,
    accountIdFile: null,
    oauthFile,
    oauthIssuer: issuer,
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

describe("dedicated OAuth ownership", () => {
  test("refreshes an expired app-owned chain atomically before collecting", async () => {
    const root = scratch();
    const credentialPath = join(root, "oauth.json");
    const oldAccess = jwt("account_test", 1);
    const newAccess = jwt("account_test", Math.floor(Date.now() / 1_000) + 3_600);
    writeFileSync(credentialPath, JSON.stringify({
      access_token: oldAccess,
      refresh_token: "refresh-old-secret",
      account_id: "account_test",
    }), { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
    const calls: string[] = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push(url);
      if (url.endsWith("/oauth/token")) {
        const body = JSON.parse(String(init?.body));
        expect(body).toEqual({ client_id: "test-client", grant_type: "refresh_token", refresh_token: "refresh-old-secret" });
        return Response.json({ access_token: newAccess, refresh_token: "refresh-new-secret" });
      }
      if (url.endsWith("rate-limit-reset-credits")) return new Response(null, { status: 404 });
      expect(new Headers(init?.headers).get("Authorization")).toBe(`Bearer ${newAccess}`);
      expect(new Headers(init?.headers).get("ChatGPT-Account-Id")).toBe("account_test");
      return Response.json({
        plan_type: "pro",
        rate_limit: {
          primary_window: {
            used_percent: 12,
            limit_window_seconds: 18_000,
            reset_at: Math.floor(Date.now() / 1_000) + 18_000,
          },
        },
      });
    }) as typeof fetch;

    const store = new DatabaseStore(join(root, "usage.sqlite"));
    const collector = new UsageCollector(store, liveConfig(credentialPath, "http://127.0.0.1"));
    const result = await collector.collect();
    expect(result.state).toBe("healthy");
    expect(calls.filter((url) => url.endsWith("/oauth/token"))).toHaveLength(1);
    expect(await loadOAuthCredentials(credentialPath)).toEqual({
      accessToken: newAccess,
      refreshToken: "refresh-new-secret",
      accountId: "account_test",
    });
    expect(statSync(credentialPath).mode & 0o077).toBe(0);
    store.close();
  });

  test("refuses a refreshed token for a different account without replacing credentials", async () => {
    const root = scratch();
    const credentialPath = join(root, "oauth.json");
    const original = `${JSON.stringify({
      access_token: jwt("account_expected", 1),
      refresh_token: "refresh-private",
      account_id: "account_expected",
    })}\n`;
    writeFileSync(credentialPath, original, { mode: 0o600 });
    chmodSync(credentialPath, 0o600);
    globalThis.fetch = (async () => Response.json({
      access_token: jwt("account_other", Math.floor(Date.now() / 1_000) + 3_600),
      refresh_token: "replacement-private",
    })) as typeof fetch;

    const credentials = await loadOAuthCredentials(credentialPath);
    await expect(refreshOAuthCredentials(credentialPath, credentials, { issuer: "http://127.0.0.1" }))
      .rejects.toThrow("different account context");
    expect(readFileSync(credentialPath, "utf8")).toBe(original);
  });

  test("creates a new dedicated chain through the official device flow shape", async () => {
    const root = scratch();
    const credentialPath = join(root, "oauth.json");
    const accessToken = jwt("account_device", Math.floor(Date.now() / 1_000) + 3_600);
    const requests: Array<{ url: string; body: string }> = [];
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      requests.push({ url, body: String(init?.body ?? "") });
      if (url.endsWith("/api/accounts/deviceauth/usercode")) {
        return Response.json({ user_code: "ABCD-EFGH", device_auth_id: "device-private", interval: 1 });
      }
      if (url.endsWith("/api/accounts/deviceauth/token")) {
        return Response.json({ authorization_code: "authorization-private", code_verifier: "verifier-private" });
      }
      return Response.json({ access_token: accessToken, refresh_token: "refresh-device-private" });
    }) as typeof fetch;

    const device = await requestDeviceCode({ issuer: "http://127.0.0.1", clientId: "test-client" });
    expect(device).toMatchObject({ verificationUrl: "http://127.0.0.1/codex/device", userCode: "ABCD-EFGH" });
    await completeDeviceLogin(credentialPath, device, { issuer: "http://127.0.0.1", clientId: "test-client" });
    expect(requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1/api/accounts/deviceauth/usercode",
      "http://127.0.0.1/api/accounts/deviceauth/token",
      "http://127.0.0.1/oauth/token",
    ]);
    expect(requests[2]?.body).toContain("grant_type=authorization_code");
    expect(await loadOAuthCredentials(credentialPath)).toEqual({
      accessToken,
      refreshToken: "refresh-device-private",
      accountId: "account_device",
    });
  });
});

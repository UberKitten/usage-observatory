import { constants as fsConstants } from "node:fs";
import { link, open, rename, rm, writeFile } from "node:fs/promises";
import { dirname, isAbsolute } from "node:path";

const MAX_CREDENTIAL_BYTES = 16_384;
const REFRESH_SKEW_SECONDS = 300;
const DEVICE_LOGIN_TIMEOUT_MILLISECONDS = 15 * 60 * 1_000;

export const DEFAULT_OAUTH_ISSUER = "https://auth.openai.com";
export const DEFAULT_OAUTH_CLIENT_ID = "app_EMoamEEZ73f0CkXaXp7hrann";

export interface OAuthCredentials {
  accessToken: string;
  refreshToken: string;
  accountId: string;
}

export interface OAuthOptions {
  issuer?: string;
  clientId?: string;
  requestTimeoutMilliseconds?: number;
}

interface DeviceCode {
  verificationUrl: string;
  userCode: string;
  deviceAuthId: string;
  intervalSeconds: number;
}

interface DeviceAuthorization {
  authorizationCode: string;
  codeVerifier: string;
}

export async function loadOAuthCredentials(path: string): Promise<OAuthCredentials> {
  requireAbsolutePath(path);
  await assertPrivateDirectory(dirname(path));
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!metadata.isFile() || metadata.size < 2 || metadata.size > MAX_CREDENTIAL_BYTES) {
      throw new Error("OAuth credential file must be a small regular file.");
    }
    if ((metadata.mode & 0o077) !== 0 || (currentUid !== null && metadata.uid !== currentUid)) {
      throw new Error("OAuth credential file must be owned by the application user with mode 0600 or stricter.");
    }
    const parsed = JSON.parse(await handle.readFile({ encoding: "utf8" }));
    return normalizeCredentials(parsed);
  } catch (error) {
    if (error instanceof SyntaxError) throw new Error("OAuth credential file contains invalid JSON.");
    throw error;
  } finally {
    await handle?.close();
  }
}

export function accessTokenExpiresSoon(accessToken: string, now = new Date()): boolean {
  const expiresAt = jwtNumericClaim(accessToken, "exp");
  if (expiresAt === null) return false;
  return expiresAt <= Math.floor(now.getTime() / 1_000) + REFRESH_SKEW_SECONDS;
}

export async function refreshOAuthCredentials(
  path: string,
  current: OAuthCredentials,
  options: OAuthOptions = {},
): Promise<OAuthCredentials> {
  const issuer = normalizedIssuer(options.issuer);
  const response = await boundedFetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      client_id: options.clientId?.trim() || DEFAULT_OAUTH_CLIENT_ID,
      grant_type: "refresh_token",
      refresh_token: current.refreshToken,
    }),
  }, options.requestTimeoutMilliseconds);
  if (!response.ok) {
    if (response.status === 400 || response.status === 401 || response.status === 403) {
      throw new Error("The dedicated OAuth refresh credential is no longer valid; run device login again.");
    }
    throw new Error(`The OAuth token endpoint returned HTTP ${response.status}.`);
  }
  const payload = await readJsonObject(response);
  const accessToken = requiredSecret(payload.access_token, "refreshed access token");
  const refreshToken = optionalSecret(payload.refresh_token) ?? current.refreshToken;
  const accountId = accountIdFromTokens(accessToken, optionalSecret(payload.id_token)) ?? current.accountId;
  if (accountId !== current.accountId) {
    throw new Error("OAuth refresh returned a different account context; credentials were not replaced.");
  }
  const refreshed = { accessToken, refreshToken, accountId };
  await saveOAuthCredentials(path, refreshed, true);
  return refreshed;
}

export async function requestDeviceCode(options: OAuthOptions = {}): Promise<DeviceCode> {
  const issuer = normalizedIssuer(options.issuer);
  const response = await boundedFetch(`${issuer}/api/accounts/deviceauth/usercode`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({ client_id: options.clientId?.trim() || DEFAULT_OAUTH_CLIENT_ID }),
  }, options.requestTimeoutMilliseconds);
  if (!response.ok) throw new Error(`Device authorization could not start (HTTP ${response.status}).`);
  const payload = await readJsonObject(response);
  const userCode = requiredPublicString(payload.user_code ?? payload.usercode, "device user code");
  const deviceAuthId = requiredSecret(payload.device_auth_id, "device authorization identifier");
  const intervalSeconds = Number(payload.interval);
  if (!Number.isFinite(intervalSeconds) || intervalSeconds < 1 || intervalSeconds > 60) {
    throw new Error("Device authorization returned an invalid polling interval.");
  }
  return {
    verificationUrl: `${issuer}/codex/device`,
    userCode,
    deviceAuthId,
    intervalSeconds,
  };
}

export async function completeDeviceLogin(
  path: string,
  device: DeviceCode,
  options: OAuthOptions = {},
): Promise<void> {
  requireAbsolutePath(path);
  const issuer = normalizedIssuer(options.issuer);
  const authorization = await pollDeviceAuthorization(issuer, device, options.requestTimeoutMilliseconds);
  const redirectUri = `${issuer}/deviceauth/callback`;
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: authorization.authorizationCode,
    redirect_uri: redirectUri,
    client_id: options.clientId?.trim() || DEFAULT_OAUTH_CLIENT_ID,
    code_verifier: authorization.codeVerifier,
  });
  const response = await boundedFetch(`${issuer}/oauth/token`, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Accept: "application/json" },
    body,
  }, options.requestTimeoutMilliseconds);
  if (!response.ok) throw new Error(`Device authorization token exchange failed (HTTP ${response.status}).`);
  const payload = await readJsonObject(response);
  const accessToken = requiredSecret(payload.access_token, "access token");
  const refreshToken = requiredSecret(payload.refresh_token, "refresh token");
  const idToken = optionalSecret(payload.id_token);
  const accountId = accountIdFromTokens(accessToken, idToken);
  if (!accountId) throw new Error("Device authorization did not identify a ChatGPT account.");
  await saveOAuthCredentials(path, { accessToken, refreshToken, accountId }, false);
}

async function pollDeviceAuthorization(
  issuer: string,
  device: DeviceCode,
  timeoutMilliseconds = 15_000,
): Promise<DeviceAuthorization> {
  const deadline = Date.now() + DEVICE_LOGIN_TIMEOUT_MILLISECONDS;
  while (Date.now() < deadline) {
    const response = await boundedFetch(`${issuer}/api/accounts/deviceauth/token`, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ device_auth_id: device.deviceAuthId, user_code: device.userCode }),
    }, timeoutMilliseconds);
    if (response.ok) {
      const payload = await readJsonObject(response);
      return {
        authorizationCode: requiredSecret(payload.authorization_code, "authorization code"),
        codeVerifier: requiredSecret(payload.code_verifier, "code verifier"),
      };
    }
    if (response.status !== 403 && response.status !== 404) {
      throw new Error(`Device authorization failed (HTTP ${response.status}).`);
    }
    await Bun.sleep(device.intervalSeconds * 1_000);
  }
  throw new Error("Device authorization timed out after 15 minutes.");
}

async function saveOAuthCredentials(path: string, credentials: OAuthCredentials, replace: boolean): Promise<void> {
  requireAbsolutePath(path);
  await assertPrivateDirectory(dirname(path));
  const tempPath = `${dirname(path)}/.oauth-${process.pid}-${crypto.randomUUID()}.tmp`;
  const content = `${JSON.stringify({
    access_token: credentials.accessToken,
    refresh_token: credentials.refreshToken,
    account_id: credentials.accountId,
  })}\n`;
  try {
    await writeFile(tempPath, content, { encoding: "utf8", mode: 0o600, flag: "wx" });
    if (replace) {
      await rename(tempPath, path);
    } else {
      try {
        await link(tempPath, path);
      } catch (error) {
        if (error && typeof error === "object" && "code" in error && error.code === "EEXIST") {
          throw new Error("OAuth credential path already exists; refusing to replace another credential chain.");
        }
        throw error;
      }
    }
  } finally {
    await rm(tempPath, { force: true });
  }
}

function normalizeCredentials(value: unknown): OAuthCredentials {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OAuth credential file has an unsupported shape.");
  const object = value as Record<string, unknown>;
  return {
    accessToken: requiredSecret(object.access_token, "access token"),
    refreshToken: requiredSecret(object.refresh_token, "refresh token"),
    accountId: requiredAccountId(object.account_id),
  };
}

function accountIdFromTokens(accessToken: string, idToken: string | null): string | null {
  for (const token of [accessToken, idToken]) {
    if (!token) continue;
    const payload = jwtPayload(token);
    const auth = payload?.["https://api.openai.com/auth"];
    const candidate = auth && typeof auth === "object" && !Array.isArray(auth)
      ? (auth as Record<string, unknown>).chatgpt_account_id
      : payload?.chatgpt_account_id;
    if (candidate !== undefined) return requiredAccountId(candidate);
  }
  return null;
}

function jwtNumericClaim(token: string, claim: string): number | null {
  const value = jwtPayload(token)?.[claim];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function jwtPayload(token: string): Record<string, unknown> | null {
  const parts = token.split(".");
  if (parts.length !== 3) return null;
  try {
    const value = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8"));
    return value && typeof value === "object" && !Array.isArray(value) ? value : null;
  } catch {
    return null;
  }
}

function requiredAccountId(value: unknown): string {
  const accountId = requiredSecret(value, "account identifier");
  if (!/^[A-Za-z0-9_-]{1,256}$/.test(accountId)) throw new Error("OAuth account identifier is malformed.");
  return accountId;
}

function requiredPublicString(value: unknown, description: string): string {
  if (typeof value !== "string" || !value.trim() || value.length > 512 || /[\r\n\0]/.test(value)) {
    throw new Error(`OAuth ${description} is malformed.`);
  }
  return value.trim();
}

function requiredSecret(value: unknown, description: string): string {
  if (typeof value !== "string" || !value || value.length > 8_192 || /[\r\n\0]/.test(value)) {
    throw new Error(`OAuth ${description} is missing or malformed.`);
  }
  return value;
}

async function assertPrivateDirectory(path: string): Promise<void> {
  let handle;
  try {
    handle = await open(path, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW);
    const metadata = await handle.stat();
    const currentUid = typeof process.getuid === "function" ? process.getuid() : null;
    if (!metadata.isDirectory() || (metadata.mode & 0o077) !== 0 || (currentUid !== null && metadata.uid !== currentUid)) {
      throw new Error("OAuth credential directory must be owned by the application user with mode 0700 or stricter.");
    }
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("OAuth credential directory")) throw error;
    throw new Error("OAuth credential directory could not be opened safely.");
  } finally {
    await handle?.close();
  }
}

function optionalSecret(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  return requiredSecret(value, "token value");
}

async function readJsonObject(response: Response): Promise<Record<string, unknown>> {
  const text = await response.text();
  if (text.length > MAX_CREDENTIAL_BYTES) throw new Error("OAuth response exceeded its safety limit.");
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new Error("OAuth response was not valid JSON.");
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("OAuth response had an unsupported shape.");
  return value as Record<string, unknown>;
}

async function boundedFetch(url: string, init: RequestInit, timeoutMilliseconds = 15_000): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMilliseconds) });
}

function normalizedIssuer(value?: string): string {
  const issuer = (value?.trim() || DEFAULT_OAUTH_ISSUER).replace(/\/+$/, "");
  let url: URL;
  try {
    url = new URL(issuer);
  } catch {
    throw new Error("OAuth issuer is not a valid URL.");
  }
  const loopback = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.username || url.password || url.search || url.hash || (url.protocol !== "https:" && !(url.protocol === "http:" && loopback))) {
    throw new Error("OAuth issuer must be credential-free HTTPS, except for explicit loopback testing.");
  }
  return issuer;
}

function requireAbsolutePath(path: string): void {
  if (!isAbsolute(path)) throw new Error("OAuth credential path must be absolute.");
}

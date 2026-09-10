import { isAbsolute } from "node:path";
import { completeDeviceLogin, DEFAULT_OAUTH_ISSUER, requestDeviceCode } from "./oauth";

async function main(): Promise<void> {
  const credentialPath = process.argv[2];
  if (!credentialPath || !isAbsolute(credentialPath)) {
    throw new Error("Usage: bun run auth:login -- /absolute/path/to/oauth.json");
  }
  if (await Bun.file(credentialPath).exists()) {
    throw new Error("Credential path already exists; move it aside explicitly before creating a new credential chain.");
  }

  const issuer = process.env.CODEX_OAUTH_ISSUER?.trim() || DEFAULT_OAUTH_ISSUER;
  const device = await requestDeviceCode({ issuer });
  console.log(`Open ${device.verificationUrl}`);
  console.log(`Enter code: ${device.userCode}`);
  console.log("Waiting for authorization (up to 15 minutes)…");
  await completeDeviceLogin(credentialPath, device, { issuer });
  console.log(`Dedicated OAuth credential created at ${credentialPath} with mode 0600.`);
}

if (import.meta.main) {
  await main().catch((error) => {
    console.error(error instanceof Error ? error.message : "Device login failed.");
    process.exitCode = 1;
  });
}

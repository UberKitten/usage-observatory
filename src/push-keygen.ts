import {
  closeSync,
  constants as fsConstants,
  fchmodSync,
  fsyncSync,
  openSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute } from "node:path";
import webPush from "web-push";
import { validateVapidSubject } from "./notifications";

function main(): void {
  const [path, subject, ...extra] = process.argv.slice(2);
  if (!path || !isAbsolute(path) || !subject || extra.length > 0) {
    throw new Error("Usage: bun run push:keygen -- /absolute/path/to/vapid.json <mailto-or-https-subject>");
  }
  validateVapidSubject(subject);

  let descriptor: number | null = null;
  let created = false;
  try {
    descriptor = openSync(
      path,
      fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW,
      0o600,
    );
    created = true;
    fchmodSync(descriptor, 0o600);
    const keys = webPush.generateVAPIDKeys();
    const contents = `${JSON.stringify({
      subject,
      publicKey: keys.publicKey,
      privateKey: keys.privateKey,
    }, null, 2)}\n`;
    writeFileSync(descriptor, contents, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = null;
    console.log(`Created owner-only VAPID key file: ${path}`);
  } catch (error) {
    if (descriptor !== null) closeSync(descriptor);
    if (created) {
      try {
        unlinkSync(path);
      } catch {
        // Preserve the original creation failure.
      }
    }
    const reason = error instanceof Error ? error.message : "key file could not be created";
    throw new Error(`VAPID key generation failed: ${reason}`);
  }
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    console.error(error instanceof Error ? error.message : "VAPID key generation failed.");
    process.exitCode = 1;
  }
}

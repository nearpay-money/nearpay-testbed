/**
 * Chrome for the browser flows (Playwright tests and `pnpm onboard:live`).
 *
 * Chrome refuses WebAuthn on pages with certificate errors, and `ignoreHTTPSErrors` only hides the
 * error. Pinning the local leaf's SPKI makes Chrome treat nearpay-deploy's certificate as valid, so
 * passkeys work without installing the local CA (a no-op where mkcert's CA is already trusted).
 */
import { createHash, X509Certificate } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Env = Record<string, string | undefined>;

/** `--ignore-certificate-errors-spki-list=<sha256(spki)>` for `<deploy>/.secrets/tls/cert.pem`, if present. */
export function localCertArgs(deployDir: string = resolve(process.env.NP_DEPLOY_DIR ?? "../nearpay-deploy")): string[] {
  const cert = join(deployDir, ".secrets/tls/cert.pem");
  if (!existsSync(cert)) return [];
  const spki = new X509Certificate(readFileSync(cert)).publicKey.export({ type: "spki", format: "der" });
  return [`--ignore-certificate-errors-spki-list=${createHash("sha256").update(spki).digest("base64")}`];
}

/**
 * The installed Chrome: `NP_CHROME`, else `/usr/bin/google-chrome` where it exists (Linux, CI), else
 * Playwright's `chrome` channel lookup (the standard install location on macOS and Windows).
 */
export function chromeExecutable(env: Env = process.env, exists: (p: string) => boolean = existsSync) {
  if (env.NP_CHROME) return env.NP_CHROME;
  return exists("/usr/bin/google-chrome") ? "/usr/bin/google-chrome" : undefined;
}

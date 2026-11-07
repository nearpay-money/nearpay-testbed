import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { chromeExecutable, localCertArgs } from "../../lib/chrome.js";

const tmp = () => mkdtempSync(join(tmpdir(), "np-chrome-"));

describe("chrome", () => {
  it("pins the local leaf certificate's SPKI when the deploy checkout has one", () => {
    expect(localCertArgs(tmp())).toStrictEqual([]);
    const dir = tmp();
    const pem = readFileSync(new URL("../fixtures/local-cert.pem", import.meta.url));
    mkdirSync(join(dir, ".secrets/tls"), { recursive: true });
    writeFileSync(join(dir, ".secrets/tls/cert.pem"), pem);
    const [arg] = localCertArgs(dir);
    expect(arg).toMatch(/^--ignore-certificate-errors-spki-list=[A-Za-z0-9+/]{43}=$/);
  });

  it("finds Chrome: NP_CHROME, the Linux path, else Playwright's chrome channel", () => {
    expect(chromeExecutable({ NP_CHROME: "/opt/chrome" }, () => true)).toBe("/opt/chrome");
    expect(chromeExecutable({}, () => true)).toBe("/usr/bin/google-chrome");
    expect(chromeExecutable({}, () => false)).toBeUndefined();
  });
});

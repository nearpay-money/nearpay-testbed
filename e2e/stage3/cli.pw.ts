/**
 * Stage 3 scenario 4 — the developer CLI against the real stack (NP_E2E=1; lld/sdks-and-tools.md §3, identity §6.2):
 * a new merchant (dashboard sign-up with a software passkey, test-mode Intents destination) runs `nearpay login
 * --no-browser` → approves the pairing code on the dashboard's `/cli/authorize` page (passkey sign-in, step-up) →
 * the CLI stores its 90-day restricted test key → `nearpay listen --forward-to` re-signs each streamed event to a
 * local endpoint → `nearpay trigger` makes real test-mode events: payment_intent.succeeded, refund.succeeded,
 * payment_intent.requires_review (USD 10.05, scenario 05), payment_intent.overpaid (USD 10.06, scenario 06). Every
 * forwarded event is checked against its HMAC signature. refund.failed (refund amount ending 04) is checked not to be
 * claimed: scenario 04 holds the refund leg (see below).
 *
 * The CLI binary comes from lib/artifacts.ts (`@nearpay/cli` when installed, else nearpay-cli's build output).
 */
import "../../lib/localhost-dns.js";
import { type ChildProcess, spawn } from "node:child_process";
import { createHmac, timingSafeEqual } from "node:crypto";
import { mkdtempSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getAccount } from "@nearpay/spec";
import { expect, type Page, test } from "@playwright/test";
import { cliBin, nodeArgs } from "../../lib/artifacts.js";
import type { SoftCredential } from "../../lib/webauthn.js";
import { stack } from "../support/env.js";
import { newMerchant } from "../support/stage3.js";

interface Run {
  child: ChildProcess;
  out: () => string;
  err: () => string;
  exit: Promise<number>;
}

function cli(args: string[], env: NodeJS.ProcessEnv): Run {
  const child = spawn(process.execPath, nodeArgs(cliBin(), args), { env, stdio: ["ignore", "pipe", "pipe"] });
  let out = "";
  let err = "";
  child.stdout?.on("data", (d) => {
    out += String(d);
  });
  child.stderr?.on("data", (d) => {
    err += String(d);
  });
  const exit = new Promise<number>((r) => child.on("exit", (code) => r(code ?? 1)));
  return { child, out: () => out, err: () => err, exit };
}

async function waitText(run: Run, re: RegExp, ms: number, what: string): Promise<RegExpExecArray> {
  const end = Date.now() + ms;
  for (;;) {
    const m = re.exec(run.out() + run.err());
    if (m) return m;
    if (Date.now() > end || run.child.exitCode !== null) {
      throw new Error(
        `CLI: no ${what} within ${ms} ms\nstdout: ${run.out().slice(-2000)}\nstderr: ${run.err().slice(-2000)}`,
      );
    }
    await new Promise((r) => setTimeout(r, 250));
  }
}

/** The software passkey as a CDP virtual-authenticator credential (resident, so "Sign in with passkey" finds it). */
async function addPasskey(page: Page, c: SoftCredential) {
  const { createPrivateKey } = await import("node:crypto");
  const cdp = await page.context().newCDPSession(page);
  await cdp.send("WebAuthn.enable");
  const { authenticatorId } = await cdp.send("WebAuthn.addVirtualAuthenticator", {
    options: {
      protocol: "ctap2",
      transport: "internal",
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  const der = createPrivateKey(c.privateKeyPem).export({ format: "der", type: "pkcs8" });
  await cdp.send("WebAuthn.addCredential", {
    authenticatorId,
    credential: {
      credentialId: Buffer.from(c.id, "base64url").toString("base64"),
      isResidentCredential: true,
      rpId: c.rpId,
      privateKey: Buffer.from(der).toString("base64"),
      userHandle: Buffer.from(c.userHandle, "base64url").toString("base64"),
      signCount: c.signCount + 1,
    },
  });
}

/** NearPay-Signature `t=…,v1=…`: HMAC-SHA256 over `<t>.<raw body>` with the session secret. */
function signatureOk(header: string | undefined, raw: string, secret: string): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(",").map((p) => p.split("=", 2) as [string, string]));
  const t = parts.t;
  const v1s = header
    .split(",")
    .filter((p) => p.startsWith("v1="))
    .map((p) => p.slice(3));
  if (!t || !v1s.length) return false;
  const mac = createHmac("sha256", secret).update(`${t}.${raw}`).digest();
  return v1s.some((v) => {
    for (const enc of ["hex", "base64", "base64url"] as const) {
      const b = Buffer.from(v, enc);
      if (b.length === mac.length && timingSafeEqual(b, mac)) return true;
    }
    return false;
  });
}

const TRIGGERS = [
  "payment_intent.succeeded",
  "refund.succeeded",
  "payment_intent.requires_review",
  "payment_intent.overpaid",
] as const;

test("nearpay login (device flow on /cli/authorize) → listen --forward-to → trigger against the real stack", async ({
  page,
}) => {
  test.setTimeout(12 * 60_000);
  await page.route(/raw\.githubusercontent\.com|cdn\.jsdelivr\.net/, (r) =>
    r.fulfill({ contentType: "application/json", body: JSON.stringify({ wallets: [], version: "1.0.0" }) }),
  );
  const st = stack();
  const merchant = await newMerchant("cli");
  merchant.session.mode = "test";
  const account = await merchant.session.call<{ id: string }>(getAccount);
  const env = {
    ...process.env,
    NEARPAY_CONFIG_DIR: mkdtempSync(join(tmpdir(), "np-cli-")),
    NEARPAY_API_BASE: st.apiUrl,
    NO_COLOR: "1",
    FORCE_COLOR: "",
  };

  // 1. device login: the pairing code is approved in the dashboard
  const login = cli(["login", "--no-browser"], env);
  const link = (
    await waitText(login, /(https:\/\/\S+\/cli\/authorize\?code=[A-Za-z0-9-]+)/, 30_000, "approval link")
  )[1] as string;
  const code = (
    await waitText(login, /\b([B-DF-HJ-NP-TV-Z]{4}-[B-DF-HJ-NP-TV-Z]{4})\b/, 5_000, "pairing code")
  )[1] as string;
  expect(new URL(link).origin).toBe(st.dashboardUrl);

  await addPasskey(page, merchant.session.credential);
  await page.goto(link);
  await expect(page).toHaveURL(/\/signin\?next=/, { timeout: 30_000 });
  await page.getByRole("button", { name: "Sign in with passkey" }).click();
  await expect(page).toHaveURL(/\/cli\/authorize\?code=/, { timeout: 30_000 });
  const card = page.getByTestId("cli-authorize");
  await expect(card.getByTestId("cli-code")).toContainText(code.toUpperCase());
  await expect(card).toContainText("Only approve a login you just started");
  await page.getByTestId("cli-approve").click();
  // a passkey sign-in a moment ago counts as a fresh step-up; otherwise the dialog asks for the passkey again
  const confirm = page.getByRole("button", { name: "Confirm with passkey" });
  const approved = card.locator("p", { hasText: "Approved. Return to your terminal" });
  await expect(confirm.or(approved)).toBeVisible({ timeout: 30_000 });
  if (await confirm.isVisible()) await confirm.click();
  await expect(approved).toBeVisible({ timeout: 30_000 });
  expect(await login.exit, login.err()).toBe(0);
  expect(login.out()).toMatch(/Logged in to .*\(acct_[0-9a-z]+\) in test mode/);

  const whoami = cli(["whoami", "--json"], env);
  expect(await whoami.exit, whoami.err()).toBe(0);
  expect(whoami.out()).toContain(account.id);
  expect(whoami.out()).toMatch(/rk_test_/);

  // 2. listen --forward-to a local endpoint that checks every signature
  const received: {
    type: string;
    id: string;
    raw: string;
    signature: string | undefined;
    object: Record<string, unknown>;
  }[] = [];
  const server = createServer((req, res) => {
    let raw = "";
    req.on("data", (d) => {
      raw += String(d);
    });
    req.on("end", () => {
      try {
        const e = JSON.parse(raw) as { id: string; type: string; data: { object: Record<string, unknown> } };
        received.push({
          type: e.type,
          id: e.id,
          raw,
          signature: req.headers["nearpay-signature"] as string,
          object: e.data.object,
        });
      } catch {
        // not an event
      }
      res.writeHead(200, { "content-type": "application/json" }).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  const listen = cli(["listen", "--forward-to", `localhost:${port}/webhooks`], env);
  try {
    const secret = (await waitText(listen, /(whsec_[A-Za-z0-9_-]+)/, 30_000, "session signing secret"))[1] as string;

    // 3. triggers: real test-mode API calls; the stream forwards every event of each flow
    for (const event of TRIGGERS) {
      // the sandbox timelines plus a busy 2-CPU stack can exceed the CLI default of 90 s
      const t = cli(["trigger", event, "--timeout", "300"], env);
      const code = await Promise.race([t.exit, new Promise<number>((r) => setTimeout(() => r(-1), 6 * 60_000))]);
      expect(code, `trigger ${event}\n${t.out()}\n${t.err()}`).toBe(0);
      const evt = new RegExp(`${event.replace(".", "\\.")} (evt_[0-9a-z]+)`).exec(t.out() + t.err())?.[1];
      expect(evt, t.out()).toBeTruthy();
      await expect.poll(() => received.some((r) => r.id === evt), { timeout: 90_000, intervals: [1000] }).toBe(true);
      const fwd = received.find((r) => r.id === evt) as (typeof received)[number];
      expect(fwd.type).toBe(event);
      expect(signatureOk(fwd.signature, fwd.raw, secret), `signature of ${evt}`).toBe(true);
      if (event === "payment_intent.requires_review") expect(fwd.object.status).toBe("requires_review");
      if (event === "payment_intent.overpaid") expect(fwd.object.status).toMatch(/succeeded|overpaid/);
    }
    // refund.failed (step 3.4 finding): a refund leg whose sandbox scenario is 04 (FAILED after processing) is held by
    // rails (`failed_after_deposit`: the merchant's funds may sit at the provider), so the refund stays `pending` and
    // no refund.failed exists — the stack offers no fast public path to a failed refund in test mode. The CLI must
    // not claim it: either it reports the trigger unsupported (exit 2) or its wait times out (exit 4, CLI 0.1.0).
    const failed = cli(["trigger", "refund.failed", "--timeout", "60"], env);
    expect([2, 4], `${failed.out()}\n${failed.err()}`).toContain(await failed.exit);
    expect(received.some((r) => r.type === "refund.failed")).toBe(false);
    // biome-ignore lint/suspicious/noControlCharactersInRegex: strips ANSI colours (Playwright sets FORCE_COLOR)
    expect((listen.out() + listen.err()).replace(/\x1b\[[0-9;]*m/g, "")).toMatch(
      /<-- \[200\] POST http:\/\/localhost:\d+\/webhooks \[evt_/,
    );
  } finally {
    listen.child.kill("SIGINT");
    await Promise.race([listen.exit, new Promise((r) => setTimeout(r, 5000))]);
    server.close();
  }
});

import { describe, expect, it, vi } from "vitest";
import { plan, runCli } from "../ops/cli.js";

const ACCT = "acct_01jbz9k3m4n5p6q7r8s9t0v1w2";
const SD = "sd_01jbz9k3m4n5p6q7r8s9t0v1w2";

describe("ops plan", () => {
  it("maps Stage 1 ops actions to the owning service's ops.js", () => {
    expect(plan(["kyb-decide", ACCT, "approved", "--reason", "docs checked"], "op")).toStrictEqual({
      service: "compliance-api",
      argv: ["kyb-decide", ACCT, "approved", "--reason", "docs checked", "--actor", "op"],
    });
    expect(plan(["kyb-show", ACCT], "op").service).toBe("compliance-api");
    expect(plan(["kill-switch"], "op")).toStrictEqual({ service: "sentinel-api", argv: ["kill-switch"] });
    expect(plan(["kill-switch-release", "false", "alarm", "--yes", "--actor", "alice"], "op")).toStrictEqual({
      service: "sentinel-api",
      argv: ["kill-switch-release", "alice: false alarm"],
    });
    expect(plan(["kill-switch-engage", "drill"], "op").argv).toStrictEqual(["kill-switch-engage", "op: drill"]);
    expect(plan(["destination-cooloff-skip", SD], "op")).toStrictEqual({
      service: "identity-api",
      argv: ["destination-cooloff-skip", SD, "--actor", "op"],
    });
    expect(plan(["account-show", "demo@merchant.test"], "op").service).toBe("identity-api");
    expect(plan(["rails-flags"], "op")).toStrictEqual({ service: "rails-api", argv: ["flags"] });
  });

  it("adds console operators only with an ops_role (kit 0.2.0) and imports a sanctions list", () => {
    expect(plan(["operator-add", "Ops@NearPay.localhost", "ops_admin"], "op")).toStrictEqual({
      service: "identity-api",
      argv: ["operator-add", "ops@nearpay.localhost", "ops_admin", "--actor", "op"],
    });
    expect(plan(["operator-revoke", "ops@nearpay.localhost"], "op").argv).toStrictEqual([
      "operator-revoke",
      "ops@nearpay.localhost",
      "--actor",
      "op",
    ]);
    const imp = plan(["sanctions-import"], "op");
    expect(imp).toMatchObject({ service: "compliance-api", argv: ["sanctions-import", "-"] });
    expect(imp.stdinFile).toMatch(/fixtures\/ofac\/sdn_advanced\.synthetic\.xml$/);
  });

  it.each([
    [["kyb-decide", "acct_x", "approved", "--reason", "r"]],
    [["kyb-decide", ACCT, "maybe", "--reason", "r"]],
    [["kyb-decide", ACCT, "approved"]],
    [["kyb-show"]],
    [["kill-switch-release", "why"]],
    [["kill-switch-release", "--yes"]],
    [["destination-cooloff-skip", "sd_x"]],
    [["account-show"]],
    [["operator-add", "ops@nearpay.localhost"]],
    [["operator-add", "ops@nearpay.localhost", "admin"]],
    [["operator-add", "not-an-email", "ops"]],
    [["operator-revoke"]],
    [["nope"]],
    [[]],
  ])("rejects %j", (argv) => {
    expect(() => plan(argv, "op")).toThrow();
  });
});

describe("runCli", () => {
  it("runs docker compose exec and passes the output and exit code through", () => {
    const run = vi.fn((_cmd: string, _args: readonly string[]) => ({
      code: 0,
      stdout: '{"engaged":false}',
      stderr: "",
    }));
    const out: string[] = [];
    expect(runCli(["kill-switch", "--deploy", "/x/deploy"], { run, out: (s) => out.push(s), err: () => {} })).toBe(0);
    const [cmd, args] = run.mock.calls[0] ?? [];
    expect(cmd).toBe("docker");
    expect(args?.includes("/x/deploy/compose")).toBe(true);
    expect(out).toStrictEqual(['{"engaged":false}\n']);
  });

  it("pipes the sanctions list to the in-container import", () => {
    const run = vi.fn((_cmd: string, _args: readonly string[], _input?: string) => ({
      code: 0,
      stdout: "{}",
      stderr: "",
    }));
    expect(runCli(["sanctions-import"], { run, out: () => {}, err: () => {} })).toBe(0);
    expect(run.mock.calls[0]?.[2]).toContain("Digital Currency Address - ETH");
    const err: string[] = [];
    expect(runCli(["sanctions-import", "/nonexistent.xml"], { run, out: () => {}, err: (s) => err.push(s) })).toBe(2);
    expect(err.join("")).toContain("cannot read");
  });

  it("prints usage (exit 2) and docker errors", () => {
    const err: string[] = [];
    expect(runCli(["bogus"], { err: (s) => err.push(s), run: vi.fn() })).toBe(2);
    expect(err[0]).toContain("usage: pnpm ops");
    const e2: string[] = [];
    expect(
      runCli(["kill-switch"], {
        deployDir: "/d",
        actor: "a",
        run: () => ({ code: 127, stdout: "", stderr: "docker: ENOENT" }),
        err: (s) => e2.push(s),
      }),
    ).toBe(127);
    expect(e2.join("")).toContain("docker is not available");
  });
});

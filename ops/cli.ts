/**
 * Local ops CLI (lld/platform.md §3, lld/dashboard-and-console.md §2 "Stage mapping", audit S-06):
 * wrappers around the services' in-container ops CLIs, run with `docker compose exec`. Since Stage 2
 * operators work in the console (`ops.<domain>`): every console session is an ops principal whose
 * `ops_role` (`ops` | `ops_admin`, kit 0.2.0) is enforced per route, so an operator is always added with
 * a role (`operator-add`), which emails the console enrolment link (Mailpit locally). The Stage 1
 * commands stay for local stacks and drills.
 *
 *   pnpm ops operator-add <email> ops|ops_admin       console operator + 24 h enrolment link
 *   pnpm ops operator-revoke <email>                  revokes the operator and their console sessions
 *   pnpm ops sanctions-import [<SDN advanced XML>]    offline stacks: loads the OFAC list (default: the
 *                                                     synthetic fixtures/ofac list; live screening answers
 *                                                     screening_unavailable until a list was loaded)
 *
 *   pnpm ops kyb-show <acct_…>
 *   pnpm ops kyb-decide <acct_…> approved|rejected|needs_info --reason <text>
 *   pnpm ops kill-switch                              state + last changes
 *   pnpm ops kill-switch-engage <reason…>             (drills, trace T7)
 *   pnpm ops kill-switch-release <reason…> --yes      resume live quoting (Stage 1: one operator, logged)
 *   pnpm ops destination-cooloff-skip <sd_…>          (NP_ENV=local stacks only)
 *   pnpm ops account-show <acct_… | email>
 *   pnpm ops rails-flags                              rails control flags (quoting_enabled after a release)
 *
 * Options: --actor <name> (default testbed:<user>; recorded by compliance and identity), --deploy <dir>.
 */
import { readFileSync } from "node:fs";
import { userInfo } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { dockerRunner, type Runner, serviceOps } from "../lib/compose.js";

export const USAGE = `usage: pnpm ops <command> [arguments] [--actor <name>] [--deploy <nearpay-deploy dir>]

  operator-add <email> ops|ops_admin
  operator-revoke <email>
  sanctions-import [<SDN advanced XML>]
  kyb-show <acct_…>
  kyb-decide <acct_…> approved|rejected|needs_info --reason <text>
  kill-switch
  kill-switch-engage <reason…>
  kill-switch-release <reason…> --yes
  destination-cooloff-skip <sd_…>
  account-show <acct_… | email>
  rails-flags`;

const ACCT = /^acct_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const SD = /^sd_[0-7][0-9a-hjkmnp-tv-z]{25}$/;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
/** Console roles (kit 0.2.0 enforces a route's `opsRoles` against the session's `ops_role`). */
export const OPS_ROLES = ["ops", "ops_admin"] as const;
/** Synthetic SDN list for offline local stacks (not OFAC data). */
export const SYNTHETIC_SDN = join(
  dirname(fileURLToPath(import.meta.url)),
  "../fixtures/ofac/sdn_advanced.synthetic.xml",
);

class UsageError extends Error {}

export interface Planned {
  service: string;
  argv: string[];
  /** File piped to the command's stdin. */
  stdinFile?: string;
}

/** Maps a testbed ops command to the owning service's ops.js invocation (pure; unit-tested). */
export function plan(argv: readonly string[], actor: string): Planned {
  const { values, positionals } = parseArgs({
    args: [...argv],
    allowPositionals: true,
    strict: true,
    options: {
      reason: { type: "string" },
      actor: { type: "string" },
      deploy: { type: "string" },
      yes: { type: "boolean" },
    },
  });
  const [cmd, ...args] = positionals;
  const who = values.actor ?? actor;
  const reasonWords = () => {
    const r = args.join(" ").trim();
    if (!r) throw new UsageError(`${cmd} needs a reason`);
    return r;
  };
  switch (cmd) {
    case "kyb-show": {
      if (!ACCT.test(args[0] ?? "")) throw new UsageError("kyb-show needs an acct_… id");
      return { service: "compliance-api", argv: ["kyb-show", args[0] as string] };
    }
    case "kyb-decide": {
      const [acct, decision] = args;
      if (!ACCT.test(acct ?? "")) throw new UsageError("kyb-decide needs an acct_… id");
      if (!["approved", "rejected", "needs_info"].includes(decision ?? "")) {
        throw new UsageError("decision must be approved, rejected or needs_info");
      }
      if (!values.reason?.trim()) throw new UsageError("kyb-decide needs --reason");
      return {
        service: "compliance-api",
        argv: ["kyb-decide", acct as string, decision as string, "--reason", values.reason.trim(), "--actor", who],
      };
    }
    case "kill-switch":
      return { service: "sentinel-api", argv: ["kill-switch"] };
    case "kill-switch-engage":
      return { service: "sentinel-api", argv: ["kill-switch-engage", `${who}: ${reasonWords()}`] };
    case "kill-switch-release": {
      const reason = reasonWords();
      if (!values.yes) throw new UsageError("kill-switch-release resumes live quoting: confirm with --yes");
      // sentinel's CLI records its own actor (cli@host); the operator's name goes into the reason.
      return { service: "sentinel-api", argv: ["kill-switch-release", `${who}: ${reason}`] };
    }
    case "destination-cooloff-skip": {
      if (!SD.test(args[0] ?? "")) throw new UsageError("destination-cooloff-skip needs an sd_… id");
      return { service: "identity-api", argv: ["destination-cooloff-skip", args[0] as string, "--actor", who] };
    }
    case "account-show": {
      if (!args[0]) throw new UsageError("account-show needs an acct_… id or an email");
      return { service: "identity-api", argv: ["account-show", args[0], "--actor", who] };
    }
    case "rails-flags":
      return { service: "rails-api", argv: ["flags"] };
    case "operator-add": {
      const [email, role] = args;
      if (!EMAIL.test(email ?? "")) throw new UsageError("operator-add needs an email address");
      if (!(OPS_ROLES as readonly string[]).includes(role ?? ""))
        throw new UsageError("operator-add needs a role: ops or ops_admin (console routes check the ops_role)");
      return {
        service: "identity-api",
        argv: ["operator-add", (email as string).toLowerCase(), role as string, "--actor", who],
      };
    }
    case "operator-revoke": {
      if (!EMAIL.test(args[0] ?? "")) throw new UsageError("operator-revoke needs an email address");
      return { service: "identity-api", argv: ["operator-revoke", (args[0] as string).toLowerCase(), "--actor", who] };
    }
    case "sanctions-import":
      return {
        service: "compliance-api",
        argv: ["sanctions-import", "-"],
        stdinFile: resolve(args[0] ?? SYNTHETIC_SDN),
      };
    default:
      throw new UsageError(cmd ? `unknown command "${cmd}"` : "missing command");
  }
}

export function runCli(
  argv: readonly string[],
  deps: { run?: Runner; out?: (s: string) => void; err?: (s: string) => void; deployDir?: string; actor?: string } = {},
): number {
  const out = deps.out ?? ((s) => process.stdout.write(s));
  const err = deps.err ?? ((s) => process.stderr.write(s));
  let p: Planned;
  let deployDir = deps.deployDir ?? resolve(process.env.NP_DEPLOY_DIR ?? "../nearpay-deploy");
  try {
    const deployFlag = argv.indexOf("--deploy");
    if (deployFlag >= 0 && argv[deployFlag + 1]) deployDir = resolve(argv[deployFlag + 1] as string);
    p = plan(argv, deps.actor ?? `testbed:${userInfo().username}`);
  } catch (e) {
    err(`${(e as Error).message}\n\n${USAGE}\n`);
    return 2;
  }
  let input: string | undefined;
  if (p.stdinFile) {
    try {
      input = readFileSync(p.stdinFile, "utf8");
    } catch (e) {
      err(`cannot read ${p.stdinFile}: ${(e as Error).message}\n`);
      return 2;
    }
  }
  const r = serviceOps({ deployDir }, p.service, p.argv, deps.run ?? dockerRunner, input);
  if (r.stdout) out(r.stdout.endsWith("\n") ? r.stdout : `${r.stdout}\n`);
  if (r.stderr) err(r.stderr.endsWith("\n") ? r.stderr : `${r.stderr}\n`);
  if (r.code === 127) err("docker is not available; start the stack with nearpay-deploy/scripts/up.sh\n");
  return r.code;
}

const isMain = import.meta.url === `file://${process.argv[1]}`;
if (isMain) process.exit(runCli(process.argv.slice(2)));

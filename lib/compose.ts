/**
 * Runs a service's in-container ops CLI (lld/platform.md §3, HANDOFF §7):
 *   docker compose -p nearpay … exec -T <svc>-api /nodejs/bin/node dist/ops.js <command> …
 * with the same project, files, env files and profile as nearpay-deploy/scripts/up.sh. There is no
 * network path to these actions in Stage 1; the console replaces them in Stage 2.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

export interface ComposeTarget {
  deployDir: string;
  project?: string;
}

export function composeExecArgs(t: ComposeTarget, service: string, argv: readonly string[]): string[] {
  const dir = join(t.deployDir, "compose");
  const profile = service.replace(/-(api|worker|tracker|feeds|batcher|ingest|dispatcher|auditor)$/, "");
  return [
    "compose",
    "--project-name",
    t.project ?? "nearpay",
    "--project-directory",
    dir,
    "-f",
    join(dir, "compose.yaml"),
    "-f",
    join(dir, "compose.local.yaml"),
    "--env-file",
    join(dir, "env/local.env"),
    "--env-file",
    join(t.deployDir, ".secrets/public/keys.env"),
    "--profile",
    profile,
    "exec",
    "-T",
    service,
    "/nodejs/bin/node",
    "dist/ops.js",
    ...argv,
  ];
}

export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

export type Runner = (cmd: string, args: readonly string[], input?: string) => RunResult;

export const dockerRunner: Runner = (cmd, args, input) => {
  const r = spawnSync(cmd, args as string[], {
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    ...(input !== undefined ? { input } : {}),
  });
  if (r.error) return { code: 127, stdout: "", stderr: `${cmd}: ${r.error.message}` };
  return { code: r.status ?? 1, stdout: r.stdout, stderr: r.stderr };
};

/** Runs `ops.js` in `service` (optional stdin); parses stdout as JSON when it is JSON. */
export function serviceOps(
  t: ComposeTarget,
  service: string,
  argv: readonly string[],
  run: Runner = dockerRunner,
  input?: string,
) {
  const r =
    input === undefined
      ? run("docker", composeExecArgs(t, service, argv))
      : run("docker", composeExecArgs(t, service, argv), input);
  let json: unknown;
  try {
    json = r.stdout.trim() ? JSON.parse(r.stdout) : undefined;
  } catch {
    json = undefined;
  }
  return { ...r, json };
}

/**
 * Stage 3 client artifacts the E2E suites run (step 3.4): `@nearpay/cli`, `@nearpay/mcp`, `@nearpay/x402` and
 * `@nearpay/agent-signer` 0.2.0. A package installed here (from the local registry) at the minimum version wins;
 * otherwise the build output of the repository's main checkout is used — never its source:
 *
 * | Variable | Default | Used |
 * |---|---|---|
 * | `NP_CLI_BIN` | `<repos>/nearpay-cli/dist/cli.js` | the `nearpay` binary (built with `pnpm build`) |
 * | `NP_AGENTKIT_DIR` | `<repos>/nearpay-agentkit` | `packages/<name>/dist/index.js` (+ `mcp/dist/bin.js`) |
 * | `NP_REPOS_DIR` | the parent of the testbed checkout | sibling repositories |
 *
 * Child processes (CLI, MCP stdio server) get `--import lib/localhost-dns-preload.mjs` so `*.localhost` resolves to
 * loopback, and inherit `NODE_EXTRA_CA_CERTS` (the local CA).
 */
import { existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

type Env = Record<string, string | undefined>;

const here = dirname(fileURLToPath(import.meta.url));
const testbed = resolve(here, "..");
export const PRELOAD = join(here, "localhost-dns-preload.mjs");

export const reposDir = (env: Env = process.env) => resolve(env.NP_REPOS_DIR ?? resolve(testbed, ".."));

const semver = (v: string) => v.split(/[.-]/).slice(0, 3).map(Number);
export function atLeast(version: string, min: string): boolean {
  const [a, b] = [semver(version), semver(min)];
  for (let i = 0; i < 3; i++) {
    if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  }
  return true;
}

/** Version of an installed package, or null. */
export function installedVersion(name: string): string | null {
  try {
    const req = createRequire(join(testbed, "package.json"));
    const pkg = req.resolve(`${name}/package.json`);
    return (JSON.parse(readFileSync(pkg, "utf8")) as { version: string }).version;
  } catch {
    return null;
  }
}

export type AgentkitPackage = "x402" | "agent-signer" | "mcp";
export const AGENTKIT_MIN = "0.2.0";

/** Where a Stage 3 agentkit package is loaded from (an installed package id or a file URL of its dist). */
export function agentkitEntry(pkg: AgentkitPackage, env: Env = process.env): string {
  const name = `@nearpay/${pkg}`;
  const v = installedVersion(name);
  if (v && atLeast(v, AGENTKIT_MIN)) return name;
  const dir = resolve(env.NP_AGENTKIT_DIR ?? join(reposDir(env), "nearpay-agentkit"));
  const entry = join(dir, "packages", pkg, "dist", "index.js");
  if (!existsSync(entry)) {
    throw new Error(
      `${name} ≥ ${AGENTKIT_MIN} is neither installed nor built at ${entry} (build nearpay-agentkit main: pnpm install && pnpm build, or set NP_AGENTKIT_DIR)`,
    );
  }
  return pathToFileURL(entry).href;
}

// biome-ignore lint/suspicious/noExplicitAny: the module shapes come from packages this repo does not depend on yet
export async function loadAgentkit<T = any>(pkg: AgentkitPackage, env: Env = process.env): Promise<T> {
  return (await import(agentkitEntry(pkg, env))) as T;
}

/** `nearpay-mcp` stdio entry (`@nearpay/mcp` bin). */
export function mcpBin(env: Env = process.env): string {
  const entry = agentkitEntry("mcp", env);
  if (entry.startsWith("file:")) return join(dirname(fileURLToPath(entry)), "bin.js");
  const req = createRequire(join(testbed, "package.json"));
  return join(dirname(req.resolve("@nearpay/mcp/package.json")), "dist", "bin.js");
}

export const CLI_MIN = "0.1.0";

/** `nearpay` CLI entry. */
export function cliBin(env: Env = process.env): string {
  if (env.NP_CLI_BIN) return resolve(env.NP_CLI_BIN);
  const v = installedVersion("@nearpay/cli");
  if (v && atLeast(v, CLI_MIN)) {
    const req = createRequire(join(testbed, "package.json"));
    return join(dirname(req.resolve("@nearpay/cli/package.json")), "dist", "cli.js");
  }
  const bin = join(reposDir(env), "nearpay-cli", "dist", "cli.js");
  if (!existsSync(bin)) {
    throw new Error(
      `@nearpay/cli is neither installed nor built at ${bin} (build nearpay-cli main, or set NP_CLI_BIN)`,
    );
  }
  return bin;
}

/** Node arguments for a child process that must resolve `*.localhost`. */
export const nodeArgs = (entry: string, args: readonly string[] = []) => ["--import", PRELOAD, entry, ...args];

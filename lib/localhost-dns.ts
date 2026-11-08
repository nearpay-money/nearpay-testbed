/**
 * `*.localhost` → loopback for Node (RFC 6761 §6.3). Browsers and curl resolve these names themselves,
 * glibc's resolver does not (Linux without nss-myhostname or /etc/hosts entries), so Node's fetch could
 * not reach `api.nearpay.localhost` & co. Imported by the E2E setup and the demo/ops scripts; a name
 * outside `.localhost` goes to the system resolver unchanged.
 */
import dns, { type LookupAddress, type LookupOptions } from "node:dns";

const original = dns.lookup;
export const isLocalhostName = (host: string) => host === "localhost" || host.endsWith(".localhost");

type Callback = (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void;

function lookup(host: string, options: LookupOptions | number | Callback, cb?: Callback): void {
  const callback = (typeof options === "function" ? options : cb) as Callback;
  const opts = typeof options === "object" ? options : typeof options === "number" ? { family: options } : {};
  if (!isLocalhostName(host)) {
    (original as (...a: unknown[]) => void)(host, opts, callback);
    return;
  }
  const v6 = opts.family === 6;
  const address = v6 ? "::1" : "127.0.0.1";
  const family = v6 ? 6 : 4;
  process.nextTick(() => (opts.all ? callback(null, [{ address, family }]) : callback(null, address, family)));
}

let installed = false;
export function installLocalhostDns(): void {
  if (installed) return;
  installed = true;
  (dns as { lookup: unknown }).lookup = lookup;
}

installLocalhostDns();

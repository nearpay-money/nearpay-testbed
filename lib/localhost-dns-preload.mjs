// `node --import <this file>`: the `*.localhost` → loopback lookup of lib/localhost-dns.ts for child processes the
// E2E suites start (the CLI, the MCP server), which do not load the TypeScript shim. Plain JavaScript on purpose.
import dns from "node:dns";

const original = dns.lookup;
dns.lookup = (host, options, cb) => {
  const callback = typeof options === "function" ? options : cb;
  const opts =
    typeof options === "object" && options !== null ? options : typeof options === "number" ? { family: options } : {};
  if (host !== "localhost" && !host.endsWith(".localhost")) return original(host, opts, callback);
  const v6 = opts.family === 6;
  const address = v6 ? "::1" : "127.0.0.1";
  const family = v6 ? 6 : 4;
  process.nextTick(() => (opts.all ? callback(null, [{ address, family }]) : callback(null, address, family)));
};

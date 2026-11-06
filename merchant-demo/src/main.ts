/**
 * Process entry: `node dist/main.js` serves on PORT (3000); `node dist/main.js healthcheck` probes
 * `/healthz` (Docker HEALTHCHECK; the image has no shell or curl).
 */
import { createApp } from "./app.js";
import { readConfig } from "./config.js";

const config = readConfig();
if (process.argv[2] === "healthcheck") {
  try {
    const res = await fetch(`http://127.0.0.1:${config.port}/healthz`, { signal: AbortSignal.timeout(2_000) });
    process.exit(res.ok ? 0 : 1);
  } catch {
    process.exit(1);
  }
}
const server = createApp({ config }).listen(config.port, "0.0.0.0", () => {
  process.stdout.write(
    `${JSON.stringify({ msg: "merchant-demo listening", port: config.port, api: config.apiBase, public_url: config.publicUrl, seeded: config.secrets.secretKey() !== null })}\n`,
  );
});
for (const sig of ["SIGTERM", "SIGINT"] as const) {
  process.on(sig, () => server.close(() => process.exit(0)));
}

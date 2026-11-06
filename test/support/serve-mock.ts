/** Playwright web server: the mock stack + merchant-demo on PORT (default 3917). */
import { startMockStack } from "./mock-stack.js";

const port = process.env.PORT ?? "3917";
const stack = await startMockStack();
const { createApp } = await import("../../merchant-demo/src/app.js");
const { readConfig } = await import("../../merchant-demo/src/config.js");
const config = readConfig({
  NP_ENV: "test",
  NP_PUBLIC_API_URL: stack.url,
  NP_DEMO_SECRET_KEY: "sk_test_mockstack00000000000000000000",
  NP_DEMO_WEBHOOK_SECRET: "whsec_mockstack000000000000000000000000001",
  NP_DEMO_SECRETS_DIR: "/nonexistent",
  NP_DEMO_PUBLIC_URL: `http://127.0.0.1:${port}`,
});
createApp({ config, log: () => {} }).listen(Number(port), "127.0.0.1", () => {
  stack.setWebhookUrl(`http://127.0.0.1:${port}/webhooks`);
  process.stdout.write(`mock stack ${stack.url}, merchant-demo http://127.0.0.1:${port}\n`);
});

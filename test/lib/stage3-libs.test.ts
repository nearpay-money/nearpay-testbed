/** Unit tests of the Stage 3 E2E support code: SSE parsing/consumer, MCP client transports, artifact resolution. */
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  AGENTKIT_MIN,
  agentkitEntry,
  atLeast,
  cliBin,
  installedVersion,
  loadAgentkit,
  mcpBin,
  nodeArgs,
  PRELOAD,
  reposDir,
} from "../../lib/artifacts.js";
import { McpClient, memoryLink, stdioChannel, toolJson } from "../../lib/mcp.js";
import { openEventStream, SseParser } from "../../lib/sse.js";

describe("SseParser", () => {
  it("parses frames across chunks, comments, multi-line data and CRLF", () => {
    const p = new SseParser();
    expect(p.push('retry: 3000\n: hb\nevent: ready\ndata: {"a"')).toEqual([]);
    const f = p.push(":1}\n\nid: evt_1\r\nevent: event\r\ndata: x\r\ndata: y\r\n\r\ndata: plain\n\n");
    expect(f).toEqual([
      { event: "ready", id: null, data: '{"a":1}' },
      { event: "event", id: "evt_1", data: "x\ny" },
      { event: "message", id: null, data: "plain" },
    ]);
    expect(p.comments).toBe(1);
    expect(p.push("field-without-colon\n\n")).toEqual([]);
  });

  it("handles a lone CR line ending and an empty event name", () => {
    const p = new SseParser();
    expect(p.push("event: reset\rdata: {}\r\r")).toEqual([{ event: "reset", id: null, data: "{}" }]);
  });
});

describe("openEventStream", () => {
  it("sends credentials and resume headers, parses events and waits for predicates", async () => {
    let seen: Record<string, string | string[] | undefined> = {};
    let url = "";
    const server = createServer((req, res) => {
      seen = req.headers;
      url = req.url ?? "";
      res.writeHead(200, { "content-type": "text/event-stream" });
      res.write("event: ready\ndata: {}\n\n");
      setTimeout(() => {
        res.write(
          ': hb\n\nid: evt_2\nevent: event\ndata: {"id":"evt_2","type":"invoice.sent","created":1,"livemode":false,"data":{"object":{"id":"in_1"}}}\n\n',
        );
        res.end();
      }, 20);
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    try {
      const s = await openEventStream({
        apiUrl: base,
        key: "sk_test_x",
        types: ["invoice.sent"],
        lastEventId: "evt_1",
        startingAfter: "evt_0",
      });
      expect(s.status).toBe(200);
      const evs = await s.waitFor((e) => e.length === 1, 2000, "one event");
      expect(evs[0]).toMatchObject({ id: "evt_2", type: "invoice.sent" });
      await s.done;
      expect(s.frames.map((f) => f.event)).toEqual(["ready", "event"]);
      expect(seen.authorization).toBe("Bearer sk_test_x");
      expect(seen["last-event-id"]).toBe("evt_1");
      expect(url).toContain("types=invoice.sent");
      expect(url).toContain("starting_after=evt_0");
      await expect(s.waitFor((e) => e.length > 5, 50, "six events")).rejects.toThrow(/timed out/);
      s.close();
    } finally {
      server.close();
    }
  });

  it("reports a refused stream without a body loop", async () => {
    const server = createServer((_req, res) => {
      res.writeHead(400, { "content-type": "application/json" }).end("{}");
    });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
    try {
      const s = await openEventStream({
        apiUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`,
        key: "k",
      });
      expect(s.status).toBe(400);
      await s.done;
      expect(s.events).toEqual([]);
    } finally {
      server.close();
    }
  });
});

describe("McpClient", () => {
  it("speaks JSON-RPC over an in-memory link (initialize, tools/list, tools/call, errors)", async () => {
    const link = memoryLink();
    const sent: unknown[] = [];
    link.server.onmessage = (m) => {
      const msg = m as { id?: number; method: string; params?: { name?: string } };
      sent.push(msg.method);
      if (msg.id === undefined || msg.method === "silent") return;
      const reply = (body: object) => void link.server.send({ jsonrpc: "2.0", id: msg.id, ...body });
      if (msg.method === "initialize") reply({ result: { serverInfo: { name: "nearpay" } } });
      else if (msg.method === "tools/list") reply({ result: { tools: [{ name: "nearpay_get_spending" }] } });
      else if (msg.params?.name === "boom") reply({ error: { code: -32000, message: "boom" } });
      else reply({ result: { content: [{ type: "text", text: '{"ok":true}' }] } });
    };
    let closed = false;
    link.server.onclose = () => {
      closed = true;
    };
    const c = new McpClient(link.client);
    expect(await c.initialize()).toMatchObject({ serverInfo: { name: "nearpay" } });
    expect(await c.tools()).toEqual(["nearpay_get_spending"]);
    expect(toolJson(await c.call("nearpay_get_spending", {}))).toEqual({ ok: true });
    await expect(c.call("boom", {})).rejects.toThrow(/boom/);
    await expect(c.request("silent", {}, 30)).rejects.toThrow(/no answer/);
    expect(sent).toContain("notifications/initialized");
    await c.close();
    expect(closed).toBe(true);
  });

  it("toolJson prefers structured content and falls back to text", () => {
    expect(toolJson({ content: [], structuredContent: { a: 1 } })).toEqual({ a: 1 });
    expect(toolJson({ content: [{ type: "text", text: "not json" }] })).toEqual({ text: "not json" });
  });

  it("runs a stdio server process (newline-delimited JSON)", async () => {
    const dir = mkdtempSync(join(tmpdir(), "np-mcp-"));
    const script = join(dir, "echo.mjs");
    writeFileSync(
      script,
      `import { createInterface } from "node:readline";
       process.stderr.write("started\\n");
       createInterface({ input: process.stdin }).on("line", (l) => {
         const m = JSON.parse(l);
         if (m.id !== undefined) process.stdout.write("garbage\\n\\n" + JSON.stringify({ jsonrpc: "2.0", id: m.id, result: { tools: [{ name: m.method }] } }) + "\\n");
       });`,
    );
    const ch = stdioChannel([script], process.env);
    const c = new McpClient(ch);
    expect(await c.tools()).toEqual(["tools/list"]);
    await c.close();
    await c.close();
    expect(ch.stderr()).toContain("started");
  });
});

describe("artifacts", () => {
  it("compares versions", () => {
    expect(atLeast("0.2.0", "0.2.0")).toBe(true);
    expect(atLeast("0.10.0", "0.2.0")).toBe(true);
    expect(atLeast("0.1.9", "0.2.0")).toBe(false);
    expect(atLeast("1.0.0-rc.1", "0.9.9")).toBe(true);
  });

  it("finds installed packages and falls back to repository build output", async () => {
    expect(installedVersion("@nearpay-money/spec")).toMatch(/^0\.5\./);
    expect(installedVersion("@nearpay-money/does-not-exist")).toBeNull();
    const repos = mkdtempSync(join(tmpdir(), "np-repos-"));
    expect(reposDir({ NP_REPOS_DIR: repos })).toBe(repos);
    expect(() => agentkitEntry("mcp", { NP_REPOS_DIR: repos })).toThrow(/neither installed nor built/);
    expect(() => cliBin({ NP_REPOS_DIR: repos })).toThrow(/neither installed nor built/);
    expect(cliBin({ NP_CLI_BIN: "/x/cli.js" })).toBe("/x/cli.js");

    for (const pkg of ["mcp", "x402"]) {
      mkdirSync(join(repos, "nearpay-agentkit/packages", pkg, "dist"), { recursive: true });
      writeFileSync(join(repos, "nearpay-agentkit/packages", pkg, "dist/index.js"), `export const name = "${pkg}";`);
    }
    mkdirSync(join(repos, "nearpay-cli/dist"), { recursive: true });
    writeFileSync(join(repos, "nearpay-cli/dist/cli.js"), "");
    const env = { NP_REPOS_DIR: repos };
    // the installed @nearpay-money/x402 (0.3.x) meets the Stage 3 minimum, so the package wins over build output
    expect(atLeast(installedVersion("@nearpay-money/x402") ?? "0.0.0", AGENTKIT_MIN)).toBe(true);
    expect(agentkitEntry("x402", env)).toBe("@nearpay-money/x402");
    // @nearpay-money/mcp is not installed here, so the repository build output is used
    expect(installedVersion("@nearpay-money/mcp")).toBeNull();
    expect(agentkitEntry("mcp", env)).toMatch(/^file:.*packages\/mcp\/dist\/index\.js$/);
    expect((await loadAgentkit("mcp", env)).name).toBe("mcp");
    expect(mcpBin(env)).toBe(join(repos, "nearpay-agentkit/packages/mcp/dist/bin.js"));
    expect(cliBin(env)).toBe(join(repos, "nearpay-cli/dist/cli.js"));
    expect(nodeArgs("/e.js", ["a"])).toEqual(["--import", PRELOAD, "/e.js", "a"]);
  });
});

/**
 * A minimal MCP client for the E2E suites (JSON-RPC 2.0, MCP 2025-06-18): `initialize` → `notifications/initialized`
 * → `tools/list` / `tools/call`. Two transports: the `nearpay-mcp` stdio binary (newline-delimited JSON, exactly how
 * an agent host runs it) and an in-process link to an embedded `createNearPayMcpServer(...)` (a server given a
 * test-mode origin signer). No MCP SDK dependency: the wire format is small and the suites assert on it.
 */
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { createInterface } from "node:readline";

type Json = Record<string, unknown>;
interface Message {
  jsonrpc: "2.0";
  id?: number | string;
  method?: string;
  params?: unknown;
  result?: unknown;
  error?: { code: number; message: string; data?: unknown };
}

export interface Channel {
  send(m: Message): void;
  onMessage(cb: (m: Message) => void): void;
  close(): Promise<void>;
}

export interface ToolResult {
  content: { type: string; text?: string }[];
  structuredContent?: Json;
  isError?: boolean;
}

export class McpClient {
  private next = 1;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  constructor(private readonly ch: Channel) {
    ch.onMessage((m) => {
      if (m.id === undefined || m.method) return; // server requests/notifications are not used by these tools
      const p = this.pending.get(Number(m.id));
      if (!p) return;
      this.pending.delete(Number(m.id));
      if (m.error) p.reject(new Error(`MCP error ${m.error.code}: ${m.error.message}`));
      else p.resolve(m.result);
    });
  }

  request<T = unknown>(method: string, params: unknown = {}, timeoutMs = 180_000): Promise<T> {
    const id = this.next++;
    return new Promise<T>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`MCP ${method}: no answer within ${timeoutMs} ms`));
      }, timeoutMs);
      this.pending.set(id, {
        resolve: (v) => {
          clearTimeout(timer);
          resolve(v as T);
        },
        reject: (e) => {
          clearTimeout(timer);
          reject(e);
        },
      });
      this.ch.send({ jsonrpc: "2.0", id, method, params });
    });
  }

  async initialize(): Promise<Json> {
    const r = await this.request<Json>("initialize", {
      protocolVersion: "2025-06-18",
      capabilities: {},
      clientInfo: { name: "nearpay-testbed", version: "0.1.0" },
    });
    this.ch.send({ jsonrpc: "2.0", method: "notifications/initialized" });
    return r;
  }

  async tools(): Promise<string[]> {
    const r = await this.request<{ tools: { name: string }[] }>("tools/list");
    return r.tools.map((t) => t.name);
  }

  call(name: string, args: Json, timeoutMs?: number): Promise<ToolResult> {
    return this.request<ToolResult>("tools/call", { name, arguments: args }, timeoutMs);
  }

  close(): Promise<void> {
    return this.ch.close();
  }
}

/** The tool's JSON result (structured content, else the first text block parsed as JSON, else the text). */
export function toolJson<T = Json>(r: ToolResult): T {
  if (r.structuredContent) return r.structuredContent as T;
  const text = r.content.find((c) => c.type === "text")?.text ?? "";
  try {
    return JSON.parse(text) as T;
  } catch {
    return { text } as T;
  }
}

/** Runs `node <args>` as an MCP stdio server; stderr is kept for failure messages. */
export function stdioChannel(args: readonly string[], env: NodeJS.ProcessEnv): Channel & { stderr: () => string } {
  const child: ChildProcessWithoutNullStreams = spawn(process.execPath, args as string[], {
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let err = "";
  child.stderr.on("data", (d) => {
    err = (err + String(d)).slice(-20_000);
  });
  const listeners: ((m: Message) => void)[] = [];
  createInterface({ input: child.stdout }).on("line", (line) => {
    if (!line.trim()) return;
    let m: Message;
    try {
      m = JSON.parse(line) as Message;
    } catch {
      return;
    }
    for (const l of listeners) l(m);
  });
  return {
    send: (m) => child.stdin.write(`${JSON.stringify(m)}\n`),
    onMessage: (cb) => listeners.push(cb),
    stderr: () => err,
    close: () =>
      new Promise<void>((resolve) => {
        if (child.exitCode !== null) return resolve();
        child.once("exit", () => resolve());
        child.stdin.end();
        setTimeout(() => child.kill("SIGTERM"), 2000).unref();
      }),
  };
}

/** The server side of an in-process link: the MCP SDK `Transport` shape (`start/send/close` + callbacks). */
export interface ServerTransport {
  start(): Promise<void>;
  send(message: unknown): Promise<void>;
  close(): Promise<void>;
  onmessage?: (message: unknown) => void;
  onclose?: () => void;
  onerror?: (e: Error) => void;
}

/** A linked pair: give `server` to `McpServer.connect(...)`, wrap `client` in `McpClient`. */
export function memoryLink(): { server: ServerTransport; client: Channel } {
  const toClient: ((m: Message) => void)[] = [];
  const server: ServerTransport = {
    start: async () => {},
    send: async (m) => {
      queueMicrotask(() => {
        for (const l of toClient) l(m as Message);
      });
    },
    close: async () => {
      server.onclose?.();
    },
  };
  return {
    server,
    client: {
      send: (m) => queueMicrotask(() => server.onmessage?.(m)),
      onMessage: (cb) => toClient.push(cb),
      close: () => server.close(),
    },
  };
}

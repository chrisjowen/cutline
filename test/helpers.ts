import { request as httpRequest } from "node:http";
import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "vitest";
import { startServer, type RunningServer, type ServerOptions } from "../src/server/app.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()?.();
});

export async function tempDir(prefix = "cutline-test-"): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)));
  cleanups.push(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

/** Starts a server on a free port with its config, home and default root inside a temp folder. */
export async function testServer(overrides: Partial<ServerOptions> = {}): Promise<RunningServer & { home: string }> {
  const home = overrides.home ?? (await tempDir());
  const server = await startServer({
    port: 0,
    configDir: join(home, ".config", "cutline"),
    defaultRoot: join(home, "Movies", "Cutline"),
    home,
    uiDir: null,
    picker: null,
    reveal: () => {},
    ...overrides,
  });
  cleanups.push(() => server.close());
  return { ...server, home };
}

export interface TestResponse {
  status: number;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
  json<T = Record<string, unknown>>(): T;
}

/**
 * A raw HTTP request, so tests can send any Host, Origin or Cookie header
 * (fetch does not allow setting Host).
 */
export function send(
  port: number,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: unknown },
): Promise<TestResponse> {
  return new Promise((resolve, reject) => {
    const payload = options.body === undefined ? undefined : JSON.stringify(options.body);
    const req = httpRequest(
      {
        host: "127.0.0.1",
        port,
        method: options.method ?? "GET",
        path: options.path,
        headers: {
          Host: `127.0.0.1:${port}`,
          ...(payload ? { "Content-Type": "application/json" } : {}),
          ...options.headers,
        },
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          const body = Buffer.concat(chunks);
          resolve({
            status: res.statusCode ?? 0,
            headers: res.headers,
            body,
            json: <T>() => JSON.parse(body.toString("utf8")) as T,
          });
        });
      },
    );
    req.on("error", reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/** send() with the server's token, as the UI would after the launch link. */
export function api(
  server: RunningServer,
  method: string,
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<TestResponse> {
  return send(server.port, { method, path, body, headers: { "X-Cutline-Token": server.token, ...headers } });
}

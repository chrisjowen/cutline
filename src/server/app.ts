// The Cutline HTTP server: JSON API, SSE change events, media with Range,
// and the built UI. Bound to 127.0.0.1 only.
import { execFile } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import { PatchRequestSchema } from "../shared/patch.js";
import { AppConfig } from "./app-config.js";
import { HttpError } from "./errors.js";
import { exists } from "./fsutil.js";
import { listFolders } from "./fs-list.js";
import { resolveInside, serveFile } from "./media.js";
import type { Picker } from "./picker.js";
import { ProjectRegistry, summary } from "./projects.js";
import { checkRequestOrigin, checkToken, sessionCookie, tokensEqual, type SecurityContext } from "./security.js";

export interface ServerOptions {
  /** 0 picks a free port. */
  port: number;
  token?: string;
  configDir: string;
  defaultRoot: string;
  home?: string;
  uiDir?: string | null;
  picker?: Picker | null;
  version?: string;
  isAlive?: (pid: number) => boolean;
  /** Reveals a path in Finder; replaced in tests. */
  reveal?: (path: string) => void;
}

export interface RunningServer {
  server: Server;
  port: number;
  token: string;
  url: string;
  launchUrl: string;
  projects: ProjectRegistry;
  close(): Promise<void>;
}

type Params = Record<string, string>;
type Handler = (ctx: { req: IncomingMessage; res: ServerResponse; params: Params; url: URL }) => Promise<unknown>;
interface Route {
  method: string;
  pattern: RegExp;
  keys: string[];
  handler: Handler;
}

const BODY_LIMIT = 1024 * 1024;
const SSE_HEARTBEAT_MS = 20_000;

function route(method: string, path: string, handler: Handler): Route {
  const keys: string[] = [];
  const source = path.replace(/:(\w+)/g, (_, key: string) => {
    keys.push(key);
    return "([^/]+)";
  });
  return { method, pattern: new RegExp(`^${source}$`), keys, handler };
}

async function readJson<T>(req: IncomingMessage, schema: z.ZodType<T>): Promise<T> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > BODY_LIMIT) throw new HttpError(413, "too-large", "request body is too large");
    chunks.push(chunk as Buffer);
  }
  let value: unknown = {};
  const text = Buffer.concat(chunks).toString("utf8");
  if (text.trim()) {
    try {
      value = JSON.parse(text);
    } catch {
      throw new HttpError(400, "bad-json", "request body is not valid JSON");
    }
  }
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(400, "bad-request", "request body is not valid", {
      issues: parsed.error.issues.map((issue) => ({ path: issue.path.join("/"), message: issue.message })),
    });
  }
  return parsed.data;
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Content-Length": Buffer.byteLength(text),
    "Cache-Control": "no-store",
  });
  res.end(text);
}

function sendError(res: ServerResponse, error: HttpError): void {
  if (res.headersSent) {
    res.destroy();
    return;
  }
  sendJson(res, error.status, { error: { code: error.code, message: error.message, ...error.details } });
}

const CreateSchema = z.strictObject({
  name: z.string().min(1).max(200),
  path: z.string().min(1).optional(),
  parent: z.string().min(1).optional(),
});
const OpenSchema = z.strictObject({ path: z.string().min(1), force: z.boolean().optional() });
const PathSchema = z.strictObject({ path: z.string().min(1) });
const PickSchema = z.strictObject({
  kind: z.enum(["folder", "file"]),
  prompt: z.string().max(200).optional(),
  defaultLocation: z.string().optional(),
});
const RestoreSchema = z.strictObject({ baseRev: z.number().int().positive().optional() });
const Empty = z.strictObject({});

const UI_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "media-src 'self' blob:",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join("; ");

function defaultReveal(path: string): void {
  if (process.platform === "darwin") execFile("open", ["-R", path], () => {});
}

export async function startServer(options: ServerOptions): Promise<RunningServer> {
  const token = options.token ?? randomBytes(24).toString("base64url");
  const home = options.home ?? homedir();
  const config = new AppConfig(options.configDir);
  const instance = randomUUID();
  const security: SecurityContext = { port: 0, token };
  const reveal = options.reveal ?? defaultReveal;
  const picker = options.picker === undefined ? null : options.picker;
  let pickerBusy = false;

  // The lock records the port so a second server can say where the project is open.
  const owner = { pid: process.pid, port: 0, instance };
  const projects = new ProjectRegistry({
    config,
    owner,
    defaultRoot: options.defaultRoot,
    home,
    isAlive: options.isAlive,
  });

  const api: Route[] = [
    route("GET", "/api/info", async () => ({
      name: "cutline",
      version: options.version ?? "0.0.0",
      port: security.port,
      platform: process.platform,
      defaultRoot: projects.defaultRoot,
      home,
      picker: picker !== null,
    })),

    route("GET", "/api/projects/recent", async () => {
      const recents = await config.recents();
      return {
        projects: await Promise.all(
          recents.map(async (entry) => ({ ...entry, exists: await exists(join(entry.path, "cutline.json")) })),
        ),
      };
    }),
    route("POST", "/api/projects/recent/remove", async ({ req }) => {
      const { path } = await readJson(req, PathSchema);
      await config.removeRecent(path);
      return { ok: true };
    }),
    route("GET", "/api/projects/open", async () => ({ projects: projects.list() })),
    route("POST", "/api/projects", async ({ req, res }) => {
      const project = await projects.create(await readJson(req, CreateSchema));
      res.statusCode = 201;
      return { project: summary(project) };
    }),
    route("POST", "/api/projects/open", async ({ req }) => {
      const { path, force } = await readJson(req, OpenSchema);
      return { project: summary(await projects.openPath(path, { force })) };
    }),

    route("POST", "/api/pick", async ({ req }) => {
      const body = await readJson(req, PickSchema);
      if (!picker) throw new HttpError(501, "picker-unavailable", "the native dialog is only available on macOS");
      if (pickerBusy) throw new HttpError(409, "picker-busy", "a dialog is already open");
      pickerBusy = true;
      try {
        let defaultLocation = body.defaultLocation;
        if (defaultLocation && !(await exists(defaultLocation))) defaultLocation = undefined;
        const prompt = body.prompt ?? (body.kind === "folder" ? "Choose a folder" : "Choose a file");
        return await picker(body.kind, { prompt, defaultLocation });
      } finally {
        pickerBusy = false;
      }
    }),
    route("GET", "/api/fs/list", async ({ url }) => listFolders(url.searchParams.get("path") || home, home)),

    route("GET", "/api/p/:pid/manifest", async ({ params }) => ({
      manifest: projects.get(params.pid as string).store.manifest,
    })),
    route("PATCH", "/api/p/:pid/manifest", async ({ req, params }) => {
      const project = projects.get(params.pid as string);
      const { baseRev, ops } = await readJson(req, PatchRequestSchema);
      const manifest = await project.store.patch(baseRev, ops);
      return { rev: manifest.rev, manifest };
    }),
    route("GET", "/api/p/:pid/snapshots", async ({ params }) => ({
      snapshots: await projects.get(params.pid as string).store.listSnapshots(),
    })),
    route("POST", "/api/p/:pid/snapshots/:rev/restore", async ({ req, params }) => {
      const project = projects.get(params.pid as string);
      const rev = Number(params.rev);
      if (!Number.isInteger(rev) || rev < 1) throw new HttpError(400, "bad-rev", "rev must be a positive integer");
      const { baseRev } = await readJson(req, RestoreSchema);
      const manifest = await project.store.restore(rev, baseRev);
      return { rev: manifest.rev, manifest };
    }),
    route("POST", "/api/p/:pid/reveal", async ({ req, params }) => {
      await readJson(req, Empty);
      reveal(projects.get(params.pid as string).root);
      return { ok: true };
    }),
    route("POST", "/api/p/:pid/close", async ({ req, params }) => {
      await readJson(req, Empty);
      await projects.close(params.pid as string);
      return { ok: true };
    }),
    route("GET", "/api/p/:pid/events", async ({ req, res, params }) => {
      const project = projects.get(params.pid as string);
      res.writeHead(200, {
        "Content-Type": "text/event-stream; charset=utf-8",
        "Cache-Control": "no-store",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      });
      const send = (event: string, data: unknown) => res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
      res.write("retry: 2000\n\n");
      send("hello", { rev: project.store.rev });
      const onChange = ({ rev }: { rev: number }) => send("manifest", { rev });
      project.store.on("change", onChange);
      const offClosed = projects.onClosed(({ id }) => {
        if (id === project.id) {
          send("closed", { id });
          res.end();
        }
      });
      const heartbeat = setInterval(() => res.write(": ping\n\n"), SSE_HEARTBEAT_MS);
      const cleanup = () => {
        clearInterval(heartbeat);
        project.store.off("change", onChange);
        offClosed();
      };
      req.on("close", cleanup);
      return undefined;
    }),
  ];

  async function handleMedia(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method", "method not allowed");
    const match = /^\/media\/([^/]+)\/(.+)$/.exec(url.pathname);
    if (!match) throw new HttpError(404, "not-found", "no such file");
    const project = projects.get(decodeURIComponent(match[1] as string));
    let relative: string;
    try {
      relative = decodeURIComponent(match[2] as string);
    } catch {
      throw new HttpError(400, "bad-path", "path is not valid");
    }
    const file = await resolveInside(project.root, relative);
    await serveFile(req, res, file, { "Cache-Control": "no-cache" });
  }

  async function handleUi(req: IncomingMessage, res: ServerResponse, url: URL): Promise<void> {
    if (req.method !== "GET" && req.method !== "HEAD") throw new HttpError(405, "method", "method not allowed");
    const launchToken = url.searchParams.get("token");
    if (launchToken !== null) {
      if (!tokensEqual(launchToken, token)) throw new HttpError(403, "bad-token", "that launch link is out of date");
      url.searchParams.delete("token");
      res.writeHead(302, {
        "Set-Cookie": sessionCookie(security.port, token),
        Location: url.pathname + url.search,
        "Cache-Control": "no-store",
        "Referrer-Policy": "no-referrer",
      });
      res.end();
      return;
    }
    const uiHeaders = { "Content-Security-Policy": UI_CSP, "Referrer-Policy": "no-referrer" };
    if (!options.uiDir) {
      res.writeHead(503, { "Content-Type": "text/plain; charset=utf-8", ...uiHeaders });
      res.end("The Cutline UI is not built. Run `npm run build`, then start cutline again.\n");
      return;
    }
    const path = url.pathname === "/" ? "index.html" : url.pathname.slice(1);
    let file: string;
    try {
      file = await resolveInside(options.uiDir, decodeURIComponent(path));
    } catch {
      file = join(options.uiDir, "index.html");
    }
    const cache = file.endsWith("index.html") ? "no-cache" : "public, max-age=31536000, immutable";
    await serveFile(req, res, file, { ...uiHeaders, "Cache-Control": cache });
  }

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    res.setHeader("X-Content-Type-Options", "nosniff");
    const origin = checkRequestOrigin(req, security);
    if (!origin.ok) throw new HttpError(origin.status, origin.code, origin.message);
    const url = new URL(req.url ?? "/", `http://127.0.0.1:${security.port}`);
    const isApi = url.pathname.startsWith("/api/");
    const isMedia = url.pathname.startsWith("/media/");
    if (!isApi && !isMedia) return handleUi(req, res, url);
    const session = checkToken(req, security);
    if (!session.ok) throw new HttpError(session.status, session.code, session.message);
    if (isMedia) return handleMedia(req, res, url);
    for (const candidate of api) {
      const match = candidate.pattern.exec(url.pathname);
      if (!match) continue;
      if (candidate.method !== req.method) continue;
      const params: Params = {};
      candidate.keys.forEach((key, index) => {
        params[key] = decodeURIComponent(match[index + 1] as string);
      });
      const result = await candidate.handler({ req, res, params, url });
      if (result !== undefined) sendJson(res, res.statusCode, result);
      return;
    }
    const known = api.some((candidate) => candidate.pattern.test(url.pathname));
    throw known ? new HttpError(405, "method", "method not allowed") : new HttpError(404, "not-found", "no such endpoint");
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      if (error instanceof HttpError) return sendError(res, error);
      console.error("cutline: request failed:", error);
      sendError(res, new HttpError(500, "internal", (error as Error).message ?? "internal error"));
    });
  });

  await new Promise<void>((resolveListen, reject) => {
    server.once("error", reject);
    server.listen(options.port, "127.0.0.1", () => {
      server.off("error", reject);
      resolveListen();
    });
  });
  const port = (server.address() as AddressInfo).port;
  security.port = port;
  owner.port = port;

  const url = `http://127.0.0.1:${port}/`;
  return {
    server,
    port,
    token,
    url,
    launchUrl: `${url}?token=${encodeURIComponent(token)}`,
    projects,
    async close() {
      await projects.closeAll();
      server.closeAllConnections();
      await new Promise<void>((resolveClose) => server.close(() => resolveClose()));
    },
  };
}

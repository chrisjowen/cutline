// Thin client for the cutline server API. The session cookie set by the
// launch link authenticates every call.
import type { Manifest } from "../shared/manifest.js";
import type { PatchOp } from "../shared/patch.js";

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly details: Record<string, unknown>,
  ) {
    super(message);
    this.name = "ApiError";
  }
}

async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
  const res = await fetch(path, {
    method,
    headers: body === undefined ? {} : { "Content-Type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const data = (await res.json().catch(() => ({}))) as { error?: { code: string; message: string } };
  if (!res.ok) {
    const { code = "error", message = res.statusText, ...details } = data.error ?? {};
    throw new ApiError(res.status, code, message, details);
  }
  return data as T;
}

export interface Info {
  version: string;
  port: number;
  platform: string;
  defaultRoot: string;
  home: string;
  picker: boolean;
}

export interface RecentProject {
  id: string;
  name: string;
  path: string;
  openedAt: string;
  exists: boolean;
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  rev: number;
}

export interface FolderListing {
  path: string;
  parent: string | null;
  isProject: boolean;
  folders: { name: string; path: string; isProject: boolean }[];
}

export type PickResult = { path: string } | { cancelled: true };

export const api = {
  info: () => call<Info>("GET", "/api/info"),
  recents: () => call<{ projects: RecentProject[] }>("GET", "/api/projects/recent").then((r) => r.projects),
  removeRecent: (path: string) => call("POST", "/api/projects/recent/remove", { path }),
  create: (body: { name: string; path?: string; parent?: string }) =>
    call<{ project: ProjectSummary }>("POST", "/api/projects", body).then((r) => r.project),
  open: (path: string, force = false) =>
    call<{ project: ProjectSummary }>("POST", "/api/projects/open", force ? { path, force } : { path }).then(
      (r) => r.project,
    ),
  pick: (kind: "folder" | "file", prompt: string, defaultLocation?: string) =>
    call<PickResult>("POST", "/api/pick", { kind, prompt, ...(defaultLocation ? { defaultLocation } : {}) }),
  listFolders: (path?: string) =>
    call<FolderListing>("GET", `/api/fs/list${path ? `?path=${encodeURIComponent(path)}` : ""}`),
  manifest: (pid: string) =>
    call<{ manifest: Manifest }>("GET", `/api/p/${encodeURIComponent(pid)}/manifest`).then((r) => r.manifest),
  patch: (pid: string, baseRev: number, ops: PatchOp[]) =>
    call<{ rev: number; manifest: Manifest }>("PATCH", `/api/p/${encodeURIComponent(pid)}/manifest`, {
      baseRev,
      ops,
    }).then((r) => r.manifest),
  reveal: (pid: string) => call("POST", `/api/p/${encodeURIComponent(pid)}/reveal`, {}),
  close: (pid: string) => call("POST", `/api/p/${encodeURIComponent(pid)}/close`, {}),
  events: (pid: string) => new EventSource(`/api/p/${encodeURIComponent(pid)}/events`),
};

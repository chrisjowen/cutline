import { request as httpRequest } from "node:http";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { RunningServer } from "../src/server/app.js";
import { exists } from "../src/server/fsutil.js";
import { lockPath } from "../src/server/lock.js";
import { api, testServer } from "./helpers.js";

interface Summary {
  id: string;
  name: string;
  root: string;
  rev: number;
}

async function create(server: RunningServer, body: Record<string, unknown>): Promise<Summary> {
  const res = await api(server, "POST", "/api/projects", body);
  expect(res.status).toBe(201);
  return res.json<{ project: Summary }>().project;
}

/** Collects SSE events until `count` named events have arrived. */
function sse(server: RunningServer, path: string, count: number): Promise<{ event: string; data: unknown }[]> {
  return new Promise((resolve, reject) => {
    const events: { event: string; data: unknown }[] = [];
    const req = httpRequest(
      { host: "127.0.0.1", port: server.port, path, headers: { "X-Cutline-Token": server.token } },
      (res) => {
        let buffer = "";
        res.setEncoding("utf8");
        res.on("data", (chunk: string) => {
          buffer += chunk;
          let end: number;
          while ((end = buffer.indexOf("\n\n")) >= 0) {
            const block = buffer.slice(0, end);
            buffer = buffer.slice(end + 2);
            const event = /^event: (.+)$/m.exec(block)?.[1];
            const data = /^data: (.+)$/m.exec(block)?.[1];
            if (event && data) events.push({ event, data: JSON.parse(data) });
            if (events.length >= count) {
              req.destroy();
              resolve(events);
            }
          }
        });
      },
    );
    req.on("error", (error) => {
      if (events.length < count) reject(error);
    });
    req.end();
  });
}

describe("projects API", () => {
  it("creates a project under the default root and lists it in recents", async () => {
    const server = await testServer();
    const project = await create(server, { name: "How to use Wheelhouse" });
    expect(project.root).toBe(join(server.home, "Movies", "Cutline", "How to use Wheelhouse"));
    expect(await exists(join(project.root, "cutline.json"))).toBe(true);
    expect(await exists(lockPath(project.root))).toBe(true);
    const recents = (await api(server, "GET", "/api/projects/recent")).json<{ projects: unknown[] }>().projects;
    expect(recents).toEqual([expect.objectContaining({ id: project.id, path: project.root, exists: true })]);
  });

  it("creates a project in a chosen parent folder or exact empty folder", async () => {
    const server = await testServer();
    const parent = join(server.home, "Elsewhere");
    expect((await create(server, { name: "A / B", parent })).root).toBe(join(parent, "A - B"));
    const exact = join(server.home, "Empty");
    await mkdir(exact);
    await writeFile(join(exact, ".DS_Store"), "");
    expect((await create(server, { name: "Exact", path: exact })).root).toBe(exact);
  });

  it("refuses to create a project in a folder that already has files", async () => {
    const server = await testServer();
    const busy = join(server.home, "Busy");
    await mkdir(busy);
    await writeFile(join(busy, "notes.txt"), "hi");
    const res = await api(server, "POST", "/api/projects", { name: "Busy", path: busy });
    expect(res.status).toBe(409);
    expect(res.json().error).toMatchObject({ code: "not-empty" });
  });

  it("offers to make an empty folder a project when opening it", async () => {
    const server = await testServer();
    const empty = join(server.home, "Fresh");
    await mkdir(empty);
    const res = await api(server, "POST", "/api/projects/open", { path: empty });
    expect(res.status).toBe(409);
    expect(res.json().error).toMatchObject({ code: "not-a-project", empty: true, suggestedName: "Fresh" });
  });

  it("reopens a project after a restart, at the revision it was left at", async () => {
    const home = (await testServer()).home;
    const first = await testServer({ home });
    const project = await create(first, { name: "Resume me" });
    const patched = await api(first, "PATCH", `/api/p/${project.id}/manifest`, {
      baseRev: 1,
      ops: [{ op: "replace", path: "/product", value: "Wheelhouse" }],
    });
    expect(patched.json()).toMatchObject({ rev: 2 });
    await first.close();
    expect(await exists(lockPath(project.root))).toBe(false);

    const second = await testServer({ home });
    const recents = (await api(second, "GET", "/api/projects/recent")).json<{ projects: { path: string }[] }>();
    expect(recents.projects[0]?.path).toBe(project.root);
    const reopened = await api(second, "POST", "/api/projects/open", { path: project.root });
    expect(reopened.json()).toMatchObject({ project: { id: project.id, rev: 2 } });
    const manifest = (await api(second, "GET", `/api/p/${project.id}/manifest`)).json<{
      manifest: { product: string };
    }>();
    expect(manifest.manifest.product).toBe("Wheelhouse");
  });

  it("refuses a stale patch with 409 and the current revision", async () => {
    const server = await testServer();
    const project = await create(server, { name: "Conflicts" });
    const body = { baseRev: 1, ops: [{ op: "replace", path: "/name", value: "One" }] };
    expect((await api(server, "PATCH", `/api/p/${project.id}/manifest`, body)).status).toBe(200);
    const stale = await api(server, "PATCH", `/api/p/${project.id}/manifest`, body);
    expect(stale.status).toBe(409);
    expect(stale.json().error).toMatchObject({ code: "rev-conflict", rev: 2 });
  });

  it("keeps the recents name in step with renames", async () => {
    const server = await testServer();
    const project = await create(server, { name: "Old name" });
    await api(server, "PATCH", `/api/p/${project.id}/manifest`, {
      baseRev: 1,
      ops: [{ op: "replace", path: "/name", value: "New name" }],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const recents = JSON.parse(await readFile(join(server.home, ".config", "cutline", "recents.json"), "utf8"));
    expect(recents.projects[0].name).toBe("New name");
  });

  it("pushes new revisions over SSE", async () => {
    const server = await testServer();
    const project = await create(server, { name: "Live" });
    const events = sse(server, `/api/p/${project.id}/events`, 2);
    await new Promise((resolve) => setTimeout(resolve, 50));
    await api(server, "PATCH", `/api/p/${project.id}/manifest`, {
      baseRev: 1,
      ops: [{ op: "replace", path: "/name", value: "Live 2" }],
    });
    expect(await events).toEqual([
      { event: "hello", data: { rev: 1 } },
      { event: "manifest", data: { rev: 2 } },
    ]);
  });

  it("lists and restores snapshots through the API", async () => {
    const server = await testServer();
    const project = await create(server, { name: "Undo" });
    await api(server, "PATCH", `/api/p/${project.id}/manifest`, {
      baseRev: 1,
      ops: [{ op: "replace", path: "/name", value: "Changed" }],
    });
    const list = (await api(server, "GET", `/api/p/${project.id}/snapshots`)).json<{ snapshots: { rev: number }[] }>();
    expect(list.snapshots.map((s) => s.rev)).toEqual([1]);
    const restored = await api(server, "POST", `/api/p/${project.id}/snapshots/1/restore`, { baseRev: 2 });
    expect(restored.json()).toMatchObject({ rev: 3, manifest: { name: "Undo" } });
  });

  it("stops a second server from opening a project the first has open", async () => {
    const home = (await testServer()).home;
    const first = await testServer({ home });
    const project = await create(first, { name: "Shared" });
    const second = await testServer({ home });
    const refused = await api(second, "POST", "/api/projects/open", { path: project.root });
    expect(refused.status).toBe(423);
    expect(refused.json().error).toMatchObject({ code: "locked", holder: { port: first.port } });

    await api(first, "POST", `/api/p/${project.id}/close`, {});
    expect(await exists(lockPath(project.root))).toBe(false);
    expect((await api(second, "POST", "/api/projects/open", { path: project.root })).status).toBe(200);
  });

  it("uses the injected native picker and reports when there is none", async () => {
    const chosen = await testServer({ picker: async () => ({ path: "/Users/someone/Movies" }) });
    expect((await api(chosen, "POST", "/api/pick", { kind: "folder" })).json()).toEqual({
      path: "/Users/someone/Movies",
    });
    const none = await testServer({ picker: null });
    expect((await api(none, "POST", "/api/pick", { kind: "folder" })).status).toBe(501);
  });

  it("browses folders inside home only", async () => {
    const server = await testServer();
    await create(server, { name: "Listed" });
    const res = await api(server, "GET", `/api/fs/list?path=${encodeURIComponent(join(server.home, "Movies", "Cutline"))}`);
    expect(res.json()).toMatchObject({ folders: [{ name: "Listed", isProject: true }] });
    expect((await api(server, "GET", "/api/fs/list?path=%2Fetc")).status).toBe(403);
  });
});

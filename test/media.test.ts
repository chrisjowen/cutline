import { mkdir, symlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseRange } from "../src/server/media.js";
import { api, send, tempDir, testServer } from "./helpers.js";

describe("parseRange", () => {
  it("parses single byte ranges", () => {
    expect(parseRange("bytes=0-99", 1000)).toEqual({ start: 0, end: 99 });
    expect(parseRange("bytes=900-", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-100", 1000)).toEqual({ start: 900, end: 999 });
    expect(parseRange("bytes=-5000", 1000)).toEqual({ start: 0, end: 999 });
    expect(parseRange("bytes=990-5000", 1000)).toEqual({ start: 990, end: 999 });
  });

  it("reports unsatisfiable ranges", () => {
    expect(parseRange("bytes=1000-", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=-0", 1000)).toBe("unsatisfiable");
    expect(parseRange("bytes=0-", 0)).toBe("unsatisfiable");
  });

  it("ignores absent, malformed and multi-part ranges", () => {
    expect(parseRange(undefined, 1000)).toBeNull();
    expect(parseRange("bytes=-", 1000)).toBeNull();
    expect(parseRange("items=0-1", 1000)).toBeNull();
    expect(parseRange("bytes=5-1", 1000)).toBeNull();
    expect(parseRange("bytes=0-1,5-6", 1000)).toBeNull();
  });
});

async function projectWithFile() {
  const server = await testServer();
  const created = await api(server, "POST", "/api/projects", { name: "Media" });
  const { project } = created.json<{ project: { id: string; root: string } }>();
  const bytes = Buffer.alloc(1000);
  for (let i = 0; i < bytes.length; i++) bytes[i] = i % 251;
  await mkdir(join(project.root, "sources", "rec-1"), { recursive: true });
  await writeFile(join(project.root, "sources", "rec-1", "screen.mp4"), bytes);
  return { server, project, bytes, path: `/media/${project.id}/sources/rec-1/screen.mp4` };
}

describe("media serving", () => {
  it("serves a whole file and advertises range support", async () => {
    const { server, bytes, path } = await projectWithFile();
    const res = await api(server, "GET", path);
    expect(res.status).toBe(200);
    expect(res.headers["accept-ranges"]).toBe("bytes");
    expect(res.headers["content-type"]).toBe("video/mp4");
    expect(res.headers["content-length"]).toBe("1000");
    expect(res.body.equals(bytes)).toBe(true);
  });

  it("serves byte ranges with 206 and Content-Range", async () => {
    const { server, bytes, path } = await projectWithFile();
    const first = await api(server, "GET", path, undefined, { Range: "bytes=0-99" });
    expect(first.status).toBe(206);
    expect(first.headers["content-range"]).toBe("bytes 0-99/1000");
    expect(first.headers["content-length"]).toBe("100");
    expect(first.body.equals(bytes.subarray(0, 100))).toBe(true);

    const middle = await api(server, "GET", path, undefined, { Range: "bytes=500-509" });
    expect(middle.body.equals(bytes.subarray(500, 510))).toBe(true);

    const suffix = await api(server, "GET", path, undefined, { Range: "bytes=-10" });
    expect(suffix.headers["content-range"]).toBe("bytes 990-999/1000");
    expect(suffix.body.equals(bytes.subarray(990))).toBe(true);
  });

  it("answers 416 for a range past the end", async () => {
    const { server, path } = await projectWithFile();
    const res = await api(server, "GET", path, undefined, { Range: "bytes=1000-" });
    expect(res.status).toBe(416);
    expect(res.headers["content-range"]).toBe("bytes */1000");
  });

  it("answers HEAD with headers only", async () => {
    const { server, path } = await projectWithFile();
    const res = await api(server, "HEAD", path, undefined, { Range: "bytes=0-9" });
    expect(res.status).toBe(206);
    expect(res.headers["content-length"]).toBe("10");
    expect(res.body.length).toBe(0);
  });

  it("refuses paths that escape the project root", async () => {
    const { server, project } = await projectWithFile();
    for (const escape of ["..%2F..%2Fetc%2Fpasswd", "sources/..%2F..%2F..%2Fetc%2Fpasswd", "%2Fetc%2Fpasswd"]) {
      const res = await api(server, "GET", `/media/${project.id}/${escape}`);
      expect([403, 404]).toContain(res.status);
      expect(res.body.toString()).not.toContain("root:");
    }
    // Unencoded dot segments are normalised away by URL parsing, so this never reaches /media.
    const raw = await api(server, "GET", `/media/${project.id}/../../etc/passwd`);
    expect(raw.body.toString()).not.toContain("root:");
  });

  it("refuses symlinks that lead outside the project", async () => {
    const { server, project } = await projectWithFile();
    const outside = await tempDir();
    await writeFile(join(outside, "secret.txt"), "secret");
    await symlink(join(outside, "secret.txt"), join(project.root, "sources", "link.txt"));
    const res = await api(server, "GET", `/media/${project.id}/sources/link.txt`);
    expect(res.status).toBe(403);
  });

  it("does not serve the private .cutline folder", async () => {
    const { server, project } = await projectWithFile();
    const res = await api(server, "GET", `/media/${project.id}/.cutline/lock`);
    expect(res.status).toBe(403);
  });

  it("returns 404 for missing files and unknown projects", async () => {
    const { server, project } = await projectWithFile();
    expect((await api(server, "GET", `/media/${project.id}/sources/nope.mp4`)).status).toBe(404);
    expect((await api(server, "GET", `/media/prj_unknown/sources/rec-1/screen.mp4`)).status).toBe(404);
  });

  it("needs the token", async () => {
    const { server, path } = await projectWithFile();
    expect((await send(server.port, { path })).status).toBe(401);
  });
});

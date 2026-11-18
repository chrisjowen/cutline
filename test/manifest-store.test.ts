import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ManifestSchema, type Manifest } from "../src/shared/manifest.js";
import { HttpError } from "../src/server/errors.js";
import { atomicWriteFile } from "../src/server/fsutil.js";
import { ManifestStore, RevConflictError, manifestPath, snapshotDir } from "../src/server/manifest-store.js";
import { tempDir } from "./helpers.js";

async function readManifest(root: string): Promise<Manifest> {
  return ManifestSchema.parse(JSON.parse(await readFile(manifestPath(root), "utf8")));
}

function rename(store: ManifestStore, name: string) {
  return store.patch(store.rev, [{ op: "replace", path: "/name", value: name }]);
}

describe("ManifestStore", () => {
  it("creates a valid schema v1 manifest at rev 1", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    const onDisk = await readManifest(root);
    expect(onDisk.schema).toBe("cutline.project/1");
    expect(onDisk.rev).toBe(1);
    expect(onDisk.name).toBe("Demo");
    expect(onDisk.id).toMatch(/^prj_[0-9A-Z]{26}$/);
    expect(onDisk.timelines).toHaveLength(1);
    expect(store.manifest).toEqual(onDisk);
  });

  it("refuses to create over an existing project", async () => {
    const root = await tempDir();
    await ManifestStore.create(root, { name: "Demo" });
    await expect(ManifestStore.create(root, { name: "Again" })).rejects.toMatchObject({ code: "already-project" });
  });

  it("bumps rev, stamps updated and snapshots the previous revision on every patch", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    const before = await readFile(manifestPath(root), "utf8");
    const next = await store.patch(1, [{ op: "replace", path: "/product", value: "Wheelhouse" }]);
    expect(next.rev).toBe(2);
    expect(next.product).toBe("Wheelhouse");
    expect((await readManifest(root)).rev).toBe(2);
    expect(await readFile(join(snapshotDir(root), "cutline.1.json"), "utf8")).toBe(before);
  });

  it("writes atomically: no tmp file is left behind", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    await rename(store, "Two");
    expect(await readdir(root)).not.toContain("cutline.json.tmp");
  });

  it("keeps the old file intact when a write fails before the rename", async () => {
    const root = await tempDir();
    const target = join(root, "file.json");
    await writeFile(target, "old");
    // A directory where the tmp file should go makes the write fail.
    await mkdir(`${target}.tmp`);
    await expect(atomicWriteFile(target, "new")).rejects.toThrow();
    expect(await readFile(target, "utf8")).toBe("old");
  });

  it("recovers from a crash mid-write by ignoring the half-written tmp file", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    await rename(store, "Saved");
    await writeFile(`${manifestPath(root)}.tmp`, '{"schema": "cutline.proj');
    const reopened = await ManifestStore.open(root);
    expect(reopened.manifest.name).toBe("Saved");
    expect(reopened.rev).toBe(2);
    expect(await readdir(root)).not.toContain("cutline.json.tmp");
  });

  it("refuses a patch against a stale revision and writes nothing", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    await rename(store, "Two");
    await expect(store.patch(1, [{ op: "replace", path: "/name", value: "Clobber" }])).rejects.toBeInstanceOf(
      RevConflictError,
    );
    expect((await readManifest(root)).name).toBe("Two");
  });

  it("lets only one of two concurrent patches on the same base revision through", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    const results = await Promise.allSettled([
      store.patch(1, [{ op: "replace", path: "/name", value: "A" }]),
      store.patch(1, [{ op: "replace", path: "/name", value: "B" }]),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual(["fulfilled", "rejected"]);
    expect(store.rev).toBe(2);
  });

  it("rejects patches that would make the manifest invalid", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    await expect(store.patch(1, [{ op: "replace", path: "/name", value: "" }])).rejects.toMatchObject({
      code: "invalid-manifest",
    });
    await expect(store.patch(1, [{ op: "add", path: "/surprise", value: 1 }])).rejects.toMatchObject({
      code: "invalid-manifest",
    });
    expect(store.rev).toBe(1);
    expect((await readManifest(root)).rev).toBe(1);
  });

  it("refuses patches to server-owned fields", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    for (const path of ["/rev", "/id", "/schema", "/created", "/updated"]) {
      await expect(store.patch(1, [{ op: "replace", path, value: "x" }])).rejects.toMatchObject({
        code: "invalid-patch",
      });
    }
  });

  it("emits a change event with the new revision", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    const seen: number[] = [];
    store.on("change", ({ rev }) => seen.push(rev));
    await rename(store, "Two");
    await rename(store, "Three");
    expect(seen).toEqual([2, 3]);
  });

  it("restores a snapshot as a new, undoable revision", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "One" });
    await rename(store, "Two"); // rev 2, snapshot 1
    await rename(store, "Three"); // rev 3, snapshot 2
    const restored = await store.restore(2);
    expect(restored.name).toBe("Two");
    expect(restored.rev).toBe(4);
    expect((await readManifest(root)).name).toBe("Two");
    // The state before the restore is itself a snapshot, so the restore can be undone.
    const undone = await store.restore(3);
    expect(undone.name).toBe("Three");
    expect(undone.rev).toBe(5);
  });

  it("refuses to restore a missing snapshot or against a stale base revision", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "One" });
    await rename(store, "Two");
    await expect(store.restore(99)).rejects.toMatchObject({ code: "no-snapshot" });
    await expect(store.restore(1, 1)).rejects.toBeInstanceOf(RevConflictError);
    expect(store.manifest.name).toBe("Two");
  });

  it("lists snapshots newest first and keeps only the most recent ones", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" }, { snapshotLimit: 3 });
    for (let i = 2; i <= 7; i++) await rename(store, `Name ${i}`);
    const snapshots = await store.listSnapshots();
    expect(snapshots.map((s) => s.rev)).toEqual([6, 5, 4]);
    expect(snapshots[0]?.updated).toEqual(expect.any(String));
  });

  it("reopens the latest revision from disk", async () => {
    const root = await tempDir();
    const store = await ManifestStore.create(root, { name: "Demo" });
    await rename(store, "Renamed");
    const reopened = await ManifestStore.open(root);
    expect(reopened.manifest).toEqual(store.manifest);
  });

  it("refuses a manifest saved by a newer schema version", async () => {
    const root = await tempDir();
    await writeFile(manifestPath(root), JSON.stringify({ schema: "cutline.project/2", rev: 1 }));
    await expect(ManifestStore.open(root)).rejects.toMatchObject({ code: "newer-schema" });
  });

  it("reports a folder without cutline.json as not a project", async () => {
    const root = await tempDir();
    const error = await ManifestStore.open(root).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({ status: 404, code: "not-a-project" });
  });

  it("refuses to write once checkLock reports the lock was taken over, and emits lock-lost", async () => {
    const root = await tempDir();
    let held = true;
    const store = await ManifestStore.create(root, { name: "Demo" }, { checkLock: () => Promise.resolve(held) });
    const lost: unknown[] = [];
    store.on("lock-lost", () => lost.push(true));
    held = false;
    await expect(rename(store, "Clobber")).rejects.toMatchObject({ code: "lock-lost", status: 409 });
    expect(lost).toHaveLength(1);
    expect(store.rev).toBe(1);
    expect((await readManifest(root)).rev).toBe(1);
  });
});

import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { acquireLock, lockPath, LockedError, processAlive } from "../src/server/lock.js";
import { exists } from "../src/server/fsutil.js";
import { tempDir } from "./helpers.js";

const me = { pid: process.pid, port: 5417, instance: "server-a" };
const other = { pid: process.pid, port: 5418, instance: "server-b" };

describe("project lock", () => {
  it("writes pid and port to .cutline/lock", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    const info = JSON.parse(await readFile(lockPath(root), "utf8"));
    expect(info).toMatchObject({ pid: process.pid, port: 5417, instance: "server-a" });
    expect(info.acquiredAt).toEqual(expect.any(String));
  });

  it("refuses a second server while the holder is alive, naming the holder", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    const error = await acquireLock(root, other).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LockedError);
    expect(error).toMatchObject({ status: 423, holder: { port: 5417, instance: "server-a" } });
  });

  it("takes over a stale lock whose process has exited", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    const lock = await acquireLock(root, other, { isAlive: () => false });
    expect(lock.info.instance).toBe("server-b");
    expect(JSON.parse(await readFile(lockPath(root), "utf8")).instance).toBe("server-b");
  });

  it("takes over a live lock only when forced", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    const lock = await acquireLock(root, other, { force: true });
    expect(lock.info.instance).toBe("server-b");
  });

  it("treats an unreadable lock file as stale", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    await writeFile(lockPath(root), "{ half writ");
    const lock = await acquireLock(root, other);
    expect(lock.info.instance).toBe("server-b");
  });

  it("is re-entrant for the server that holds it", async () => {
    const root = await tempDir();
    await acquireLock(root, me);
    const again = await acquireLock(root, me);
    expect(again.info.instance).toBe("server-a");
  });

  it("releases only its own lock", async () => {
    const root = await tempDir();
    const mine = await acquireLock(root, me);
    await acquireLock(root, other, { force: true });
    await mine.release();
    expect(await exists(lockPath(root))).toBe(true);
    const theirs = await acquireLock(root, other);
    await theirs.release();
    expect(await exists(lockPath(root))).toBe(false);
  });

  it("detects whether a process is alive", () => {
    expect(processAlive(process.pid)).toBe(true);
    expect(processAlive(2 ** 22 + 12345)).toBe(false);
  });
});

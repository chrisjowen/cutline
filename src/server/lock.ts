// .cutline/lock stops two Cutline servers from editing one project at once.
// It holds the pid and port of the server that owns the project. A lock whose
// process has gone away is stale and is taken over silently.
import { readFileSync, unlinkSync } from "node:fs";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { HttpError } from "./errors.js";

export interface LockOwner {
  pid: number;
  port: number;
  /** Unique per server run, so one process can tell its own locks from another server's. */
  instance: string;
}

export interface LockInfo extends LockOwner {
  acquiredAt: string;
}

export function lockPath(root: string): string {
  return join(root, ".cutline", "lock");
}

export class LockedError extends HttpError {
  constructor(readonly holder: LockInfo) {
    super(423, "locked", `this project is open in another Cutline (pid ${holder.pid}, port ${holder.port})`, {
      holder,
    });
  }
}

/** Thrown when a write is refused because another server has taken over the project's lock. */
export class LockLostError extends HttpError {
  constructor() {
    super(409, "lock-lost", "another Cutline server has taken over this project; it has been closed here");
  }
}

export function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: the process exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLock(path: string): Promise<LockInfo | null> {
  try {
    const value = JSON.parse(await readFile(path, "utf8")) as Partial<LockInfo>;
    if (typeof value.pid !== "number" || typeof value.instance !== "string") return null;
    return value as LockInfo;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") throw error;
    return null; // unreadable or half-written: treat as stale
  }
}

export class ProjectLock {
  private released = false;

  constructor(
    readonly path: string,
    readonly info: LockInfo,
  ) {}

  /** True while the lock file on disk still names this instance as holder. */
  async isHeld(): Promise<boolean> {
    const holder = await readLock(this.path).catch(() => null);
    return holder?.instance === this.info.instance;
  }

  /** Removes the lock file if it is still ours. */
  async release(): Promise<void> {
    if (this.released) return;
    this.released = true;
    try {
      const holder = await readLock(this.path);
      if (holder?.instance === this.info.instance) await unlink(this.path);
    } catch {
      // Already gone.
    }
  }

  /** Synchronous variant for process exit handlers. */
  releaseSync(): void {
    if (this.released) return;
    this.released = true;
    try {
      const holder = JSON.parse(readFileSync(this.path, "utf8")) as Partial<LockInfo>;
      if (holder.instance === this.info.instance) unlinkSync(this.path);
    } catch {
      // Already gone or unreadable.
    }
  }
}

/**
 * Takes the project lock for owner. Throws LockedError when another live
 * server holds it, unless `force` is set (an explicit "take over").
 */
export async function acquireLock(
  root: string,
  owner: LockOwner,
  options: { force?: boolean; isAlive?: (pid: number) => boolean } = {},
): Promise<ProjectLock> {
  const isAlive = options.isAlive ?? processAlive;
  const path = lockPath(root);
  await mkdir(join(root, ".cutline"), { recursive: true });
  const info: LockInfo = { ...owner, acquiredAt: new Date().toISOString() };
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await writeFile(path, `${JSON.stringify(info, null, 2)}\n`, { flag: "wx" });
      return new ProjectLock(path, info);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    let holder: LockInfo | null;
    try {
      holder = await readLock(path);
    } catch {
      continue; // removed between our write and read; try again
    }
    if (holder && holder.instance === owner.instance) return new ProjectLock(path, holder);
    if (holder && isAlive(holder.pid) && !options.force) throw new LockedError(holder);
    await unlink(path).catch(() => {});
  }
  throw new HttpError(409, "lock-race", "could not take the project lock; try again");
}

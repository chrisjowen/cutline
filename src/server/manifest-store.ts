// The single writer of a project's cutline.json.
//
// Every change is a new revision: the previous file is first copied to
// .cutline/snapshots/cutline.<rev>.json, then the new one is written
// atomically (tmp + fsync + rename). Patches name the revision they were made
// against, and a patch against a stale revision is refused, so two tabs can
// never silently overwrite each other.
import { EventEmitter } from "node:events";
import { copyFile, mkdir, readFile, readdir, rename, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  MANIFEST_FILE,
  ManifestSchema,
  SCHEMA_ID,
  SERVER_OWNED_FIELDS,
  newManifest,
  schemaVersion,
  type Manifest,
} from "../shared/manifest.js";
import { projectId } from "../shared/ids.js";
import { applyPatch, PatchError, type PatchOp } from "../shared/patch.js";
import { HttpError } from "./errors.js";
import { atomicWriteJson, exists } from "./fsutil.js";
import { LockLostError } from "./lock.js";

export const SNAPSHOT_LIMIT = 50;
const SNAPSHOT_RE = /^cutline\.(\d+)\.json$/;

export interface SnapshotInfo {
  rev: number;
  updated: string | null;
  bytes: number;
}

export interface ManifestChange {
  rev: number;
  manifest: Manifest;
}

export class RevConflictError extends HttpError {
  constructor(baseRev: number, rev: number) {
    super(409, "rev-conflict", `patch made against rev ${baseRev}, but the project is at rev ${rev}`, {
      baseRev,
      rev,
    });
  }
}

function invalid(message: string, details: Record<string, unknown> = {}): HttpError {
  return new HttpError(422, "invalid-manifest", message, details);
}

function validate(value: unknown): Manifest {
  const result = ManifestSchema.safeParse(value);
  if (!result.success) {
    throw invalid("the result is not a valid cutline.json", {
      issues: result.error.issues.map((issue) => ({ path: issue.path.join("/"), message: issue.message })),
    });
  }
  return result.data;
}

export function manifestPath(root: string): string {
  return join(root, MANIFEST_FILE);
}

export function snapshotDir(root: string): string {
  return join(root, ".cutline", "snapshots");
}

export interface ManifestStoreOptions {
  snapshotLimit?: number;
  /** Checked before every write; a write is refused once this reports false (the lock was taken over). */
  checkLock?: () => Promise<boolean>;
}

export class ManifestStore extends EventEmitter<{ change: [ManifestChange]; "lock-lost": [] }> {
  private current: Manifest;
  private queue: Promise<unknown> = Promise.resolve();

  private constructor(
    readonly root: string,
    manifest: Manifest,
    private readonly snapshotLimit: number,
    private readonly checkLock?: () => Promise<boolean>,
  ) {
    super();
    this.current = manifest;
  }

  /** Creates cutline.json (rev 1) in root, which must not already hold one. */
  static async create(
    root: string,
    init: { name: string; id?: string; now?: Date },
    options: ManifestStoreOptions = {},
  ): Promise<ManifestStore> {
    if (await exists(manifestPath(root))) {
      throw new HttpError(409, "already-project", `${root} already contains ${MANIFEST_FILE}`);
    }
    const manifest = validate(newManifest({ id: init.id ?? projectId(), name: init.name, now: init.now }));
    await mkdir(snapshotDir(root), { recursive: true });
    await atomicWriteJson(manifestPath(root), manifest);
    return new ManifestStore(root, manifest, options.snapshotLimit ?? SNAPSHOT_LIMIT, options.checkLock);
  }

  /** Loads an existing cutline.json, refusing unknown or newer schema versions. */
  static async open(root: string, options: ManifestStoreOptions = {}): Promise<ManifestStore> {
    const path = manifestPath(root);
    // A leftover tmp file means a write was interrupted before its rename;
    // cutline.json itself is still the last complete revision.
    await unlink(`${path}.tmp`).catch(() => {});
    let raw: unknown;
    try {
      raw = JSON.parse(await readFile(path, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new HttpError(404, "not-a-project", `${root} has no ${MANIFEST_FILE}`);
      }
      throw invalid(`${MANIFEST_FILE} could not be read: ${(error as Error).message}`);
    }
    const version = schemaVersion(raw);
    if (version === null) throw invalid(`${MANIFEST_FILE} has no recognised "schema" field`);
    if (version > 1) {
      throw new HttpError(409, "newer-schema", `this project was saved by a newer Cutline (schema v${version})`, {
        version,
      });
    }
    const manifest = validate(raw);
    await mkdir(snapshotDir(root), { recursive: true });
    return new ManifestStore(root, manifest, options.snapshotLimit ?? SNAPSHOT_LIMIT, options.checkLock);
  }

  get manifest(): Manifest {
    return this.current;
  }

  get rev(): number {
    return this.current.rev;
  }

  /** Applies JSON Patch ops made against baseRev and writes the next revision. */
  patch(baseRev: number, ops: PatchOp[]): Promise<Manifest> {
    return this.serial(async () => {
      if (baseRev !== this.current.rev) throw new RevConflictError(baseRev, this.current.rev);
      let patched: Manifest;
      try {
        patched = applyPatch(this.current, ops, SERVER_OWNED_FIELDS);
      } catch (error) {
        if (error instanceof PatchError) throw new HttpError(422, "invalid-patch", error.message, { index: error.index });
        throw error;
      }
      return this.commit(validate(patched));
    });
  }

  /**
   * Makes the content of snapshot `rev` the current state, as a new revision,
   * so a restore is itself undoable.
   */
  restore(rev: number, baseRev?: number): Promise<Manifest> {
    return this.serial(async () => {
      if (baseRev !== undefined && baseRev !== this.current.rev) {
        throw new RevConflictError(baseRev, this.current.rev);
      }
      let raw: unknown;
      try {
        raw = JSON.parse(await readFile(join(snapshotDir(this.root), `cutline.${rev}.json`), "utf8"));
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") {
          throw new HttpError(404, "no-snapshot", `there is no snapshot of rev ${rev}`);
        }
        throw error;
      }
      const snapshot = validate(raw);
      const { schema, id, created } = this.current;
      return this.commit(validate({ ...snapshot, schema, id, created }));
    });
  }

  async listSnapshots(): Promise<SnapshotInfo[]> {
    const dir = snapshotDir(this.root);
    const names = await readdir(dir).catch(() => [] as string[]);
    const snapshots: SnapshotInfo[] = [];
    for (const name of names) {
      const match = SNAPSHOT_RE.exec(name);
      if (!match) continue;
      const path = join(dir, name);
      const info = await stat(path);
      let updated: string | null = null;
      try {
        const value = JSON.parse(await readFile(path, "utf8")) as { updated?: unknown };
        if (typeof value.updated === "string") updated = value.updated;
      } catch {
        // A damaged snapshot is still listed; restoring it will report the problem.
      }
      snapshots.push({ rev: Number(match[1]), updated, bytes: info.size });
    }
    return snapshots.sort((a, b) => b.rev - a.rev);
  }

  private async commit(next: Manifest): Promise<Manifest> {
    if (this.checkLock && !(await this.checkLock())) {
      this.emit("lock-lost");
      throw new LockLostError();
    }
    const previous = this.current;
    const written: Manifest = {
      ...next,
      schema: SCHEMA_ID,
      rev: previous.rev + 1,
      updated: new Date().toISOString(),
    };
    const dir = snapshotDir(this.root);
    await mkdir(dir, { recursive: true });
    const snapshot = join(dir, `cutline.${previous.rev}.json`);
    if (await exists(manifestPath(this.root))) {
      await copyFile(manifestPath(this.root), `${snapshot}.tmp`);
      await rename(`${snapshot}.tmp`, snapshot);
    } else {
      await atomicWriteJson(snapshot, previous);
    }
    await atomicWriteJson(manifestPath(this.root), written);
    this.current = written;
    await this.pruneSnapshots();
    this.emit("change", { rev: written.rev, manifest: written });
    return written;
  }

  private async pruneSnapshots(): Promise<void> {
    const dir = snapshotDir(this.root);
    const revs = (await readdir(dir))
      .map((name) => SNAPSHOT_RE.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => b - a);
    for (const rev of revs.slice(this.snapshotLimit)) {
      await unlink(join(dir, `cutline.${rev}.json`)).catch(() => {});
    }
  }

  private serial<T>(task: () => Promise<T>): Promise<T> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }
}

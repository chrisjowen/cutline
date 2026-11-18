// The projects this server has open, keyed by project id.
// Opening a project takes its lock and loads its manifest; closing releases both.
import { mkdir, realpath, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { MANIFEST_FILE } from "../shared/manifest.js";
import type { AppConfig } from "./app-config.js";
import { HttpError } from "./errors.js";
import { exists, expandPath, folderNameFor, isEffectivelyEmptyDir } from "./fsutil.js";
import { acquireLock, type LockOwner, type ProjectLock } from "./lock.js";
import { ManifestStore } from "./manifest-store.js";

export interface OpenProject {
  id: string;
  root: string;
  store: ManifestStore;
  lock: ProjectLock;
}

export interface ProjectSummary {
  id: string;
  name: string;
  root: string;
  rev: number;
}

export function summary(project: OpenProject): ProjectSummary {
  const { id, name, rev } = project.store.manifest;
  return { id, name, rev, root: project.root };
}

export class ProjectRegistry {
  private readonly open = new Map<string, OpenProject>();
  private readonly listeners = new Set<(event: { type: "closed"; id: string }) => void>();

  constructor(
    private readonly options: {
      config: AppConfig;
      owner: LockOwner;
      defaultRoot: string;
      home: string;
      isAlive?: (pid: number) => boolean;
    },
  ) {}

  get defaultRoot(): string {
    return this.options.defaultRoot;
  }

  get(id: string): OpenProject {
    const project = this.open.get(id);
    if (!project) throw new HttpError(404, "project-not-open", "that project is not open; open it from Projects");
    return project;
  }

  list(): ProjectSummary[] {
    return [...this.open.values()].map(summary);
  }

  onClosed(listener: (event: { type: "closed"; id: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /**
   * Creates a project. `path` is the exact project folder; otherwise the
   * folder is `<parent or default root>/<name>`. The folder may already exist
   * only if it is empty.
   */
  async create(input: { name: string; path?: string; parent?: string }): Promise<OpenProject> {
    const name = input.name.trim();
    if (!name) throw new HttpError(400, "bad-name", "a project needs a name");
    let target: string;
    if (input.path) {
      target = this.expand(input.path);
    } else {
      const folder = folderNameFor(name);
      if (!folder) throw new HttpError(400, "bad-name", "that name cannot be used as a folder name");
      target = join(this.expand(input.parent ?? this.options.defaultRoot), folder);
    }
    if (await exists(target)) {
      const info = await stat(target);
      if (!info.isDirectory()) throw new HttpError(409, "not-a-folder", `${target} is a file`);
      if (await exists(join(target, MANIFEST_FILE))) {
        throw new HttpError(409, "already-project", `${target} is already a Cutline project`, { path: target });
      }
      if (!(await isEffectivelyEmptyDir(target))) {
        throw new HttpError(409, "not-empty", `${target} already has files in it; choose an empty folder`, {
          path: target,
        });
      }
    }
    await mkdir(target, { recursive: true });
    const root = await realpath(target);
    const lock = await acquireLock(root, this.options.owner, { isAlive: this.options.isAlive });
    try {
      const store = await ManifestStore.create(root, { name });
      return await this.register(root, store, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  /** Opens the project in `path`; an already-open project is returned as is. */
  async openPath(path: string, options: { force?: boolean } = {}): Promise<OpenProject> {
    const target = this.expand(path);
    let root: string;
    try {
      root = await realpath(target);
    } catch {
      throw new HttpError(404, "not-found", `no such folder: ${target}`, { path: target });
    }
    if (!(await stat(root)).isDirectory()) throw new HttpError(400, "not-a-folder", `${root} is not a folder`);
    const already = [...this.open.values()].find((project) => project.root === root);
    if (already) {
      await this.touch(already);
      return already;
    }
    if (!(await exists(join(root, MANIFEST_FILE)))) {
      const empty = await isEffectivelyEmptyDir(root);
      throw new HttpError(
        409,
        "not-a-project",
        empty ? `${root} is empty; it can be made into a project` : `${root} has no ${MANIFEST_FILE}`,
        { path: root, empty, suggestedName: basename(root) },
      );
    }
    const lock = await acquireLock(root, this.options.owner, {
      force: options.force,
      isAlive: this.options.isAlive,
    });
    try {
      const store = await ManifestStore.open(root);
      return await this.register(root, store, lock);
    } catch (error) {
      await lock.release();
      throw error;
    }
  }

  async close(id: string): Promise<void> {
    const project = this.open.get(id);
    if (!project) return;
    this.open.delete(id);
    project.store.removeAllListeners();
    await project.lock.release();
    for (const listener of this.listeners) listener({ type: "closed", id });
  }

  async closeAll(): Promise<void> {
    await Promise.all([...this.open.keys()].map((id) => this.close(id)));
  }

  /** For process exit handlers, where async work cannot run. */
  releaseAllSync(): void {
    for (const project of this.open.values()) project.lock.releaseSync();
  }

  private async register(root: string, store: ManifestStore, lock: ProjectLock): Promise<OpenProject> {
    const id = store.manifest.id;
    const clash = this.open.get(id);
    if (clash && clash.root !== root) {
      throw new HttpError(409, "duplicate-id", `a project with the same id is already open from ${clash.root}`, {
        other: clash.root,
      });
    }
    const project: OpenProject = { id, root, store, lock };
    this.open.set(id, project);
    let name = store.manifest.name;
    store.on("change", ({ manifest }) => {
      if (manifest.name !== name) {
        name = manifest.name;
        void this.options.config.renameRecent(root, name).catch(() => {});
      }
    });
    await this.touch(project);
    return project;
  }

  private async touch(project: OpenProject): Promise<void> {
    await this.options.config.touchRecent({ id: project.id, name: project.store.manifest.name, path: project.root });
  }

  private expand(path: string): string {
    try {
      return expandPath(path, this.options.home);
    } catch (error) {
      throw new HttpError(400, "bad-path", (error as Error).message);
    }
  }
}

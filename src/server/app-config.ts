// App-wide state that lives outside projects, in ~/.config/cutline/.
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { atomicWriteJson } from "./fsutil.js";

export const RECENTS_LIMIT = 20;

const RecentSchema = z.object({
  id: z.string(),
  name: z.string(),
  path: z.string(),
  openedAt: z.string(),
});

export type RecentProject = z.infer<typeof RecentSchema>;

export class AppConfig {
  private queue: Promise<unknown> = Promise.resolve();

  constructor(readonly dir: string) {}

  get recentsFile(): string {
    return join(this.dir, "recents.json");
  }

  async recents(): Promise<RecentProject[]> {
    try {
      const raw = JSON.parse(await readFile(this.recentsFile, "utf8")) as unknown;
      const parsed = z.object({ projects: z.array(RecentSchema) }).safeParse(raw);
      return parsed.success ? parsed.data.projects : [];
    } catch {
      return [];
    }
  }

  /** Moves (or adds) the project to the top of the recents list. */
  touchRecent(entry: Omit<RecentProject, "openedAt">): Promise<void> {
    return this.update((list) => [
      { ...entry, openedAt: new Date().toISOString() },
      ...list.filter((item) => item.path !== entry.path),
    ]);
  }

  renameRecent(path: string, name: string): Promise<void> {
    return this.update((list) => list.map((item) => (item.path === path ? { ...item, name } : item)));
  }

  removeRecent(path: string): Promise<void> {
    return this.update((list) => list.filter((item) => item.path !== path));
  }

  private update(change: (list: RecentProject[]) => RecentProject[]): Promise<void> {
    const run = this.queue.then(async () => {
      const next = change(await this.recents()).slice(0, RECENTS_LIMIT);
      await mkdir(this.dir, { recursive: true });
      await atomicWriteJson(this.recentsFile, { projects: next });
    });
    this.queue = run.catch(() => {});
    return run;
  }
}

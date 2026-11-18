import { constants } from "node:fs";
import { access, open, readdir, rename, unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";

/** Files macOS drops into folders that do not make a folder "non-empty" for our purposes. */
const IGNORABLE_FILES = new Set([".DS_Store", ".localized"]);

export async function exists(path: string): Promise<boolean> {
  try {
    await access(path, constants.F_OK);
    return true;
  } catch {
    return false;
  }
}

export async function isEffectivelyEmptyDir(path: string): Promise<boolean> {
  const entries = await readdir(path);
  return entries.every((name) => IGNORABLE_FILES.has(name));
}

async function fsyncDir(dir: string): Promise<void> {
  try {
    const handle = await open(dir, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch {
    // Some filesystems refuse to fsync a directory; the rename is still atomic.
  }
}

/**
 * Writes data to `<path>.tmp`, fsyncs it, then renames it over path, so a
 * reader (or a crash) only ever sees the old file or the complete new one.
 */
export async function atomicWriteFile(path: string, data: string | Uint8Array): Promise<void> {
  const tmp = `${path}.tmp`;
  const handle = await open(tmp, "w");
  try {
    await handle.writeFile(data);
    await handle.sync();
  } catch (error) {
    await handle.close();
    await unlink(tmp).catch(() => {});
    throw error;
  }
  await handle.close();
  await rename(tmp, path);
  await fsyncDir(dirname(path));
}

export async function atomicWriteJson(path: string, value: unknown): Promise<void> {
  await atomicWriteFile(path, `${JSON.stringify(value, null, 2)}\n`);
}

/** Expands a leading `~` and resolves to an absolute path; relative paths are refused. */
export function expandPath(input: string, home = homedir()): string {
  const trimmed = input.trim();
  let expanded = trimmed;
  if (trimmed === "~") expanded = home;
  else if (trimmed.startsWith("~/")) expanded = join(home, trimmed.slice(2));
  if (!isAbsolute(expanded)) throw new Error(`path must be absolute: ${input}`);
  return resolve(expanded);
}

/** Turns a project name into a folder name that is safe on macOS and Linux. */
export function folderNameFor(name: string): string {
  const cleaned = name
    .replace(/[/:\\\0]/g, "-")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\.+/, "");
  return basename(cleaned).slice(0, 120);
}

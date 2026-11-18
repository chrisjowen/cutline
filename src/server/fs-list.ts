// The fallback folder browser for when the native dialog is unavailable.
// It only lists folders, and only inside the home directory.
import { readdir, realpath } from "node:fs/promises";
import { dirname, join, sep } from "node:path";
import { MANIFEST_FILE } from "../shared/manifest.js";
import { HttpError } from "./errors.js";
import { exists } from "./fsutil.js";

export interface FolderListing {
  path: string;
  parent: string | null;
  isProject: boolean;
  folders: { name: string; path: string; isProject: boolean }[];
}

export async function listFolders(path: string, home: string): Promise<FolderListing> {
  const realHome = await realpath(home);
  let real: string;
  try {
    real = await realpath(path);
  } catch {
    throw new HttpError(404, "not-found", `no such folder: ${path}`);
  }
  if (real !== realHome && !real.startsWith(realHome + sep)) {
    throw new HttpError(403, "outside-home", "the folder browser is limited to your home folder");
  }
  let entries;
  try {
    entries = await readdir(real, { withFileTypes: true });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOTDIR") throw new HttpError(400, "not-a-folder", `${path} is not a folder`);
    throw new HttpError(403, "unreadable", `cannot read ${path}`);
  }
  const folders = await Promise.all(
    entries
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map(async (entry) => {
        const full = join(real, entry.name);
        return { name: entry.name, path: full, isProject: await exists(join(full, MANIFEST_FILE)) };
      }),
  );
  folders.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return {
    path: real,
    parent: real === realHome ? null : dirname(real),
    isProject: await exists(join(real, MANIFEST_FILE)),
    folders,
  };
}

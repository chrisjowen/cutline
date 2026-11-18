// Serves files from inside a project root with HTTP Range support, so the
// browser can seek through long recordings without loading them whole.
import { createReadStream } from "node:fs";
import { realpath, stat } from "node:fs/promises";
import type { IncomingMessage, ServerResponse } from "node:http";
import { extname, resolve, sep } from "node:path";
import { pipeline } from "node:stream/promises";
import { HttpError } from "./errors.js";

const CONTENT_TYPES: Record<string, string> = {
  ".mp4": "video/mp4",
  ".m4v": "video/mp4",
  ".mov": "video/quicktime",
  ".webm": "video/webm",
  ".mkv": "video/x-matroska",
  ".m4a": "audio/mp4",
  ".mp3": "audio/mpeg",
  ".wav": "audio/wav",
  ".ogg": "audio/ogg",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
  ".svg": "image/svg+xml",
  ".json": "application/json",
  ".srt": "application/x-subrip",
  ".vtt": "text/vtt",
  ".txt": "text/plain; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".ico": "image/x-icon",
};

export function contentTypeFor(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

export type ByteRange = { start: number; end: number };

/**
 * Parses a Range header for a file of `size` bytes. Returns the inclusive
 * byte range, "unsatisfiable" (answer 416), or null when the header should be
 * ignored and the whole file sent (absent, malformed or multi-range).
 */
export function parseRange(header: string | undefined, size: number): ByteRange | "unsatisfiable" | null {
  if (header === undefined) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match) return null;
  const [, first = "", last = ""] = match;
  if (first === "" && last === "") return null;
  if (first === "") {
    const suffix = Number(last);
    if (suffix === 0 || size === 0) return "unsatisfiable";
    return { start: Math.max(0, size - suffix), end: size - 1 };
  }
  const start = Number(first);
  const end = last === "" ? size - 1 : Math.min(Number(last), size - 1);
  if (start >= size) return "unsatisfiable";
  if (end < start) return null;
  return { start, end };
}

/**
 * Resolves a URL-relative path inside root. Refuses `..`, absolute paths,
 * the private .cutline folder, and anything a symlink would lead outside root.
 */
export async function resolveInside(root: string, relative: string): Promise<string> {
  const parts = relative.split("/").filter((part) => part !== "" && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === ".." || part.includes("\0") || part.includes("\\"))) {
    throw new HttpError(403, "bad-path", "path is outside the project");
  }
  if (parts[0] === ".cutline") throw new HttpError(403, "bad-path", "project internals are not served");
  const realRoot = await realpath(root);
  const candidate = resolve(realRoot, ...parts);
  if (!candidate.startsWith(realRoot + sep)) throw new HttpError(403, "bad-path", "path is outside the project");
  let real: string;
  try {
    real = await realpath(candidate);
  } catch {
    throw new HttpError(404, "not-found", "no such file");
  }
  if (!real.startsWith(realRoot + sep)) throw new HttpError(403, "bad-path", "path is outside the project");
  return real;
}

export async function serveFile(
  req: IncomingMessage,
  res: ServerResponse,
  path: string,
  extraHeaders: Record<string, string> = {},
): Promise<void> {
  const info = await stat(path).catch(() => null);
  if (!info?.isFile()) throw new HttpError(404, "not-found", "no such file");
  const size = info.size;
  const headers: Record<string, string | number> = {
    "Content-Type": contentTypeFor(path),
    "Accept-Ranges": "bytes",
    "Last-Modified": info.mtime.toUTCString(),
    ...extraHeaders,
  };
  const range = parseRange(req.headers.range, size);
  if (range === "unsatisfiable") {
    res.writeHead(416, { ...headers, "Content-Range": `bytes */${size}`, "Content-Length": 0 });
    res.end();
    return;
  }
  const { start, end } = range ?? { start: 0, end: size - 1 };
  const length = size === 0 ? 0 : end - start + 1;
  if (range) headers["Content-Range"] = `bytes ${start}-${end}/${size}`;
  headers["Content-Length"] = length;
  res.writeHead(range ? 206 : 200, headers);
  if (req.method === "HEAD" || length === 0) {
    res.end();
    return;
  }
  await pipeline(createReadStream(path, { start, end }), res).catch(() => {
    // The client went away mid-stream (normal when a video seeks).
  });
}

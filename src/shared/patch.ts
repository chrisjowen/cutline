// A small subset of JSON Patch (RFC 6902): add, remove, replace and test.
// The UI sends these as {baseRev, ops}; the server applies them to a copy of
// the manifest and validates the result before writing.
import { z } from "zod";

export const PatchOpSchema = z.discriminatedUnion("op", [
  z.strictObject({ op: z.literal("add"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("replace"), path: z.string(), value: z.unknown() }),
  z.strictObject({ op: z.literal("remove"), path: z.string() }),
  z.strictObject({ op: z.literal("test"), path: z.string(), value: z.unknown() }),
]);

export const PatchRequestSchema = z.strictObject({
  baseRev: z.number().int().positive(),
  ops: z.array(PatchOpSchema).min(1).max(500),
});

export type PatchOp = z.infer<typeof PatchOpSchema>;
export type PatchRequest = z.infer<typeof PatchRequestSchema>;

export class PatchError extends Error {
  constructor(
    message: string,
    readonly index: number,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

export function parsePointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error(`invalid JSON pointer: ${pointer}`);
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replace(/~1/g, "/").replace(/~0/g, "~"));
}

type Container = Record<string, unknown> | unknown[];

function isContainer(value: unknown): value is Container {
  return typeof value === "object" && value !== null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return isContainer(value) && !Array.isArray(value);
}

function arrayIndex(arr: unknown[], key: string, allowEnd: boolean): number {
  if (allowEnd && key === "-") return arr.length;
  if (!/^(0|[1-9]\d*)$/.test(key)) throw new Error(`invalid array index: ${key}`);
  const index = Number(key);
  const max = allowEnd ? arr.length : arr.length - 1;
  if (index > max) throw new Error(`array index out of range: ${key}`);
  return index;
}

function resolveParent(doc: unknown, parts: string[]): { parent: Container; key: string } {
  let node = doc;
  for (const part of parts.slice(0, -1)) {
    if (Array.isArray(node)) node = node[arrayIndex(node, part, false)];
    else if (isRecord(node) && Object.hasOwn(node, part)) node = node[part];
    else throw new Error(`path not found at "${part}"`);
  }
  if (!isContainer(node)) throw new Error("path parent is not an object or array");
  return { parent: node, key: parts[parts.length - 1] as string };
}

function getValue(doc: unknown, parts: string[]): unknown {
  let node = doc;
  for (const part of parts) {
    if (Array.isArray(node)) node = node[arrayIndex(node, part, false)];
    else if (isRecord(node) && Object.hasOwn(node, part)) node = node[part];
    else throw new Error(`path not found at "${part}"`);
  }
  return node;
}

function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (Array.isArray(a) || Array.isArray(b)) {
    return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((item, i) => deepEqual(item, b[i]));
  }
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => Object.hasOwn(b, key) && deepEqual(a[key], b[key]));
}

/**
 * Applies ops to a deep copy of doc and returns the copy. Paths whose first
 * segment is in `protectedKeys` are refused. Throws PatchError on any failure,
 * leaving doc untouched.
 */
export function applyPatch<T>(doc: T, ops: PatchOp[], protectedKeys: readonly string[] = []): T {
  const copy = structuredClone(doc) as unknown;
  ops.forEach((op, index) => {
    try {
      const parts = parsePointer(op.path);
      if (parts.length === 0) throw new Error("cannot patch the document root");
      if (parts.some((part) => part === "__proto__" || part === "constructor" || part === "prototype")) {
        throw new Error("forbidden path segment");
      }
      if (protectedKeys.includes(parts[0] as string)) throw new Error(`"/${parts[0]}" is set by the server`);
      if (op.op === "test") {
        if (!deepEqual(getValue(copy, parts), op.value)) throw new Error(`test failed at ${op.path}`);
        return;
      }
      const { parent, key } = resolveParent(copy, parts);
      if (Array.isArray(parent)) {
        if (op.op === "add") parent.splice(arrayIndex(parent, key, true), 0, structuredClone(op.value));
        else if (op.op === "replace") parent[arrayIndex(parent, key, false)] = structuredClone(op.value);
        else parent.splice(arrayIndex(parent, key, false), 1);
        return;
      }
      if (op.op === "add") {
        parent[key] = structuredClone(op.value);
      } else {
        if (!Object.hasOwn(parent, key)) throw new Error(`path not found: ${op.path}`);
        if (op.op === "replace") parent[key] = structuredClone(op.value);
        else delete parent[key];
      }
    } catch (error) {
      if (error instanceof PatchError) throw error;
      throw new PatchError(`op ${index} (${op.op} ${op.path}): ${(error as Error).message}`, index);
    }
  });
  return copy as T;
}

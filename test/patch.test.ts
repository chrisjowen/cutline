import { describe, expect, it } from "vitest";
import { applyPatch, PatchError, parsePointer } from "../src/shared/patch.js";

describe("applyPatch", () => {
  const doc = { name: "a", tags: ["x", "y"], nested: { "a/b": 1, "c~d": 2 } };

  it("adds, replaces and removes object keys and array items without touching the input", () => {
    const out = applyPatch(doc, [
      { op: "replace", path: "/name", value: "b" },
      { op: "add", path: "/tags/-", value: "z" },
      { op: "add", path: "/tags/0", value: "w" },
      { op: "remove", path: "/tags/1" },
      { op: "replace", path: "/nested/a~1b", value: 3 },
      { op: "remove", path: "/nested/c~0d" },
    ]);
    expect(out).toEqual({ name: "b", tags: ["w", "y", "z"], nested: { "a/b": 3 } });
    expect(doc.tags).toEqual(["x", "y"]);
  });

  it("supports test ops as preconditions, regardless of key order", () => {
    expect(applyPatch(doc, [{ op: "test", path: "/nested", value: { "c~d": 2, "a/b": 1 } }])).toEqual(doc);
    expect(() => applyPatch(doc, [{ op: "test", path: "/name", value: "nope" }])).toThrow(PatchError);
  });

  it("fails on missing paths, bad indexes, protected keys and prototype keys", () => {
    expect(() => applyPatch(doc, [{ op: "replace", path: "/missing", value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: "remove", path: "/tags/5" }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: "add", path: "/tags/01", value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: "replace", path: "/name", value: 1 }], ["name"])).toThrow(/set by the server/);
    expect(() => applyPatch(doc, [{ op: "add", path: "/__proto__/polluted", value: 1 }])).toThrow(PatchError);
    expect(() => applyPatch(doc, [{ op: "replace", path: "", value: {} }])).toThrow(PatchError);
  });

  it("parses JSON pointers with escapes", () => {
    expect(parsePointer("/a~1b/c~0d/0")).toEqual(["a/b", "c~d", "0"]);
    expect(() => parsePointer("no-slash")).toThrow();
  });
});

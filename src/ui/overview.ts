// A project's home screen: everything captured and created, with counts.
// Phase 0 has nothing to list yet, but the project name and product autosave
// to cutline.json and the page follows changes made in other tabs.
import type { Manifest } from "../shared/manifest.js";
import type { PatchOp } from "../shared/patch.js";
import { api, ApiError } from "./api.js";
import { h, relativeTime, toast } from "./dom.js";

const SAVE_DELAY_MS = 500;

/** Loads the manifest, reopening the project from recents when the server was restarted. */
async function loadManifest(pid: string): Promise<Manifest | null> {
  try {
    return await api.manifest(pid);
  } catch (error) {
    if (!(error instanceof ApiError) || error.code !== "project-not-open") throw error;
  }
  const recent = (await api.recents()).find((entry) => entry.id === pid && entry.exists);
  if (!recent) return null;
  const project = await api.open(recent.path);
  return api.manifest(project.id);
}

function section(title: string, count: number, empty: string, ...content: Node[]): HTMLElement {
  return h(
    "section",
    { class: "card overview-section" },
    h("header", { class: "section-head" }, h("h2", {}, title), h("span", { class: "count" }, String(count))),
    ...(content.length ? content : [h("p", { class: "empty" }, empty)]),
  );
}

export async function renderOverview(root: HTMLElement, pid: string): Promise<() => void> {
  let manifest = await loadManifest(pid);
  if (!manifest) {
    toast("That project is not open and is not in your recent projects.", "error");
    location.hash = "#/";
    return () => {};
  }
  let projectRoot = "";
  try {
    projectRoot = (await api.recents()).find((entry) => entry.id === pid)?.path ?? "";
  } catch {
    // The path is only shown for orientation.
  }

  const status = h("span", { class: "save-status", role: "status" });
  const showSaved = () => {
    status.textContent = `Saved · rev ${manifest?.rev}`;
    status.className = "save-status";
  };

  // Autosave: edits are queued per field and sent as one patch after a short pause.
  const pending = new Map<string, unknown>();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let saving = false;
  async function flush(): Promise<void> {
    if (saving || !pending.size || !manifest) return;
    saving = true;
    const ops: PatchOp[] = [...pending].map(([path, value]) => ({ op: "replace", path, value }));
    pending.clear();
    status.textContent = "Saving…";
    try {
      manifest = await api.patch(pid, manifest.rev, ops);
      showSaved();
    } catch (error) {
      if (error instanceof ApiError && error.code === "rev-conflict") {
        // Someone else saved first: take their revision, then reapply our edit on top.
        manifest = await api.manifest(pid);
        for (const op of ops) if (op.op === "replace" && !pending.has(op.path)) pending.set(op.path, op.value);
      } else {
        status.textContent = `Not saved: ${error instanceof Error ? error.message : String(error)}`;
        status.className = "save-status save-error";
      }
    } finally {
      saving = false;
    }
    if (pending.size) void flush();
  }
  function queue(path: string, value: unknown): void {
    pending.set(path, value);
    status.textContent = "Editing…";
    clearTimeout(timer);
    timer = setTimeout(() => void flush(), SAVE_DELAY_MS);
  }

  const nameInput = h("input", {
    name: "name",
    class: "title-input",
    value: manifest.name,
    "aria-label": "Project name",
    maxlength: 200,
    oninput: () => {
      const name = nameInput.value.trim();
      if (name) queue("/name", name);
    },
  });
  const productInput = h("input", {
    class: "input",
    value: manifest.product,
    name: "product",
    placeholder: "e.g. Wheelhouse",
    "aria-label": "Product",
    oninput: () => queue("/product", productInput.value),
  });

  const body = h("div", { class: "overview-grid" });
  const renderBody = (m: Manifest) => {
    const timelines = m.timelines.map((timeline) =>
      h(
        "div",
        { class: "row" },
        h("span", { class: "row-title" }, timeline.name),
        h("span", { class: "row-meta" }, `${timeline.items.length} items`),
      ),
    );
    body.replaceChildren(
      section("Sources", m.sources.length, "Nothing captured yet. Recording sections and importing videos arrive with Capture mode."),
      section("Clips", m.clips.length, "No clips yet. Carve labelled clips from your sources in Edit mode."),
      section("Timelines", m.timelines.length, "No timelines.", ...timelines),
      section("Exports", m.exports.length, "No exports yet."),
    );
  };
  renderBody(manifest);
  showSaved();

  // Follow changes from other tabs.
  const events = api.events(pid);
  events.addEventListener("manifest", (event) => {
    const { rev } = JSON.parse((event as MessageEvent<string>).data) as { rev: number };
    if (!manifest || rev <= manifest.rev || saving) return;
    void api.manifest(pid).then((fresh) => {
      manifest = fresh;
      if (document.activeElement !== nameInput && !pending.has("/name")) nameInput.value = fresh.name;
      if (document.activeElement !== productInput && !pending.has("/product")) productInput.value = fresh.product;
      renderBody(fresh);
      showSaved();
    });
  });
  events.addEventListener("closed", () => {
    toast("This project was closed.");
    location.hash = "#/";
  });

  const modeTab = (label: string, active: boolean, hint?: string) =>
    h("button", { type: "button", class: active ? "mode active" : "mode", disabled: !active, title: hint, "aria-current": active ? "page" : undefined }, label);

  root.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "#/", title: "All projects" }, "Cutline"),
      h(
        "nav",
        { class: "modes", "aria-label": "Mode" },
        modeTab("Overview", true),
        modeTab("Capture", false, "Capture mode arrives in the next phase"),
        modeTab("Edit", false, "Edit mode arrives in a later phase"),
      ),
      status,
      h(
        "button",
        {
          type: "button",
          class: "btn btn-small",
          onclick: () => {
            void flush().finally(() => {
              void api.close(pid).catch(() => {});
              location.hash = "#/";
            });
          },
        },
        "Close project",
      ),
    ),
    h(
      "main",
      { class: "page overview-page" },
      h(
        "section",
        { class: "project-head" },
        nameInput,
        h(
          "div",
          { class: "project-meta" },
          projectRoot ? h("code", { class: "path" }, projectRoot) : null,
          h(
            "button",
            { type: "button", class: "btn btn-small", onclick: () => void api.reveal(pid).catch(() => {}) },
            "Reveal in Finder",
          ),
          h("span", { class: "row-meta" }, `Created ${relativeTime(manifest.created)}`),
        ),
        h("label", { class: "label" }, "Product", h("span", { class: "hint-inline" }, " — named in scripts and titles"), productInput),
      ),
      body,
    ),
  );

  return () => {
    events.close();
    clearTimeout(timer);
    void flush();
  };
}

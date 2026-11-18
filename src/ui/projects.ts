// The Projects screen: recent projects, New project and Open project.
import { api, ApiError, type Info, type RecentProject } from "./api.js";
import { ask, h, relativeTime, toast } from "./dom.js";
import { browseFolders } from "./folder-browser.js";

function goToProject(id: string): void {
  location.hash = `#/p/${encodeURIComponent(id)}`;
}

/** Picks a folder with the native dialog, or the in-app browser when there is none. */
async function pickFolder(info: Info, prompt: string, start: string): Promise<string | null> {
  if (info.picker) {
    try {
      const result = await api.pick("folder", prompt, start);
      return "path" in result ? result.path : null;
    } catch (error) {
      if (!(error instanceof ApiError) || error.code !== "picker-unavailable") throw error;
    }
  }
  return browseFolders(prompt, start);
}

/** Opens a folder as a project, offering to create one in an empty folder or take over a lock. */
export async function openFolder(path: string): Promise<void> {
  try {
    goToProject((await api.open(path)).id);
  } catch (error) {
    if (!(error instanceof ApiError)) throw error;
    if (error.code === "not-a-project" && error.details.empty) {
      const name = String(error.details.suggestedName ?? "Untitled");
      const ok = await ask("Make this a project?", `${path} is empty. Make it a Cutline project called “${name}”?`, "Make project");
      if (ok) goToProject((await api.create({ name, path })).id);
      return;
    }
    if (error.code === "locked") {
      const holder = error.details.holder as { port?: number } | undefined;
      const ok = await ask(
        "Open in another Cutline",
        `This project is open in another Cutline window (port ${holder?.port ?? "?"}). Taking it over stops that one from saving.`,
        "Take over",
        true,
      );
      if (ok) goToProject((await api.open(path, true)).id);
      return;
    }
    throw error;
  }
}

export async function renderProjects(root: HTMLElement): Promise<() => void> {
  const [info, recents] = await Promise.all([api.info(), api.recents()]);
  let parent = info.defaultRoot;

  const run = (task: () => Promise<void>) => () => {
    task().catch((error: unknown) => toast(error instanceof Error ? error.message : String(error), "error"));
  };

  // New project
  const nameInput = h("input", {
    id: "project-name",
    name: "name",
    class: "input",
    placeholder: "How to use Wheelhouse",
    autocomplete: "off",
    required: true,
  });
  const locationText = h("code", { class: "path" }, parent);
  const target = h("p", { class: "hint" });
  const updateTarget = () => {
    const name = nameInput.value.trim().replace(/[/:\\]/g, "-");
    target.textContent = name ? `Creates ${parent.replace(/\/$/, "")}/${name}` : "Each project is a folder; everything for it is saved there.";
  };
  nameInput.addEventListener("input", updateTarget);
  updateTarget();

  const newForm = h(
    "form",
    {
      class: "card new-project",
      hidden: true,
      onsubmit: (event: Event) => {
        event.preventDefault();
        run(async () => {
          const name = nameInput.value.trim();
          if (!name) return;
          goToProject((await api.create({ name, parent })).id);
        })();
      },
    },
    h("h2", {}, "New project"),
    h("label", { for: "project-name", class: "label" }, "Name"),
    nameInput,
    h("span", { class: "label" }, "Location"),
    h(
      "div",
      { class: "location-row" },
      locationText,
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: run(async () => {
            const chosen = await pickFolder(info, "Where should the project folder go?", parent);
            if (chosen) {
              parent = chosen;
              locationText.textContent = chosen;
              updateTarget();
            }
          }),
        },
        "Choose…",
      ),
    ),
    target,
    h(
      "div",
      { class: "form-actions" },
      h("button", { type: "button", class: "btn", onclick: () => (newForm.hidden = true) }, "Cancel"),
      h("button", { type: "submit", class: "btn btn-primary" }, "Create project"),
    ),
  );

  // Open by typed path (fallback)
  const pathInput = h("input", { name: "path", class: "input", placeholder: "~/Movies/Cutline/My project", autocomplete: "off" });
  const openByPath = h(
    "details",
    { class: "open-path" },
    h("summary", {}, "Open a folder by path"),
    h(
      "form",
      {
        class: "location-row",
        onsubmit: (event: Event) => {
          event.preventDefault();
          if (pathInput.value.trim()) run(() => openFolder(pathInput.value.trim()))();
        },
      },
      pathInput,
      h(
        "button",
        {
          type: "button",
          class: "btn",
          onclick: run(async () => {
            const chosen = await browseFolders("Open a project folder", info.defaultRoot);
            if (chosen) pathInput.value = chosen;
          }),
        },
        "Browse…",
      ),
      h("button", { type: "submit", class: "btn btn-primary" }, "Open"),
    ),
  );

  // Recents
  const list = h("ul", { class: "recents" });
  const recentItem = (recent: RecentProject) => {
    const li = h("li", { class: recent.exists ? "recent" : "recent recent-missing" });
    li.append(
      h(
        "button",
        {
          type: "button",
          class: "recent-open",
          disabled: !recent.exists,
          title: recent.exists ? `Open ${recent.path}` : "This folder has moved or been deleted",
          onclick: run(() => openFolder(recent.path)),
        },
        h("span", { class: "recent-name" }, recent.name),
        h("span", { class: "recent-path" }, recent.path),
        h("span", { class: "recent-when" }, recent.exists ? relativeTime(recent.openedAt) : "missing"),
      ),
      h(
        "button",
        {
          type: "button",
          class: "icon-btn",
          title: "Remove from recents (the folder is not touched)",
          "aria-label": `Remove ${recent.name} from recents`,
          onclick: run(async () => {
            await api.removeRecent(recent.path);
            li.remove();
            if (!list.children.length) list.replaceWith(emptyRecents);
          }),
        },
        "×",
      ),
    );
    return li;
  };
  list.append(...recents.map(recentItem));
  const emptyRecents = h("p", { class: "empty" }, "No projects yet. Create one to get started.");

  root.replaceChildren(
    h(
      "header",
      { class: "topbar" },
      h("a", { class: "brand", href: "#/" }, "Cutline"),
      h("span", { class: "topbar-meta" }, `v${info.version}`),
    ),
    h(
      "main",
      { class: "page projects-page" },
      h(
        "section",
        { class: "hero" },
        h("h1", {}, "Projects"),
        h(
          "p",
          { class: "lede" },
          "A project is a folder on your disk. Recordings, imports, scripts, narration, exports and your edits are all saved there, so you can close Cutline and pick up where you left off.",
        ),
        h(
          "div",
          { class: "hero-actions" },
          h(
            "button",
            {
              type: "button",
              class: "btn btn-primary btn-large",
              onclick: () => {
                newForm.hidden = false;
                nameInput.focus();
              },
            },
            "New project",
          ),
          h(
            "button",
            {
              type: "button",
              class: "btn btn-large",
              onclick: run(async () => {
                const chosen = await pickFolder(info, "Open a Cutline project folder", info.defaultRoot);
                if (chosen) await openFolder(chosen);
              }),
            },
            "Open project…",
          ),
        ),
      ),
      newForm,
      h("section", { class: "recents-section" }, h("h2", {}, "Recent"), recents.length ? list : emptyRecents),
      openByPath,
    ),
  );
  return () => {};
}

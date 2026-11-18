// In-app folder browser: the fallback for when the native Finder dialog is
// not available. Resolves the chosen folder, or null when cancelled.
import { api, ApiError, type FolderListing } from "./api.js";
import { h } from "./dom.js";

export function browseFolders(title: string, start?: string): Promise<string | null> {
  return new Promise((resolve) => {
    let current: FolderListing | null = null;
    const crumb = h("code", { class: "browser-path" });
    const list = h("ul", { class: "browser-list" });
    const error = h("p", { class: "form-error", hidden: true });
    const up = h("button", { type: "button", class: "btn btn-small", onclick: () => current?.parent && load(current.parent) }, "↑ Up");
    const choose = h("button", { value: "ok", class: "btn btn-primary" }, "Choose this folder");

    async function load(path?: string) {
      try {
        current = await api.listFolders(path);
        error.hidden = true;
      } catch (e) {
        error.textContent = e instanceof ApiError ? e.message : String(e);
        error.hidden = false;
        if (current) return;
        current = await api.listFolders();
      }
      crumb.textContent = current.path;
      up.disabled = current.parent === null;
      list.replaceChildren(
        ...(current.folders.length
          ? current.folders.map((folder) =>
              h(
                "li",
                {},
                h(
                  "button",
                  { type: "button", class: "browser-item", onclick: () => load(folder.path) },
                  h("span", { class: "folder-icon", "aria-hidden": "true" }, folder.isProject ? "◆" : "▸"),
                  folder.name,
                  folder.isProject ? h("span", { class: "badge" }, "project") : null,
                ),
              ),
            )
          : [h("li", { class: "browser-empty" }, "No folders here")]),
      );
    }

    const dialog = h(
      "dialog",
      { class: "modal modal-wide" },
      h("h2", {}, title),
      h("div", { class: "browser-bar" }, up, crumb),
      list,
      error,
      h(
        "form",
        { method: "dialog", class: "modal-actions" },
        h("button", { value: "cancel", class: "btn" }, "Cancel"),
        choose,
      ),
    );
    dialog.addEventListener("close", () => {
      resolve(dialog.returnValue === "ok" && current ? current.path : null);
      dialog.remove();
    });
    document.body.append(dialog);
    dialog.showModal();
    void load(start);
  });
}

import { ApiError } from "./api.js";
import { h } from "./dom.js";
import { renderOverview } from "./overview.js";
import { renderProjects } from "./projects.js";
import "./styles.css";

const root = document.getElementById("app") as HTMLElement;
let cleanup: () => void = () => {};

function renderNoSession(): void {
  root.replaceChildren(
    h(
      "main",
      { class: "page center" },
      h("h1", {}, "Cutline"),
      h(
        "p",
        { class: "lede" },
        "This tab is not connected to the running Cutline. Open Cutline with the link the ",
        h("code", {}, "cutline"),
        " command printed in your terminal (it also opens it for you).",
      ),
    ),
  );
}

async function route(): Promise<void> {
  cleanup();
  cleanup = () => {};
  const match = /^#\/p\/([^/]+)/.exec(location.hash);
  try {
    cleanup = match ? await renderOverview(root, decodeURIComponent(match[1] as string)) : await renderProjects(root);
  } catch (error) {
    if (error instanceof ApiError && error.status === 401) return renderNoSession();
    root.replaceChildren(
      h(
        "main",
        { class: "page center" },
        h("h1", {}, "Something went wrong"),
        h("p", { class: "lede" }, error instanceof Error ? error.message : String(error)),
        h("a", { class: "btn", href: "#/" }, "Back to projects"),
      ),
    );
  }
}

window.addEventListener("hashchange", () => void route());
void route();

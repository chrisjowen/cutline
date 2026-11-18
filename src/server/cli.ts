#!/usr/bin/env node
// `cutline`: starts the local server and opens the UI in the browser.
import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { startServer, type RunningServer } from "./app.js";
import { defaultPicker } from "./picker.js";

const DEFAULT_PORT = 5417;
const here = dirname(fileURLToPath(import.meta.url));

const USAGE = `Usage: cutline [options]

  --port <n>          port to listen on (default ${DEFAULT_PORT}, or a free one if taken)
  --root <dir>        default folder for new projects (default ~/Movies/Cutline)
  --config-dir <dir>  app settings and recent projects (default ~/.config/cutline)
  --no-open           do not open the browser
  -h, --help          show this help
`;

function findUiDir(): string | null {
  // dist/server/cli.js -> dist/ui; src/server/cli.ts (dev) -> dist/ui
  for (const candidate of [join(here, "../ui"), join(here, "../../dist/ui")]) {
    if (existsSync(join(candidate, "index.html"))) return candidate;
  }
  return null;
}

function readVersion(): string {
  try {
    const pkg = JSON.parse(readFileSync(join(here, "../../package.json"), "utf8")) as { version?: string };
    return pkg.version ?? "0.0.0";
  } catch {
    return "0.0.0";
  }
}

function openBrowser(url: string): void {
  const command = process.platform === "darwin" ? "open" : process.platform === "win32" ? "explorer" : "xdg-open";
  execFile(command, [url], () => {});
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      port: { type: "string" },
      root: { type: "string" },
      "config-dir": { type: "string" },
      "no-open": { type: "boolean", default: false },
      help: { type: "boolean", short: "h", default: false },
    },
  });
  if (values.help) {
    process.stdout.write(USAGE);
    return;
  }
  const portText = values.port ?? process.env.CUTLINE_PORT;
  const port = portText === undefined ? DEFAULT_PORT : Number(portText);
  if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error(`invalid port: ${portText}`);

  const options = {
    port,
    configDir: resolve(values["config-dir"] ?? process.env.CUTLINE_CONFIG_DIR ?? join(homedir(), ".config", "cutline")),
    defaultRoot: resolve(values.root ?? process.env.CUTLINE_DEFAULT_ROOT ?? join(homedir(), "Movies", "Cutline")),
    uiDir: findUiDir(),
    picker: defaultPicker(),
    version: readVersion(),
  };

  let running: RunningServer;
  try {
    running = await startServer(options);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EADDRINUSE" || portText !== undefined) throw error;
    running = await startServer({ ...options, port: 0 });
  }

  process.stdout.write(`Cutline ${options.version} is running.\nOpen: ${running.launchUrl}\n`);
  if (!options.uiDir) process.stdout.write("Note: the UI is not built yet; run `npm run build`.\n");
  if (!values["no-open"]) openBrowser(running.launchUrl);

  // Locks must not outlive the server, or the next launch would see them as held.
  process.on("exit", () => running.projects.releaseAllSync());
  let stopping = false;
  const stop = () => {
    if (stopping) process.exit(1);
    stopping = true;
    running.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

main().catch((error: unknown) => {
  process.stderr.write(`cutline: ${(error as Error).message}\n`);
  process.exit(1);
});

// Native macOS file and folder dialogs, opened by the server with osascript
// so the chosen path is a real filesystem path (never a browser handle).
import { execFile } from "node:child_process";

export type PickKind = "folder" | "file";
export type PickResult = { path: string } | { cancelled: true };
export type Picker = (kind: PickKind, options: { prompt: string; defaultLocation?: string }) => Promise<PickResult>;

// The prompt and default location are passed as argv, never spliced into the
// script, so no path or prompt text can change what the script does.
function script(kind: PickKind, withLocation: boolean): string[] {
  const command = kind === "folder" ? "choose folder" : "choose file";
  const location = withLocation ? " default location (POSIX file (item 2 of argv))" : "";
  return [
    "on run argv",
    "activate",
    `set chosen to ${command} with prompt (item 1 of argv)${location}`,
    "return POSIX path of chosen",
    "end run",
  ];
}

export const macPicker: Picker = (kind, { prompt, defaultLocation }) =>
  new Promise((resolvePick, reject) => {
    const args = script(kind, Boolean(defaultLocation)).flatMap((line) => ["-e", line]);
    args.push(prompt);
    if (defaultLocation) args.push(defaultLocation);
    execFile("osascript", args, { timeout: 30 * 60 * 1000 }, (error, stdout, stderr) => {
      if (error) {
        // -128 is "User canceled."
        if (/-128/.test(stderr)) resolvePick({ cancelled: true });
        else reject(new Error(stderr.trim() || error.message));
        return;
      }
      const path = stdout.trim();
      resolvePick({ path: path.length > 1 ? path.replace(/\/$/, "") : path });
    });
  });

export function defaultPicker(): Picker | null {
  return process.platform === "darwin" ? macPicker : null;
}

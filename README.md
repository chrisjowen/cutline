# Cutline

A local, project-based screencast tool: capture screen + talk-over sections over time, import videos, carve and stitch clips, AI-written scene scripts, cloned-voice narration, subtitles and export. Single user, runs on localhost.

Cutline is two parts: a small Node server bound to `127.0.0.1`, and a browser UI (Chrome) that it serves. Every project is an ordinary folder on disk, and the server is the only thing that writes to it, so you can close the tab or quit Cutline and reopen the project exactly where you left off.

> **Status: Phase 0 (foundation).** Projects (create, open, recents), the project manifest with autosave, revisions and snapshots, and an empty Overview. Capture, editing and AI arrive in later phases.

## Run it

Needs Node 22 or newer.

```sh
npm install
npm start          # builds the UI and server, starts Cutline and opens the browser
```

`cutline` prints a launch link such as `http://127.0.0.1:5417/?token=…` and opens it. That link carries a per-run token; opening it sets a session cookie for this run. If you open Cutline in a new browser later, use the link printed in the terminal.

Options:

```
--port <n>          port to listen on (default 5417, or a free one if taken)
--root <dir>        default folder for new projects (default ~/Movies/Cutline)
--config-dir <dir>  app settings and recent projects (default ~/.config/cutline)
--no-open           do not open the browser
```

The same settings can be given as `CUTLINE_PORT`, `CUTLINE_DEFAULT_ROOT` and `CUTLINE_CONFIG_DIR`.

### Development

```sh
npm run dev        # rebuilds the UI on change and restarts the server on change
npm run check      # typecheck + lint + tests
npm test
```

## Projects

- **New project** asks for a name and a location (default `~/Movies/Cutline/`) and creates `<location>/<name>/`. **Choose…** opens the native macOS folder dialog, run by the server.
- **Open project…** opens the native dialog. A folder containing `cutline.json` opens; an empty folder can be made into a project.
- **Open a folder by path** is the fallback: type a path, or browse folders in your home folder.
- **Recent** projects are kept in `~/.config/cutline/recents.json`.

A project folder looks like this (later phases fill in `sources/`, `derived/`, `narration/` and `exports/`):

```
My project/
  cutline.json              manifest and all edit state
  .cutline/
    lock                    pid + port of the Cutline server editing this project
    snapshots/cutline.<rev>.json   the last 50 revisions of cutline.json
```

### `cutline.json`

Schema `cutline.project/1` (see `src/shared/manifest.ts`): project id and name, `rev`, timestamps, product, settings, sources, clips, timelines, exports, and the `ui` state that "resume where I left off" restores.

- **Atomic writes:** `cutline.json.tmp` is written and fsynced, then renamed over `cutline.json`.
- **Revisions:** every change bumps `rev`; the previous file is copied to `.cutline/snapshots/` first.
- **Patches:** the UI sends `{baseRev, ops}` (JSON Patch `add`/`remove`/`replace`/`test`). A patch against an old `baseRev` is refused with `409`, so two tabs never silently overwrite each other. The result must still be a valid manifest.
- **Live updates:** each new revision is pushed to open tabs over server-sent events.
- **Restore:** a snapshot can be restored; the restore is itself a new revision, so it can be undone.

### Lock

Opening a project writes `.cutline/lock`. A second Cutline server refuses to open a project whose lock holder is still running (it can take it over only when asked to explicitly). A lock left by a process that has exited is taken over silently. Locks are released on close and when the server exits.

## Security

The server only listens on `127.0.0.1` and:

- refuses any request whose `Host` is not `127.0.0.1:<port>` or `localhost:<port>` (DNS rebinding);
- refuses requests with a foreign `Origin` or a cross-site `Sec-Fetch-Site`;
- requires the per-run token (session cookie `SameSite=Strict`, or an `X-Cutline-Token` header) for every `/api/` and `/media/` request;
- serves project files only from inside the open project root (no `..`, no symlink escapes, nothing under `.cutline/`).

## API (Phase 0)

```
GET  /api/info
GET  /api/projects/recent                 POST /api/projects/recent/remove {path}
POST /api/projects {name, parent?|path?}  POST /api/projects/open {path, force?}
GET  /api/projects/open
POST /api/pick {kind: "folder"|"file"}    GET  /api/fs/list?path=
GET  /api/p/:pid/manifest                 PATCH /api/p/:pid/manifest {baseRev, ops}
GET  /api/p/:pid/snapshots                POST /api/p/:pid/snapshots/:rev/restore {baseRev?}
GET  /api/p/:pid/events  (SSE)            POST /api/p/:pid/close · POST /api/p/:pid/reveal
GET  /media/:pid/<path inside project>    (HTTP Range)
```

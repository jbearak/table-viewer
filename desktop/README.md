# Table Viewer desktop app

Standalone Electron shell for Table Viewer. It reuses the shared viewer controller (`src/viewer-controller.ts`), the state store, and the same webview bundle as the VS Code extension; only the shell (windows, tabs, menus, dialogs, preferences, custom `tv-app://` protocol) is desktop-specific.

## Prerequisites

- Node.js >= 24 and `npm install` at the repo root.

## Run in development

```sh
npm run desktop:dev
```

This builds `dist/webview` (shared with the extension) and `dist/desktop` (main process, preloads, shell/prefs renderers via `desktop/build.mjs`), then launches Electron. Open files via **File → Open…**, the command line (`electron dist/desktop/main.js path/to/file.csv`), or Finder "Open with…" once packaged.

## Packaging (unsigned local macOS builds)

```sh
npm run desktop:package       # dmg + zip in dist/desktop-packages/
npm run desktop:package:dir   # unpacked .app only (faster, for local checks)
```

v1 ships unsigned builds only: no code signing, notarization, or auto-update. Gatekeeper will warn on first launch of an unsigned app (right-click → Open, or `xattr -dr com.apple.quarantine "Table Viewer.app"`).

The config lives in `desktop/electron-builder.yml`:

- File associations declare the app as *a* handler for `csv`/`tsv`/`xlsx`/`xls` (`rank: Alternate`) so it appears in "Open with…" without claiming default-handler status.
- The app bundle contains only the esbuild outputs (`dist/desktop`, `dist/webview`) plus `package.json` — no `node_modules`.
- License notices for the GPL-3.0 app are shipped in `Contents/Resources`: `LICENSE.txt` (Table Viewer), `THIRD_PARTY_NOTICES.txt` (generated from the production npm dependency closure by `desktop/collect-licenses.mjs`), `LICENSE.electron.txt`, and `LICENSES.chromium.html`.

## Smoke test

```sh
npm run test:desktop-smoke
```

A Playwright Electron test (`desktop/test-smoke/`) launches the built dev bundle with a csv and an xlsx fixture, asserts both viewer tabs render the data grid, applies/clears a column sort, and drives the Edit menu's Copy and Select All against the grid. It runs the real app binary, so it is kept separate from the vitest suite and is not wired into CI (the GitHub Actions Linux runner would need xvfb plus Electron sandbox flags; run it locally on a desktop OS instead).

The app honors `TABLE_VIEWER_USER_DATA_DIR` to relocate `userData` (settings, state store, single-instance lock); the smoke test uses it to isolate each run in a temp directory.

## State and settings

- Per-file view state: `userData/state/tableViewer.fileState.v1.json` (same envelope schema as the VS Code extension's globalState store; not shared between the two in v1).
- Preferences: `userData/settings.v1.json`, edited via the Preferences window (**Cmd+,**).

The font family and font size preferences style the whole app — tab bar, table views, and the Preferences window itself — mirroring how the extension's font settings apply to its entire UI. Worksheet tabs default to a vertical orientation.

## Zoom

The main window is several `webContents`: the tab-bar renderer plus one `WebContentsView` per open file. Electron's stock zoom roles act on whichever one has focus, which would scale the tab bar or the table in isolation, so **View → Zoom In / Zoom Out / Actual Size** (`Cmd/Ctrl` with `+`, `-`, `0`) instead drive one shared zoom level in `desktop/main/zoom.ts`, applied to every `webContents` at once. Tab-bar height is expressed in the renderer's CSS pixels, so `TabManager` scales the per-tab view bounds by the same factor.

## Edit menu

The Edit menu is hand-built rather than `role: 'editMenu'`. The stock menu's Undo, Redo, Delete, and Paste and Match Style items have nothing to act on — there is no undo model, and the grid is a canvas with no DOM selection — so they are omitted. Cut and Paste keep their native roles, because the one place they mean anything is the CSV cell editor's text field, which is exactly what those roles operate on.

Copy and Select All are custom items. Their native roles would both do nothing on the canvas *and* claim `Cmd/Ctrl+C` / `Cmd/Ctrl+A` before the page could handle them (on macOS an application-menu key equivalent never reaches the renderer). Instead, `route_edit_command` in `desktop/main/main.ts` forwards the intent to the active viewer tab as an `editCommand` host message; `src/webview/edit-command.ts` then decides whether the focused text field or the grid should receive it. Menu clicks in any other window (Preferences, whose fields are ordinary inputs) fall back to the native editing command. Routing keys off the window Electron reports with the click, not a separately sampled focus — sampling focus is racy and can silently drop the command.

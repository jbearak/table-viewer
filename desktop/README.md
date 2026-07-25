# Table Viewer desktop app

Standalone Electron shell for Table Viewer. It reuses the shared viewer controller (`src/viewer-controller.ts`), the state store, and the same webview bundle as the VS Code extension; only the shell (windows, menus, dialogs, preferences, custom `tv-app://` protocol) is desktop-specific.

## Windows

Every open file gets its own window (`desktop/main/viewer-windows.ts`), so spreadsheets can be resized, moved, and shown side by side — the way an Excel user expects, and more flexible than a tab strip. Opening a file that is already open focuses its window instead of loading it twice.

With no file open the app shows a small welcome window (`desktop/renderer/welcome.html`), which offers **Open File…** and **Preferences…** (the latter lives in the app menu on macOS and under File elsewhere); **File → New Window** (`Cmd/Ctrl+N`) opens another one, and so does launching the app a second time with no file argument. Opening a file from a welcome window replaces it — a launcher has nothing to show once it has produced a viewer window — while **File → Open…** from a viewer window leaves that window on its own file. `Cmd/Ctrl+W` closes a window; as on any Mac app, closing the last one leaves the app running with just the menu bar (on Windows and Linux it quits).

New windows are placed by `desktop/main/window-geometry.ts`: the first is centered, each further one cascades down and right from the most recent, and every window is clamped to fit the display's work area — including a size remembered from a larger monitor. The last closed window's size is remembered in `settings.v1.json` (`windowWidth` / `windowHeight`, written by the app rather than the Preferences window) so the next window opens like the last one.

## Prerequisites

- Node.js >= 24 and `npm install` at the repo root.

## Run in development

```sh
npm run desktop:dev
```

This builds `dist/webview` (shared with the extension) and `dist/desktop` (main process, preloads, welcome/prefs renderers via `desktop/build.mjs`), then launches Electron. Open files via **File → Open…**, the command line (`electron dist/desktop/main.js path/to/file.csv`), or Finder "Open with…" once packaged.

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

Two Playwright Electron specs (`desktop/test-smoke/`) drive the built dev bundle. `desktop-smoke.spec.ts` launches it with a csv and an xlsx fixture and asserts each file opened in its own titled window with its grid rendered, that the windows are independently sized and zoomed, that a column sort applies and clears, and that the Edit menu's Copy and Select All reach the grid. `welcome-smoke.spec.ts` launches it with no file and covers the launcher plus File → New Window. They run the real app binary, so they are kept separate from the vitest suite and are not wired into CI (the GitHub Actions Linux runner would need xvfb plus Electron sandbox flags; run it locally on a desktop OS instead).

The app honors `TABLE_VIEWER_USER_DATA_DIR` to relocate `userData` (settings, state store, single-instance lock); the smoke test uses it to isolate each run in a temp directory.

## State and settings

- Per-file view state: `userData/state/tableViewer.fileState.v1.json` (same envelope schema as the VS Code extension's globalState store; not shared between the two in v1).
- Preferences: `userData/settings.v1.json`, edited via the Preferences window (**Cmd+,**).

The font family and font size preferences style the whole app — viewer windows, the welcome window, and the Preferences window itself — mirroring how the extension's font settings apply to its entire UI. Worksheet tabs (the sheet strip *inside* an Excel file) default to a vertical orientation.

The Appearance preference (`theme`) is `system` by default, which follows the OS light/dark setting; `light` and `dark` pin it. It is applied by handing the value to Electron's `nativeTheme.themeSource`, so the rest of the theming path is unchanged — everything downstream still reads `nativeTheme.shouldUseDarkColors` (see `desktop/main/theme.ts`).

## Unsaved CSV edits

Unsaved edits are durable: the shared controller persists `pendingEdits` per file in the state store and hands them back when the file is reopened, so closing a window does not lose a draft — it comes back where you left it (hot-exit semantics, the same as the VS Code extension). Closing therefore does not prompt.

Because the draft is invisible until then, the window says so instead: `desktop/main/dirty-state.ts` derives an "unsaved edits" flag from the viewer protocol messages already passing through `viewer-windows.ts`, and the window marks itself edited — a dot in the close button on macOS (`setDocumentEdited`, which needs the represented filename that is already set), a `•` before the file name in the title elsewhere. The flag comes from both directions, and needs both: the webview posts `pendingEditsChanged` while editing (and `null` after a save), but a draft *restored* from an earlier session arrives host → webview in `editSessionResult` / `workbookSnapshot`, since the webview only echoes `pendingEditsChanged` once it is in edit mode with a session.

## Zoom

**View → Zoom In / Zoom Out / Actual Size** (`Cmd/Ctrl` with `+`, `-`, `0`) zoom the focused window only, like a browser tab or Excel's per-workbook zoom. The menu items are custom rather than the stock zoom roles so the level stays inside the range in `desktop/main/zoom.ts`.

Chromium keys zoom by *origin*, so viewer windows sharing one host would silently share one zoom level. Each window therefore loads its own `tv-app://viewer-<n>/index.html` (`viewer_url` in `desktop/main/viewer-html.ts`); the protocol handler serves every `viewer-<n>` host from the same generated page.

## Edit menu

The Edit menu is hand-built rather than `role: 'editMenu'`. The stock menu's Undo, Redo, Delete, and Paste and Match Style items have nothing to act on — there is no undo model, and the grid is a canvas with no DOM selection — so they are omitted. Cut and Paste keep their native roles, because the one place they mean anything is the CSV cell editor's text field, which is exactly what those roles operate on.

Copy and Select All are custom items. Their native roles would both do nothing on the canvas *and* claim `Cmd/Ctrl+C` / `Cmd/Ctrl+A` before the page could handle them (on macOS an application-menu key equivalent never reaches the renderer). Instead, `route_edit_command` in `desktop/main/main.ts` forwards the intent to the viewer window the click came from as an `editCommand` host message; `src/webview/edit-command.ts` then decides whether the focused text field or the grid should receive it. Menu clicks in any other window (the welcome window, or Preferences, whose fields are ordinary inputs) fall back to the native editing command. Routing keys off the window Electron reports with the click, not a separately sampled focus — sampling focus is racy and can silently drop the command.

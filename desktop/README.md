# Table Viewer desktop app

Standalone Electron shell for Table Viewer. It reuses the shared viewer controller (`src/viewer-controller.ts`), the state store, and the same webview bundle as the VS Code extension; only the shell (windows, tabs, menus, dialogs, preferences, custom `tv-app://` protocol) is desktop-specific.

## Prerequisites

- Node.js >= 24 and `npm install` at the repo root.
- If your npm setup blocks package install scripts (e.g. an allow-scripts policy), the Electron binary is not downloaded automatically. Run it manually once:

  ```sh
  node node_modules/electron/install.js
  ```

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

A Playwright Electron test (`desktop/test-smoke/`) launches the built dev bundle with a csv and an xlsx fixture, asserts both viewer tabs render the data grid, and applies/clears a column sort. It runs the real app binary, so it is kept separate from the vitest suite and is not wired into CI (the GitHub Actions Linux runner would need xvfb plus Electron sandbox flags; run it locally on a desktop OS instead).

The app honors `TABLE_VIEWER_USER_DATA_DIR` to relocate `userData` (settings, state store, single-instance lock); the smoke test uses it to isolate each run in a temp directory.

## State and settings

- Per-file view state: `userData/state/tableViewer.fileState.v1.json` (same envelope schema as the VS Code extension's globalState store; not shared between the two in v1).
- Preferences: `userData/settings.json`, edited via the Preferences window (**Cmd+,**).

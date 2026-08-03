# Table Viewer desktop app

Standalone Electron shell for Table Viewer. It reuses the shared viewer controller (`src/viewer-controller.ts`), the state store, and the same webview bundle as the VS Code extension; only the shell (windows, menus, dialogs, preferences, custom `tv-app://` protocol) is desktop-specific.

## Windows

Every open file gets its own window (`desktop/main/viewer-windows.ts`), so spreadsheets can be resized, moved, and shown side by side — the way an Excel user expects, and more flexible than a tab strip. Opening a file that is already open focuses its window instead of loading it twice.

With no file open the app shows a small welcome window (`desktop/renderer/welcome.html`), which offers **Open File…** and **Preferences…** (the latter lives in the app menu on macOS and under File elsewhere); **File → New Window** (`Cmd/Ctrl+N`) opens another one, and so does launching the app a second time with no file argument. Opening a file from a welcome window replaces it — a launcher has nothing to show once it has produced a viewer window — while **File → Open…** from a viewer window leaves that window on its own file. `Cmd/Ctrl+W` closes a window; as on any Mac app, closing the last one leaves the app running with just the menu bar (on Windows and Linux it quits).

New windows are placed by `desktop/main/window-geometry.ts`: the first is centered, each further one cascades down and right from the most recent, and every window is clamped to fit the display's work area — including a size remembered from a larger monitor. How big a new window is comes from the **New window size** preference:

- **Match last window** (the default) follows the size you last gave a viewer window, picked up from the resize itself, so opening a second file mid-session matches the window you just sized without having to close it first. A maximized or fullscreen window is not followed — that size is a mode, not a preference. This is the native-app convention: window geometry is state the app keeps for you, so the width and height shown in Preferences are a readout rather than fields.
- **Fixed size** makes the width and height yours to type, and stops the app changing them, so resizing a window afterwards cannot rewrite what you set.

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

Both pass `-c.mac.identity=null`, so they never need a certificate. Gatekeeper will warn on first launch of an unsigned app (right-click → Open, or `xattr -dr com.apple.quarantine "Table Viewer.app"`).

`npm run desktop:package:release` is the same build *without* those overrides: it signs if a Developer ID certificate is available. CI uses it, and signs + notarizes once the Apple secrets are set — see [docs/homebrew-tap.md](../docs/homebrew-tap.md#signing).

## Packaging (Windows)

```sh
npm run desktop:package:win   # setup + portable exe, x64 + arm64
```

Must be run on Windows — electron-builder's NSIS and portable targets shell out to Windows tooling.

**This script is developer-only; no release publishes its output.** The desktop's view state lives in SQLite, and this build cannot open that database on Windows (see [State and settings](#state-and-settings) below), so a Windows exe built today would be a viewer whose settings never survive a restart. `release-build.yml`'s `desktop-windows` job therefore packages nothing. It reports that and **exits 0**: the macOS release still ships, because Windows being unproven must not withhold the platform that is proven. The missing-artifact guarantee lives in `release-publish.yml`, and which way it falls depends on the trigger — a publish from a pushed tag warns and continues, since the build run's own `success` conclusion is what vouches for it, while a hand-dispatched publish bypasses that conclusion check and therefore fails on an absent `windows-<tag>` artifact unless dispatched with `allow_missing_windows=true`. The rest of this section documents what the script produces locally and what a future unfenced Windows release would ship.

Four exes land in `dist/desktop-packages/`: `table-viewer-<version>-<arch>-setup.exe` and `table-viewer-<version>-<arch>-portable.exe` for each of `x64` and `arm64`. The per-target `artifactName` overrides in `electron-builder.yml` exist because both targets emit `.exe` and would otherwise collide on the shared name, and `nsis.buildUniversalInstaller: false` is what splits the installer per architecture instead of shipping one that carries both payloads.

File associations on Windows are registered by `desktop/installer.nsh` (wired in via `nsis.include`), not by electron-builder's `fileAssociations`. The generated ones write the *default* value of `HKCU\Software\Classes\.csv` — which is how Windows records the default program — so installing would have taken `.xlsx` from Excel. The hand-written version writes a vendor-prefixed ProgID plus an `OpenWithProgids` entry instead, so the app shows up in "Open with…" and the user's default is untouched. This is also why `fileAssociations` is scoped under `mac:` in the config: electron-builder concatenates the root and per-platform lists, so a top-level entry cannot be kept away from Windows.

Windows builds are always unsigned: there is no Authenticode certificate, so nothing in the config attempts signing. SmartScreen shows "Windows protected your PC" on first run of an unsigned exe. Note that `CSC_IDENTITY_AUTO_DISCOVERY` does *not* apply here despite the generic name — in electron-builder it is read only by `isAutoDiscoveryCodeSignIdentity`, whose sole consumer is the macOS signing path, so it governs Developer ID keychain discovery and has no effect on Windows certificate selection. That is why `release-build.yml` pins it off on the *macOS* packaging step, and why there is nothing to pin for a local Windows build. To keep a certificate in your store from being picked up on Windows, use electron-builder's `win.certificateSubjectName`/`certificateSha1` or `CSC_LINK`, which are the knobs that path actually consults.

The config lives in `desktop/electron-builder.yml`:

- File associations declare the app as *a* handler for `csv`/`tsv`/`xlsx`/`xls` (`rank: Alternate`) so it appears in "Open with…" without claiming default-handler status.
- The app bundle contains only the esbuild outputs (`dist/desktop`, `dist/webview`) plus `package.json` — no `node_modules`.
- `artifactName` names the dmg/zip `table-viewer-<version>-<arch>` rather than after `productName`, which has a space — those filenames are part of the download URL the Homebrew cask pins.
- License notices for the GPL-3.0 app are shipped in the packaged app's resources directory (`Contents/Resources` on macOS, `resources/` on Windows): `LICENSE.txt` (Table Viewer), `THIRD_PARTY_NOTICES.txt` (generated from the production npm dependency closure by `desktop/collect-licenses.mjs`), `LICENSE.electron.txt`, and `LICENSES.chromium.html`. The `afterPack` hook (`desktop/after-pack.mjs`) asserts all four are present and non-empty in the packaged app, because a missing `extraResources` source is only a *warning* in electron-builder — a half-installed `node_modules/electron` otherwise yields a normal-looking dmg or installer with the Electron/Chromium attributions silently absent.

## Smoke test

```sh
npm run test:desktop-smoke
```

Three Playwright Electron specs (`desktop/test-smoke/`) drive the built dev bundle. `desktop-smoke.spec.ts` launches it with a csv and an xlsx fixture and asserts each file opened in its own titled window with its grid rendered, that the windows are independently sized and zoomed, that a column sort applies and clears, that the Edit menu's Copy and Select All reach the grid, and that the Appearance and Color theme preferences repaint the open windows (asserted against CSS custom properties, never rendered pixels — the Glide canvas is not drivable headlessly), and that the About window opens with its version and notice links. `welcome-smoke.spec.ts` launches it with no file and covers the launcher plus File → New Window. `state-relaunch.spec.ts` asserts the plan's relaunch gate: that a clean quit-and-relaunch restores view state from the same `userData` directory, and that a forced termination recovers under the rollback journal on the next launch.

**Only one of the three runs in CI, and the split is a property of how they are written.** The `desktop-relaunch` job in `.github/workflows/ci.yml` runs `npm run test:desktop-smoke:relaunch` on `macos-latest` — `state-relaunch.spec.ts` alone. It is CI-safe because it drives no menu commands and makes no focus assertions: everything it checks it reads back through the grid's accessibility cell and the state database, neither of which depends on the app being frontmost. **Keep it that way.** A focus assertion or a menu-routed command added to that spec makes the CI job flaky on a shared runner, and it will fail intermittently rather than plainly. Its focus-dependent siblings stay out of CI for exactly that reason (the Linux runner would also need xvfb plus Electron sandbox flags); run the full `npm run test:desktop-smoke` locally on a desktop OS instead.

**Leave the machine alone while the full suite runs.** These specs drive a real app on your real desktop, and the menu-routed commands (Edit → Copy, Select All, View → Zoom) stop reaching the grid once the app is no longer frontmost — so switching to another window mid-run fails the suite. It is not a hermetic test: reproduced deliberately by activating another app on a loop, it fails the very first run, always in one of the focus-dependent tests. Everything that *can* be waited for is (see `click_grid_cell` and `focus_viewer`); frontmost-ness is the part no amount of waiting fixes, since taking focus back would just fight whoever is using the machine.

The app honors `TABLE_VIEWER_USER_DATA_DIR` to relocate `userData` (settings, state store, single-instance lock); the smoke test uses it to isolate each run in a temp directory. It is read from the environment of *any* launch, so treat it as a production override rather than a test-only hook. The single-instance lock is keyed on the userData path Electron is given, so the value is resolved through `canonical_existing_path` (existing prefix via `realpath`) to collapse symlink, relative, and case-different spellings of one directory onto a single key. That is not a full guarantee: two genuinely different userData directories whose `state/` subdirectories are the same physical directory still each win the lock, and no single-process check can detect it — after which "Set Aside and Start Fresh", whose all-processes-closed attestation authorizes reclaiming a peer's reader token by exact id, would move the database out from under the other instance's live handle. Do not point it at a location another Table Viewer instance is using.

## State and settings

- Per-file view state: `userData/state/file-state.sqlite3`, a SQLite database in
  rollback-journal mode (`journal_mode=DELETE`, `synchronous=FULL`). Its hot
  `-journal` sidecar belongs to it and is never separated from it — the two are
  preserved, moved, and recovered as one set. Coordination markers live beside it
  in `.file-state.sqlite3.recovery-gate/`, and a set-aside database is moved to a
  sibling `file-state.sqlite3.recovery.<uuid>/` directory rather than deleted.
  Physically separate from the VS Code extension's database; no state is shared
  or synchronized between the two.
- Preferences: `userData/settings.v1.json`, edited via the Preferences window (**Cmd+,**).

The desktop app requires a platform on which a directory flush can be proven
durable. Windows currently has no such primitive available without a native
addon, so the app declines the platform up front rather than running with view
state it cannot persist; `desktop/packaged-recovery-gate.mjs` asserts that
refusal on Windows and the full recovery matrix elsewhere.

### Windows durability verification

Windows is not a dropped target. The refusal above is a statement about
*evidence*, not about Windows, so `desktop/windows-durability-probe.mjs` runs on
the CI `windows-durability` job to gather it: which flush and write-through
primitives the packaged Electron runtime can actually reach, what each one
guarantees and what it does not, what the volume's filesystem really is (reported,
not assumed), and — as a skeleton, one or two representative cut points today —
what a kill-crash at a durable cut point leaves behind. It emits one JSON object
with a `verdict` of `verified`, `not-verified`, or `inconclusive`, derived from
those observations rather than written down.

The decision tree the verdict feeds, both branches of which are explicit:

- **The gate verifies.** Windows ships the SQLite state backend on exactly the
  evidence standard macOS ships on — a documented durability contract plus
  kill-crash verification against the packaged runtime, which is the same trust
  basis `fsync` gives on POSIX. Only then is
  `assert_sqlite_directory_durability_supported` revisited.
- **The gate cannot verify.** Windows ships view-only, exactly as it does today:
  files open and display, and the persistent state backend is declined up front.

Neither branch permits silent weakening. A `not-verified` verdict is a result and
does **not** fail CI — a job that failed on an unproven primitive would only
create pressure to find a way to make it pass. Only a malfunction of the probe
itself fails. Equally, a `verified` verdict is unreachable from a partial run: the
report lists covered *and* pending cut points, and the verdict requires the matrix
to be complete, so two green cut points can never be mistaken for verification.
Completing that matrix is the next step; extending `REPRESENTATIVE_CUT_POINTS` in
the probe is all it takes mechanically.

Run it locally on a Windows machine with `npm run probe:windows:durability`. On
any other platform it reports that it did not run and exits 0.

The font family and font size preferences style the whole app — viewer windows, the welcome window, the Preferences window itself, and the About window — mirroring how the extension's font settings apply to its entire UI. Worksheet tabs (the sheet strip *inside* an Excel file) default to a vertical orientation.

The Appearance preference (`theme`) is `system` by default, which follows the OS light/dark setting; `light` and `dark` pin it. It is applied by handing the value to Electron's `nativeTheme.themeSource`, so Appearance only picks the *mode*. Two further preferences pick which theme paints each mode: `lightThemeId` and `darkThemeId`. Keeping a slot per mode means switching Appearance back and forth never loses the theme chosen for the other mode.

`resolve_theme_id` in `desktop/main/theme-definitions.ts` is the single place the active theme is computed (mode from `nativeTheme.shouldUseDarkColors`, theme from the matching slot), so no call site can get the mode right while ignoring the theme choice. `theme-definitions.ts` is also the registry of the nine shipped themes — the two hand-tuned VS Code look-alikes (Light, Dark) plus seven ports (Solarized Light/Dark, Catppuccin Latte/Frappé/Macchiato/Mocha, SynthWave '84), whose 16 semantic roles are expanded into the full `--vscode-*` set by `desktop/main/theme-palette.ts`. Ported palettes are attributed in [NOTICE.md](../NOTICE.md).

The Preferences **Color theme** select is a view of the live theme payload rather than of the settings file, so it lists the themes for whichever mode is resolved *right now* and retargets itself when the OS flips under Appearance = System.

## About window

**About Table Viewer** (the app menu on macOS, **Help** elsewhere) opens a small custom window (`desktop/renderer/about.html`) rather than the native macOS About panel: GPL-3.0 expects an interactive program to surface its license and warranty notice, and the native panel cannot host the links that make that practical. It offers the app's own license, [NOTICE.md](../NOTICE.md), and the generated npm package notices.

The display name in the markup is hardcoded, because `app.name` is the package name (`table-viewer`) outside a packaged build. The version is not read from Electron either: `app.getVersion()` reports *Electron's* version in a dev run (the app is launched as `electron dist/desktop/main.js`, and `dist/desktop` has no `package.json`), so `desktop/build.mjs` injects the root `package.json` version into the main bundle as `__APP_VERSION__` — one source of truth, correct in both modes. The window is a sandboxed renderer like Preferences, so its preload cannot call `shell` itself; the link targets go over IPC and the main process maps each target name to a URL, so a compromised renderer cannot open an arbitrary one.

`notices_file_path` (`desktop/main/notices-path.ts`) resolves the bundled `THIRD_PARTY_NOTICES.txt`, which lives in two different places: `dist/desktop/` in a dev run, and `Contents/Resources/` in a packaged app (electron-builder excludes it from `files` and ships it via `extraResources`). It only exists once `desktop/collect-licenses.mjs` has run, which `npm run desktop:dev` now does.

## Unsaved CSV edits

Unsaved edits are durable: the shared controller persists `pendingEdits` per file in the state store and hands them back when the file is reopened, so closing a window does not lose a draft — it comes back where you left it (hot-exit semantics, the same as the VS Code extension). Closing therefore does not prompt.

Because the draft is invisible until then, the window says so instead: `desktop/main/dirty-state.ts` derives an "unsaved edits" flag from the viewer protocol messages already passing through `viewer-windows.ts`, and the window marks itself edited — a dot in the close button on macOS (`setDocumentEdited`, which needs the represented filename that is already set), a `•` before the file name in the title elsewhere. The flag comes from both directions, and needs both: the webview posts `pendingEditsChanged` while editing (and `null` after a save), but a draft *restored* from an earlier session arrives host → webview in `editSessionResult` / `workbookSnapshot`, since the webview only echoes `pendingEditsChanged` once it is in edit mode with a session.

## Zoom

**View → Zoom In / Zoom Out / Actual Size** (`Cmd/Ctrl` with `+`, `-`, `0`) zoom the focused window only, like a browser tab or Excel's per-workbook zoom. The menu items are custom rather than the stock zoom roles so the level stays inside the range in `desktop/main/zoom.ts`.

Chromium keys zoom by *origin*, so viewer windows sharing one host would silently share one zoom level. Each window therefore loads its own `tv-app://viewer-<n>/index.html` (`viewer_url` in `desktop/main/viewer-html.ts`); the protocol handler serves every `viewer-<n>` host from the same generated page.

## Edit menu

The Edit menu is hand-built rather than `role: 'editMenu'`. The stock menu's Undo, Redo, Delete, and Paste and Match Style items have nothing to act on — there is no undo model, and the grid is a canvas with no DOM selection — so they are omitted. Cut and Paste keep their native roles, because the one place they mean anything is the CSV cell editor's text field, which is exactly what those roles operate on.

Copy and Select All are custom items. Their native roles would both do nothing on the canvas *and* claim `Cmd/Ctrl+C` / `Cmd/Ctrl+A` before the page could handle them (on macOS an application-menu key equivalent never reaches the renderer). Instead, `route_edit_command` in `desktop/main/main.ts` forwards the intent to the viewer window the click came from as an `editCommand` host message; `src/webview/edit-command.ts` then decides whether the focused text field or the grid should receive it. Menu clicks in any other window (the welcome window, or Preferences, whose fields are ordinary inputs) fall back to the native editing command. Routing keys off the window Electron reports with the click, not a separately sampled focus — sampling focus is racy and can silently drop the command.

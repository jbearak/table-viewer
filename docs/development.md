# Development

Clone the repo and run `npm install`. Node >= 24 is required (`engines.node` in `package.json`, and what CI runs).

## npm scripts

**Typechecking** (the esbuild bundlers strip types without checking them, so this
is the only thing that does — CI runs it):

- `npm run typecheck:all` — all three projects at once
- `npm run typecheck` — extension, webview, and unit tests (`tsconfig.json`)
- `npm run typecheck:desktop` — desktop shell (`desktop/tsconfig.json`)
- `npm run typecheck:integration` — integration tests (`tsconfig.integration.json`)

**VS Code extension:**

- `npm run bundle && npm run bundle:webview` — build the extension and webview bundles
- `npm test` — vitest unit tests
- `npm run test:integration` — VS Code Extension Host integration tests
- `npm run package` — build the `.vsix` with vsce

**Desktop app:**

- `npm run desktop:dev` — build the bundles and launch the app with Electron
- `npm run desktop:package` — unsigned local macOS build (dmg + zip, under `dist/desktop-packages/`)
- `npm run desktop:package:dir` — unpacked `.app` only (faster, for local checks)
- `npm run desktop:package:win` — Windows setup + portable exe (x64 + arm64); must be run on Windows
- `npm run test:desktop-smoke` — Playwright Electron smoke tests (separate from the vitest suite)

See [desktop/README.md](../desktop/README.md) for more on the desktop shell.

## `scripts/setup.sh`

A maintainer convenience script: it does a full local install of both front ends from a working tree, so you can use your own build the way an end user would. It is not part of CI or the release pipeline — releases go through the GitHub Actions workflows in `.github/workflows/`, kicked off by [`scripts/bump-version.sh`](#scriptsbump-versionsh).

```sh
./scripts/setup.sh                 # extension + desktop app
./scripts/setup.sh --no-desktop    # extension only
./scripts/setup.sh --no-extension  # desktop app only
./scripts/setup.sh --help
```

Passing both `--no-` flags is an error (nothing left to install), as is any unrecognized argument. Flags are validated before any work starts.

What it does, in order:

1. **Preflight** — requires `node` and `npm` on `PATH`, and Node >= 24 (matching `engines.node`). Anything missing is a hard error.
2. **`npm install`** — always runs, regardless of flags.
3. **Extension** (skipped with `--no-extension`):
   - `npm run vscode:prepublish` to build the extension and webview bundles.
   - Deletes any `table-viewer-*.vsix` at the repo root, then `npm run package` to produce `table-viewer-<version>.vsix`, where `<version>` comes from `package.json`. The clean means the installed file can only be this run's build, and stale older-version VSIXes (which vsce leaves behind) don't accumulate. A missing VSIX at the expected path afterward is a hard error.
   - Installs that VSIX with `--install-extension … --force` into every editor found on `PATH`, trying `code`, `code-insiders`, `codium`, `kiro`, `antigravity`, `cursor`, and `windsurf`. Editors that aren't installed are reported as `not found` and skipped; an install that fails is reported as `failed` and does not stop the run. Finding no editors at all is a warning, not an error.
4. **Desktop app** (skipped with `--no-desktop`):
   - Skipped with a warning — not an error — on non-macOS hosts. `desktop/electron-builder.yml` does configure Windows targets, but the script's install step is macOS-specific (it copies into `/Applications` and clears the quarantine attribute), so it stays macOS-only. On Windows, run `npm run desktop:package:win` and install by hand: it writes four files to `dist/desktop-packages/`, so run the `table-viewer-<version>-<arch>-setup.exe` matching your machine's architecture (`x64` or `arm64`). The `-portable.exe` of the same architecture is the alternative — it runs as-is with nothing installed and no Start Menu entry or file associations.
   - `npm run desktop:package:dir` builds the unpacked bundle at `dist/desktop-packages/mac-<arch>/Table Viewer.app`.
   - Deletes any existing `/Applications/Table Viewer.app` and copies the fresh build in its place. Note this **replaces** an app installed there by other means.
   - Clears the quarantine attribute (`xattr -dr com.apple.quarantine`) on the installed copy, so the unsigned build launches without the Gatekeeper prompt described in [desktop/README.md](../desktop/README.md).
5. **Summary** — prints the VSIX filename and the installed app path, listing only the halves that actually ran.

The script runs under `set -e`, so an unexpected failure in `npm install` or either build aborts it; the tolerated failures are exactly the ones called out above (missing editors, a per-editor install failure, unsupported host for the desktop build).

## `scripts/bump-version.sh`

The other maintainer script: it sets the version in `package.json`, commits that, and creates the annotated release tag. It builds and publishes nothing itself — pushing the tag is what starts the release.

```sh
./scripts/bump-version.sh          # patch bump (default)
./scripts/bump-version.sh minor
./scripts/bump-version.sh major
./scripts/bump-version.sh 1.2.3    # explicit version
./scripts/bump-version.sh 1.0.0-beta.1
./scripts/bump-version.sh --help
```

The argument is either a bump type (`major`, `minor`, `patch`) or an explicit `x.y.z` version with an optional pre-release suffix. Anything else exits 1 with the usage text.

What it does, in order:

1. **Preconditions** — the working tree must be clean (`git status --porcelain` empty), and the computed tag `v<version>` must not already exist. Either violation is a hard error before anything is modified.
2. **Computes the new version** — reads the current version out of `package.json`. For a bump type, any pre-release suffix is stripped first, so `patch` on `1.0.0-beta.1` yields `1.0.1`, not `1.0.0-beta.2`; `major` and `minor` zero out the components below them. An explicit version is used as given.
3. **Writes `package.json`** via Node (not `npm version`, so no lifecycle scripts run), then syncs `package-lock.json` with `npm install --package-lock-only --ignore-scripts`.
4. **Commits and tags** — stages just those two files, commits as `chore: bump version to <version>`, and creates an annotated tag `v<version>`.
5. **Prints the push command.** It deliberately does not push.

Pushing the tag is the release trigger: `.github/workflows/release-build.yml` runs on `v*` tags, and `release-publish.yml` runs on that build's completion. Both also accept a manual `workflow_dispatch` with an explicit tag. A manual Release Build must be dispatched from that same tag ref (for example, `gh workflow run release-build.yml --ref v1.2.3 -f tag=v1.2.3`), so its run SHA and artifacts remain bound to the immutable release commit.

`release-build.yml` has three jobs: `build` packages the `.vsix` on Linux, `desktop` packages the standalone macOS app (arm64 dmg + zip) on a macOS runner, and `desktop-windows` packages the unsigned Windows exes (setup + portable, x64 + arm64) on a Windows runner. `release-publish.yml` publishes the extension to both marketplaces, attaches every artifact to the GitHub Release, and — once enabled — opens a cask bump PR against the Homebrew tap. See the [Homebrew tap guide](homebrew-tap.md) for that flow, its one-time setup, and how code signing switches itself on.

```sh
git push && git push --tags
```

To undo a bump before pushing, drop the tag and the commit:

```sh
git tag -d v<version> && git reset --hard HEAD~1
```

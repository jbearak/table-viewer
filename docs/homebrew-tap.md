# Homebrew tap

The standalone macOS app is distributed through a Homebrew **cask** in a
separate tap repo, `jbearak/homebrew-table-viewer`, so users can install it with

```sh
brew install --cask jbearak/table-viewer/table-viewer
```

This mirrors the arrangement used by [`sight`](https://github.com/jbearak/sight)
and [`raven`](https://github.com/jbearak/raven): the tool's own repo builds the
artifact and pushes a bump PR to a tap repo that holds nothing but the
cask/formula and its CI.

A cask rather than a formula because Table Viewer is a GUI app: casks install a
prebuilt `.app` into `/Applications` and handle upgrade, uninstall, and `zap`
(settings cleanup). A formula would have to hide the bundle in the keg and can't
manage `/Applications`. Building from source in a formula was also ruled out —
the Electron runtime is ~100 MB and would have to be downloaded at install time
either way, and Homebrew has no Electron *formula* to depend on (only a cask,
pinned to one version, which a packaged app can't be repointed at).

## The moving parts

| Where | What |
| --- | --- |
| `release-build.yml`, `desktop` job | Runs `npm run desktop:package:release` on a macOS runner, producing `table-viewer-<version>-arm64.dmg` + `.zip` and their `.sha256` files as the `desktop-<tag>` artifact. |
| `release-publish.yml` | Downloads that artifact, verifies the checksums, attaches the dmg/zip to the GitHub Release, seeds a placeholder tap when necessary, then opens cask bump PRs for later releases. |
| `jbearak/homebrew-table-viewer` | `Casks/table-viewer.rb`, `bin/update-cask.sh` (the single source of truth for the cask edit), and CI that audits + installs the cask on an Apple Silicon runner. |

The version and checksum in the cask are only ever written by
`bin/update-cask.sh`. Release CI copies the tracked scaffold on the first run
and invokes that same updater for both the seed and every later bump, so those
paths cannot drift.

## Architecture and macOS floor

arm64 only, macOS 12 (Monterey) or newer — the floor comes from the bundled
Electron runtime (`LSMinimumSystemVersion` in the built bundle). Intel macOS is
intentionally out of scope, matching `sight` and `raven`.

## Signing

The application inside an official desktop artifact is Developer ID signed.
When all three notarytool credentials are available it is also notarized and
stapled, so Gatekeeper accepts the installed `Table Viewer.app` as a Notarized
Developer ID application. With incomplete notarytool credentials the workflow
ships a signed-but-not-notarized app instead and Gatekeeper may warn. The outer
DMG container is signed but is not separately notarized/stapled, which does not
affect the app payload used by the cask or the ZIP payload used for automatic
updates.

The release workflow is wired for signing and turns it on by itself once
the credentials exist as `release` **environment** secrets in this repo:

| Secret | What |
| --- | --- |
| `CSC_LINK` | base64 of a Developer ID Application `.p12` |
| `CSC_KEY_PASSWORD` | that `.p12`'s password |
| `APPLE_ID` | Apple ID email for notarytool |
| `APPLE_APP_SPECIFIC_PASSWORD` | app-specific password for that Apple ID |
| `APPLE_TEAM_ID` | 10-character Developer Team ID |

`CSC_LINK` alone switches on signing; all three notarytool secrets are needed
before notarization is attempted (with `CSC_LINK` but incomplete notarytool
credentials the job warns and ships signed-but-not-notarized). `desktop/`'s
electron-builder config deliberately leaves `mac.identity` unset — the local
`npm run desktop:package` scripts pass `-c.mac.identity=null` explicitly, so a
local build never needs a certificate.

Enabling signing needs **no** change to the cask, the tap, or CI. The cask's
`caveats` and the tap README's first-launch section are both phrased as
conditionals ("if macOS blocks the first launch…") rather than asserting the app
is unsigned, so they stay accurate once notarized builds ship and can simply be
left alone. `caveats` is only text printed after install; a stale one is
cosmetic, but there is nothing stale about a conditional.

## One-time setup

The tap repo (`jbearak/homebrew-table-viewer`) already exists, holding only a
placeholder README. It was created empty on purpose: a fine-grained PAT can only
be scoped to a repository that exists, and seeding the cask before any release
carried a dmg would have meant a red tap CI pointing at a 404.

1. **Give release CI write access to the tap.** Store `HOMEBREW_TAP_TOKEN` as
   a secret on this repository's `release` environment. It should be a GitHub
   App installation token or fine-grained PAT restricted to
   `jbearak/homebrew-table-viewer` with **Contents: write**, **Pull requests:
   write**, and **Workflows: write**. The workflow permission is needed only
   because the initial seed installs the tap's test workflow.

   ```sh
   gh secret set HOMEBREW_TAP_TOKEN -R jbearak/table-viewer --env release
   ```

2. **Run a release publisher.** Every release carrying the arm64 dmg now runs
   the tap publisher automatically. If the tap still contains only its
   placeholder README, release CI copies the tracked `.github/homebrew-tap/`
   scaffold, fills in the released version and checksum, and fast-forwards
   `main`. Re-running `release-publish.yml` manually for an existing release
   such as `v0.9.1` is also safe: registry publication is skip-duplicate and the
   GitHub Release action updates the existing release before the tap step.

   The seed refuses to overwrite any unexpected tracked tap content. Once the
   cask exists, later releases take the update path and open a bump PR instead
   of writing `main` directly. Because the cask and tap CI arrive together, the
   first CI run audits and installs a cask whose checksum matches a real dmg.

3. **Require the tap's CI.** In the tap repo, Settings → Branches: require the
   `test` check on `main`, so a bump PR can't merge red. Do this after step 2:
   the check has to have run once before it can be selected as required.

   This step is also what makes auto-merge meaningful. `gh pr merge --auto`
   errors on a PR that is *already* mergeable, so with no required check the
   bump PR just sits there and the workflow logs a warning. With the check
   required, the PR merges by itself once CI is green. (Auto-merge and
   delete-branch-on-merge are already enabled on the tap repo; auto-merge is off
   by default and `--auto` fails outright without it.)

The token can ship arbitrary cask Ruby to anyone installing from the tap, so
set an expiration and keep it in the `release` environment. Any protection rule
added to that environment (required reviewers, a wait timer) gates both the
desktop build and publisher jobs.

## Verifying a cask change locally

`brew` can use a checked-out tap directly, which is worth doing before pushing a
cask edit — `brew style` and `brew audit` catch different things:

```sh
TAP=$(brew --repository)/Library/Taps/jbearak/homebrew-table-viewer
mkdir -p "$(dirname "$TAP")" && cp -R /path/to/tap "$TAP"
brew style --cask jbearak/table-viewer/table-viewer
brew audit --strict --cask jbearak/table-viewer/table-viewer   # add --online to check the URL
```

To test an install against a locally built dmg, point the cask's `url` at
`file:///…/dist/desktop-packages/table-viewer-<version>-arm64.dmg` and install
into a scratch appdir so you don't clobber an app already in `/Applications`
(e.g. one that `scripts/setup.sh` installed — the cask refuses to overwrite it):

```sh
HOMEBREW_CASK_OPTS="--appdir=/tmp/tv-appdir" \
  brew install --cask jbearak/table-viewer/table-viewer
xattr -dr com.apple.quarantine "/tmp/tv-appdir/Table Viewer.app"   # if you want to launch it
```

Don't reach for `--no-quarantine` here. Homebrew 6 removed it from the command
line (as a flag it fails with `Error: invalid option`), and while
`HOMEBREW_CASK_OPTS` does still parse it, on Homebrew 6.0.12 it does not
actually suppress the attribute — installs with and without it both leave
`com.apple.quarantine` on the app. Strip it afterwards with `xattr -dr`, which
does work, or just notarize.

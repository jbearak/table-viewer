# homebrew-table-viewer

Homebrew tap for the standalone [Table Viewer](https://github.com/jbearak/table-viewer)
macOS app, a fast viewer for Excel, CSV and TSV files.

## Install

```sh
brew install --cask jbearak/table-viewer/table-viewer
```

The fully qualified command taps this repository automatically and installs the
prebuilt Apple Silicon app in `/Applications`. Table Viewer supports macOS 12
(Monterey) and newer.

If macOS blocks the first launch, right-click **Table Viewer** in Finder and
choose **Open**, or run:

```sh
xattr -dr com.apple.quarantine "/Applications/Table Viewer.app"
```

## Upgrade and uninstall

```sh
brew update
brew upgrade --cask jbearak/table-viewer/table-viewer
brew uninstall --cask jbearak/table-viewer/table-viewer
```

Use `brew uninstall --cask --zap jbearak/table-viewer/table-viewer` to remove
the app together with its saved settings and view state.

## Updates

Each Table Viewer release recomputes the dmg checksum from the artifact it just
published and opens a cask bump PR here. The PR is audited and installed on an
Apple Silicon runner before it merges.

Never replace a published release asset in place. If a release is bad, revert
its cask bump or publish a new patch release.

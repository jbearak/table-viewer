#!/usr/bin/env bash
# Prepare a checked-out jbearak/homebrew-table-viewer repository for the
# current Table Viewer release. The placeholder repository is seeded from the
# tracked scaffold; an initialized tap is updated through its own guarded
# cask updater.
set -euo pipefail

TAP_DIR="${1:?usage: prepare-homebrew-tap.sh <tap dir> <version> <dmg path>}"
VERSION="${2:?missing version}"
DMG="${3:?missing dmg path}"

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEMPLATE="$REPO_ROOT/.github/homebrew-tap"
TAP_DIR="$(cd "$TAP_DIR" && pwd)"
DMG="$(cd "$(dirname "$DMG")" && pwd)/$(basename "$DMG")"

VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]] \
  || { echo "ERROR: invalid Homebrew cask version: $VERSION" >&2; exit 1; }
[[ -f "$DMG" ]] || { echo "ERROR: no such dmg: $DMG" >&2; exit 1; }
[[ "$(basename "$DMG")" == "table-viewer-$VERSION-arm64.dmg" ]] \
  || { echo "ERROR: dmg filename does not match version $VERSION: $(basename "$DMG")" >&2; exit 1; }
git -C "$TAP_DIR" rev-parse --is-inside-work-tree >/dev/null

MODE=update
if [[ ! -f "$TAP_DIR/Casks/table-viewer.rb" ]]; then
  # The known pre-seed repository contains only its placeholder README. Refuse
  # to treat any other repository shape as disposable: an unexpected partial
  # or hand-maintained tap needs a human decision instead of a CI overwrite.
  while IFS= read -r tracked; do
    [[ "$tracked" == "README.md" ]] || {
      echo "ERROR: refusing to seed tap with unexpected tracked file: $tracked" >&2
      exit 1
    }
  done < <(git -C "$TAP_DIR" ls-files)

  cp -R "$TEMPLATE/." "$TAP_DIR/"
  MODE=seed
fi

[[ -x "$TAP_DIR/bin/update-cask.sh" ]] \
  || { echo "ERROR: tap is missing executable bin/update-cask.sh" >&2; exit 1; }
"$TAP_DIR/bin/update-cask.sh" "$VERSION" "$DMG"

if [[ -n "${GITHUB_OUTPUT:-}" ]]; then
  echo "mode=$MODE" >> "$GITHUB_OUTPUT"
fi
echo "Prepared Homebrew tap in $MODE mode for Table Viewer $VERSION."

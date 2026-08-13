#!/usr/bin/env bash
# Update Casks/table-viewer.rb to a released version and the checksum of that
# release's arm64 dmg. Validation happens before the original cask is replaced.
set -euo pipefail

VERSION="${1:?usage: update-cask.sh <version> <dmg path>}"
DMG="${2:?missing dmg path}"
REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CASK="$REPO_ROOT/Casks/table-viewer.rb"

VERSION="${VERSION#v}"
[[ "$VERSION" =~ ^[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z][0-9A-Za-z.-]*)?(\+[0-9A-Za-z][0-9A-Za-z.-]*)?$ ]] \
  || { echo "ERROR: invalid version: $VERSION" >&2; exit 1; }
[[ -f "$DMG" ]] || { echo "ERROR: no such file: $DMG" >&2; exit 1; }
[[ "$(basename "$DMG")" == "table-viewer-$VERSION-arm64.dmg" ]] \
  || { echo "ERROR: dmg filename does not match version $VERSION" >&2; exit 1; }
[[ -f "$CASK" ]] || { echo "ERROR: no such cask: $CASK" >&2; exit 1; }

# A delayed workflow or manual replay must never move Homebrew users backward.
# Node is part of the upstream release runner, and this self-contained SemVer
# comparison keeps prereleases ordered correctly without an npm dependency.
CURRENT_VERSION="$(sed -nE 's/^  version "([^"]+)"$/\1/p' "$CASK")"
[[ -n "$CURRENT_VERSION" ]] \
  || { echo "ERROR: could not read current cask version" >&2; exit 1; }
if ! node - "$CURRENT_VERSION" "$VERSION" <<'NODE'
const [current, requested] = process.argv.slice(2);
const parse = (text) => {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(text);
  if (!match) throw new Error(`invalid SemVer: ${text}`);
  return { core: match.slice(1, 4).map(Number), pre: match[4]?.split('.') };
};
const compare = (left, right) => {
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index] - right.core[index];
  }
  if (!left.pre && !right.pre) return 0;
  if (!left.pre) return 1;
  if (!right.pre) return -1;
  for (let index = 0; index < Math.max(left.pre.length, right.pre.length); index += 1) {
    if (left.pre[index] === undefined) return -1;
    if (right.pre[index] === undefined) return 1;
    if (left.pre[index] === right.pre[index]) continue;
    const leftNumeric = /^\d+$/.test(left.pre[index]);
    const rightNumeric = /^\d+$/.test(right.pre[index]);
    if (leftNumeric && rightNumeric) return Number(left.pre[index]) - Number(right.pre[index]);
    if (leftNumeric !== rightNumeric) return leftNumeric ? -1 : 1;
    return left.pre[index] < right.pre[index] ? -1 : 1;
  }
  return 0;
};
if (compare(parse(current), parse(requested)) > 0) {
  console.error(`ERROR: refusing to downgrade Homebrew cask from ${current} to ${requested}`);
  process.exit(1);
}
NODE
then
  exit 1
fi

if command -v sha256sum >/dev/null 2>&1; then
  SHA256="$(sha256sum "$DMG" | awk '{print $1}')"
else
  SHA256="$(shasum -a 256 "$DMG" | awk '{print $1}')"
fi
[[ "$SHA256" =~ ^[0-9a-f]{64}$ ]] \
  || { echo "ERROR: invalid sha256: $SHA256" >&2; exit 1; }

WORK="$CASK.new"
trap 'rm -f "$WORK"' EXIT
cp "$CASK" "$WORK"
perl -pi -e "s/^  version \"[^\"]+\"$/  version \"$VERSION\"/" "$WORK"
perl -pi -e "s/^  sha256 \"[0-9a-f]{64}\"$/  sha256 \"$SHA256\"/" "$WORK"

[[ "$(grep -c "^  version \"$VERSION\"$" "$WORK")" -eq 1 ]] \
  || { echo "ERROR: version was not written exactly once" >&2; exit 1; }
[[ "$(grep -cE '^  sha256 ' "$WORK")" -eq 1 ]] \
  || { echo "ERROR: expected exactly one sha256 stanza" >&2; exit 1; }
grep -q "^  sha256 \"$SHA256\"$" "$WORK" \
  || { echo "ERROR: checksum was not written" >&2; exit 1; }
! grep -q '0000000000000000000000000000000000000000000000000000000000000000' "$WORK" \
  || { echo "ERROR: placeholder checksum remains" >&2; exit 1; }

mv "$WORK" "$CASK"
echo "Updated $CASK to Table Viewer $VERSION ($SHA256)."

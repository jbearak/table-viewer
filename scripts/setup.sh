#!/bin/bash
#
# Table Viewer Setup Script
# Builds the VSIX package and installs it to supported editors, and (on macOS)
# builds the standalone desktop app and installs it to /Applications.
#
# USAGE:
#   ./scripts/setup.sh                 # extension + desktop app
#   ./scripts/setup.sh --no-desktop    # extension only
#   ./scripts/setup.sh --no-extension  # desktop app only
#

set -e

USAGE="Usage: $0 [--no-desktop] [--no-extension]"

DESKTOP=1
EXTENSION=1
for arg in "$@"; do
    case "$arg" in
        --no-desktop) DESKTOP=0 ;;
        --no-extension) EXTENSION=0 ;;
        -h|--help)
            echo "$USAGE"
            exit 0
            ;;
        *)
            echo "Error: unknown option: $arg"
            echo "$USAGE"
            exit 1
            ;;
    esac
done

if [ $DESKTOP -eq 0 ] && [ $EXTENSION -eq 0 ]; then
    echo "Error: --no-desktop and --no-extension leave nothing to install."
    echo "$USAGE"
    exit 1
fi

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/.." && pwd)"
cd "$REPO_ROOT"

# Check for node
if ! command -v node &> /dev/null; then
    echo "Error: node is required but not installed."
    exit 1
fi

# Check Node version (matches engines.node in package.json)
if ! node -e '
    const [major, minor, patch] = process.versions.node.split(".").map(Number);
    const supported = major > 26
        || (major === 26 && (minor > 5 || (minor === 5 && patch >= 1)));
    process.exit(supported ? 0 : 1);
'; then
    echo "Error: Node >= 26.5.1 is required (found $(node -v))."
    exit 1
fi

# Check for npm
if ! command -v npm &> /dev/null; then
    echo "Error: npm is required but not installed."
    exit 1
fi

echo "=== Table Viewer Setup ==="
echo ""

# Colors for output
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Step 1: Install dependencies
echo "Installing dependencies..."
npm install
echo -e "${GREEN}✓ Dependencies installed${NC}"
echo ""

# Steps 2-4: Build the VSIX and install it to editors
VSIX_FILE=""
if [ $EXTENSION -eq 1 ]; then
    # Step 2: Bundle extension and webview
    echo "Bundling extension..."
    npm run vscode:prepublish
    echo -e "${GREEN}✓ Extension bundled${NC}"
    echo ""

    # Step 3: Package the VSIX. Drop any previously built VSIX first (including
    # older versions, which vsce leaves behind) so the file we install can only
    # be the one this run produced.
    echo "Packaging extension..."
    rm -f table-viewer-*.vsix
    npm run package
    echo -e "${GREEN}✓ VSIX package built${NC}"
    echo ""

    # The filename is fixed by package.json's version, so there is nothing to glob.
    VERSION=$(node -p "require('./package.json').version")
    VSIX_FILE="table-viewer-${VERSION}.vsix"

    if [ ! -f "$VSIX_FILE" ]; then
        echo -e "${RED}Error: No VSIX file found: $VSIX_FILE${NC}"
        exit 1
    fi
    echo "Found VSIX: $VSIX_FILE"
    echo ""

    # Step 4: Install to editors
    echo "Installing extension to editors..."
    EDITORS=("code" "code-insiders" "codium" "kiro" "antigravity" "cursor" "windsurf")
    INSTALLED=0

    for editor in "${EDITORS[@]}"; do
        if command -v "$editor" &> /dev/null; then
            echo -n "  $editor: "
            if "$editor" --install-extension "$VSIX_FILE" --force &> /dev/null; then
                echo -e "${GREEN}✓${NC}"
                INSTALLED=$((INSTALLED + 1))
            else
                echo -e "${YELLOW}failed${NC}"
            fi
        else
            echo -e "  $editor: ${YELLOW}not found${NC}"
        fi
    done

    if [ $INSTALLED -eq 0 ]; then
        echo -e "${YELLOW}Warning: No editors found to install extension${NC}"
    else
        echo -e "${GREEN}✓ Extension installed to $INSTALLED editor(s)${NC}"
    fi
    echo ""
fi

# Step 5: Build and install the standalone desktop app (macOS only)
APP_DEST=""
if [ $DESKTOP -eq 1 ]; then
    if [ "$(uname -s)" != "Darwin" ]; then
        echo -e "${YELLOW}Skipping desktop app: packaging is macOS-only for now (see desktop/README.md)${NC}"
        echo ""
    else
        # Use a ZIP target so the installed app has release-shaped update metadata.
        # This unsigned local build can check GitHub and direct the user to a newer
        # release, but it must not offer Squirrel.Mac's signature-dependent install.
        # Clear previous package output so the app we install must come from this run.
        echo "Building desktop app..."
        rm -rf dist/desktop-packages
        npm run desktop:package:zip
        echo -e "${GREEN}✓ Desktop app built${NC}"
        echo ""

        APP_MATCHES=()
        while IFS= read -r match; do
            APP_MATCHES+=("$match")
        done < <(find dist/desktop-packages -maxdepth 2 -name "Table Viewer.app" -type d)

        if [ ${#APP_MATCHES[@]} -eq 0 ]; then
            echo -e "${RED}Error: built app not found under dist/desktop-packages${NC}"
            exit 1
        fi
        if [ ${#APP_MATCHES[@]} -gt 1 ]; then
            echo -e "${RED}Error: multiple app bundles found under dist/desktop-packages:${NC}"
            printf '  %s\n' "${APP_MATCHES[@]}"
            echo "Remove dist/desktop-packages and re-run."
            exit 1
        fi
        APP_SRC="${APP_MATCHES[0]}"
        echo "Built: $APP_SRC"

        APP_DEST="/Applications/Table Viewer.app"
        if pgrep -f "$APP_DEST/Contents/MacOS/Table Viewer" >/dev/null 2>&1; then
            echo -e "${RED}Error: Table Viewer is running. Quit it, then re-run setup.${NC}"
            exit 1
        fi
        echo "Installing desktop app to $APP_DEST..."
        if [ -e "$APP_DEST" ]; then
            echo "  replacing existing install"
            rm -rf "$APP_DEST"
        fi
        cp -R "$APP_SRC" "$APP_DEST"
        # Unsigned build: clear the quarantine flag so Gatekeeper doesn't block launch.
        xattr -dr com.apple.quarantine "$APP_DEST" 2>/dev/null || true
        echo -e "${GREEN}✓ Desktop app installed${NC}"
        echo ""
    fi
fi

echo "=== Setup Complete ==="
if [ -n "$VSIX_FILE" ]; then
    echo "Extension: $VSIX_FILE"
fi
if [ -n "$APP_DEST" ]; then
    echo "Desktop app: $APP_DEST"
fi

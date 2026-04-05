#!/bin/bash
#
# Table Viewer Setup Script
# Builds the VSIX package and installs it to supported editors
#
# USAGE:
#   ./scripts/setup.sh
#

set -e

# Check for node
if ! command -v node &> /dev/null; then
    echo "Error: node is required but not installed."
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

# Step 2: Bundle extension and webview
echo "Bundling extension..."
npm run vscode:prepublish
echo -e "${GREEN}✓ Extension bundled${NC}"
echo ""

# Step 3: Package the VSIX
echo "Packaging extension..."
npm run package
echo -e "${GREEN}✓ VSIX package built${NC}"
echo ""

# Find the VSIX file
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

echo "=== Setup Complete ==="
echo "Extension: $VSIX_FILE"

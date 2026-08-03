import { defineConfig } from '@vscode/test-cli';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const companionManifest = JSON.parse(readFileSync(
    fileURLToPath(new URL('./companion/package.json', import.meta.url)),
    'utf8',
));
const companionVsix = fileURLToPath(new URL(
    `./companion/table-viewer-companion-${companionManifest.version}.vsix`,
    import.meta.url,
));

// Run the compiled integration suite in both embedded runtimes that bound the
// shared node:sqlite API: the product floor and the current stable release at
// implementation time. The extension under test is loaded from this folder
// (package.json `main` → dist/extension.js), so pretest:integration bundles it.
const shared = {
    files: 'out/test-integration/**/*.test.js',
    // A clean, empty workspace; tests open fixtures by absolute URI. The local
    // companion VSIX must remain enabled so packaged local bridge routing is tested;
    // production only offers it through extensionPack and never hard-blocks the main extension.
    launchArgs: [],
    installExtensions: [companionVsix],
    skipExtensionDependencies: true,
    mocha: {
        ui: 'bdd',
        // VS Code download + Electron startup + large-file perf smoke need headroom.
        timeout: 120000,
    },
};

export default defineConfig([
    {
        ...shared,
        label: 'minimum',
        version: '1.127.0',
    },
    {
        ...shared,
        label: 'current',
        version: '1.131.0',
    },
]);

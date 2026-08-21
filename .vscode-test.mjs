import { defineConfig } from '@vscode/test-cli';

// Run the compiled integration suite in both embedded runtimes that bound the
// shared node:sqlite API: the product floor and the current stable release at
// implementation time. The extension under test is loaded from this folder
// (package.json `main` → dist/extension.js), so pretest:integration bundles it.
const shared = {
    files: 'out/test-integration/**/*.test.js',
    // A clean, empty workspace; tests open fixtures by absolute URI.
    launchArgs: ['--disable-extensions'],
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
        version: '1.134.0',
    },
]);

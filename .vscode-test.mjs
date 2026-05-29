import { defineConfig } from '@vscode/test-cli';

// Runs the compiled integration tests (src/test-integration → out/) inside a
// real VS Code Extension Host. The extension under test is loaded from this
// folder (package.json `main` → dist/extension.js), so `npm run bundle` must
// run first — wired via the `pretest:integration` script.
export default defineConfig({
    files: 'out/test-integration/**/*.test.js',
    version: 'stable',
    // A clean, empty workspace; tests open fixtures by absolute URI.
    launchArgs: ['--disable-extensions'],
    mocha: {
        ui: 'bdd',
        // VS Code download + Electron startup + large-file perf smoke need headroom.
        timeout: 120000,
    },
});

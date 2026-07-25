// Build script for the desktop (Electron) bundles. Produces dist/desktop/*
// alongside the extension's dist/extension.js and dist/webview/* — the viewer
// windows reuse the existing dist/webview bundle (npm run bundle:webview).
//
// Deliberately separate entry points from the extension build so the `vscode`
// module never enters a desktop bundle (only `electron` stays external).
import { build } from 'esbuild';
import { copyFile, mkdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop_dir = dirname(fileURLToPath(import.meta.url));
const repo_dir = join(desktop_dir, '..');
const out_dir = join(repo_dir, 'dist', 'desktop');

// The app's own version, injected into the main bundle as __APP_VERSION__.
// `app.getVersion()` cannot be trusted in a dev run: the app is launched as
// `electron dist/desktop/main.js` and dist/desktop has no package.json, so
// Electron reports *its own* version. Injecting at build time keeps the root
// package.json the single source of truth and is right in both modes.
const { version } = JSON.parse(await readFile(join(repo_dir, 'package.json'), 'utf8'));

const node_common = {
    bundle: true,
    platform: 'node',
    format: 'cjs',
    target: 'es2022',
    external: ['electron'],
    sourcemap: true,
    outdir: out_dir,
    logLevel: 'info',
};

await mkdir(out_dir, { recursive: true });

// Main process (pulls in the shared viewer controller + state store).
// Only this bundle gets the version define — the About renderer receives it over
// IPC rather than being built with its own copy.
await build({
    ...node_common,
    entryPoints: [join(desktop_dir, 'main', 'main.ts')],
    define: { __APP_VERSION__: JSON.stringify(version) },
});

// Preload scripts (need Node/electron require at runtime → cjs, not browser).
await build({
    ...node_common,
    entryPoints: [
        join(desktop_dir, 'preload', 'viewer-preload.ts'),
        join(desktop_dir, 'preload', 'welcome-preload.ts'),
        join(desktop_dir, 'preload', 'prefs-preload.ts'),
        join(desktop_dir, 'preload', 'about-preload.ts'),
    ],
});

// Renderer scripts for the welcome (launcher), preferences, and About pages.
await build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    outdir: out_dir,
    logLevel: 'info',
    entryPoints: [
        join(desktop_dir, 'renderer', 'welcome.ts'),
        join(desktop_dir, 'renderer', 'prefs.ts'),
        join(desktop_dir, 'renderer', 'about.ts'),
    ],
});

// Static pages.
for (const file of ['welcome.html', 'prefs.html', 'about.html']) {
    await copyFile(join(desktop_dir, 'renderer', file), join(out_dir, file));
}

// Build script for the desktop (Electron) bundles. Produces dist/desktop/*
// alongside the extension's dist/extension.js and dist/webview/* — the viewer
// tabs reuse the existing dist/webview bundle (npm run bundle:webview).
//
// Deliberately separate entry points from the extension build so the `vscode`
// module never enters a desktop bundle (only `electron` stays external).
import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const desktop_dir = dirname(fileURLToPath(import.meta.url));
const repo_dir = join(desktop_dir, '..');
const out_dir = join(repo_dir, 'dist', 'desktop');

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
await build({
    ...node_common,
    entryPoints: [join(desktop_dir, 'main', 'main.ts')],
});

// Preload scripts (need Node/electron require at runtime → cjs, not browser).
await build({
    ...node_common,
    entryPoints: [
        join(desktop_dir, 'preload', 'viewer-preload.ts'),
        join(desktop_dir, 'preload', 'shell-preload.ts'),
        join(desktop_dir, 'preload', 'prefs-preload.ts'),
    ],
});

// Renderer scripts for the shell (tab bar) and preferences pages.
await build({
    bundle: true,
    platform: 'browser',
    format: 'iife',
    target: 'es2022',
    sourcemap: true,
    outdir: out_dir,
    logLevel: 'info',
    entryPoints: [
        join(desktop_dir, 'renderer', 'shell.ts'),
        join(desktop_dir, 'renderer', 'prefs.ts'),
    ],
});

// Static pages.
for (const file of ['shell.html', 'prefs.html']) {
    await copyFile(join(desktop_dir, 'renderer', file), join(out_dir, file));
}

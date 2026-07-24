// Generates dist/desktop/THIRD_PARTY_NOTICES.txt for the packaged desktop app.
//
// Table Viewer is GPL-3.0; the shipped app must carry the license notices of
// the third-party packages bundled into dist/webview + dist/desktop. We take
// the conservative superset: every production dependency in package-lock.json
// (the esbuild bundles can only contain code from that closure).
//
// Electron's own LICENSE and LICENSES.chromium.html are copied into the app
// bundle via extraResources in desktop/electron-builder.yml; this file covers
// npm packages.
import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const out_file = join(repo_dir, 'dist', 'desktop', 'THIRD_PARTY_NOTICES.txt');

const LICENSE_FILE_RE = /^(licen[cs]e|copying|notice)(\.|$)/i;

async function license_text(pkg_dir) {
    let entries;
    try {
        entries = await readdir(pkg_dir);
    } catch {
        return undefined;
    }
    const name = entries.find((entry) => LICENSE_FILE_RE.test(entry));
    if (!name) return undefined;
    try {
        return await readFile(join(pkg_dir, name), 'utf8');
    } catch {
        return undefined;
    }
}

const lock = JSON.parse(
    await readFile(join(repo_dir, 'package-lock.json'), 'utf8'),
);

const sections = [];
const missing = [];
for (const [pkg_path, info] of Object.entries(lock.packages)) {
    // Skip the root project and everything that is dev-only (not shipped).
    if (!pkg_path.startsWith('node_modules/') || info.dev) continue;
    const pkg_dir = join(repo_dir, pkg_path);
    let name = pkg_path.replace(/^.*node_modules\//, '');
    let version = info.version ?? '';
    let license = info.license ?? '';
    try {
        const pkg = JSON.parse(
            await readFile(join(pkg_dir, 'package.json'), 'utf8'),
        );
        name = pkg.name ?? name;
        version = pkg.version ?? version;
        license = typeof pkg.license === 'string' ? pkg.license : license;
    } catch {
        // Fall back to lockfile metadata.
    }
    const text = await license_text(pkg_dir);
    const header = `${name}@${version}${license ? ` (${license})` : ''}`;
    if (text) {
        sections.push(`${header}\n${'-'.repeat(header.length)}\n${text.trim()}\n`);
    } else {
        missing.push(header);
    }
}

sections.sort();
missing.sort();

const preamble = [
    'THIRD-PARTY SOFTWARE NOTICES',
    '',
    'Table Viewer (GPL-3.0) bundles the following third-party npm packages.',
    'The full license text of each package is reproduced below.',
    '',
    "Electron's own license and the Chromium third-party notices are shipped",
    'alongside this file (LICENSE.electron.txt, LICENSES.chromium.html).',
    '',
    missing.length
        ? `Packages without a license file in their published tarball (license\nidentifier from package metadata): ${missing.join(', ')}`
        : '',
    '',
    '='.repeat(72),
    '',
].join('\n');

await mkdir(dirname(out_file), { recursive: true });
await writeFile(out_file, preamble + sections.join('\n' + '='.repeat(72) + '\n\n'));
console.log(`wrote ${out_file} (${sections.length} packages, ${missing.length} without license file)`);

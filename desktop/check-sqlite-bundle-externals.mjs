import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_dir = fileURLToPath(new URL('..', import.meta.url));
const package_json = JSON.parse(await readFile(join(repo_dir, 'package.json'), 'utf8'));
const extension_bundle = package_json.scripts?.bundle;
if (typeof extension_bundle !== 'string'
    || !extension_bundle.includes('--external:node:sqlite')) {
    throw new Error('extension server bundle does not explicitly externalize node:sqlite');
}

/**
 * Both halves of the same assertion, applied to every bundle that must reach
 * node:sqlite through the embedded runtime rather than through a bundled copy:
 * the runtime `require` has to survive, and no SQLite implementation may have
 * been inlined beside it. A bundled shim would hide whether the runtime actually
 * supplies the API, and would make a packaged build depend on node_modules.
 */
async function assert_externalized_sqlite(label, ...segments) {
    const bundle = await readFile(join(repo_dir, ...segments), 'utf8');
    if (!bundle.includes('require("node:sqlite")')) {
        throw new Error(`${label} does not retain the node:sqlite runtime import`);
    }
    if (bundle.includes('class DatabaseSync')) {
        throw new Error(`${label} appears to contain a bundled SQLite implementation`);
    }
}

await assert_externalized_sqlite(
    'desktop runtime probe bundle',
    'dist', 'runtime-probes', 'electron-sqlite-runtime-probe.js',
);
// The bundle actually shipped to users. It carries the desktop's SQLite file-state
// backend, so it — not only the probe beside it — is what has to be verified.
await assert_externalized_sqlite('desktop main bundle', 'dist', 'desktop', 'main.js');

process.stdout.write(
    'extension bundle script, desktop main bundle, and desktop runtime probe bundle'
    + ' externalize node:sqlite\n',
);

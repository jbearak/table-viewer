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

const electron_probe = await readFile(
    join(repo_dir, 'dist', 'runtime-probes', 'electron-sqlite-runtime-probe.js'),
    'utf8',
);
if (!electron_probe.includes('require("node:sqlite")')) {
    throw new Error('desktop server bundle does not retain the node:sqlite runtime import');
}
if (electron_probe.includes('class DatabaseSync')) {
    throw new Error('desktop server bundle appears to contain a bundled SQLite implementation');
}

process.stdout.write('extension and desktop server bundles externalize node:sqlite\n');

import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_dir = fileURLToPath(new URL('..', import.meta.url));
const package_json = JSON.parse(await readFile(join(repo_dir, 'package.json'), 'utf8'));
for (const [label, script_name] of [
    ['extension server bundle', 'bundle'],
    ['companion extension bundle', 'bundle:companion'],
]) {
    const command = package_json.scripts?.[script_name];
    if (typeof command !== 'string' || !command.includes('--external:node:sqlite')) {
        throw new Error(`${label} does not explicitly externalize node:sqlite`);
    }
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
    'companion extension bundle',
    'companion', 'dist', 'extension.js',
);
await assert_externalized_sqlite(
    'desktop runtime probe bundle',
    'dist', 'runtime-probes', 'electron-sqlite-runtime-probe.js',
);
// The packaged recovery gate runs the real open/recovery/preservation code under
// Electron. If it ever reached a bundled SQLite instead of the embedded runtime,
// every gate below it would be proving properties of the wrong engine.
await assert_externalized_sqlite(
    'desktop packaged recovery gate bundle',
    'dist', 'runtime-probes', 'packaged-recovery-gate.js',
);
// The Windows durability probe drives production initialization at real durable
// cut points to see what the platform's primitives do. A bundled SQLite would make
// it an investigation of the wrong engine, and its whole output would be evidence
// about a build nobody ships.
await assert_externalized_sqlite(
    'desktop windows durability probe bundle',
    'dist', 'runtime-probes', 'windows-durability-probe.js',
);
// The bundle actually shipped to users. It carries the desktop's SQLite file-state
// backend, so it — not only the probe beside it — is what has to be verified.
await assert_externalized_sqlite('desktop main bundle', 'dist', 'desktop', 'main.js');

/**
 * Neither runtime-only bundle may be inside the directory electron-builder
 * packages. The build script places them in dist/runtime-probes on purpose, and
 * that placement is the entire mechanism keeping fault-injection code — including
 * a driver whose child processes call `process.abort()` — out of a shipped app.
 * A one-word change to an `outdir` would undo it silently, so it is asserted
 * rather than left to the comment beside it.
 */
for (const name of [
    'electron-sqlite-runtime-probe.js',
    'packaged-recovery-gate.js',
    'windows-durability-probe.js',
]) {
    if (existsSync(join(repo_dir, 'dist', 'desktop', name))) {
        throw new Error(`${name} was emitted into the packaged desktop directory`);
    }
}

process.stdout.write(
    'extension and companion bundle scripts, companion bundle, desktop main bundle,'
    + ' desktop runtime probe bundle, packaged recovery gate bundle, and windows durability probe bundle externalize'
    + ' node:sqlite; runtime-only bundles are outside the packaged desktop directory\n',
);

// Fails a release build whose runtime dependencies include a `file:`
// dependency, such as the vendored @jbearak/dta-parser tarball, so that a
// release cannot ship a dependency that is not on npm by accident.
//
// Usage: node scripts/check-release-dependencies.mjs [path/to/package.json]
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** Runtime dependencies whose spec is a local `file:` path. */
export function file_dependencies(manifest) {
    return Object.entries(manifest.dependencies ?? {})
        .filter(([, spec]) => typeof spec === 'string' && spec.startsWith('file:'))
        .map(([name, spec]) => `${name} (${spec})`);
}

const is_main = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (is_main) {
    const path = process.argv[2]
        ?? join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json');
    const found = file_dependencies(JSON.parse(readFileSync(path, 'utf8')));
    if (found.length > 0) {
        console.error(
            `Release blocked: runtime dependencies come from local files: ${found.join(', ')}.\n`
            + 'Publish the package to npm and depend on the published version, '
            + 'or remove this check from release-build.yml to release anyway.',
        );
        process.exit(1);
    }
    console.log('No runtime dependency comes from a local file.');
}

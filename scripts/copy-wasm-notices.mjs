// Copies the THIRD-PARTY-NOTICES of @jbearak/dta-parser and pqparser (the
// licences of the crates compiled into their wasm modules) next to the
// extension bundle, so the VSIX carries them. A Node script rather than
// `cp`, so it runs on Windows.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repo_dir, 'package.json'));
// Tests write elsewhere through TABLE_VIEWER_NOTICES_DIR.
const out_dir = process.env.TABLE_VIEWER_NOTICES_DIR ?? join(repo_dir, 'dist');
mkdirSync(out_dir, { recursive: true });
// Neither package's exports include package.json; each main entry is dist/index.js.
for (const [name, file] of [['@jbearak/dta-parser', 'dta-parser'], ['pqparser', 'pqparser']]) {
    const package_dir = dirname(dirname(require.resolve(name)));
    copyFileSync(join(package_dir, 'THIRD-PARTY-NOTICES'), join(out_dir, `THIRD-PARTY-NOTICES-${file}.txt`));
}

// Copies @jbearak/dta-parser's THIRD-PARTY-NOTICES (the licences of the
// crates compiled into its wasm module) next to the extension bundle, so the
// VSIX carries them. A Node script rather than `cp`, so it runs on Windows.
import { copyFileSync, mkdirSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const repo_dir = join(dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(join(repo_dir, 'package.json'));
// The package's exports do not include package.json; its main entry is dist/index.js.
const package_dir = dirname(dirname(require.resolve('@jbearak/dta-parser')));
// Tests write elsewhere through TABLE_VIEWER_NOTICES_OUT.
const out_file = process.env.TABLE_VIEWER_NOTICES_OUT
    ?? join(repo_dir, 'dist', 'THIRD-PARTY-NOTICES-dta-parser.txt');
mkdirSync(dirname(out_file), { recursive: true });
copyFileSync(join(package_dir, 'THIRD-PARTY-NOTICES'), out_file);

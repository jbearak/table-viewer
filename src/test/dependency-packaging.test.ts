import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo_dir = resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(join(repo_dir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
};
const lock = JSON.parse(readFileSync(join(repo_dir, 'package-lock.json'), 'utf8')) as {
    packages: Record<string, { version: string }>;
};
// The installed version, so that moving to a new one needs no change here.
function locked(name: string): string {
    return `${name}@${lock.packages[`node_modules/${name}`].version}`;
}
const vscodeignore = readFileSync(join(repo_dir, '.vscodeignore'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith('#'));

const temporary: string[] = [];
function temp_dir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tv-dependency-packaging-'));
    temporary.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('wasm packages\' third-party notices', () => {
    it('copies each package\'s third-party notices beside the extension bundle', () => {
        expect(manifest.scripts.bundle).toMatch(/&& node scripts\/copy-wasm-notices\.mjs$/u);
        expect(vscodeignore.some((line) => line.startsWith('dist/THIRD'))).toBe(false);
        const dir = temp_dir();
        execFileSync(process.execPath, [join(repo_dir, 'scripts', 'copy-wasm-notices.mjs')], {
            env: { ...process.env, TABLE_VIEWER_NOTICES_DIR: dir },
        });
        const dta = readFileSync(join(dir, 'THIRD-PARTY-NOTICES-dta-parser.txt'), 'utf8');
        expect(dta).toMatch(/^Third-party notices for @jbearak\/dta-parser/u);
        expect(dta).toContain('zstd');
        const pq = readFileSync(join(dir, 'THIRD-PARTY-NOTICES-pqparser.txt'), 'utf8');
        expect(pq).toMatch(/^Third-party notices for pqparser/u);
        expect(pq).toContain('brotli');
    });

    it.each([
        [locked('@jbearak/dta-parser'), 'Third-party notices for @jbearak/dta-parser'],
        [locked('pqparser'), 'Third-party notices for pqparser'],
    ])('adds %s\'s third-party notices to the desktop notices', (header, notices) => {
        const out = join(temp_dir(), 'THIRD_PARTY_NOTICES.txt');
        execFileSync(process.execPath, [join(repo_dir, 'desktop', 'collect-licenses.mjs')], {
            env: { ...process.env, TABLE_VIEWER_NOTICES_OUT: out },
        });
        const text = readFileSync(out, 'utf8');
        const start = text.indexOf(header);
        expect(start).toBeGreaterThan(-1);
        const section = text.slice(start, text.indexOf('='.repeat(72), start));
        expect(section).toContain('GNU GENERAL PUBLIC LICENSE');
        expect(section).toContain(notices);
    });
});

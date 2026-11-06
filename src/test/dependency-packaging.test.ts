import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo_dir = resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(join(repo_dir, 'package.json'), 'utf8')) as {
    scripts: Record<string, string>;
};
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

describe('@jbearak/dta-parser third-party notices', () => {
    it('copies the package third-party notices beside the extension bundle', () => {
        expect(manifest.scripts.bundle).toMatch(/&& node scripts\/copy-dta-parser-notices\.mjs$/u);
        expect(vscodeignore.some((line) => line.startsWith('dist/THIRD'))).toBe(false);
        const out = join(temp_dir(), 'notices.txt');
        execFileSync(process.execPath, [join(repo_dir, 'scripts', 'copy-dta-parser-notices.mjs')], {
            env: { ...process.env, TABLE_VIEWER_NOTICES_OUT: out },
        });
        const text = readFileSync(out, 'utf8');
        expect(text).toMatch(/^Third-party notices for @jbearak\/dta-parser/u);
        expect(text).toContain('zstd');
    });

    it('adds the package third-party notices to the desktop notices', () => {
        const out = join(temp_dir(), 'THIRD_PARTY_NOTICES.txt');
        execFileSync(process.execPath, [join(repo_dir, 'desktop', 'collect-licenses.mjs')], {
            env: { ...process.env, TABLE_VIEWER_NOTICES_OUT: out },
        });
        const text = readFileSync(out, 'utf8');
        const start = text.indexOf('@jbearak/dta-parser@1.1.0');
        expect(start).toBeGreaterThan(-1);
        const section = text.slice(start, text.indexOf('='.repeat(72), start));
        expect(section).toContain('GNU GENERAL PUBLIC LICENSE');
        expect(section).toContain('Third-party notices for @jbearak/dta-parser');
    });
});

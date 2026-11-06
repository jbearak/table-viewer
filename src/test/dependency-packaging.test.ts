import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repo_dir = resolve(__dirname, '../..');
const manifest = JSON.parse(readFileSync(join(repo_dir, 'package.json'), 'utf8')) as {
    dependencies: Record<string, string>;
    scripts: Record<string, string>;
};
const vscodeignore = readFileSync(join(repo_dir, '.vscodeignore'), 'utf8')
    .split(/\r?\n/u)
    .filter((line) => line.length > 0 && !line.startsWith('#'));
const release_build = readFileSync(
    join(repo_dir, '.github', 'workflows', 'release-build.yml'),
    'utf8',
);

const temporary: string[] = [];
function temp_dir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'tv-dependency-packaging-'));
    temporary.push(dir);
    return dir;
}
afterEach(() => {
    for (const dir of temporary.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('release dependency check', () => {
    const script = join(repo_dir, 'scripts', 'check-release-dependencies.mjs');
    const run = (dependencies: Record<string, string>) => {
        const dir = temp_dir();
        const path = join(dir, 'package.json');
        writeFileSync(path, JSON.stringify({ dependencies, devDependencies: { x: 'file:x.tgz' } }));
        return spawnSync(process.execPath, [script, path], { encoding: 'utf8' });
    };

    it('fails on a runtime dependency from a local file, naming it', () => {
        const result = run({ a: '^1.0.0', b: 'file:vendor/b-1.0.0.tgz' });
        expect(result.status).toBe(1);
        expect(result.stderr).toContain('b (file:vendor/b-1.0.0.tgz)');
        expect(result.stderr).not.toContain('a (');
    });

    it('passes when every runtime dependency comes from a registry', () => {
        const result = run({ a: '^1.0.0' });
        expect(result.status).toBe(0);
    });

    it('runs after npm ci in every release build job', () => {
        const installs = release_build.match(/run: npm ci\n/gu) ?? [];
        const checks = release_build.match(
            /run: npm ci\n\n {6}- name: Refuse runtime dependencies from local files\n {8}run: node scripts\/check-release-dependencies\.mjs\n/gu,
        ) ?? [];
        expect(installs.length).toBe(4);
        expect(checks.length).toBe(installs.length);
    });
});

describe('vendored @jbearak/dta-parser', () => {
    it('is installed from the vendored tarball and kept out of the VSIX', () => {
        expect(manifest.dependencies['@jbearak/dta-parser'])
            .toBe('file:vendor/dta-parser/jbearak-dta-parser-1.1.0.tgz');
        expect(vscodeignore).toContain('vendor/**');
        expect(vscodeignore.some((line) => line.startsWith('dist/THIRD'))).toBe(false);
    });

    it('copies the package third-party notices beside the extension bundle', () => {
        expect(manifest.scripts.bundle).toMatch(/&& node scripts\/copy-dta-parser-notices\.mjs$/u);
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

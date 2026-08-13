import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

const repoRoot = process.cwd();
const prepareScript = path.join(repoRoot, 'scripts', 'prepare-homebrew-tap.sh');
const temporaryDirectories: string[] = [];

function makeTap(...trackedFiles: string[]): string {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-viewer-homebrew-tap-'));
    temporaryDirectories.push(directory);
    execFileSync('git', ['init', '-q', directory]);
    for (const file of trackedFiles) {
        const target = path.join(directory, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, `${file} placeholder\n`);
    }
    if (trackedFiles.length > 0) execFileSync('git', ['-C', directory, 'add', ...trackedFiles]);
    return directory;
}

function makeDmg(directory: string, version: string, contents: string): string {
    const dmg = path.join(directory, `table-viewer-${version}-arm64.dmg`);
    fs.writeFileSync(dmg, contents);
    return dmg;
}

function commitSeededTap(tap: string): void {
    execFileSync('git', ['-C', tap, 'config', 'user.name', 'Tap Test']);
    execFileSync('git', ['-C', tap, 'config', 'user.email', 'tap-test@example.com']);
    execFileSync('git', ['-C', tap, 'add', 'README.md', 'Casks', 'bin', '.github']);
    execFileSync('git', ['-C', tap, 'commit', '-qm', 'Seed tap']);
}

function prepare(tap: string, version: string, dmg: string) {
    const output = path.join(path.dirname(tap), `${path.basename(tap)}.output`);
    fs.rmSync(output, { force: true });
    const result = spawnSync(prepareScript, [tap, version, dmg], {
        encoding: 'utf8',
        env: { ...process.env, GITHUB_OUTPUT: output },
    });
    return { ...result, workflowOutput: fs.existsSync(output) ? fs.readFileSync(output, 'utf8') : '' };
}

afterEach(() => {
    for (const directory of temporaryDirectories.splice(0)) {
        fs.rmSync(directory, { recursive: true, force: true });
        fs.rmSync(`${directory}.output`, { force: true });
    }
});

describe.skipIf(process.platform === 'win32')('Homebrew tap release preparation', () => {
    it('seeds the placeholder repository and writes the release checksum', () => {
        const tap = makeTap('README.md');
        const dmg = makeDmg(tap, '1.2.3', 'released dmg bytes');
        const result = prepare(tap, '1.2.3', dmg);

        expect(result.status, result.stderr).toBe(0);
        expect(result.workflowOutput).toBe('mode=seed\n');
        expect(fs.existsSync(path.join(tap, '.github', 'workflows', 'tests.yml'))).toBe(true);
        expect(fs.statSync(path.join(tap, 'bin', 'update-cask.sh')).mode & 0o111).not.toBe(0);

        const checksum = createHash('sha256').update('released dmg bytes').digest('hex');
        const cask = fs.readFileSync(path.join(tap, 'Casks', 'table-viewer.rb'), 'utf8');
        expect(cask).toContain('version "1.2.3"');
        expect(cask).toContain(`sha256 "${checksum}"`);
        expect(cask).not.toContain('0000000000000000000000000000000000000000000000000000000000000000');
    });

    it('uses the guarded updater after the tap has been seeded', () => {
        const tap = makeTap('README.md');
        const firstDmg = makeDmg(tap, '1.2.3', 'first dmg');
        expect(prepare(tap, '1.2.3', firstDmg).status).toBe(0);
        commitSeededTap(tap);

        const nextDmg = makeDmg(tap, '1.2.4-beta.1', 'next dmg');
        const result = prepare(tap, 'v1.2.4-beta.1', nextDmg);

        expect(result.status, result.stderr).toBe(0);
        expect(result.workflowOutput).toBe('mode=update\n');
        const cask = fs.readFileSync(path.join(tap, 'Casks', 'table-viewer.rb'), 'utf8');
        expect(cask).toContain('version "1.2.4-beta.1"');
        expect(cask).toContain(createHash('sha256').update('next dmg').digest('hex'));
        expect(spawnSync('git', ['-C', tap, 'diff', '--quiet', '--', 'Casks/table-viewer.rb']).status).toBe(1);
    });

    it('refuses to downgrade an initialized tap', () => {
        const tap = makeTap('README.md');
        const currentDmg = makeDmg(tap, '2.0.0', 'current dmg');
        expect(prepare(tap, '2.0.0', currentDmg).status).toBe(0);
        commitSeededTap(tap);

        const oldDmg = makeDmg(tap, '1.9.9', 'old dmg');
        const result = prepare(tap, '1.9.9', oldDmg);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('refusing to downgrade Homebrew cask from 2.0.0 to 1.9.9');
        const cask = fs.readFileSync(path.join(tap, 'Casks', 'table-viewer.rb'), 'utf8');
        expect(cask).toContain('version "2.0.0"');
        expect(spawnSync('git', ['-C', tap, 'diff', '--quiet']).status).toBe(0);
    });

    it('refuses to overwrite an unexpected partial tap', () => {
        const tap = makeTap('README.md', 'HAND_EDITED.md');
        const dmg = makeDmg(tap, '1.2.3', 'released dmg bytes');
        const result = prepare(tap, '1.2.3', dmg);

        expect(result.status).not.toBe(0);
        expect(result.stderr).toContain('refusing to seed tap with unexpected tracked file: HAND_EDITED.md');
        expect(fs.existsSync(path.join(tap, 'Casks', 'table-viewer.rb'))).toBe(false);
    });
});

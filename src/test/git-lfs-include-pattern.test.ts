/**
 * `git lfs pull --include=` takes glob patterns, not literal paths.
 *
 * These tests run against the real git-lfs binary, because the bug they cover
 * is invisible to a fake: a filename containing `[`, `*` or `?` is read as a
 * pattern, matches nothing, and `pull` exits 0 anyway — so the file stays a
 * pointer while the command claims success.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { escaped_include_pattern, node_git_lfs_port } from '../node-git-lfs';

describe('escaped_include_pattern', () => {
    it('escapes every glob metacharacter git-lfs would interpret', () => {
        expect(escaped_include_pattern('data[1].csv')).toBe('data\\[1\\].csv');
        expect(escaped_include_pattern('star*name.csv')).toBe('star\\*name.csv');
        expect(escaped_include_pattern('what?.csv')).toBe('what\\?.csv');
        // The backslash itself, and escaped first so its own output is not
        // re-escaped into `\\\\`.
        expect(escaped_include_pattern('back\\slash.csv')).toBe('back\\\\slash.csv');
    });

    it('leaves an ordinary path untouched', () => {
        expect(escaped_include_pattern('a/b/data.csv')).toBe('a/b/data.csv');
    });
});

const git = (cwd: string, ...args: string[]) =>
    execFileSync('git', args, { cwd, encoding: 'utf8' });

const NAMES = ['data[1].csv', 'star*name.csv', 'what?.csv', 'plain.csv'];
/** Committed so the refusal test names a file that really exists. */
const COMMA_NAME = 'with,comma.csv';
let root: string | undefined;
let repo: string;
let full_size = 0;
let available = true;

beforeAll(() => {
    try {
        execFileSync('git', ['lfs', 'version'], { encoding: 'utf8' });
    } catch {
        available = false;
        return;
    }
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-glob-'));
    git(root, 'init', '-q', '--bare', 'origin.git');
    const origin = path.join(root, 'origin.git');
    git(root, 'clone', '-q', origin, 'src');
    const src = path.join(root, 'src');
    git(src, 'lfs', 'install', '--local');
    fs.writeFileSync(path.join(src, '.gitattributes'),
        '*.csv filter=lfs diff=lfs merge=lfs -text\n');
    const rows = ['a,b'];
    for (let i = 0; i < 300; i += 1) rows.push(`${i},v${i}`);
    const body = `${rows.join('\n')}\n`;
    full_size = Buffer.byteLength(body);
    for (const name of [...NAMES, COMMA_NAME]) {
        fs.writeFileSync(path.join(src, name), body);
    }
    git(src, 'add', '-A');
    git(src, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x');
    git(src, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
    repo = path.join(root, 'ptr');
    execFileSync('git', ['clone', '-q', origin, 'ptr'],
        { cwd: root, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
    git(repo, 'lfs', 'install', '--local');
});

afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
});

const uri_for = (name: string) => {
    const p = path.join(repo, name);
    return { scheme: 'file', authority: '', path: p, query: '', fragment: '', fsPath: p };
};

describe('an object that is missing from the remote', () => {
    it('is reported as objectMissing, not as a generic failure', async () => {
        if (!available) return;
        // Real git-lfs 3.7.1 exits 2 with `remote missing object <oid>` here.
        // Classified distinctly because no retry can produce bytes the remote
        // does not have, so the banner must not offer one.
        // Built in its own origin so deleting the LFS store cannot affect the
        // other cases in this file, which share the fixture above.
        const iso = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-gone-'));
        git(iso, 'init', '-q', '--bare', 'origin.git');
        const iso_origin = path.join(iso, 'origin.git');
        git(iso, 'clone', '-q', iso_origin, 'src');
        const iso_src = path.join(iso, 'src');
        git(iso_src, 'lfs', 'install', '--local');
        fs.writeFileSync(path.join(iso_src, '.gitattributes'),
            '*.csv filter=lfs diff=lfs merge=lfs -text\n');
        fs.writeFileSync(path.join(iso_src, 'plain.csv'), 'a,b\n1,2\n');
        git(iso_src, 'add', '-A');
        git(iso_src, '-c', 'user.email=a@b', '-c', 'user.name=a', 'commit', '-qm', 'x');
        git(iso_src, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
        execFileSync('git', ['clone', '-q', iso_origin, 'gone'],
            { cwd: iso, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
        const fresh = path.join(iso, 'gone');
        git(fresh, 'lfs', 'install', '--local');
        // Now the object exists nowhere it could be fetched from.
        fs.rmSync(path.join(iso_origin, 'lfs'), { recursive: true, force: true });
        const target = path.join(fresh, 'plain.csv');
        expect(fs.statSync(target).size).toBeLessThan(200);
        const outcome = await node_git_lfs_port.pull({
            scheme: 'file', authority: '', path: target,
            query: '', fragment: '', fsPath: target,
        });
        expect(outcome).toMatchObject({ type: 'failed', reason: 'objectMissing' });
        // The oid must not leak verbatim into user-facing copy.
        expect((outcome as { detail?: string }).detail ?? '')
            .not.toMatch(/[0-9a-f]{20,}/u);
        fs.rmSync(iso, { recursive: true, force: true });
    }, 60_000);
});

describe('pulling a file whose name contains glob metacharacters', () => {
    for (const name of NAMES) {
        it(`fetches ${name} rather than reporting a false success`, async () => {
            if (!available) return;
            const target = path.join(repo, name);
            expect(fs.statSync(target).size).toBeLessThan(200);
            const outcome = await node_git_lfs_port.pull(uri_for(name));
            expect(outcome).toEqual({ type: 'resolved' });
            expect(fs.statSync(target).size).toBe(full_size);
        }, 60_000);
    }

    it('refuses a comma in the name instead of silently fetching nothing', async () => {
        if (!available) return;
        // git-lfs splits `--include` on commas and a backslash does not escape
        // the separator, so this file cannot be named in the argument at all.
        // Saying so beats a pull that exits 0 having matched nothing.
        const outcome = await node_git_lfs_port.pull(uri_for(COMMA_NAME));
        expect(outcome).toMatchObject({ type: 'failed', reason: 'failed' });
        expect((outcome as { detail?: string }).detail).toContain('comma');
    }, 60_000);
});

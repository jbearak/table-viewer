import * as assert from 'assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import * as vscode from 'vscode';
import { activate_extension } from './helpers';

/**
 * Does a resolve actually become visible to the extension?
 *
 * The controller decides whether the pointer is gone by re-reading the file
 * through `vscode.workspace.fs`, not through `node:fs`. If that read is served
 * from VS Code's cache, `git lfs pull` can rewrite the file on disk and the
 * extension will still see the pointer — which is exactly the symptom of a
 * resolve button that appears to do nothing. This isolates that question.
 */
describe('git-lfs resolve visibility through the VS Code filesystem', () => {
    let root: string | undefined;
    let file: string;
    let available = true;

    before(async () => {
        await activate_extension();
        try {
            execFileSync('git', ['lfs', 'version'], { encoding: 'utf8' });
        } catch {
            available = false;
            return;
        }
        const git = (cwd: string, ...args: string[]) =>
            execFileSync('git', args, { cwd, encoding: 'utf8' });
        // `--initial-branch` and the explicit checkout below keep this off the
        // ambient `init.defaultBranch`: where that is `master`, a bare repo's
        // HEAD points at `refs/heads/master` while the push targets `main`, so
        // the clone checks out nothing and every later read fails with ENOENT.
        root = fs.mkdtempSync(path.join(os.tmpdir(), 'lfs-vsc-'));
        git(root, 'init', '-q', '--bare', '--initial-branch=main', 'origin.git');
        const origin = path.join(root, 'origin.git');
        git(root, 'clone', '-q', origin, 'src');
        const src = path.join(root, 'src');
        git(src, 'lfs', 'install', '--local');
        fs.writeFileSync(path.join(src, '.gitattributes'),
            '*.csv filter=lfs diff=lfs merge=lfs -text\n');
        const rows = ['a,b'];
        for (let i = 0; i < 400; i += 1) rows.push(`${i},v${i}`);
        fs.writeFileSync(path.join(src, 'data.csv'), `${rows.join('\n')}\n`);
        git(src, 'checkout', '-q', '-B', 'main');
        git(src, 'add', '-A');
        git(
            src,
            '-c', 'user.email=table-viewer-test@example.invalid',
            '-c', 'user.name=Table Viewer Test',
            'commit', '-qm', 'fixture',
        );
        git(src, 'push', '-q', 'origin', 'HEAD:refs/heads/main');
        execFileSync('git', ['clone', '-q', origin, 'ptr'],
            { cwd: root, env: { ...process.env, GIT_LFS_SKIP_SMUDGE: '1' } });
        const repo = path.join(root, 'ptr');
        git(repo, 'lfs', 'install', '--local');
        file = path.join(repo, 'data.csv');
    });

    after(() => {
        if (root) fs.rmSync(root, { recursive: true, force: true });
    });

    it('sees the fetched bytes, not a cached pointer', async () => {
        if (!available) return;
        const uri = vscode.Uri.file(file);

        // Prime VS Code's cache the way opening the table does.
        const before = await vscode.workspace.fs.readFile(uri);
        assert.ok(before.byteLength < 200,
            `expected a pointer, got ${before.byteLength} bytes`);

        execFileSync('git', ['lfs', 'pull', '--include=data.csv'],
            { cwd: path.dirname(file), encoding: 'utf8' });

        const on_disk = fs.statSync(file).size;
        assert.ok(on_disk > 1000, `pull did not fetch: ${on_disk} bytes on disk`);

        // The question: does the extension's own read see it?
        let seen = 0;
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
            seen = (await vscode.workspace.fs.readFile(uri)).byteLength;
            if (seen === on_disk) break;
            await new Promise((r) => setTimeout(r, 100));
        }
        assert.strictEqual(seen, on_disk,
            `vscode.workspace.fs still returns ${seen} bytes `
            + `while ${on_disk} are on disk`);
    });
});

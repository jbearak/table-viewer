import * as assert from 'assert';
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import {
    TABLE_DIFF_SCHEME,
    table_diff_document_uris,
    table_diff_uris_from_unordered_pair,
} from '../table-diff-uris';
import {
    activate_extension,
    all_tabs,
    close_all_editors,
    has_custom_tab,
    wait_for,
} from './helpers';

const TABLE_VIEW_TYPE = 'tableViewer.editor';
const temporary_directories = new Set<string>();
process.once('exit', () => {
    for (const directory of temporary_directories) {
        fs.rmSync(directory, { recursive: true, force: true });
    }
});

interface GitApi {
    toGitUri(uri: vscode.Uri, ref: string): vscode.Uri;
    openRepository(root: vscode.Uri): Promise<unknown>;
}

async function git_api(): Promise<GitApi> {
    const extension = vscode.extensions.getExtension<{ getAPI(version: 1): GitApi }>('vscode.git');
    assert.ok(extension, 'the built-in Git extension must be available');
    const exports = extension.isActive ? extension.exports : await extension.activate();
    return exports.getAPI(1);
}

function initialize_repository(directory: string): vscode.Uri {
    execFileSync('git', ['init', '-q', directory]);
    execFileSync('git', ['-C', directory, 'config', 'user.name', 'Table Viewer Test']);
    execFileSync('git', ['-C', directory, 'config', 'user.email', 'test@example.com']);
    const file = vscode.Uri.file(path.join(directory, 'data.csv'));
    fs.writeFileSync(file.fsPath, 'value\n1\n');
    execFileSync('git', ['-C', directory, 'add', 'data.csv']);
    execFileSync('git', ['-C', directory, 'commit', '-qm', 'Initial table']);
    return file;
}

async function read_text(uri: vscode.Uri): Promise<string> {
    return Buffer.from(await vscode.workspace.fs.readFile(uri)).toString('utf8');
}

function tab_diagnostics(): string {
    return JSON.stringify(all_tabs().map((tab) => ({
        label: tab.label,
        inputType: tab.input?.constructor.name,
        uriScheme: tab.input instanceof vscode.TabInputCustom
            ? tab.input.uri.scheme
            : undefined,
    })));
}

describe('custom editor diffs', () => {
    let temporary_directory: string | undefined;

    afterEach(async () => {
        temporary_directory = undefined;
        await close_all_editors();
        // The built-in Git extension can still have delayed repository work in
        // flight. Keep its working directory alive until the extension host exits.
    });

    async function prepare_repository(): Promise<{
        readonly file: vscode.Uri;
        readonly api: GitApi;
    }> {
        await activate_extension();
        await close_all_editors();
        await vscode.commands.executeCommand('workbench.action.joinAllGroups');
        temporary_directory = fs.mkdtempSync(path.join(os.tmpdir(), 'table-viewer-diff-'));
        temporary_directories.add(temporary_directory);
        const file = initialize_repository(temporary_directory);
        const api = await git_api();
        const repository = await api.openRepository(vscode.Uri.file(temporary_directory));
        assert.ok(repository, 'the Git extension must open the temporary repository');
        return { file, api };
    }

    async function expect_one_table_diff(): Promise<void> {
        const settled = await wait_for(
            () => all_tabs().length === 1 && has_custom_tab(TABLE_VIEW_TYPE),
        );
        assert.strictEqual(
            settled,
            true,
            `expected one Table Viewer comparison tab; tabs=${tab_diagnostics()}`,
        );
        assert.strictEqual(all_tabs().length, 1);
        assert.strictEqual(
            vscode.window.tabGroups.all.length,
            1,
            `expected the comparison to remain in one editor group; tabs=${tab_diagnostics()}`,
        );
    }

    it('replaces an unstaged Git diff with one Table Viewer comparison', async () => {
        const { file, api } = await prepare_repository();
        fs.writeFileSync(file.fsPath, 'value\n2\n');
        const original = api.toGitUri(file, '~');
        assert.strictEqual(await read_text(original), 'value\n1\n');

        await vscode.commands.executeCommand(
            'vscode.diff',
            original,
            file,
            'Unstaged table diff',
        );

        await expect_one_table_diff();
        const comparison_tab = all_tabs()[0];
        assert.ok(comparison_tab.input instanceof vscode.TabInputCustom);
        assert.strictEqual(comparison_tab.input.uri.scheme, TABLE_DIFF_SCHEME);

        await vscode.commands.executeCommand('tableViewer.openWorkingTreeFile');
        const file_open = await wait_for(() => {
            const active = vscode.window.tabGroups.activeTabGroup.activeTab;
            return all_tabs().length === 2
                && active?.input instanceof vscode.TabInputCustom
                && active.input.uri.scheme === 'file';
        });
        assert.strictEqual(
            file_open,
            true,
            `expected Open File to retain the comparison and activate the file; tabs=${tab_diagnostics()}`,
        );
        assert.ok(all_tabs().includes(comparison_tab));

        await vscode.commands.executeCommand('git.openChange', file);
        const comparison_revealed = await wait_for(() => (
            all_tabs().length === 2
            && vscode.window.tabGroups.activeTabGroup.activeTab === comparison_tab
        ));
        assert.strictEqual(
            comparison_revealed,
            true,
            `expected Open Changes to reveal the retained comparison; tabs=${tab_diagnostics()}`,
        );
        assert.strictEqual(
            all_tabs().filter((tab) => (
                tab.input instanceof vscode.TabInputCustom
                && tab.input.uri.scheme === TABLE_DIFF_SCHEME
            )).length,
            1,
        );
    });

    it('replaces a staged Git diff with one Table Viewer comparison', async () => {
        const { file, api } = await prepare_repository();
        fs.writeFileSync(file.fsPath, 'value\n2\n');
        execFileSync('git', ['-C', temporary_directory!, 'add', 'data.csv']);
        const original = api.toGitUri(file, 'HEAD');
        const modified = api.toGitUri(file, '');
        assert.strictEqual(await read_text(original), 'value\n1\n');
        assert.strictEqual(await read_text(modified), 'value\n2\n');

        await vscode.commands.executeCommand(
            'vscode.diff',
            original,
            modified,
            'Staged table diff',
        );

        await expect_one_table_diff();
        const comparison_tab = all_tabs()[0];
        assert.ok(comparison_tab.input instanceof vscode.TabInputCustom);
        assert.strictEqual(comparison_tab.input.uri.scheme, TABLE_DIFF_SCHEME);

        await vscode.commands.executeCommand('tableViewer.openWorkingTreeFile');
        const file_open = await wait_for(() => {
            const active = vscode.window.tabGroups.activeTabGroup.activeTab;
            return all_tabs().length === 2
                && active?.input instanceof vscode.TabInputCustom
                && active.input.uri.scheme === 'file'
                && active.input.uri.fsPath === file.fsPath;
        });
        assert.strictEqual(
            file_open,
            true,
            `expected staged Open File to activate the working tree; tabs=${tab_diagnostics()}`,
        );
        assert.ok(all_tabs().includes(comparison_tab));
    });

    it('replaces a Source Control Graph commit change with one Table Viewer comparison', async () => {
        const { file, api } = await prepare_repository();
        const parent = execFileSync(
            'git',
            ['-C', temporary_directory!, 'rev-parse', 'HEAD'],
            { encoding: 'utf8' },
        ).trim();
        fs.writeFileSync(file.fsPath, 'value\n2\n');
        execFileSync('git', ['-C', temporary_directory!, 'add', 'data.csv']);
        execFileSync('git', ['-C', temporary_directory!, 'commit', '-qm', 'Intermediate update']);
        fs.writeFileSync(file.fsPath, 'value\n3\n');
        execFileSync('git', ['-C', temporary_directory!, 'commit', '-qam', 'Final update']);
        const commit = execFileSync(
            'git',
            ['-C', temporary_directory!, 'rev-parse', 'HEAD'],
            { encoding: 'utf8' },
        ).trim();
        const original = api.toGitUri(file, parent);
        const modified = api.toGitUri(file, commit);
        assert.ok((await vscode.workspace.fs.stat(original)).size > 0);
        assert.ok((await vscode.workspace.fs.stat(modified)).size > 0);
        assert.strictEqual(await read_text(original), 'value\n1\n');
        assert.strictEqual(await read_text(modified), 'value\n3\n');
        const orientations = await Promise.all([
            table_diff_uris_from_unordered_pair(original, modified),
            table_diff_uris_from_unordered_pair(modified, original),
        ]);
        for (const oriented of orientations) {
            assert.ok(oriented, 'the Git API must resolve non-adjacent revision ancestry');
            assert.strictEqual(oriented.original.toString(), original.toString());
            assert.strictEqual(oriented.modified.toString(), modified.toString());
        }

        await vscode.commands.executeCommand(
            'vscode.diff',
            original,
            modified,
            'Source Control Graph table diff',
        );

        await expect_one_table_diff();
        const comparison_tab = all_tabs()[0];
        assert.ok(comparison_tab.input instanceof vscode.TabInputCustom);
        const decoded = table_diff_document_uris(comparison_tab.input.uri);
        assert.ok(decoded, 'the comparison document must decode');
        assert.strictEqual(decoded.original.toString(), original.toString());
        assert.strictEqual(decoded.modified.toString(), modified.toString());

        await vscode.commands.executeCommand('tableViewer.openWorkingTreeFile');
        const file_open = await wait_for(() => {
            const active = vscode.window.tabGroups.activeTabGroup.activeTab;
            return all_tabs().length === 2
                && active?.input instanceof vscode.TabInputCustom
                && active.input.uri.scheme === 'file'
                && active.input.uri.fsPath === file.fsPath;
        });
        assert.strictEqual(
            file_open,
            true,
            `expected Source Control Graph Open File to retain the comparison; tabs=${tab_diagnostics()}`,
        );
        assert.ok(all_tabs().includes(comparison_tab));
    });
});

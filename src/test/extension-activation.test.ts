import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

const seams = vi.hoisted(() => ({
    events: [] as string[],
    openedOptions: undefined as {
        storageDirectory: string;
        appVersion: string;
        getMaxStoredFiles?: () => number;
    } | undefined,
    openError: undefined as Error | undefined,
    store: undefined as any,
    failViewerRegistration: false,
    throwViewerDispose: false,
    throwViewerDrain: false,
    throwPreviewDispose: false,
    throwPreviewDrain: false,
    throwDatabaseClose: false,
    openSheetResult: true,
    openSheetError: undefined as Error | undefined,
    openSheetArgs: undefined as { uri: unknown; sheetName: string } | undefined,
    openDiffError: undefined as Error | undefined,
    openDiffArgs: undefined as {
        diff: { modified: unknown; original: unknown };
        viewColumn: unknown;
    } | undefined,
    openWorkingTreeArgs: undefined as unknown,
    nativeDiffDuringRegistration: undefined as {
        tab: unknown;
        diff: { modified: unknown; original: unknown };
    } | undefined,
}));

vi.mock('../custom-editor', () => ({
    TABLE_VIEW_TYPE: 'tableViewer.editor',
    register_table_viewer: (
        _context: unknown,
        store: unknown,
        options?: { replaceNativeDiff?(tab: unknown, diff: unknown): void },
    ) => {
        seams.events.push(store === seams.store ? 'register:viewers' : 'register:wrong-store');
        if (seams.failViewerRegistration) throw new Error('viewer registration failed');
        if (seams.nativeDiffDuringRegistration) {
            options?.replaceNativeDiff?.(
                seams.nativeDiffDuringRegistration.tab,
                seams.nativeDiffDuringRegistration.diff,
            );
        }
        return {
            dispose() {
                seams.events.push('dispose:viewers');
                if (seams.throwViewerDispose) throw new Error('viewer dispose failed');
            },
            async drain() {
                seams.events.push('drain:viewers');
                if (seams.throwViewerDrain) throw new Error('viewer drain failed');
            },
            async openWorkbookAtSheet(uri: unknown, sheetName: string) {
                seams.openSheetArgs = { uri, sheetName };
                if (seams.openSheetError) throw seams.openSheetError;
                return seams.openSheetResult;
            },
            async openTableDiff(
                diff: { modified: unknown; original: unknown },
                viewColumn: unknown,
            ) {
                seams.openDiffArgs = { diff, viewColumn };
                if (seams.openDiffError) throw seams.openDiffError;
            },
            async openWorkingTreeFile(uri: unknown) {
                seams.openWorkingTreeArgs = uri;
            },
        };
    },
}));

vi.mock('../csv-preview', () => ({
    show_csv_preview() {},
    dispose_csv_preview() {
        seams.events.push('dispose:preview');
        if (seams.throwPreviewDispose) throw new Error('preview dispose failed');
    },
    async drain_csv_previews() {
        seams.events.push('drain:preview');
        if (seams.throwPreviewDrain) throw new Error('preview drain failed');
    },
}));

vi.mock('../vscode-state-database', () => ({
    open_vscode_state_database: async (options: typeof seams.openedOptions) => {
        seams.openedOptions = options;
        if (seams.openError) {
            seams.events.push('open:failed');
            throw seams.openError;
        }
        seams.events.push('open:sqlite');
        return {
            databasePath: `${options!.storageDirectory}/file-state.sqlite3`,
            store: seams.store,
            async close() {
                seams.events.push('close:database');
                if (seams.throwDatabaseClose) throw new Error('database close failed');
            },
        };
    },
}));

import { activate, deactivate } from '../extension';
import {
    TABLE_DIFF_SCHEME,
    table_diff_document_uri,
    table_diff_document_uris,
    table_diff_uris,
    table_diff_working_tree_uri,
} from '../table-diff-uris';

function git_uri(path: string, ref: string): vscode.Uri {
    return vscode_mock.Uri.file(path).with({
        scheme: 'git',
        query: JSON.stringify({ path, ref }),
    }) as unknown as vscode.Uri;
}

function context(): vscode.ExtensionContext {
    const values = new Map<string, unknown>();
    return {
        extensionUri: vscode_mock.Uri.file('/extension'),
        globalStorageUri: vscode_mock.Uri.file('/global-storage'),
        extension: { packageJSON: { version: '0.7.0' } },
        globalState: {
            get(key: string, fallback?: unknown) {
                return values.has(key) ? values.get(key) : fallback;
            },
            async update(key: string, value: unknown) {
                values.set(key, value);
            },
        },
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

beforeEach(async () => {
    await deactivate();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    seams.events.length = 0;
    seams.openedOptions = undefined;
    seams.openError = undefined;
    seams.store = versioned_state_store().store;
    seams.failViewerRegistration = false;
    seams.throwViewerDispose = false;
    seams.throwViewerDrain = false;
    seams.throwPreviewDispose = false;
    seams.throwPreviewDrain = false;
    seams.throwDatabaseClose = false;
    seams.openSheetResult = true;
    seams.openSheetError = undefined;
    seams.openSheetArgs = undefined;
    seams.openDiffError = undefined;
    seams.openDiffArgs = undefined;
    seams.openWorkingTreeArgs = undefined;
    seams.nativeDiffDuringRegistration = undefined;
});

afterEach(async () => {
    await deactivate();
});

describe('table_diff_uris', () => {
    it('recognizes the unstaged and staged Git SCM diff shapes', () => {
        const file = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const unstaged_original = git_uri('/repo/data.csv', '~');
        expect(table_diff_uris(unstaged_original, file)).toEqual({
            original: unstaged_original,
            modified: file,
        });

        const staged_original = git_uri('/repo/data.csv', 'HEAD');
        const staged_modified = git_uri('/repo/data.csv', '');
        expect(table_diff_uris(staged_original, staged_modified)).toEqual({
            original: staged_original,
            modified: staged_modified,
        });
    });

    it.each(['csv', 'TSV', 'xls', 'XLSX'])(
        'recognizes a Source Control Graph %s commit diff',
        (extension) => {
            const file_path = `/repo/tables/data.${extension}`;
            const original = git_uri(file_path, 'a'.repeat(40));
            const modified = git_uri(file_path, 'b'.repeat(40));

            expect(table_diff_uris(original, modified)).toEqual({ original, modified });
        },
    );

    it('rejects non-object and mismatched Git history revisions', () => {
        const file_path = '/repo/data.csv';
        const parent = 'a'.repeat(40);
        const commit = 'b'.repeat(40);
        const original = git_uri(file_path, parent);
        const modified = git_uri(file_path, commit);

        expect(table_diff_uris(git_uri(file_path, parent.slice(0, 7)), modified))
            .toBeUndefined();
        expect(table_diff_uris(git_uri(file_path, 'HEAD'), modified)).toBeUndefined();
        expect(table_diff_uris(original, git_uri(file_path, parent))).toBeUndefined();
        expect(table_diff_uris(
            original,
            git_uri('/repo/other.csv', commit).with({ path: file_path }) as vscode.Uri,
        )).toBeUndefined();
        expect(table_diff_uris(
            original.with({
                query: JSON.stringify({ path: '/repo/other.csv', ref: parent }),
            }) as vscode.Uri,
            modified,
        )).toBeUndefined();
    });

    it('round-trips Source Control Graph revisions and derives the working-tree file', () => {
        const diff = {
            original: git_uri('/repo/nested/data.csv', 'c'.repeat(40)),
            modified: git_uri('/repo/nested/data.csv', 'd'.repeat(40)),
        };

        const document = table_diff_document_uri(diff);
        const decoded = table_diff_document_uris(document);

        expect(decoded).toMatchObject({
            original: expect.objectContaining({ scheme: 'git' }),
            modified: expect.objectContaining({ scheme: 'git' }),
        });
        expect(table_diff_document_uri(decoded!).toString()).toBe(document.toString());
        expect(table_diff_working_tree_uri(decoded!)).toMatchObject({
            scheme: 'file',
            path: '/repo/nested/data.csv',
            query: '',
            fragment: '',
        });
    });

    it('ignores non-SCM refs, unsupported files, and mismatched resources', () => {
        const file = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        expect(table_diff_uris(git_uri('/repo/data.csv', '~1'), file)).toBeUndefined();
        expect(table_diff_uris(
            git_uri('/repo/data.txt', '~'),
            vscode_mock.Uri.file('/repo/data.txt') as unknown as vscode.Uri,
        )).toBeUndefined();
        expect(table_diff_uris(
            git_uri('/repo/other.csv', '~'),
            file,
        )).toBeUndefined();
        expect(table_diff_uris(
            git_uri('/repo/data.csv', 'HEAD'),
            git_uri('/repo/data.csv', '~'),
        )).toBeUndefined();
        expect(table_diff_uris(
            git_uri('/repo/other.csv', '~').with({ path: '/repo/data.csv' }) as vscode.Uri,
            file,
        )).toBeUndefined();
    });

    it('round-trips stable, distinct unstaged and staged comparison documents', () => {
        const file = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const unstaged = {
            original: git_uri('/repo/data.csv', '~'),
            modified: file,
        };
        const staged = {
            original: git_uri('/repo/data.csv', 'HEAD'),
            modified: git_uri('/repo/data.csv', ''),
        };

        const unstaged_document = table_diff_document_uri(unstaged);
        const staged_document = table_diff_document_uri(staged);

        expect(unstaged_document.scheme).toBe(TABLE_DIFF_SCHEME);
        expect(table_diff_document_uri(unstaged).toString()).toBe(
            unstaged_document.toString(),
        );
        expect(staged_document.toString()).not.toBe(unstaged_document.toString());
        expect(table_diff_document_uris(unstaged_document)).toMatchObject({
            original: expect.objectContaining({ scheme: 'git', path: '/repo/data.csv' }),
            modified: expect.objectContaining({ scheme: 'file', path: '/repo/data.csv' }),
        });
        const decoded_staged = table_diff_document_uris(staged_document);
        expect(decoded_staged).toMatchObject({
            original: expect.objectContaining({ scheme: 'git', path: '/repo/data.csv' }),
            modified: expect.objectContaining({ scheme: 'git', path: '/repo/data.csv' }),
        });
        expect(table_diff_working_tree_uri(decoded_staged!)).toMatchObject({
            scheme: 'file',
            path: '/repo/data.csv',
            query: '',
        });
    });

    it('derives a staged working-tree URI from the embedded Git path', () => {
        const original = git_uri('/repo/data.csv', 'HEAD').with({
            path: '/repo/data.csv.git',
        }) as vscode.Uri;
        const modified = git_uri('/repo/data.csv', '').with({
            path: '/repo/data.csv.git',
        }) as vscode.Uri;

        expect(table_diff_working_tree_uri({ original, modified })).toMatchObject({
            scheme: 'file',
            path: '/repo/data.csv',
            query: '',
            fragment: '',
        });
    });

    it('rejects malformed or spoofed comparison document identities', () => {
        const file = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const valid = table_diff_document_uri({
            original: git_uri('/repo/data.csv', '~'),
            modified: file,
        });

        expect(table_diff_document_uris(valid.with({ query: 'not-base64' }) as vscode.Uri))
            .toBeUndefined();
        expect(table_diff_document_uris(valid.with({ path: '/repo/other.csv' }) as vscode.Uri))
            .toBeUndefined();
        const mismatched_git_path = table_diff_document_uri({
            original: git_uri('/repo/other.csv', '~').with({
                path: '/repo/data.csv',
            }) as vscode.Uri,
            modified: file,
        });
        expect(table_diff_document_uris(mismatched_git_path)).toBeUndefined();
        expect(table_diff_document_uris(file)).toBeUndefined();
    });
});

describe('VS Code activation', () => {
    it('opens the SQLite state database under global storage and registers the live commands', async () => {
        const created: string[] = [];
        vscode_mock.__setCreateDirectoryImplementation(async (uri) => {
            created.push(uri.fsPath);
        });

        await activate(context());

        expect(created).toEqual(['/global-storage/state']);
        expect(seams.openedOptions).toMatchObject({
            storageDirectory: '/global-storage/state',
            appVersion: '0.7.0',
        });
        expect(seams.events).toEqual(['open:sqlite', 'register:viewers']);
        expect(vscode_mock.__getRegisteredCommands()).toEqual([
            'tableViewer.showCsvPreviewToSide',
            'tableViewer.showCsvPreview',
            'tableViewer.openCsvTable',
            'tableViewer.openAsText',
            'tableViewer.openWorkingTreeFile',
            'tableViewer.openWorkbookAtSheet',
            'tableViewer.openTableDiff',
            'tableViewer.openStagedTableDiff',
            'tableViewer.manageStoredFileState',
        ]);
    });

    it('registers no retired migration or physical-edit command', async () => {
        await activate(context());

        for (const retired of [
            'tableViewer.setupPhysicalEditProtocol',
            'tableViewer.armSqliteMigration',
            'tableViewer.upgradeToSqlitePersistence',
        ]) {
            expect(vscode_mock.__getRegisteredCommands()).not.toContain(retired);
        }
    });

    it('opens a workbook at a worksheet and warns when the worksheet is absent', async () => {
        await activate(context());
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const args = { uri: 'file:///workbooks/book.xlsx', sheetName: 'Table A1' };

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openWorkbookAtSheet',
            args,
        )).resolves.toBe(true);
        expect(seams.openSheetArgs).toMatchObject({
            uri: expect.objectContaining({ scheme: 'file', path: '/workbooks/book.xlsx' }),
            sheetName: 'Table A1',
        });
        expect(warning).not.toHaveBeenCalled();

        seams.openSheetResult = false;
        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openWorkbookAtSheet',
            args,
        )).resolves.toBe(false);
        expect(warning).toHaveBeenCalledWith('Worksheet "Table A1" was not found.');
    });

    it('opens a table diff for an SCM resource state against its git original', async () => {
        await activate(context());
        const uri = vscode_mock.Uri.file('/repo/data.csv');

        await vscode_mock.commands.executeCommand(
            'tableViewer.openTableDiff',
            { resourceUri: uri },
        );

        expect(seams.openDiffArgs).toMatchObject({
            diff: {
                modified: expect.objectContaining({ scheme: 'file', path: '/repo/data.csv' }),
                original: expect.objectContaining({
                    scheme: 'git',
                    query: JSON.stringify({ path: '/repo/data.csv', ref: '~' }),
                }),
            },
        });
    });

    it('opens a staged table diff from the index against HEAD', async () => {
        await activate(context());
        const uri = vscode_mock.Uri.file('/repo/data.csv');

        await vscode_mock.commands.executeCommand(
            'tableViewer.openStagedTableDiff',
            { resourceUri: uri },
        );

        expect(seams.openDiffArgs).toMatchObject({
            diff: {
                modified: expect.objectContaining({
                    scheme: 'git',
                    query: JSON.stringify({ path: '/repo/data.csv', ref: '' }),
                }),
                original: expect.objectContaining({
                    scheme: 'git',
                    query: JSON.stringify({ path: '/repo/data.csv', ref: 'HEAD' }),
                }),
            },
        });
    });

    it.each([
        {
            name: 'unstaged',
            diff: {
                original: git_uri('/repo/data.csv', '~'),
                modified: vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri,
            },
        },
        {
            name: 'staged',
            diff: {
                original: git_uri('/repo/data.csv', 'HEAD'),
                modified: git_uri('/repo/data.csv', ''),
            },
        },
    ])('opens the working-tree file from a $name comparison document', async ({ diff }) => {
        await activate(context());

        await vscode_mock.commands.executeCommand(
            'tableViewer.openWorkingTreeFile',
            table_diff_document_uri(diff),
        );

        expect(seams.openWorkingTreeArgs).toMatchObject({
            scheme: 'file',
            path: '/repo/data.csv',
            query: '',
        });
    });

    it('ignores Open File outside a Table Viewer comparison document', async () => {
        await activate(context());

        await vscode_mock.commands.executeCommand(
            'tableViewer.openWorkingTreeFile',
            vscode_mock.Uri.file('/repo/data.csv'),
        );

        expect(seams.openWorkingTreeArgs).toBeUndefined();
    });

    it.each([
        {
            name: 'unstaged',
            original: git_uri('/repo/data.csv', '~'),
            modified: vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri,
        },
        {
            name: 'staged',
            original: git_uri('/repo/data.csv', 'HEAD'),
            modified: git_uri('/repo/data.csv', ''),
        },
        {
            name: 'Source Control Graph history',
            original: git_uri('/repo/data.csv', 'd'.repeat(40)),
            modified: git_uri('/repo/data.csv', 'e'.repeat(40)),
        },
    ])('replaces a native $name diff tab with one Table Viewer comparison', async ({
        original,
        modified,
    }) => {
        await activate(context());
        const tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(original, modified),
        };

        await vscode_mock.__fireTabChange({ opened: [tab], changed: [tab] });

        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
        expect(seams.openDiffArgs).toEqual({
            diff: { modified, original },
            viewColumn: vscode_mock.ViewColumn.One,
        });
    });

    it('replaces a restored native diff in its own inactive editor group', async () => {
        const unrelated: vscode_mock.MockTab = { label: 'notes.txt', input: undefined };
        const original = git_uri('/repo/data.csv', '~');
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const diff_tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(original, modified),
        };
        vscode_mock.__setTabGroups([
            { viewColumn: vscode_mock.ViewColumn.One, tabs: [unrelated] },
            { viewColumn: vscode_mock.ViewColumn.Two, tabs: [diff_tab] },
        ], vscode_mock.ViewColumn.One);

        await activate(context());

        await vi.waitFor(() => expect(seams.openDiffArgs).toEqual({
            diff: { modified, original },
            viewColumn: vscode_mock.ViewColumn.Two,
        }));
        expect(vscode_mock.__getClosedTabs()).toEqual([diff_tab]);
        expect(vscode_mock.window.tabGroups.activeTabGroup.activeTab).toBe(unrelated);
    });

    it('retries replacement after VS Code declines to close a native diff tab', async () => {
        await activate(context());
        const tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(
                git_uri('/repo/data.csv', '~'),
                vscode_mock.Uri.file('/repo/data.csv'),
            ),
        };
        vscode_mock.__setCloseTabImplementation(async () => false);

        await vscode_mock.__fireTabChange({ opened: [tab] });
        expect(seams.openDiffArgs).toBeDefined();
        expect(vscode_mock.__getClosedTabs()).toEqual([]);

        vscode_mock.__setCloseTabImplementation(undefined);
        await vscode_mock.__fireTabChange({ changed: [tab] });
        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
    });

    it('replays an older custom-editor diff resolved during activation', async () => {
        const original = git_uri('/repo/data.csv', '~');
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const tab: vscode_mock.MockTab = { label: 'data.csv', input: undefined };
        await vscode_mock.__fireTabChange({ opened: [tab] });
        seams.nativeDiffDuringRegistration = {
            tab,
            diff: { original, modified },
        };

        await activate(context());

        await vi.waitFor(() => expect(seams.openDiffArgs).toEqual({
            diff: { modified, original },
            viewColumn: vscode_mock.ViewColumn.One,
        }));
        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
    });

    it('replaces a native diff that was already open when activation finished', async () => {
        const original = git_uri('/repo/data.csv', '~');
        const modified = vscode_mock.Uri.file('/repo/data.csv') as unknown as vscode.Uri;
        const tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(original, modified),
        };
        await vscode_mock.__fireTabChange({ opened: [tab] });

        await activate(context());

        await vi.waitFor(() => expect(seams.openDiffArgs).toEqual({
            diff: { modified, original },
            viewColumn: vscode_mock.ViewColumn.One,
        }));
        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
    });

    it('leaves unrelated native diff tabs open', async () => {
        await activate(context());
        const tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(
                git_uri('/repo/data.csv', '~1'),
                vscode_mock.Uri.file('/repo/data.csv'),
            ),
        };

        await vscode_mock.__fireTabChange({ opened: [tab] });

        expect(vscode_mock.__getClosedTabs()).toEqual([]);
        expect(seams.openDiffArgs).toBeUndefined();
    });

    it('reports a native diff replacement failure without rejecting the tab event', async () => {
        await activate(context());
        seams.openDiffError = new Error('replacement could not open');
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const tab: vscode_mock.MockTab = {
            label: 'data.csv',
            input: new vscode_mock.TabInputTextDiff(
                git_uri('/repo/data.csv', '~'),
                vscode_mock.Uri.file('/repo/data.csv'),
            ),
        };

        await expect(vscode_mock.__fireTabChange({ opened: [tab] })).resolves.toBeUndefined();

        await vi.waitFor(() => expect(show_error).toHaveBeenCalledWith(
            'replacement could not open',
        ));
        expect(vscode_mock.__getClosedTabs()).toEqual([]);

        seams.openDiffError = undefined;
        await vscode_mock.__fireTabChange({ changed: [tab] });
        expect(vscode_mock.__getClosedTabs()).toEqual([tab]);
    });

    it('prefers the git extension API for the original URI when available', async () => {
        await activate(context());
        const api_uri = vscode_mock.Uri.file('/repo/data.csv')
            .with({ scheme: 'git', query: 'from-api' });
        vscode_mock.__setExtension('vscode.git', {
            exports: {
                getAPI: () => ({ toGitUri: (_uri: unknown, ref: string) => {
                    expect(ref).toBe('~');
                    return api_uri;
                } }),
            },
        });

        await vscode_mock.commands.executeCommand(
            'tableViewer.openTableDiff',
            { resourceUri: vscode_mock.Uri.file('/repo/data.csv') },
        );

        expect(seams.openDiffArgs?.diff.original).toBe(api_uri);
    });

    it('refuses a table diff for a file missing from the working tree', async () => {
        await activate(context());
        vscode_mock.__setStatImplementation(async () => {
            throw Object.assign(new Error('missing'), { code: 'FileNotFound' });
        });
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openTableDiff',
            { resourceUri: vscode_mock.Uri.file('/repo/gone.csv') },
        )).rejects.toThrow('no longer exists in the working tree');
        expect(show_error).toHaveBeenCalledOnce();
        expect(seams.openDiffArgs).toBeUndefined();
    });

    it('preserves non-missing stat failures when opening an unstaged diff', async () => {
        await activate(context());
        const error = Object.assign(new Error('permission denied'), { code: 'NoPermissions' });
        vscode_mock.__setStatImplementation(async () => { throw error; });
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openTableDiff',
            { resourceUri: vscode_mock.Uri.file('/repo/data.csv') },
        )).rejects.toBe(error);
        expect(show_error).toHaveBeenCalledWith('permission denied');
        expect(seams.openDiffArgs).toBeUndefined();
    });

    it('ignores a table diff invocation with no file target', async () => {
        await activate(context());

        await vscode_mock.commands.executeCommand('tableViewer.openTableDiff', {});

        expect(seams.openDiffArgs).toBeUndefined();
    });

    it('reports a table diff open failure and preserves the rejection', async () => {
        await activate(context());
        const error = new Error('diff could not open');
        seams.openDiffError = error;
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openTableDiff',
            { resourceUri: vscode_mock.Uri.file('/repo/data.csv') },
        )).rejects.toBe(error);
        expect(show_error).toHaveBeenCalledWith('diff could not open');
    });

    it('reports a workbook open failure and preserves the command rejection', async () => {
        await activate(context());
        const error = new Error('workbook could not be opened');
        seams.openSheetError = error;
        const show_error = vi.spyOn(vscode_mock.window, 'showErrorMessage');

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openWorkbookAtSheet',
            { uri: 'file:///workbooks/book.xlsx', sheetName: 'Table A1' },
        )).rejects.toBe(error);
        expect(show_error).toHaveBeenCalledWith('workbook could not be opened');
    });

    it('rejects malformed workbook-at-worksheet command arguments', async () => {
        await activate(context());

        await expect(vscode_mock.commands.executeCommand(
            'tableViewer.openWorkbookAtSheet',
            { uri: 'file:///workbooks/book.xlsx' },
        )).rejects.toThrow(
            'requires { uri: string, sheetName: string }',
        );
        expect(seams.openSheetArgs).toBeUndefined();
    });

    it('clamps a hand-edited maxStoredFiles setting at both bounds', async () => {
        await activate(context());
        const get_max = seams.openedOptions?.getMaxStoredFiles;
        expect(get_max?.()).toBe(10_000);

        vscode_mock.__setConfigurationValue('tableViewer.maxStoredFiles', 0);
        expect(get_max?.()).toBe(1);
        vscode_mock.__setConfigurationValue('tableViewer.maxStoredFiles', 10 ** 9);
        expect(get_max?.()).toBe(100_000);
        vscode_mock.__setConfigurationValue('tableViewer.maxStoredFiles', 12.7);
        expect(get_max?.()).toBe(12);
        vscode_mock.__setConfigurationValue('tableViewer.maxStoredFiles', Number.NaN);
        expect(get_max?.()).toBe(10_000);
        vscode_mock.__setConfigurationValue('tableViewer.maxStoredFiles', 'lots');
        expect(get_max?.()).toBe(10_000);
    });

    it('fails activation loudly when the database cannot be opened', async () => {
        // SQLite is the only backend, so there is nothing to degrade to. Activation
        // must fail where VS Code will show it rather than come up with authority
        // the user cannot see the loss of.
        seams.openError = new Error(
            'Table Viewer could not open its state database at /global-storage/state/'
            + 'file-state.sqlite3: database is locked.',
        );
        const shown: unknown[] = [];
        vi.spyOn(vscode_mock.window, 'showErrorMessage')
            .mockImplementation((...args: unknown[]) => {
                shown.push(args[0]);
                return undefined as never;
            });

        await expect(activate(context())).rejects.toBe(seams.openError);

        expect(shown).toEqual([seams.openError.message]);
        // Nothing was registered, and no store was ever handed out.
        expect(seams.events).toEqual(['open:failed']);
        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
    });

    it('rethrows a non-Error open failure and still tells the user something', async () => {
        seams.openError = 'refused' as unknown as Error;
        const shown: unknown[] = [];
        vi.spyOn(vscode_mock.window, 'showErrorMessage')
            .mockImplementation((...args: unknown[]) => {
                shown.push(args[0]);
                return undefined as never;
            });

        await expect(activate(context())).rejects.toBe('refused');

        expect(shown).toEqual(['refused']);
    });

    it('fails activation rather than deactivating a runtime it never built', async () => {
        seams.openError = new Error('open refused');
        vi.spyOn(vscode_mock.window, 'showErrorMessage')
            .mockImplementation(() => undefined as never);

        await expect(activate(context())).rejects.toThrow('open refused');
        seams.events.length = 0;

        // VS Code does not call deactivate for an activation that threw, but a
        // teardown that arrived anyway must not touch a database that was never
        // opened or dispose registrations that were never made.
        await deactivate();

        expect(seams.events).toEqual([]);
    });

    it('closes the database when viewer registration fails during activation', async () => {
        seams.failViewerRegistration = true;

        await expect(activate(context())).rejects.toThrow('viewer registration failed');

        expect(seams.events).toEqual([
            'open:sqlite',
            'register:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
    });

    it('rolls back partial command registration, drains viewers, and closes the database', async () => {
        const register_command = vscode_mock.commands.registerCommand.bind(vscode_mock.commands);
        let registrations = 0;
        vi.spyOn(vscode_mock.commands, 'registerCommand').mockImplementation((command, handler) => {
            registrations += 1;
            if (registrations === 2) throw new Error('command registration failed');
            return register_command(command, handler);
        });

        await expect(activate(context())).rejects.toThrow('command registration failed');

        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
        expect(seams.events).toEqual([
            'open:sqlite',
            'register:viewers',
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
    });

    it('preserves the activation error when the rollback close also fails', async () => {
        const register_command = vscode_mock.commands.registerCommand.bind(vscode_mock.commands);
        let registrations = 0;
        vi.spyOn(vscode_mock.commands, 'registerCommand').mockImplementation((command, handler) => {
            registrations += 1;
            if (registrations === 2) throw new Error('command registration failed');
            return register_command(command, handler);
        });
        seams.throwDatabaseClose = true;

        await expect(activate(context())).rejects.toThrow('command registration failed');

        expect(seams.events.at(-1)).toBe('close:database');
    });

    it('shares concurrent teardown and closes the database exactly once', async () => {
        await activate(context());
        seams.events.length = 0;

        const teardown = deactivate();
        expect(deactivate()).toBe(teardown);
        await teardown;
        await deactivate();

        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });

    it('keeps SQLite open after a failed viewer drain and retries deactivation later', async () => {
        const register_command = vscode_mock.commands.registerCommand.bind(vscode_mock.commands);
        vi.spyOn(vscode_mock.commands, 'registerCommand').mockImplementation((command, handler) => {
            const registered = register_command(command, handler);
            return {
                dispose() {
                    registered.dispose();
                    throw new Error('command dispose failed');
                },
            };
        });
        await activate(context());
        seams.events.length = 0;
        seams.throwViewerDispose = true;
        seams.throwViewerDrain = true;
        seams.throwPreviewDispose = true;

        const failed_teardown = deactivate();
        expect(deactivate()).toBe(failed_teardown);
        await expect(failed_teardown).rejects.toThrow('viewer drain failed');

        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
        ]);

        seams.throwViewerDrain = false;
        await deactivate();
        await deactivate();

        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });

    it('keeps SQLite open after a failed preview drain and retries deactivation later', async () => {
        await activate(context());
        seams.events.length = 0;
        seams.throwPreviewDrain = true;

        await expect(deactivate()).rejects.toThrow('preview drain failed');

        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
        ]);

        seams.throwPreviewDrain = false;
        await deactivate();
        await deactivate();

        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });
});

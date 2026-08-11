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
    openSheetArgs: undefined as { uri: unknown; sheetName: string } | undefined,
}));

vi.mock('../custom-editor', () => ({
    TABLE_VIEW_TYPE: 'tableViewer.editor',
    register_table_viewer: (_context: unknown, store: unknown) => {
        seams.events.push(store === seams.store ? 'register:viewers' : 'register:wrong-store');
        if (seams.failViewerRegistration) throw new Error('viewer registration failed');
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
                return seams.openSheetResult;
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
    seams.openSheetArgs = undefined;
});

afterEach(async () => {
    await deactivate();
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
            'tableViewer.openWorkbookAtSheet',
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

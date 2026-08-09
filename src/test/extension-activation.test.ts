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
        openFallbackStore: () => { store: any; close(): Promise<void> };
        warn: (message: string) => void | Promise<void>;
    } | undefined,
    mode: 'sqlite' as 'sqlite' | 'fallback',
    store: undefined as any,
    fallbackStore: undefined as any,
    failViewerRegistration: false,
    throwViewerDispose: false,
    throwViewerDrain: false,
    throwPreviewDispose: false,
    throwDatabaseClose: false,
}));

vi.mock('../custom-editor', () => ({
    TABLE_VIEW_TYPE: 'tableViewer.editor',
    register_table_viewer: (_context: unknown, store: unknown) => {
        const expected = seams.mode === 'sqlite' ? seams.store : seams.fallbackStore;
        seams.events.push(store === expected ? 'register:viewers' : 'register:wrong-store');
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
        };
    },
}));

vi.mock('../csv-preview', () => ({
    show_csv_preview() {},
    dispose_csv_preview() {
        seams.events.push('dispose:preview');
        if (seams.throwPreviewDispose) throw new Error('preview dispose failed');
    },
}));

vi.mock('../vscode-state-database', () => ({
    open_vscode_state_database: async (options: typeof seams.openedOptions) => {
        seams.openedOptions = options;
        seams.events.push(`open:${seams.mode}`);
        if (seams.mode === 'fallback') seams.fallbackStore = options!.openFallbackStore().store;
        const store = seams.mode === 'sqlite' ? seams.store : seams.fallbackStore;
        return {
            mode: seams.mode,
            databasePath: `${options!.storageDirectory}/file-state.sqlite3`,
            store,
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
    seams.mode = 'sqlite';
    seams.store = versioned_state_store().store;
    seams.fallbackStore = undefined;
    seams.failViewerRegistration = false;
    seams.throwViewerDispose = false;
    seams.throwViewerDrain = false;
    seams.throwPreviewDispose = false;
    seams.throwDatabaseClose = false;
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

    it('keeps every viewer and command live on the degraded fallback store', async () => {
        seams.mode = 'fallback';

        await activate(context());

        expect(seams.events).toEqual(['open:fallback', 'register:viewers']);
        expect(vscode_mock.__getRegisteredCommands())
            .toContain('tableViewer.openCsvTable');
    });

    it('offers a durable Memento-backed fallback store that survives a reload', async () => {
        seams.mode = 'fallback';
        const shared = context();

        await activate(shared);
        const first = seams.openedOptions!.openFallbackStore();
        const initial = await first.store.read('/a.csv');
        await first.store.compare_and_set('/a.csv', initial.revision, { activeSheetIndex: 3 });
        await first.close();


        // A second activation against the same ExtensionContext is what a window
        // reload looks like: the degraded medium must still have the state.
        await deactivate();
        await activate(shared);
        const second = seams.openedOptions!.openFallbackStore();
        expect((await second.store.read('/a.csv')).state).toMatchObject({ activeSheetIndex: 3 });
    });

    it('closes the database when viewer registration fails during activation', async () => {
        seams.failViewerRegistration = true;

        await expect(activate(context())).rejects.toThrow('viewer registration failed');

        expect(seams.events).toEqual(['open:sqlite', 'register:viewers', 'close:database']);
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
            'dispose:viewers',
            'drain:viewers',
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

    it('disposes registrations, drains viewers, then closes the database exactly once', async () => {
        await activate(context());
        seams.events.length = 0;

        await deactivate();
        await deactivate();

        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });

    it('still closes the database once when teardown disposables and drains throw', async () => {
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

        await deactivate();
        await deactivate();

        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
        expect(seams.events).toEqual([
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });
});

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

const seams = vi.hoisted(() => ({
    events: [] as string[],
    openedOptions: undefined as {
        storageDirectory: string;
        appVersion: string;
        getMaxStoredFiles: () => number;
        warn: (message: string) => void | Promise<void>;
    } | undefined,
    mode: 'sqlite' as 'sqlite' | 'memory',
    store: undefined as unknown,
    failViewerRegistration: false,
    throwViewerStop: false,
    throwViewerDispose: false,
    throwViewerDrain: false,
    throwPreviewDispose: false,
    throwPreviewDrain: false,
    throwDatabaseClose: false,
}));

vi.mock('../custom-editor', () => ({
    TABLE_VIEW_TYPE: 'tableViewer.editor',
    register_table_viewer: (_context: unknown, store: unknown) => {
        seams.events.push(store === seams.store ? 'register:viewers' : 'register:wrong-store');
        if (seams.failViewerRegistration) throw new Error('viewer registration failed');
        return {
            stop_admissions() {
                seams.events.push('stop:viewers');
                if (seams.throwViewerStop) throw new Error('viewer stop failed');
            },
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
    async drain_csv_previews() {
        seams.events.push('drain:preview');
        if (seams.throwPreviewDrain) throw new Error('preview drain failed');
    },
}));

vi.mock('../vscode-cosmetic-state-database', () => ({
    open_vscode_cosmetic_state_database: async (options: typeof seams.openedOptions) => {
        seams.openedOptions = options;
        seams.events.push(`open:${seams.mode}`);
        return {
            mode: seams.mode,
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
    return {
        extensionUri: vscode_mock.Uri.file('/extension'),
        globalStorageUri: vscode_mock.Uri.file('/global-storage'),
        extension: { packageJSON: { version: '0.7.0' } },
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
    seams.failViewerRegistration = false;
    seams.throwViewerStop = false;
    seams.throwViewerDispose = false;
    seams.throwViewerDrain = false;
    seams.throwPreviewDispose = false;
    seams.throwPreviewDrain = false;
    seams.throwDatabaseClose = false;
});

afterEach(async () => {
    await deactivate();
});

describe('VS Code activation', () => {
    it('opens the direct cosmetic SQLite path and registers only the live commands', async () => {
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
        expect(seams.openedOptions?.getMaxStoredFiles()).toBe(10_000);
        expect(seams.events).toEqual(['open:sqlite', 'register:viewers']);
        expect(vscode_mock.__getRegisteredCommands()).toEqual(expect.arrayContaining([
            'tableViewer.showCsvPreviewToSide',
            'tableViewer.showCsvPreview',
            'tableViewer.openCsvTable',
            'tableViewer.openAsText',
        ]));
        expect(vscode_mock.__getRegisteredCommands())
            .not.toContain('tableViewer.setupPhysicalEditProtocol');
    });

    it('keeps providers and CSV commands registered with the cosmetic memory fallback', async () => {
        seams.mode = 'memory';

        await activate(context());

        expect(seams.events).toEqual(['open:memory', 'register:viewers']);
        expect(vscode_mock.__getCustomEditorRegistrations()).toEqual([]);
        expect(vscode_mock.__getRegisteredCommands())
            .toContain('tableViewer.openCsvTable');
    });

    it('closes SQLite when provider registration fails during activation', async () => {
        seams.failViewerRegistration = true;

        await expect(activate(context())).rejects.toThrow('viewer registration failed');

        expect(seams.events).toEqual([
            'open:sqlite',
            'register:viewers',
            'close:database',
        ]);
        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
    });

    it('rolls back partial command registration, drains viewers, and closes SQLite', async () => {
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
            'stop:viewers',
            'dispose:viewers',
            'drain:viewers',
            'close:database',
        ]);
    });

    it('preserves the activation error when rollback database close also fails', async () => {
        const register_command = vscode_mock.commands.registerCommand.bind(vscode_mock.commands);
        let registrations = 0;
        vi.spyOn(vscode_mock.commands, 'registerCommand').mockImplementation((command, handler) => {
            registrations += 1;
            if (registrations === 2) throw new Error('command registration failed');
            return register_command(command, handler);
        });
        seams.throwDatabaseClose = true;

        await expect(activate(context())).rejects.toThrow('command registration failed');

        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
        expect(seams.events).toEqual([
            'open:sqlite',
            'register:viewers',
            'stop:viewers',
            'dispose:viewers',
            'drain:viewers',
            'close:database',
        ]);
    });

    it('stops admissions, disposes registrations, drains, then closes SQLite once', async () => {
        await activate(context());
        seams.events.length = 0;

        await deactivate();
        await deactivate();

        expect(seams.events).toEqual([
            'stop:viewers',
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(seams.events.at(-1)).toBe('close:database');
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });

    it('closes SQLite once when teardown disposables and drains throw', async () => {
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
        seams.throwViewerStop = true;
        seams.throwViewerDispose = true;
        seams.throwViewerDrain = true;
        seams.throwPreviewDispose = true;
        seams.throwPreviewDrain = true;

        await deactivate();
        await deactivate();

        expect(vscode_mock.__getRegisteredCommands()).toEqual([]);
        expect(seams.events).toEqual([
            'stop:viewers',
            'dispose:preview',
            'dispose:viewers',
            'drain:viewers',
            'drain:preview',
            'close:database',
        ]);
        expect(seams.events.filter((event) => event === 'close:database')).toHaveLength(1);
    });
});

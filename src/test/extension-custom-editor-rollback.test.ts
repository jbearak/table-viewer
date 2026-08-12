import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

const seams = vi.hoisted(() => ({
    events: [] as string[],
    store: undefined as any,
}));

vi.mock('../csv-preview', () => ({
    show_csv_preview() {},
    dispose_csv_preview() {},
    async drain_csv_previews() {},
}));

vi.mock('../vscode-state-database', () => ({
    open_vscode_state_database: async () => {
        seams.events.push('open:database');
        return {
            databasePath: '/global-storage/state/file-state.sqlite3',
            store: seams.store,
            async close() {
                seams.events.push('close:database');
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
    seams.store = versioned_state_store().store;
});

afterEach(async () => {
    await deactivate();
});

describe('VS Code custom-editor activation rollback', () => {
    it('closes SQLite when the custom-editor registration throws', async () => {
        vi.spyOn(vscode_mock.window, 'registerCustomEditorProvider')
            .mockImplementation((view_type) => {
                seams.events.push(`register:${view_type}`);
                throw new Error('Table Viewer provider registration failed');
            });
        const extension_context = context();

        await expect(activate(extension_context)).rejects
            .toThrow('Table Viewer provider registration failed');

        expect(seams.events).toEqual([
            'open:database',
            'register:tableViewer.editor',
            'close:database',
        ]);
        expect(vscode_mock.__getCustomEditorRegistrations()).toEqual([]);
        expect(extension_context.subscriptions).toEqual([]);
    });
});

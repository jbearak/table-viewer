import { describe, expect, it, beforeEach } from 'vitest';
import type * as vscode from 'vscode';
import { register_table_viewer } from '../custom-editor';
import type { FileStateStore } from '../state';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';

function state_store(): FileStateStore {
    return versioned_state_store().store;
}

function context(): vscode.ExtensionContext {
    return {
        extensionUri: vscode_mock.Uri.file('/ext'),
        subscriptions: [],
    } as unknown as vscode.ExtensionContext;
}

beforeEach(() => {
    vscode_mock.__reset();
});

describe('register_table_viewer', () => {
    it('keeps multi-viewer support for both Excel and CSV custom editors', () => {
        register_table_viewer(context(), state_store());

        const registrations = vscode_mock.__getCustomEditorRegistrations();
        const excel = registrations.find((r) => r.viewType === 'tableViewer.excelViewer');
        const csv = registrations.find((r) => r.viewType === 'tableViewer.editor');

        expect(excel?.options).toMatchObject({ supportsMultipleEditorsPerDocument: true });
        expect(csv?.options).toMatchObject({ supportsMultipleEditorsPerDocument: true });
    });
});

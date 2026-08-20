/**
 * The controller side of git compare mode: attach_viewer with a `compare`
 * option builds the original from its URI, projects gitCompare configuration,
 * withdraws editing capabilities, answers row requests with compareDiff pages,
 * and degrades to a plain open (with a warning) when the original is unreadable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { attach_viewer, csv_table_profile } from '../viewer-controller';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();

const MODIFIED = 'h\na\nb\n';
const ORIGINAL = 'h\nA\n';

function open_compare_table(original_path = '/tmp/original.csv') {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file('/tmp/compare.csv') as unknown as vscode.Uri,
        with_in_memory_authority_transactions(versioned_state_store().store),
        csv_table_profile(),
        fake_viewer_host,
        { compare: { originalUri: vscode_mock.Uri.file(original_path) as unknown as vscode.Uri } },
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

type Posted = { type: string } & Record<string, unknown>;

function posted(panel: ReturnType<typeof open_compare_table>, type: string): Posted[] {
    return (panel.__messages as Posted[]).filter((message) => message.type === type);
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 8, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async (uri) =>
        enc.encode(String(uri.fsPath ?? uri).includes('original') ? ORIGINAL : MODIFIED));
});

describe('compare mode controller', () => {
    it('projects gitCompare configuration and withdraws editing', async () => {
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: { pairings: unknown[] } };
            capabilities: { csvEditingSupported: boolean; csvEditable: boolean };
        };
        expect(snapshot.capabilities.csvEditingSupported).toBe(false);
        expect(snapshot.capabilities.csvEditable).toBe(false);
        expect(snapshot.configuration.gitCompare?.pairings).toEqual([
            { status: 'matched', name: 'Sheet1', modifiedIndex: 0, originalIndex: 0 },
        ]);
    });

    it('answers a row request with a compareDiff page beside rowData', async () => {
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const { generation } = posted(panel, 'workbookSnapshot')[0]
            .snapshot as { generation: number };
        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 10,
            requestId: 'r1',
            generation,
        });
        await vi.waitFor(() => expect(posted(panel, 'compareDiff').length).toBeGreaterThan(0));
        const diff = posted(panel, 'compareDiff')[0];
        expect(diff.requestId).toBe('r1');
        expect(diff.rowStatus).toEqual(['same', 'added']);
        expect(diff.changedCells).toEqual([{ row: 0, col: 0, base: 'A' }]);
        expect(posted(panel, 'rowData').length).toBeGreaterThan(0);
    });

    it('degrades to a plain open with a warning when the original is unreadable', async () => {
        vscode_mock.__setReadFileImplementation(async (uri) => {
            if (String(uri.fsPath ?? uri).includes('original')) {
                throw new Error('git object missing');
            }
            return enc.encode(MODIFIED);
        });
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: unknown };
            capabilities: { csvEditingSupported: boolean };
        };
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        // The file still opens read-only: compare intent, not editing intent.
        expect(snapshot.capabilities.csvEditingSupported).toBe(false);
        expect(warning).toHaveBeenCalledTimes(1);
        const { generation } = posted(panel, 'workbookSnapshot')[0]
            .snapshot as { generation: number };
        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 10,
            requestId: 'r1',
            generation,
        });
        await vi.waitFor(() => expect(posted(panel, 'rowData').length).toBeGreaterThan(0));
        expect(posted(panel, 'compareDiff')).toEqual([]);
    });

    it('refuses an edit session request in compare mode', async () => {
        // The snapshot withdraws the Edit button, but the host must refuse the
        // protocol too: a stale or buggy renderer could still post
        // requestEditSession, and only the host gate stands between that and
        // the working-tree file.
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        await panel.__receive({ type: 'requestEditSession', requestId: 'edit-1', sheetIndex: 0 });
        await vi.waitFor(() => expect(posted(panel, 'editSessionResult').length).toBeGreaterThan(0));
        expect(posted(panel, 'editSessionResult')[0]).toMatchObject({
            requestId: 'edit-1',
            granted: false,
        });
    });
});

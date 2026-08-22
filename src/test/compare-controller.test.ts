/**
 * The controller side of git compare mode: attach_viewer with a `compare`
 * option builds the original from its URI, projects gitCompare configuration,
 * withdraws editing capabilities, answers row requests with compareDiff pages,
 * and degrades to a plain open (with a warning) when the original is unreadable.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    csv_table_profile,
    type ViewerControllerOptions,
    type ViewerProfile,
} from '../viewer-controller';
import { transform_schema_for_sheet } from '../types';
import { with_in_memory_authority_transactions } from '../state-authority';
import { versioned_state_store } from './helpers/versioned-state-store';
import * as vscode_mock from './mocks/vscode';
import { fake_viewer_host } from './mocks/host-ports';

const enc = new TextEncoder();

const MODIFIED = 'h\na\nb\n';
const ORIGINAL = 'h\nA\n';

function open_compare_controller(
    original_path = '/tmp/original.csv',
    profile: ViewerProfile = csv_table_profile(),
    options: ViewerControllerOptions = {},
) {
    const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
    const state_store = versioned_state_store();
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file('/tmp/compare.csv') as unknown as vscode.Uri,
        with_in_memory_authority_transactions(state_store.store),
        profile,
        fake_viewer_host,
        {
            ...options,
            compare: { originalUri: vscode_mock.Uri.file(original_path) as unknown as vscode.Uri },
        },
    );
    panel.onDidDispose(() => controller.dispose());
    return { controller, panel, state_store };
}

function open_compare_table(original_path = '/tmp/original.csv') {
    return open_compare_controller(original_path).panel;
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

    it('parses each side with its own format', async () => {
        // The window is attached for the modified file, so its profile is the
        // modified format's. Reusing it for the original split this TSV on
        // commas, turning two columns into one — and across csv/xlsx it fed
        // one parser the other's bytes outright.
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original')
                ? 'h\tk\nA\tB\n'
                : MODIFIED));
        const panel = open_compare_table('/tmp/original.tsv');
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: { changedColumnNames: { base: string }[][] } };
        };
        // The original's second column is gone from the modified side; if the
        // tab had not been honoured there would be no second column at all,
        // and column 0 would read as renamed from 'h\tk'.
        expect(snapshot.configuration.gitCompare?.changedColumnNames[0])
            .toEqual([{ col: 1, base: 'k' }]);
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

    it('reports an inserted row as one addition rather than shifting every row', async () => {
        // The regression content alignment exists for: positionally, inserting
        // a row near the top makes every row below it look changed.
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original')
                ? 'h\na\nb\nc\n'
                : 'h\na\nNEW\nb\nc\n'));
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
        expect(diff.rowStatus).toEqual(['same', 'added', 'same', 'same']);
        expect(diff.changedCells).toEqual([]);
    });

    it('reports change counts on the snapshot', async () => {
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original')
                ? 'h\na\nb\n'
                : 'h\na\nCHANGED\nNEW\n'));
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: { counts: unknown; degraded: boolean } };
        };
        expect(snapshot.configuration.gitCompare?.counts).toEqual({
            addedRows: 1, deletedRows: 0, changedCells: 1,
        });
        expect(snapshot.configuration.gitCompare?.degraded).toBe(false);
    });

    it('filters the grid to the changed rows and back', async () => {
        // The compare window's "Only changed rows" toggle, end to end: the
        // controller is the only place that knows which grid rows changed.
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original')
                ? 'h\na\nb\nc\n'
                : 'h\na\nNEW\nb\nc\n'));
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            generation: number;
            meta: { sheets: readonly Parameters<typeof transform_schema_for_sheet>[0][] };
        };
        const schema = transform_schema_for_sheet(snapshot.meta.sheets[0]);
        const set_transform = async (onlyChangedRows: boolean, requestId: string) => {
            await panel.__receive({
                type: 'setTransform',
                sheetIndex: 0,
                requestId,
                intent: 'apply',
                sourceGeneration: snapshot.generation,
                state: {
                    sort: [],
                    filters: [],
                    onlyChangedRows,
                    schema,
                },
            });
            return await vi.waitFor(() => {
                const install = posted(panel, 'transformInstalled')
                    .find((message) => message.requestId === requestId);
                expect(install).toBeDefined();
                return install as Posted & {
                    view: { rowCount: number; permuted: boolean };
                    rules?: unknown;
                };
            });
        };

        // Four grid rows past the header; only the inserted one changed.
        const on = await set_transform(true, 't1');
        expect(on.view.permuted).toBe(true);
        expect(on.view.rowCount).toBe(1);
        // The ack has to say the filter is on. The renderer replaces its
        // transform state with these rules and the toggle reads its position
        // back off them, so an ack that omitted the field left the button
        // showing "off" while the grid stayed filtered — every later click
        // then asked to enable it again and nothing could turn it off.
        expect((on.rules as { onlyChangedRows?: boolean } | undefined)?.onlyChangedRows)
            .toBe(true);

        const off = await set_transform(false, 't2');
        expect(off.view.rowCount).toBe(4);
        expect((off.rules as { onlyChangedRows?: boolean } | undefined)?.onlyChangedRows)
            .toBeUndefined();
    });

    it('does not persist the changed-rows filter as saved view state', async () => {
        // Session state of this comparison, not a saved view: persisted, a
        // later plain open of the same file would come back filtered by a
        // comparison it no longer has, with no control anywhere to clear it.
        // The strip lives at the durable write in `persist_transform_commit`,
        // and only there: the core and the renderer both need the field, since
        // it is how the toggle knows it is on.
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original')
                ? 'h\na\nb\nc\n'
                : 'h\na\nNEW\nb\nc\n'));
        const { panel, state_store } = open_compare_controller();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            generation: number;
            meta: { sheets: readonly Parameters<typeof transform_schema_for_sheet>[0][] };
        };
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            requestId: 'p1',
            intent: 'apply',
            sourceGeneration: snapshot.generation,
            state: {
                sort: [],
                filters: [],
                hiddenRows: [1],
                onlyChangedRows: true,
                schema: transform_schema_for_sheet(snapshot.meta.sheets[0]),
            },
        });
        await vi.waitFor(() => expect(
            posted(panel, 'transformInstalled').some((message) => message.requestId === 'p1'),
        ).toBe(true));
        const stored = await vi.waitFor(async () => {
            const state = (await state_store.store.read('/tmp/compare.csv')).state as {
                transforms?: ({ hiddenRows?: number[]; onlyChangedRows?: boolean } | undefined)[];
            };
            expect(state.transforms?.[0]).toBeDefined();
            return state.transforms![0]!;
        });
        // The rest of the transform is genuinely saved view state and stays.
        expect(stored.hiddenRows).toEqual([1]);
        expect(stored.onlyChangedRows).toBeUndefined();
    });

    it('reports alignment progress before the snapshot exists', async () => {
        const panel = open_compare_table();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot').length).toBeGreaterThan(0));
        const reports = posted(panel, 'compareProgress') as unknown as {
            scannedRows: number;
            totalRows: number;
        }[];
        expect(reports.length).toBeGreaterThan(0);
        // Monotonic and bounded: a bar that goes backwards, or past its own
        // total, reads as a bug in the comparison rather than in the readout.
        let previous = 0;
        for (const report of reports) {
            expect(report.scannedRows).toBeGreaterThanOrEqual(previous);
            expect(report.scannedRows).toBeLessThanOrEqual(report.totalRows);
            previous = report.scannedRows;
        }
        // Both sides' rows are the work, and the last report accounts for all of it.
        expect(reports[reports.length - 1].scannedRows)
            .toBe(reports[reports.length - 1].totalRows);
    });

    it('closes the window when the alignment is cancelled, without a warning', async () => {
        const close = vi.fn();
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const { panel } = open_compare_controller(
            '/tmp/original.csv',
            csv_table_profile(),
            { requestClose: close },
        );
        await panel.__receive({ type: 'cancelCompare' });
        expect(close).toHaveBeenCalledTimes(1);
        // Cancelling is the user's own decision, not a comparison failure.
        expect(warning).not.toHaveBeenCalled();
    });

    it('ignores a cancel from a window that is not comparing', async () => {
        const close = vi.fn();
        const panel = vscode_mock.window.createWebviewPanel('tableViewer.editor', 'table');
        const controller = attach_viewer(
            panel as unknown as Parameters<typeof attach_viewer>[0],
            vscode_mock.Uri.file('/tmp/plain.csv') as unknown as vscode.Uri,
            with_in_memory_authority_transactions(versioned_state_store().store),
            csv_table_profile(),
            fake_viewer_host,
            { requestClose: close },
        );
        panel.onDidDispose(() => controller.dispose());
        await panel.__receive({ type: 'cancelCompare' });
        expect(close).not.toHaveBeenCalled();
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

    it('preserves the plain fallback when unavailable comparison cleanup throws', async () => {
        const base_profile = csv_table_profile();
        const comparison_failure = new Error('comparison metadata failed');
        const cleanup_failure = new Error('comparison cleanup failed');
        let close_calls = 0;
        const profile: ViewerProfile = {
            ...base_profile,
            async build_source(...args) {
                const original = new TextDecoder().decode(args[0]) === ORIGINAL;
                const source = await base_profile.build_source(...args);
                if (original) {
                    source.meta = () => {
                        throw comparison_failure;
                    };
                    source.close = () => {
                        close_calls += 1;
                        throw cleanup_failure;
                    };
                }
                return source;
            },
        };
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { panel } = open_compare_controller('/tmp/original.csv', profile);

        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot')).toHaveLength(1));

        const snapshot = posted(panel, 'workbookSnapshot')[0].snapshot as {
            configuration: { gitCompare?: unknown };
        };
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        expect(close_calls).toBe(1);
        expect(warning).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            'Failed to close unavailable comparison source',
            { code: 'UNKNOWN' },
        );
    });

    it('preserves a modified-side build failure when original cleanup also throws', async () => {
        const base_profile = csv_table_profile();
        const modified_failure = new Error('modified build failed');
        const cleanup_failure = new Error('original close failed');
        let close_calls = 0;
        const profile: ViewerProfile = {
            ...base_profile,
            async build_source(...args) {
                if (new TextDecoder().decode(args[0]) === MODIFIED) throw modified_failure;
                const source = await base_profile.build_source(...args);
                source.close = () => {
                    close_calls += 1;
                    throw cleanup_failure;
                };
                return source;
            },
        };
        const error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const { panel } = open_compare_controller('/tmp/original.csv', profile);

        await panel.__receive({ type: 'ready' });

        await vi.waitFor(() => expect(error).toHaveBeenCalledWith(modified_failure.message));
        expect(close_calls).toBeGreaterThan(0);
    });

    it('degrades after the original disappears during candidate validation', async () => {
        const base_profile = csv_table_profile();
        let throw_on_original_close = false;
        const profile: ViewerProfile = {
            ...base_profile,
            async build_source(...args) {
                const original = new TextDecoder().decode(args[0]) === ORIGINAL;
                const source = await base_profile.build_source(...args);
                if (original && throw_on_original_close) {
                    source.close = () => {
                        throw new Error('rejected original close failed');
                    };
                }
                return source;
            },
        };
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const log = vi.spyOn(console, 'error').mockImplementation(() => {});
        const { controller, panel } = open_compare_controller(
            '/tmp/original.csv',
            profile,
        );
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot')).toHaveLength(1));
        throw_on_original_close = true;

        let original_stat_calls = 0;
        vscode_mock.__setStatImplementation(async (uri) => {
            if (String(uri.fsPath ?? uri).includes('original')) {
                original_stat_calls += 1;
                if (original_stat_calls >= 2) throw new Error('git object disappeared');
                return { size: ORIGINAL.length, mtime: 1 };
            }
            return { size: MODIFIED.length, mtime: 1 };
        });
        vscode_mock.__setReadFileImplementation(async (uri) =>
            enc.encode(String(uri.fsPath ?? uri).includes('original') ? ORIGINAL : MODIFIED));

        await expect(controller.refresh_if_changed()).resolves.toBe(false);
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot')).toHaveLength(2));

        const snapshot = posted(panel, 'workbookSnapshot')[1].snapshot as {
            configuration: { gitCompare?: unknown };
        };
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        expect(warning).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
        expect(log).toHaveBeenCalledWith(
            'Failed to close unused table source',
            { code: 'UNKNOWN' },
        );
    });

    it('degrades when the original cannot stabilize during validation', async () => {
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const error = vi.spyOn(vscode_mock.window, 'showErrorMessage');
        const { controller, panel } = open_compare_controller();
        await panel.__receive({ type: 'ready' });
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot')).toHaveLength(1));

        let original_stat_calls = 0;
        vscode_mock.__setStatImplementation(async (uri) => {
            if (String(uri.fsPath ?? uri).includes('original')) {
                original_stat_calls += 1;
                return { size: ORIGINAL.length, mtime: original_stat_calls };
            }
            return { size: MODIFIED.length, mtime: 1 };
        });

        await expect(controller.refresh_if_changed()).resolves.toBe(false);
        await vi.waitFor(() => expect(posted(panel, 'workbookSnapshot')).toHaveLength(2));

        const snapshot = posted(panel, 'workbookSnapshot')[1].snapshot as {
            configuration: { gitCompare?: unknown };
        };
        expect(snapshot.configuration.gitCompare).toBeUndefined();
        expect(warning).toHaveBeenCalledTimes(1);
        expect(error).not.toHaveBeenCalled();
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

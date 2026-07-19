import { beforeEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import {
    attach_viewer,
    type ViewerProfile,
} from '../viewer-controller';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import type { FileStateStore } from '../state';
import type { PerFileState, StoredPerFileState } from '../types';
import * as vscode_mock from './mocks/vscode';

class PhysicalExcelSource implements DataSource {
    constructor(
        private readonly rows: (RenderedCell | null)[][] = [
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Bob'), number(25)],
        ],
        private readonly sheet_name = 'People',
    ) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: this.sheet_name,
                rowCount: 3,
                columnCount: 2,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start: number, count: number): RowWindow {
        const clamped = Math.max(0, Math.min(start, this.rows.length));
        return {
            startRow: clamped,
            rows: this.rows.slice(clamped, clamped + count),
        };
    }

    close(): void {}
}

function text(raw: string): RenderedCell {
    return { raw, formatted: raw, bold: false, italic: false, rawType: 'string' };
}

function number(raw: number): RenderedCell {
    return {
        raw: String(raw), formatted: String(raw), bold: false, italic: false, rawType: 'number',
    };
}

function mutable_state_store(initial: StoredPerFileState = {}) {
    let state: StoredPerFileState = structuredClone(initial);
    const store: FileStateStore = {
        get: () => structuredClone(state),
        set: async (_path, next) => { state = structuredClone(next); },
        update: async (_path, updater) => {
            state = structuredClone(updater(structuredClone(state) as StoredPerFileState));
        },
    };
    return { store, value: () => state };
}

function excel_profile(
    builds: { count: number },
    make_source: () => DataSource = () => new PhysicalExcelSource(),
): ViewerProfile {
    return {
        editing: false,
        async build_source(_raw, _path, state) {
            builds.count++;
            return new ExcelHeaderDataSource(
                make_source(),
                state.excelFirstRowHeaders,
            );
        },
    };
}

function open_excel(
    path: string,
    store: FileStateStore,
    profile: ViewerProfile,
) {
    const panel = vscode_mock.window.createWebviewPanel(
        'tableViewer.excelViewer',
        'excel',
    );
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(path) as unknown as vscode.Uri,
        store,
        profile,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function messages_of<T extends string>(
    panel: { __messages: unknown[] },
    type: T,
): Array<Record<string, any> & { type: T }> {
    return panel.__messages.filter((message): message is Record<string, any> & { type: T } => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === type
    ));
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => new Uint8Array([1]));
});

describe('Excel first-row header controller', () => {
    it('applies persisted overrides before first metadata', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
            excelFirstRowHeaderVersion: 1,
        });
        const builds = { count: 0 };
        const panel = open_excel('/tmp/people.xlsx', state.store, excel_profile(builds));

        await panel.__receive({ type: 'ready' });

        const meta = messages_of(panel, 'sheetMeta')[0];
        expect(meta.meta.sheets[0]).toMatchObject({
            rowCount: 3,
            columnNames: undefined,
            excelFirstRowHeader: { mode: 'off', active: false, detected: true },
        });
        expect(builds.count).toBe(1);
    });

    it('normalizes legacy name-keyed layout state during the first migration', async () => {
        const state = mutable_state_store({
            activeSheet: 'People',
            rowHeights: { People: { 0: 44 } },
            scrollPosition: { People: { top: 100, left: 20 } },
        });
        const panel = open_excel(
            '/tmp/legacy.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );

        await panel.__receive({ type: 'ready' });

        expect(messages_of(panel, 'sheetMeta')).toHaveLength(1);
        expect(state.value()).toMatchObject({
            activeSheetIndex: 0,
            rowHeights: [undefined],
            scrollPosition: [undefined],
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
    });

    it('clears row-addressed state when auto-detection changes while closed', async () => {
        const state = mutable_state_store({
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
        const ambiguous_rows = [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ];
        const panel = open_excel(
            '/tmp/changed.xlsx',
            state.store,
            excel_profile(
                { count: 0 },
                () => new PhysicalExcelSource(ambiguous_rows),
            ),
        );

        await panel.__receive({ type: 'ready' });

        expect(messages_of(panel, 'sheetMeta')[0].meta.sheets[0]
            .excelFirstRowHeader.active).toBe(false);
        expect(state.value()).toMatchObject({
            rowHeights: [undefined],
            scrollPosition: [undefined],
            excelFirstRowHeaderActive: { People: false },
        });
    });

    it('persists and broadcasts a toggle without reparsing', async () => {
        const state = mutable_state_store({
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            excelFirstRowHeaderVersion: 1,
        });
        const builds = { count: 0 };
        const panel = open_excel('/tmp/people.xlsx', state.store, excel_profile(builds));
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'header:1',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });

        expect(builds.count).toBe(1);
        expect(state.value()).toMatchObject({
            excelFirstRowHeaders: { People: 'off' },
            rowHeights: [undefined],
            scrollPosition: [undefined],
        });
        const reload = messages_of(panel, 'metaReload')[0];
        expect(reload.meta.sheets[0]).toMatchObject({
            rowCount: 3,
            excelFirstRowHeader: { mode: 'off', active: false },
        });
        expect(reload.generation).toBe(initial.generation + 1);
        expect(reload.sourceGeneration).toBe(initial.sourceGeneration + 1);
    });

    it('rejects stale or mismatched header requests', async () => {
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/people.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'Wrong',
            enabled: false,
            requestId: 'wrong',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'stale',
            generation: initial.generation - 1,
            sourceGeneration: initial.sourceGeneration,
        });

        const results = messages_of(panel, 'excelFirstRowHeaderError');
        expect(results).toHaveLength(2);
        expect(results.every((result) => typeof result.error === 'string')).toBe(true);
        expect(messages_of(panel, 'metaReload')).toHaveLength(0);
        expect((state.value() as PerFileState).excelFirstRowHeaders).toBeUndefined();
    });

    it('updates every open tab for the same workbook', async () => {
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const profile = excel_profile(builds);
        const first = open_excel('/tmp/shared.xlsx', state.store, profile);
        const second = open_excel('/tmp/shared.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const initial = messages_of(first, 'sheetMeta')[0];

        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'shared',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });

        expect(messages_of(first, 'metaReload')).toHaveLength(1);
        expect(messages_of(second, 'metaReload')).toHaveLength(1);
        expect(messages_of(second, 'metaReload')[0].meta.sheets[0]
            .excelFirstRowHeader.active).toBe(false);
        expect(builds.count).toBe(2);
    });
});

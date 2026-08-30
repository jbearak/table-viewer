import { beforeEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import type * as vscode from 'vscode';
import { attach_viewer, type ViewerProfile } from '../viewer-controller';
import { ExcelHeaderDataSource } from '../data-source/excel-header-source';
import { XlsxDataSource } from '../data-source/xlsx-source';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import type {
    AuthorityFileStateStore,
    DurableFileAuthority,
    FileStateStore,
} from '../state';
import type { HostMessage, PerFileState } from '../types';
import { MAX_SHEET_ROWS } from '../spreadsheet-safety';
import type { WorkbookSnapshot } from '../viewer-snapshot';
import * as vscode_mock from './mocks/vscode';
import { acquire_file_coordinator } from '../file-coordinator';
import {
    finalize_authority,
    stage_authority,
    with_in_memory_authority_transactions,
} from '../state-authority';
import { fake_viewer_host } from './mocks/host-ports';

class PhysicalExcelSource implements DataSource {
    readonly warnings?: string[];

    constructor(
        private readonly rows: (RenderedCell | null)[][] = [
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Bob'), number(25)],
        ],
        private readonly sheet_name = 'People',
        warnings: string[] = [],
    ) {
        this.warnings = warnings;
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: this.sheet_name,
                rowCount: this.rows.length,
                sourceRowCount: this.rows.length,
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
        raw: String(raw),
        formatted: String(raw),
        bold: false,
        italic: false,
        rawType: 'number',
    };
}

const empty_authority: DurableFileAuthority = {
    commitSequence: 0,
    authorityRevision: 0,
    physicalRevision: 0,
    projectionRevision: 0,
};

// These fixtures only ever hold the current state shape (migration of the
// legacy shape is covered in state.test.ts), so they are typed `PerFileState`
// rather than the `StoredPerFileState` union the store *reads* — assertions can
// then reach fields like `transforms`, which the legacy arm does not have.
function mutable_state_store(initial: PerFileState = {}) {
    let state: PerFileState = structuredClone(initial);
    let revision = 0;
    const store: FileStateStore = {
        async read() {
            return { state: structuredClone(state), revision };
        },
        async compare_and_set(_path, expected, next, validate) {
            const valid = validate === undefined || validate() === true;
            if (expected !== revision || !valid) {
                return {
                    type: 'conflict',
                    snapshot: { state: structuredClone(state), revision },
                    authority: structuredClone(empty_authority),
                };
            }
            state = structuredClone(next);
            revision += 1;
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision },
                authority: structuredClone(empty_authority),
            };
        },
        async touch() {},
    };
    return {
        store,
        value: () => state,
        /** Like `store.read`, but keeping the current-shape type. */
        snapshot: () => ({ state: structuredClone(state), revision }),
    };
}

function gated_state_store(initial: PerFileState = {}) {
    const base = mutable_state_store(initial);
    let release: (() => void) | undefined;
    let started: (() => void) | undefined;
    let gate: Promise<void> | undefined;
    const store: FileStateStore = {
        async read(path) {
            return base.store.read(path);
        },
        async compare_and_set(path, expected, next, validate) {
            const pending = gate;
            gate = undefined;
            if (pending) {
                started?.();
                started = undefined;
                await pending;
            }
            return base.store.compare_and_set(path, expected, next, validate);
        },
        async touch(path) {
            await base.store.touch(path);
        },
    };
    return {
        store,
        value: base.value,
        block_next_update() {
            gate = new Promise<void>((resolve) => { release = resolve; });
            return new Promise<void>((resolve) => { started = resolve; });
        },
        release_update() {
            release?.();
            release = undefined;
        },
    };
}

function excel_profile(
    builds: { count: number },
    make_source: () => DataSource = () => new PhysicalExcelSource(),
    break_projection = false,
): ViewerProfile {
    return {
        editing: false,
        async build_source(_raw, _path, state) {
            builds.count += 1;
            const source = new ExcelHeaderDataSource(
                make_source(),
                state.excelFirstRowHeaders,
            );
            if (break_projection && builds.count === 1) {
                source.set_override = () => false;
            }
            return source;
        },
    };
}

function open_excel(path: string, store: FileStateStore, profile: ViewerProfile) {
    const panel = vscode_mock.window.createWebviewPanel(
        'tableViewer.editor',
        'excel',
    );
    const controller = attach_viewer(
        panel as unknown as Parameters<typeof attach_viewer>[0],
        vscode_mock.Uri.file(path) as unknown as vscode.Uri,
        with_in_memory_authority_transactions(store),
        profile,
        fake_viewer_host,
    );
    panel.onDidDispose(() => controller.dispose());
    return panel;
}

function messages_of<T extends HostMessage['type']>(
    panel: { __messages: unknown[] },
    type: T,
): Array<Extract<HostMessage, { type: T }>> {
    return panel.__messages.filter((message): message is Extract<HostMessage, { type: T }> => (
        typeof message === 'object'
        && message !== null
        && 'type' in message
        && message.type === type
    ));
}

function snapshots(panel: { __messages: unknown[] }): WorkbookSnapshot[] {
    return messages_of(panel, 'workbookSnapshot').map((message) => message.snapshot);
}

async function ready(panel: ReturnType<typeof open_excel>): Promise<WorkbookSnapshot> {
    await panel.__receive({ type: 'ready' });
    await vi.waitFor(() => expect(snapshots(panel).length).toBeGreaterThan(0));
    return snapshots(panel).at(-1)!;
}

async function toggle(
    panel: ReturnType<typeof open_excel>,
    basis: WorkbookSnapshot,
    requestId: string,
    enabled: boolean,
): Promise<void> {
    await panel.__receive({
        type: 'setExcelFirstRowHeader',
        sheetIndex: 0,
        sheetName: 'People',
        enabled,
        requestId,
        generation: basis.generation,
        sourceGeneration: basis.sourceGeneration,
    });
}

beforeEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 1 }));
    vscode_mock.__setReadFileImplementation(async () => new Uint8Array([1]));
});

describe('Excel workbook snapshot controller', () => {
    it('delivers initial Excel state through workbookSnapshot only', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
        });
        const builds = { count: 0 };
        const panel = open_excel('/native-initial.xlsx', state.store, excel_profile(builds));

        const initial = await ready(panel);

        expect(initial.presentation).toBe('initial');
        expect(initial.reason).toBe('ready');
        expect(initial.meta.sheets[0]).toMatchObject({
            name: 'People',
            rowCount: 3,
            columnNames: undefined,
            excelFirstRowHeader: { active: false },
        });
        expect(initial.state.excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(initial.capabilities).toEqual({
            appendRowCeiling: MAX_SHEET_ROWS,
            csvEditable: false,
            csvEditingSupported: false,
            csvSaveLifecycle: { revision: 0, state: 'idle' },
        });
        expect(builds.count).toBe(1);
    });

    it('applies a direct header projection with one adoption and one result snapshot', async () => {
        const state = mutable_state_store();
        const builds = { count: 0 };
        const panel = open_excel('/native-fast.xlsx', state.store, excel_profile(builds));
        const initial = await ready(panel);
        const before = snapshots(panel).length;

        await toggle(panel, initial, 'fast', false);
        await vi.waitFor(() => expect(snapshots(panel).length).toBeGreaterThan(before));
        const applied = snapshots(panel).at(-1)!;

        expect(builds.count).toBe(1);
        expect(applied.reason).toBe('excelHeader');
        expect(applied.presentation).toBe('refresh');
        expect(applied.generation).toBe(initial.generation + 1);
        expect(applied.sourceGeneration).toBe(initial.sourceGeneration + 1);
        expect(applied.identity.sourceBasis.physicalRevision)
            .toBe(initial.identity.sourceBasis.physicalRevision);
        expect(applied.identity.sourceBasis.projectionRevision)
            .toBe(initial.identity.sourceBasis.projectionRevision + 1);
        expect(applied.meta.sheets[0].excelFirstRowHeader?.active).toBe(false);
        expect(applied.state.excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(applied.commandResult).toEqual({
            type: 'excelFirstRowHeader',
            requestId: 'fast',
            outcome: 'applied',
        });
    });

    it('promotes the first non-hidden row and atomically disables it on Unhide all', async () => {
        const rows = [
            [text('Report'), text('')],
            [text('Generated'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Bob'), number(25)],
        ];
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
            transforms: [{
                sort: [],
                filters: [],
                hiddenRows: [0, 1],
                schema: '["People",2,null]',
            }],
        });
        const panel = open_excel(
            '/non-hidden-header.xlsx',
            state.store,
            excel_profile({ count: 0 }, () => new PhysicalExcelSource(rows)),
        );
        const initial = await ready(panel);
        const restore = {
            type: 'setTransform' as const,
            sheetIndex: 0,
            state: state.value().transforms![0]!,
            requestId: 'restore-hidden-prefix',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'restore' as const,
        };
        await panel.__receive(restore);
        const restored = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === restore.requestId,
        )!;

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'promote-visible',
            generation: restored.view.basis.generation,
            sourceGeneration: restored.view.basis.sourceGeneration,
        });
        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'promote-visible', outcome: 'applied' }));
        const promoted = snapshots(panel).at(-1)!;
        expect(promoted.meta.sheets[0]).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { active: true, sourceRow: 2 },
        });
        expect(promoted.state.transforms?.[0]?.hiddenRows).toEqual([0, 1]);

        await panel.__receive({
            ...restore,
            state: promoted.state.transforms![0]!,
            requestId: 'restore-promoted-prefix',
            generation: promoted.generation,
            sourceGeneration: promoted.sourceGeneration,
        });
        const promoted_restore = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'restore-promoted-prefix',
        )!;
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: { sort: [], filters: [] },
            requestId: 'bypass-atomic-unhide',
            generation: promoted_restore.view.basis.generation,
            sourceGeneration: promoted_restore.view.basis.sourceGeneration,
            intent: 'user',
        });
        // Terminal, not transient: nothing here clears on its own, so the webview
        // stops asking rather than retrying. A refusal cannot describe a view at all
        // now, so what proves the host changed nothing is the durable state, checked
        // below, not an echo in the message.
        expect(messages_of(panel, 'transformRefused').find(
            (message) => message.requestId === 'bypass-atomic-unhide',
        )).toMatchObject({
            reason: 'Use Unhide all to restore rows above the active header.',
            terminal: true,
        });
        expect(state.value().transforms?.[0]?.hiddenRows).toEqual([0, 1]);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [],
                filters: [],
                hiddenRows: [0, 1, 2],
                schema: promoted.state.transforms![0]!.schema,
            },
            requestId: 'hide-promoted-header',
            generation: promoted_restore.view.basis.generation,
            sourceGeneration: promoted_restore.view.basis.sourceGeneration,
            intent: 'user',
        });
        expect(messages_of(panel, 'transformRefused').find(
            (message) => message.requestId === 'hide-promoted-header',
        )).toMatchObject({
            reason: 'The active header row cannot be hidden.',
            terminal: true,
        });
        expect(state.value().transforms?.[0]?.hiddenRows).toEqual([0, 1]);
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            unhideAll: true,
            requestId: 'unhide-and-disable',
            generation: promoted_restore.view.basis.generation,
            sourceGeneration: promoted_restore.view.basis.sourceGeneration,
        });
        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'unhide-and-disable', outcome: 'applied' }));
        const unhidden = snapshots(panel).at(-1)!;
        expect(unhidden.meta.sheets[0].excelFirstRowHeader?.active).toBe(false);
        expect(unhidden.state.transforms?.[0]?.hiddenRows).toBeUndefined();
        expect(state.value().excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(state.value().transforms?.[0]).toBeUndefined();
    });

    it('atomically hides rows above the clicked row and promotes it as the header', async () => {
        const rows = [
            [text('Report'), text('')],
            [text('Generated'), text('')],
            [text('Name'), text('Age')],
            [text('Alice'), number(30)],
            [text('Bob'), number(25)],
        ];
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
        });
        const panel = open_excel(
            '/context-header.xlsx',
            state.store,
            excel_profile({ count: 0 }, () => new PhysicalExcelSource(rows)),
        );
        const initial = await ready(panel);

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            headerRow: 2,
            requestId: 'context-promote',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });

        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'context-promote', outcome: 'applied' }));
        const promoted = snapshots(panel).at(-1)!;
        expect(promoted.meta.sheets[0]).toMatchObject({
            columnNames: ['Name', 'Age'],
            excelFirstRowHeader: { mode: 'on', active: true, sourceRow: 2 },
        });
        expect(promoted.state.transforms?.[0]?.hiddenRows).toEqual([0, 1]);
        expect(promoted.state.excelFirstRowHeaders).toEqual({ People: 'on' });
        expect(state.value().transforms?.[0]?.hiddenRows).toEqual([0, 1]);
    });

    it('turns off every header after manual row-nine promotions in the survey workbook', async () => {
        const bytes = new Uint8Array(readFileSync(join(
            __dirname,
            'fixtures',
            'undesa_pd_2024_wcu_country_data_survey-based.xlsx',
        )));
        const state = mutable_state_store();
        const profile: ViewerProfile = {
            editing: false,
            async build_source(_raw, _path, saved) {
                const physical = await XlsxDataSource.create(bytes);
                return new ExcelHeaderDataSource(
                    physical,
                    saved.excelFirstRowHeaders,
                    physical.meta().sheets.map(
                        (_sheet, index) => saved.transforms?.[index]?.hiddenRows,
                    ),
                );
            },
        };
        const panel = open_excel('/survey-header-queue.xlsx', state.store, profile);
        let basis = await ready(panel);
        let generation = basis.generation;
        let source_generation = basis.sourceGeneration;
        expect(basis.meta.sheets.map((sheet) => sheet.name)).toEqual([
            'INFORMATION NOTE',
            'Database Field Descriptions',
            'By methods',
            'By marital status and age',
        ]);

        for (const sheet_index of [2, 3]) {
            const sheet_name = basis.meta.sheets[sheet_index].name;
            const request_id = `promote:${sheet_name}`;
            await panel.__receive({
                type: 'setExcelFirstRowHeader',
                sheetIndex: sheet_index,
                sheetName: sheet_name,
                enabled: true,
                headerRow: 8,
                requestId: request_id,
                generation,
                sourceGeneration: source_generation,
            });
            await vi.waitFor(() => expect(snapshots(panel).some((snapshot) => (
                snapshot.commandResult?.requestId === request_id
            ))).toBe(true));
            basis = snapshots(panel).find((snapshot) => (
                snapshot.commandResult?.requestId === request_id
            ))!;
            expect(basis.commandResult).toMatchObject({ outcome: 'applied' });
            generation = basis.generation;
            source_generation = basis.sourceGeneration;
            await panel.__receive({
                type: 'snapshotApplied',
                identity: basis.identity,
                disposition: 'applied',
            });

            const transform = basis.state.transforms?.[sheet_index];
            expect(transform?.hiddenRows).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
            const restore_id = `restore:${sheet_name}`;
            await panel.__receive({
                type: 'setTransform',
                sheetIndex: sheet_index,
                state: transform!,
                requestId: restore_id,
                generation,
                sourceGeneration: source_generation,
                intent: 'restore',
            });
            await vi.waitFor(() => expect(messages_of(panel, 'transformInstalled').some(
                (message) => message.requestId === restore_id,
            )).toBe(true));
            const installed = messages_of(panel, 'transformInstalled').find(
                (message) => message.requestId === restore_id,
            )!;
            generation = installed.view.basis.generation;
            source_generation = installed.view.basis.sourceGeneration;
        }

        for (const [sheet_index, sheet] of basis.meta.sheets.entries()) {
            const latest = snapshots(panel).at(-1)!;
            generation = latest.generation;
            source_generation = latest.sourceGeneration;
            const request_id = `disable:${sheet.name}`;
            await panel.__receive({
                type: 'setExcelFirstRowHeader',
                sheetIndex: sheet_index,
                sheetName: sheet.name,
                enabled: false,
                requestId: request_id,
                generation,
                sourceGeneration: source_generation,
            });
            await vi.waitFor(() => expect(snapshots(panel).some((snapshot) => (
                snapshot.commandResult?.requestId === request_id
            ))).toBe(true));
            basis = snapshots(panel).find((snapshot) => (
                snapshot.commandResult?.requestId === request_id
            ))!;
            expect(
                basis.commandResult,
                `${sheet_index}:${sheet.name}:${JSON.stringify({
                    result: basis.commandResult,
                    generation,
                    installs: messages_of(panel, 'transformInstalled').map(
                        (message) => [message.requestId, message.view.basis.generation],
                    ),
                    snapshots: snapshots(panel).map((snapshot) => [
                        snapshot.reason,
                        snapshot.commandResult?.requestId,
                        snapshot.generation,
                    ]),
                })}`,
            ).toMatchObject({
                outcome: 'applied',
            });
            generation = basis.generation;
            source_generation = basis.sourceGeneration;
            await panel.__receive({
                type: 'snapshotApplied',
                identity: basis.identity,
                disposition: 'applied',
            });
        }

        expect(state.value().excelFirstRowHeaders).toEqual({
            'INFORMATION NOTE': 'off',
            'Database Field Descriptions': 'off',
            'By methods': 'off',
            'By marital status and age': 'off',
        });
    }, 30_000);

    it('refreshes after another writer changes the hidden header candidate', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
        });
        const builds = { count: 0 };
        const panel = open_excel(
            '/stale-hidden-candidate.xlsx',
            state.store,
            excel_profile(builds),
        );
        const initial = await ready(panel);
        const external = state.snapshot();
        await state.store.compare_and_set(
            '/stale-hidden-candidate.xlsx',
            external.revision,
            {
                ...external.state,
                transforms: [{
                    sort: [],
                    filters: [],
                    hiddenRows: [0],
                    schema: '["People",2,null]',
                }],
            },
        );

        await toggle(panel, initial, 'stale-candidate', true);
        await vi.waitFor(() => expect(snapshots(panel).some((snapshot) => (
            snapshot.commandResult?.requestId === 'stale-candidate'
            && snapshot.commandResult.outcome === 'rejected'
        ))).toBe(true));
        await vi.waitFor(() => expect(builds.count).toBeGreaterThan(1));
        const refreshed = snapshots(panel).at(-1)!;
        const transform = refreshed.state.transforms![0]!;
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: transform,
            requestId: 'restore-external-hidden-row',
            generation: refreshed.generation,
            sourceGeneration: refreshed.sourceGeneration,
            intent: 'restore',
        });
        const restored = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'restore-external-hidden-row',
        )!;
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'retry-candidate',
            generation: restored.view.basis.generation,
            sourceGeneration: restored.view.basis.sourceGeneration,
        });

        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'retry-candidate', outcome: 'applied' }));
        expect(snapshots(panel).at(-1)?.meta.sheets[0].excelFirstRowHeader?.sourceRow)
            .toBe(1);
    });

    it('atomically turns off an unavailable explicit header when all rows unhide', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'on' },
            transforms: [{
                sort: [],
                filters: [],
                hiddenRows: [0, 1, 2],
                schema: '["People",2,null]',
            }],
        });
        const panel = open_excel(
            '/all-hidden-explicit-header.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        const initial = await ready(panel);
        expect(initial.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'on', active: false, available: false,
        });
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: initial.state.transforms![0]!,
            requestId: 'restore-all-hidden',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'restore',
        });
        const restored = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'restore-all-hidden',
        )!;
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            unhideAll: true,
            requestId: 'restore-all-rows',
            generation: restored.view.basis.generation,
            sourceGeneration: restored.view.basis.sourceGeneration,
        });

        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'restore-all-rows', outcome: 'applied' }));
        const result = snapshots(panel).at(-1)!;
        expect(result.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'off', active: false, available: true,
        });
        expect(result.state.transforms?.[0]).toBeUndefined();
    });

    it('ignores corrupt persisted hidden-row shapes while opening Excel', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'on' },
            transforms: [{
                sort: [],
                filters: [],
                schema: '["People",2,null]',
                hiddenRows: { length: 1 },
            } as unknown as NonNullable<PerFileState['transforms']>[number]],
        });
        const panel = open_excel(
            '/corrupt-hidden-rows.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );

        const initial = await ready(panel);
        expect(initial.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'on', active: true, sourceRow: 0,
        });
    });

    it('canonicalizes injected hidden rows before selecting a manual header', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
        });
        const panel = open_excel(
            '/unsorted-hidden-rows.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        const initial = await ready(panel);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [],
                filters: [],
                hiddenRows: [1, 0],
                schema: '["People",2,null]',
            },
            requestId: 'unsorted-hidden-rows',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'user',
        });
        const applied = messages_of(panel, 'transformInstalled').find(
            (message) => message.requestId === 'unsorted-hidden-rows',
        )!;
        // From the ack's own rules: the record carries rules only where it permuted.
        expect(applied.rules?.hiddenRows).toEqual([0, 1]);
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 0, direction: 'asc' }],
                filters: [],
                schema: '["Other",2,null]',
            },
            requestId: 'wrong-live-schema',
            generation: applied.view.basis.generation,
            sourceGeneration: applied.view.basis.sourceGeneration,
            intent: 'user',
        });
        // A validation refusal is terminal: the webview marks the source handled so a
        // saved view the sheet can no longer support gets dropped instead of retried
        // forever. The refusal itself can no longer describe a view, so what proves
        // the host changed nothing is the durable state below.
        expect(messages_of(panel, 'transformRefused').find(
            (message) => message.requestId === 'wrong-live-schema',
        )).toMatchObject({
            reason: 'The saved table view no longer matches this sheet.',
            terminal: true,
        });
        expect(state.value().transforms?.[0]?.hiddenRows).toEqual([0, 1]);

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'promote-after-unsorted',
            generation: applied.view.basis.generation,
            sourceGeneration: applied.view.basis.sourceGeneration,
        });
        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'promote-after-unsorted', outcome: 'applied' }));
        expect(snapshots(panel).at(-1)?.meta.sheets[0].excelFirstRowHeader?.sourceRow)
            .toBe(2);
    });

    it('retains the exact result snapshot across ACK loss and watcher wake', async () => {
        const state = mutable_state_store();
        const builds = { count: 0 };
        const panel = open_excel('/native-retry.xlsx', state.store, excel_profile(builds));
        const initial = await ready(panel);
        panel.__autoAckSnapshots = false;

        await toggle(panel, initial, 'retry', false);
        await vi.waitFor(() => expect(snapshots(panel).some((snapshot) => (
            snapshot.commandResult?.requestId === 'retry'
        ))).toBe(true));
        const result_snapshot = snapshots(panel).find((snapshot) => (
            snapshot.commandResult?.requestId === 'retry'
        ))!;
        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.waitFor(() => expect(snapshots(panel).filter((snapshot) => (
            snapshot.identity.deliveryId === result_snapshot.identity.deliveryId
        )).length).toBeGreaterThan(1));

        const retries = snapshots(panel).filter((snapshot) => (
            snapshot.identity.deliveryId === result_snapshot.identity.deliveryId
        ));
        expect(retries.every((snapshot) => snapshot === result_snapshot)).toBe(true);
        expect(builds.count).toBeGreaterThanOrEqual(2);
    });

    it('keeps the exact authority basis after a same-digest watcher refresh', async () => {
        const state = mutable_state_store();
        const builds = { count: 0 };
        const panel = open_excel('/native-dedup.xlsx', state.store, excel_profile(builds));
        const initial = await ready(panel);

        await vscode_mock.__getWatchers()[0].__fireChange();
        expect(builds.count).toBe(2);
        await toggle(panel, initial, 'after-dedup', false);
        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'after-dedup', outcome: 'applied' }));

        expect(builds.count).toBe(2);
        expect(snapshots(panel).at(-1)?.reason).toBe('excelHeader');
    });

    it('fast-applies across tabs after a commit-sequence-only physical advance', async () => {
        const path = '/cross-tab-sequence.xlsx';
        const state = mutable_state_store();
        const authority_store = with_in_memory_authority_transactions(state.store);
        const first_builds = { count: 0 };
        const second_builds = { count: 0 };
        const first = open_excel(path, state.store, excel_profile(first_builds));
        const second = open_excel(path, state.store, excel_profile(second_builds));
        const first_basis = await ready(first);
        await ready(second);
        const coordinator = acquire_file_coordinator(
            vscode_mock.Uri.file(path),
            authority_store,
        );
        await coordinator.state_ready();
        const authority = coordinator.authority();
        const started = coordinator.begin_physical(
            authority.authorityRevision,
            authority.physicalDigest!,
        );
        if (started.type !== 'started') throw new Error('operation rejected');
        const stored = await authority_store.read(coordinator.statePath);
        await stage_authority(authority_store, coordinator.statePath, {
            id: started.token.id,
            kind: 'physical',
            ordinal: started.token.ordinal,
            expectedStateRevision: stored.revision,
            expectedCommitSequence: authority.commitSequence,
            physicalDigest: authority.physicalDigest,
        });
        const turn = await coordinator.request_commit_turn(started.token);
        if (turn.type !== 'granted') throw new Error('turn rejected');
        const finalization_basis = coordinator.authority();
        const finalized = await finalize_authority(
            authority_store,
            coordinator.statePath,
            started.token.id,
        );
        if (finalized.type !== 'finalized') throw new Error('finalize rejected');
        coordinator.finalize_authority_commit(
            started.token,
            turn.turn,
            finalized,
            finalization_basis,
        );

        await toggle(first, first_basis, 'cross-tab-sequence', false);
        await vi.waitFor(() => expect(snapshots(first).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'cross-tab-sequence', outcome: 'applied' }));
        await vi.waitFor(() => expect(snapshots(second).at(-1)?.reason).toBe('excelHeader'));
        expect(first_builds.count).toBe(1);
        expect(second_builds.count).toBe(1);
        coordinator.dispose();
    });

    it('signals every tab to recover after an indeterminate header finalization', async () => {
        const state = mutable_state_store();
        const base = with_in_memory_authority_transactions(state.store);
        let projection_id = '';
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                const local = await base.finalize_authority_transaction(path, id);
                if (local.type === 'finalized' && id.startsWith('projection:')) {
                    projection_id = id;
                    const current = await base.read(path);
                    await base.stage_authority_transaction(path, {
                        id: 'later-sequence',
                        kind: 'physical',
                        ordinal: 999,
                        expectedStateRevision: current.revision,
                        expectedCommitSequence: local.authority.commitSequence,
                        physicalDigest: local.authority.physicalDigest,
                    });
                    await base.finalize_authority_transaction(path, 'later-sequence');
                }
                return local;
            },
            async inspect_authority_transaction(path, id) {
                if (id === projection_id) throw new Error('transient inspect failure');
                return base.inspect_authority_transaction(path, id);
            },
        };
        const first_builds = { count: 0 };
        const second_builds = { count: 0 };
        const first = open_excel(
            '/indeterminate-header.xlsx',
            store,
            excel_profile(first_builds),
        );
        const second = open_excel(
            '/indeterminate-header.xlsx',
            store,
            excel_profile(second_builds),
        );
        const first_initial = await ready(first);
        await ready(second);

        await toggle(first, first_initial, 'indeterminate-header', false);
        await vi.waitFor(() => expect(snapshots(first).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'indeterminate-header', outcome: 'recovered' }));
        await vi.waitFor(() => expect(first_builds.count).toBeGreaterThan(1));
        await vi.waitFor(() => expect(second_builds.count).toBeGreaterThan(1));
        await vi.waitFor(() => expect(snapshots(second).at(-1)?.meta.sheets[0]
            .excelFirstRowHeader?.active).toBe(false));
        expect(snapshots(first).some((snapshot) => (
            snapshot.reason === 'excelHeader'
            && snapshot.commandResult?.requestId === 'indeterminate-header'
            && snapshot.commandResult.outcome === 'applied'
        ))).toBe(false);
        expect(snapshots(second).some((snapshot) => (
            snapshot.commandResult?.requestId === 'indeterminate-header'
        ))).toBe(false);
        expect(snapshots(second).at(-1)?.reason).toBe('recovery');
    });

    it('recovers when header finalization and reconciliation inspection both fail', async () => {
        const state = mutable_state_store();
        const base = with_in_memory_authority_transactions(state.store);
        let projection_id = '';
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                if (!id.startsWith('projection:')) {
                    return base.finalize_authority_transaction(path, id);
                }
                projection_id = id;
                const finalized = await base.finalize_authority_transaction(path, id);
                if (finalized.type !== 'finalized') return finalized;
                throw new Error('ambiguous finalize');
            },
            async inspect_authority_transaction(path, id) {
                if (id === projection_id) throw new Error('inspection unavailable');
                return base.inspect_authority_transaction(path, id);
            },
        };
        const builds = { count: 0 };
        const panel = open_excel(
            '/finalize-reconcile-failure-header.xlsx',
            store,
            excel_profile(builds),
        );
        const initial = await ready(panel);

        await toggle(panel, initial, 'finalize-reconcile-failure', false);
        await vi.waitFor(() => expect(snapshots(panel).at(-1)?.commandResult)
            .toMatchObject({
                requestId: 'finalize-reconcile-failure',
                outcome: 'recovered',
            }));
        await vi.waitFor(() => expect(builds.count).toBeGreaterThan(1));
        expect(snapshots(panel).some((snapshot) => (
            snapshot.reason === 'excelHeader'
            && snapshot.commandResult?.requestId === 'finalize-reconcile-failure'
            && snapshot.commandResult.outcome === 'applied'
        ))).toBe(false);
    });

    it('uses a result-only snapshot for validation rejection', async () => {
        const state = mutable_state_store();
        const builds = { count: 0 };
        const panel = open_excel('/native-rejected.xlsx', state.store, excel_profile(builds));
        const initial = await ready(panel);
        const before = snapshots(panel).length;

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'Wrong',
            enabled: false,
            requestId: 'rejected',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.waitFor(() => expect(snapshots(panel).length).toBeGreaterThan(before));
        const rejected = snapshots(panel).at(-1)!;

        expect(rejected.identity.authority).toEqual(initial.identity.authority);
        expect(rejected.identity.sourceBasis).toEqual(initial.identity.sourceBasis);
        expect(rejected.generation).toBe(initial.generation);
        expect(rejected.sourceGeneration).toBe(initial.sourceGeneration);
        expect(rejected.commandResult).toMatchObject({
            type: 'excelFirstRowHeader',
            requestId: 'rejected',
            outcome: 'rejected',
            error: 'The selected worksheet no longer matches this request.',
        });
    });

    it('rebuilds through the shared physical refresh when fast projection is unavailable', async () => {
        const state = mutable_state_store();
        const builds = { count: 0 };
        const panel = open_excel(
            '/native-recovered.xlsx',
            state.store,
            excel_profile(builds, undefined, true),
        );
        const initial = await ready(panel);

        await toggle(panel, initial, 'recovered', false);
        await vi.waitFor(() => expect(snapshots(panel).some((snapshot) => (
            snapshot.commandResult?.requestId === 'recovered'
            && snapshot.commandResult.outcome === 'recovered'
        ))).toBe(true));
        const recovered = snapshots(panel).find((snapshot) => (
            snapshot.commandResult?.requestId === 'recovered'
        ))!;

        expect(builds.count).toBe(2);
        expect(recovered.reason).toBe('recovery');
        expect(recovered.meta.sheets[0].excelFirstRowHeader?.active).toBe(false);
        expect(recovered.state.excelFirstRowHeaders).toEqual({ People: 'off' });
        expect(recovered.commandResult).toMatchObject({
            requestId: 'recovered',
            outcome: 'recovered',
        });
    });

    it('broadcasts the latest projection to every tab but retains the result only at origin', async () => {
        const state = mutable_state_store();
        const builds_a = { count: 0 };
        const builds_b = { count: 0 };
        const panel_a = open_excel('/native-shared.xlsx', state.store, excel_profile(builds_a));
        const panel_b = open_excel('/native-shared.xlsx', state.store, excel_profile(builds_b));
        const initial_a = await ready(panel_a);
        await ready(panel_b);

        await toggle(panel_a, initial_a, 'shared', false);
        await vi.waitFor(() => expect(snapshots(panel_a).at(-1)?.commandResult?.requestId)
            .toBe('shared'));
        await vi.waitFor(() => expect(snapshots(panel_b).at(-1)?.meta.sheets[0]
            .excelFirstRowHeader?.active).toBe(false));
        const projected_a = snapshots(panel_a).at(-1)!;
        const projected_b = snapshots(panel_b).at(-1)!;

        expect(projected_a.identity.authority).toEqual(projected_b.identity.authority);
        expect(projected_a.identity.sourceBasis).toEqual(projected_b.identity.sourceBasis);
        expect(projected_a.commandResult?.requestId).toBe('shared');
        expect(projected_b.commandResult).toBeUndefined();
        expect(projected_b.meta.sheets[0].excelFirstRowHeader?.active).toBe(false);
        expect(builds_a.count).toBeGreaterThanOrEqual(1);
        expect(builds_b.count).toBeGreaterThanOrEqual(1);
    });

    it('does not block durable commit on another panel transport', async () => {
        const state = mutable_state_store();
        const panel_a = open_excel('/native-nonblocking.xlsx', state.store, excel_profile({ count: 0 }));
        const panel_b = open_excel('/native-nonblocking.xlsx', state.store, excel_profile({ count: 0 }));
        const initial_a = await ready(panel_a);
        await ready(panel_b);
        panel_b.__autoAckSnapshots = false;
        panel_b.webview.postMessage = () => new Promise<boolean>(() => {});

        await expect(toggle(panel_a, initial_a, 'nonblocking', false))
            .resolves.toBeUndefined();
        await vi.waitFor(() => expect(snapshots(panel_a).at(-1)?.commandResult)
            .toMatchObject({ requestId: 'nonblocking' }));
    });

    it('continues broadcasting after the origin is disposed during commit', async () => {
        const state = gated_state_store();
        const panel_a = open_excel('/native-dispose.xlsx', state.store, excel_profile({ count: 0 }));
        const panel_b = open_excel('/native-dispose.xlsx', state.store, excel_profile({ count: 0 }));
        const initial_a = await ready(panel_a);
        await ready(panel_b);
        const started = state.block_next_update();

        const command = toggle(panel_a, initial_a, 'disposed-origin', false);
        await started;
        panel_a.dispose();
        state.release_update();
        await command;

        await vi.waitFor(() => expect(snapshots(panel_b).at(-1)?.meta.sheets[0]
            .excelFirstRowHeader?.active).toBe(false));
        expect(snapshots(panel_b).at(-1)?.commandResult).toBeUndefined();
    });

    it('surfaces physical warnings only after ACK and deduplicates across tabs', async () => {
        const warning = vi.spyOn(vscode_mock.window, 'showWarningMessage');
        const state = mutable_state_store();
        const profile_a = excel_profile(
            { count: 0 },
            () => new PhysicalExcelSource(undefined, undefined, ['parse warning']),
        );
        const profile_b = excel_profile(
            { count: 0 },
            () => new PhysicalExcelSource(undefined, undefined, ['parse warning']),
        );
        const panel_a = open_excel('/native-warning.xlsx', state.store, profile_a);
        const panel_b = open_excel('/native-warning.xlsx', state.store, profile_b);
        panel_a.__autoAckSnapshots = false;
        panel_b.__autoAckSnapshots = false;
        const snapshot_a = await ready(panel_a);
        const snapshot_b = await ready(panel_b);

        expect(warning).not.toHaveBeenCalled();
        await panel_a.__receive({
            type: 'snapshotApplied',
            identity: snapshot_a.identity,
            disposition: 'applied',
        });
        await panel_b.__receive({
            type: 'snapshotApplied',
            identity: snapshot_b.identity,
            disposition: 'applied',
        });

        expect(warning).toHaveBeenCalledTimes(1);
        expect(warning).toHaveBeenCalledWith('parse warning');
    });

    it('projects the migrated row heights on the very first view', async () => {
        // The row-height migration end to end, on the profile and the state shape where it
        // actually matters: a non-editing Excel panel opening a file whose durable heights
        // were written by a version that keyed them by *display* row, under a promotion
        // that was already active. `plan_excel_candidate_state` re-keys them during
        // `commit_physical_candidate`, so the very first delivery has to project the
        // *committed* map and not the one the pre-commit read saw.
        //
        // The two answers are distinguishable, which is what makes this worth asserting.
        // Under a row-0 promotion, display d is source d + 1, so the stored `{0:40, 1:60}`
        // migrates to `{1:40, 2:60}` and projects straight back to `{0:40, 1:60}`. Read
        // through a stale latch the same stored map would be *taken* for source keys:
        // source 0 is the promoted header and has no display row at all, source 1 lands at
        // display 0, and the panel would open showing `{0:60}` — one height silently gone
        // and the other on the wrong row.
        //
        // The path is safe because `project_state_for_panel` observes the commit receipt,
        // and `PanelSession.create_desired` samples the core *after* that — every delivery
        // re-reads the projection live rather than using the material captured beside the
        // adoption. This test is what keeps that ordering from being quietly reversed.
        const state = mutable_state_store({
            excelFirstRowHeaderVersion: 1,
            excelFirstRowHeaderActive: { People: true },
            rowHeights: [{ 0: 40, 1: 60 }],
        });
        const panel = open_excel(
            '/row-height-migration.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );

        const initial = await ready(panel);

        // The promotion really is active, auto-detected, and really did take one row out
        // of the display space — the premise the shift is derived from, asserted rather
        // than assumed. (`sourceRow` is reported only for an *explicit* `'on'`, so the
        // row-count gap is what names it here; the migration derives the same fact by
        // re-projecting the sheet with `'on'`.)
        expect(initial.meta.sheets[0].excelFirstRowHeader)
            .toMatchObject({ mode: 'auto', active: true });
        expect(initial.meta.sheets[0]).toMatchObject({ rowCount: 2, sourceRowCount: 3 });
        expect(initial.rowHeightProjection).toEqual([{ 0: 40, 1: 60 }]);
        expect(state.value().rowHeights).toEqual([{ 1: 40, 2: 60 }]);
        expect(state.value().rowHeightsVersion).toBe(1);
    });
});

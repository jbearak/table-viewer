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
import type { AuthorityFileStateStore, FileStateStore } from '../state';
import type { HostMessage, PerFileState, StoredPerFileState } from '../types';
import * as vscode_mock from './mocks/vscode';
import { with_in_memory_authority_transactions } from '../state-authority';

const HEADER_RELOAD_RETRY_TEST_MS = 250;

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
                rowCount: this.rows.length,
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
    let revision = 0;
    const store: FileStateStore = {
        async read() {
            return { state: structuredClone(state), revision };
        },
        async compare_and_set(_path, expected, next) {
            if (expected !== revision) {
                return {
                    type: 'conflict',
                    snapshot: { state: structuredClone(state), revision },
                };
            }
            state = structuredClone(next);
            revision += 1;
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision },
            };
        },
        async touch() {},
    };
    return { store, value: () => state };
}

function gated_state_store(initial: StoredPerFileState = {}) {
    let state: StoredPerFileState = structuredClone(initial);
    let revision = 0;
    let release_next: (() => void) | undefined;
    let notify_started: (() => void) | undefined;
    let wait_next: Promise<void> | undefined;
    let transaction_commits = 0;
    const store: FileStateStore = {
        async read() {
            return { state: structuredClone(state), revision };
        },
        async compare_and_set(_path, expected, next) {
            const pending = wait_next;
            wait_next = undefined;
            if (pending) {
                notify_started?.();
                notify_started = undefined;
                await pending;
            }
            if (expected !== revision) {
                return {
                    type: 'conflict',
                    snapshot: { state: structuredClone(state), revision },
                };
            }
            state = structuredClone(next);
            revision += 1;
            transaction_commits += 1;
            return {
                type: 'committed',
                snapshot: { state: structuredClone(state), revision },
            };
        },
        async touch() {},
    };
    return {
        store,
        value: () => state,
        commit_count: () => transaction_commits,
        block_next_update() {
            wait_next = new Promise<void>((resolve) => { release_next = resolve; });
            return new Promise<void>((resolve) => { notify_started = resolve; });
        },
        release_update() {
            release_next?.();
            release_next = undefined;
        },
    };
}

function excel_profile(
    builds: { count: number },
    make_source: () => DataSource = () => new PhysicalExcelSource(),
): ViewerProfile {
    return {
        metadataDelivery: 'legacy',
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
        with_in_memory_authority_transactions(store),
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
        expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(0);

        await panel.__receive({
            type: 'snapshotApplied',
            identity: {
                deliveryId: 999,
                authority: { fileId: '/tmp/people.xlsx', revision: 999 },
                stateRevision: 999,
                sourceBasis: { physicalRevision: 999, projectionRevision: 999 },
            },
            disposition: 'applied',
        });
        expect(messages_of(panel, 'sheetMeta')).toHaveLength(1);
        expect(messages_of(panel, 'workbookSnapshot')).toHaveLength(0);
    });

    it('derives adopted overrides from the immutable physical receipt state', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'off' },
            excelFirstRowHeaderVersion: 1,
        });
        const base = with_in_memory_authority_transactions(state.store);
        const store: AuthorityFileStateStore = {
            ...base,
            async finalize_authority_transaction(path, id) {
                const finalized = await base.finalize_authority_transaction(path, id);
                if (finalized.type === 'finalized') {
                    const later = await state.store.compare_and_set(
                        path,
                        finalized.snapshot.revision,
                        {
                            ...(finalized.snapshot.state as PerFileState),
                            excelFirstRowHeaders: { People: 'on' },
                        },
                    );
                    expect(later.type).toBe('committed');
                }
                return finalized;
            },
        };
        const panel = open_excel(
            '/tmp/receipt-overrides.xlsx',
            store,
            excel_profile({ count: 0 }),
        );

        await panel.__receive({ type: 'ready' });

        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'on' });
        expect(messages_of(panel, 'sheetMeta')[0].meta.sheets[0]).toMatchObject({
            rowCount: 3,
            columnNames: undefined,
            excelFirstRowHeader: { mode: 'off', active: false, detected: true },
        });
    });

    it('allows disabling an active header override after the sheet becomes empty', async () => {
        const state = mutable_state_store({
            excelFirstRowHeaders: { People: 'on' },
            excelFirstRowHeaderVersion: 1,
        });
        const panel = open_excel(
            '/tmp/empty-header.xlsx',
            state.store,
            excel_profile(
                { count: 0 },
                () => new PhysicalExcelSource([]),
            ),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        expect(initial.meta.sheets[0]).toMatchObject({
            rowCount: 0,
            excelFirstRowHeader: {
                mode: 'on',
                active: true,
                available: false,
            },
        });

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'disable-empty',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        const reload = messages_of(panel, 'metaReload').at(-1)!;
        expect(reload.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'off',
            active: false,
            available: false,
        });
        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'off' });
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'enable-empty',
            generation: reload.generation,
            sourceGeneration: reload.sourceGeneration,
        });
        expect(messages_of(panel, 'metaReload')).toHaveLength(1);
        expect(messages_of(panel, 'excelFirstRowHeaderError').at(-1)).toMatchObject({
            requestId: 'enable-empty',
            error: expect.stringContaining('no first row'),
        });
    });

    it('refuses adoption when disposal happens during the durable transaction', async () => {
        let persisted: StoredPerFileState = {
            rowHeights: [{ 0: 44 }],
        };
        let resolve_decision!: () => void;
        const decision_ready = new Promise<void>((resolve) => {
            resolve_decision = resolve;
        });
        let release_commit!: () => void;
        const commit_gate = new Promise<void>((resolve) => {
            release_commit = resolve;
        });
        let revision = 0;
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(persisted), revision };
            },
            async compare_and_set(_path, expected, next) {
                resolve_decision();
                await commit_gate;
                if (expected !== revision) {
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(persisted), revision },
                    };
                }
                persisted = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(persisted), revision },
                };
            },
            async touch() {},
        };
        const close_spy = vi.spyOn(PhysicalExcelSource.prototype, 'close');
        const panel = open_excel(
            '/tmp/dispose-during-transaction.xlsx',
            store,
            excel_profile({ count: 0 }),
        );

        const ready = panel.__receive({ type: 'ready' });
        await decision_ready;
        panel.dispose();
        release_commit();
        await ready;

        expect(close_spy).toHaveBeenCalledTimes(1);
        expect(messages_of(panel, 'sheetMeta')).toHaveLength(0);
        expect(messages_of(panel, 'metaReload')).toHaveLength(0);
        expect((persisted as PerFileState).excelFirstRowHeaderVersion).toBe(1);
        expect((persisted as PerFileState).rowHeights).toEqual([undefined]);
    });

    it('rebases candidate migration after a CAS conflict without losing newer fields', async () => {
        const input_spy = vi.spyOn(ExcelHeaderDataSource.prototype, 'planning_input');
        const live_plan_spy = vi.spyOn(ExcelHeaderDataSource.prototype, 'plan_override');
        let persisted: StoredPerFileState = {
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 12, left: 3 }],
        };
        let revision = 0;
        let conflicts = 0;
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(persisted), revision };
            },
            async compare_and_set(_path, expected, next) {
                if (conflicts === 0) {
                    conflicts += 1;
                    persisted = {
                        ...(persisted as PerFileState),
                        columnWidths: [{ 0: 123 }],
                        pendingEdits: { '0:0': 'newer' },
                        transforms: [undefined],
                        columnVisibility: [undefined],
                    };
                    revision += 1;
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(persisted), revision },
                    };
                }
                expect(expected).toBe(revision);
                persisted = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(persisted), revision },
                };
            },
            async touch() {},
        };
        const panel = open_excel(
            '/tmp/candidate-cas-conflict.xlsx',
            store,
            excel_profile({ count: 0 }),
        );

        await panel.__receive({ type: 'ready' });

        expect(conflicts).toBe(1);
        expect(input_spy).toHaveBeenCalledTimes(1);
        expect(live_plan_spy).not.toHaveBeenCalled();
        expect(persisted).toMatchObject({
            columnWidths: [{ 0: 123 }],
            pendingEdits: { '0:0': 'newer' },
            transforms: [undefined],
            columnVisibility: [undefined],
            rowHeights: [undefined],
            scrollPosition: [undefined],
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
    });

    it('rebases a candidate to auto when a CAS conflict removes its captured override', async () => {
        let persisted: StoredPerFileState = {
            excelFirstRowHeaders: { People: 'off' },
            excelFirstRowHeaderActive: { People: false },
        };
        let revision = 0;
        let conflicted = false;
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(persisted), revision };
            },
            async compare_and_set(_path, expected, next) {
                if (!conflicted) {
                    conflicted = true;
                    persisted = {
                        excelFirstRowHeaderActive: { People: false },
                    };
                    revision += 1;
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(persisted), revision },
                    };
                }
                expect(expected).toBe(revision);
                persisted = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(persisted), revision },
                };
            },
            async touch() {},
        };
        const panel = open_excel(
            '/tmp/candidate-auto-rebase.xlsx',
            store,
            excel_profile({ count: 0 }),
        );

        await panel.__receive({ type: 'ready' });

        const meta = messages_of(panel, 'sheetMeta')[0];
        expect(conflicted).toBe(true);
        expect((persisted as PerFileState).excelFirstRowHeaders).toBeUndefined();
        expect((persisted as PerFileState).excelFirstRowHeaderActive)
            .toEqual({ People: true });
        expect(meta.meta.sheets[0].excelFirstRowHeader).toMatchObject({
            mode: 'auto', detected: true, active: true,
        });
        expect(meta.meta.sheets[0].columnNames).toEqual(['Name', 'Age']);
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

    it('migrates pre-feature transforms and visibility when auto headers activate', async () => {
        const physical_schema = '["People",2,null]';
        const projected_schema = '["People",2,["Name","Age"]]';
        const state = mutable_state_store({
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: physical_schema,
            }],
            columnVisibility: [{
                hiddenColumns: [1],
                schema: physical_schema,
            }],
        });
        const panel = open_excel(
            '/tmp/upgrade.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );

        await panel.__receive({ type: 'ready' });

        expect((state.value() as PerFileState).transforms?.[0]?.schema)
            .toBe(projected_schema);
        expect((state.value() as PerFileState).columnVisibility?.[0]?.schema)
            .toBe(projected_schema);
        expect(messages_of(panel, 'sheetMeta')[0].state).toMatchObject({
            transforms: [{ schema: projected_schema }],
            columnVisibility: [{ schema: projected_schema }],
        });
    });

    it('rolls back migration state when a prepared candidate becomes stale', async () => {
        const physical_schema = '["People",2,null]';
        const projected_schema = '["People",2,["Name","Age"]]';
        const original_state: StoredPerFileState = {
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: physical_schema,
            }],
            columnVisibility: [{ hiddenColumns: [1], schema: physical_schema }],
            excelFirstRowHeaderActive: { People: false },
        };
        const state = gated_state_store(original_state);
        const ambiguous_rows = [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ];
        const profile: ViewerProfile = {
            metadataDelivery: 'legacy',
            editing: false,
            async build_source(raw, _path, current) {
                const physical = raw[0] === 1
                    ? new PhysicalExcelSource(ambiguous_rows)
                    : new PhysicalExcelSource();
                return new ExcelHeaderDataSource(
                    physical,
                    current.excelFirstRowHeaders,
                );
            },
        };
        const file_path = '/tmp/transactional-migration.xlsx';
        const panel = open_excel(file_path, state.store, profile);
        await panel.__receive({ type: 'ready' });
        const reset_snapshot = await state.store.read(file_path);
        await state.store.compare_and_set(
            file_path,
            reset_snapshot.revision,
            structuredClone(original_state),
        );
        const commits_before_stale_candidate = state.commit_count();

        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        let resolve_stale_verify!: (bytes: Uint8Array) => void;
        let stale_verify_started!: () => void;
        const stale_verify = new Promise<Uint8Array>((resolve) => {
            resolve_stale_verify = resolve;
        });
        const stale_verify_ready = new Promise<void>((resolve) => {
            stale_verify_started = resolve;
        });
        let stale_reads = 0;
        vscode_mock.__setReadFileImplementation(async () => {
            stale_reads += 1;
            if (stale_reads === 1) return new Uint8Array([2]);
            stale_verify_started();
            return stale_verify;
        });
        const stale_reload = vscode_mock.__getWatchers()[0].__fireChange();
        await stale_verify_ready;

        let resolve_current_read!: (bytes: Uint8Array) => void;
        const current_read = new Promise<Uint8Array>((resolve) => {
            resolve_current_read = resolve;
        });
        let current_reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 3 }));
        vscode_mock.__setReadFileImplementation(async () => {
            current_reads += 1;
            if (current_reads === 1) return current_read;
            return new Uint8Array([3]);
        });
        const current_reload = vscode_mock.__getWatchers()[0].__fireChange();
        resolve_stale_verify(new Uint8Array([3]));
        await stale_reload;

        expect(state.value()).toMatchObject(original_state);
        expect((state.value() as PerFileState).excelFirstRowHeaderVersion)
            .toBeUndefined();
        expect(state.commit_count()).toBe(commits_before_stale_candidate);

        resolve_current_read(new Uint8Array([3]));
        await current_reload;
        expect(state.value()).toMatchObject({
            rowHeights: [undefined],
            scrollPosition: [undefined],
            transforms: [{ schema: projected_schema }],
            columnVisibility: [{ hiddenColumns: [1], schema: projected_schema }],
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
        expect(state.commit_count()).toBe(commits_before_stale_candidate + 1);
    });

    it('orders a leased migration before a newer physical replan', async () => {
        const original: StoredPerFileState = {
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            }],
            columnVisibility: [{ hiddenColumns: [1], schema: '["People",2,null]' }],
            excelFirstRowHeaderActive: { People: false },
            excelFirstRowHeaderVersion: 1,
        };
        let persisted = structuredClone(original);
        let revision = 0;
        let gate_migration = false;
        let release_migration!: () => void;
        const migration_gate = new Promise<void>((resolve) => {
            release_migration = resolve;
        });
        let mark_migration_started!: () => void;
        const migration_started = new Promise<void>((resolve) => {
            mark_migration_started = resolve;
        });
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(persisted), revision };
            },
            async compare_and_set(_path, expected, next, validate) {
                if (gate_migration) {
                    gate_migration = false;
                    mark_migration_started();
                    await migration_gate;
                }
                if (expected !== revision || validate?.() === false) {
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(persisted), revision },
                    };
                }
                persisted = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(persisted), revision },
                };
            },
            async touch() {},
        };
        const ambiguous_rows = [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ];
        const profile: ViewerProfile = {
            metadataDelivery: 'legacy',
            editing: false,
            async build_source(raw, _path, current) {
                return new ExcelHeaderDataSource(
                    raw[0] === 2
                        ? new PhysicalExcelSource()
                        : new PhysicalExcelSource(ambiguous_rows),
                    current.excelFirstRowHeaders,
                );
            },
        };
        const file_path = '/tmp/stale-candidate-migration.xlsx';
        const first = open_excel(file_path, store, profile);
        const second = open_excel(file_path, store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        let mark_newer_verified!: () => void;
        const newer_verified = new Promise<void>((resolve) => {
            mark_newer_verified = resolve;
        });
        let reads = 0;
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 4) mark_newer_verified();
            return new Uint8Array([reads <= 2 ? 2 : 3]);
        });
        const close_spy = vi.spyOn(PhysicalExcelSource.prototype, 'close');
        gate_migration = true;
        const stale_reload = vscode_mock.__getWatchers()[0].__fireChange();
        await migration_started;

        // The older operation already owns the durable commit lease. The newer
        // verified candidate queues, then replans from the committed state.
        const newer_reload = vscode_mock.__getWatchers()[1].__fireChange();
        await newer_verified;
        for (let i = 0; i < 10; i++) await Promise.resolve();
        release_migration();
        await Promise.all([stale_reload, newer_reload]);

        expect(persisted).toMatchObject({
            rowHeights: [undefined],
            scrollPosition: [undefined],
            excelFirstRowHeaderActive: { People: false },
            excelFirstRowHeaderVersion: 1,
        });
        expect(close_spy).toHaveBeenCalled();
        const latest = messages_of(second, 'metaReload').at(-1)!;
        expect(latest.meta.sheets[0].excelFirstRowHeader.active).toBe(false);
    });

    it('orders blocked B before a newer candidate reverts to digest A', async () => {
        const original: StoredPerFileState = {
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            excelFirstRowHeaderActive: { People: false },
            excelFirstRowHeaderVersion: 1,
        };
        let persisted = structuredClone(original);
        let revision = 0;
        let gate_migration = false;
        let release_migration!: () => void;
        const migration_gate = new Promise<void>((resolve) => {
            release_migration = resolve;
        });
        let mark_migration_started!: () => void;
        const migration_started = new Promise<void>((resolve) => {
            mark_migration_started = resolve;
        });
        const store: FileStateStore = {
            async read() {
                return { state: structuredClone(persisted), revision };
            },
            async compare_and_set(_path, expected, next, validate) {
                if (gate_migration) {
                    gate_migration = false;
                    mark_migration_started();
                    await migration_gate;
                }
                if (expected !== revision || validate?.() === false) {
                    return {
                        type: 'conflict',
                        snapshot: { state: structuredClone(persisted), revision },
                    };
                }
                persisted = structuredClone(next);
                revision += 1;
                return {
                    type: 'committed',
                    snapshot: { state: structuredClone(persisted), revision },
                };
            },
            async touch() {},
        };
        const ambiguous_rows = [
            [text('Name'), text('City')],
            [text('Alice'), text('London')],
            [text('Bob'), text('Paris')],
        ];
        const profile: ViewerProfile = {
            metadataDelivery: 'legacy',
            editing: false,
            async build_source(raw, _path, current) {
                return new ExcelHeaderDataSource(
                    raw[0] === 2
                        ? new PhysicalExcelSource()
                        : new PhysicalExcelSource(ambiguous_rows),
                    current.excelFirstRowHeaders,
                );
            },
        };
        const file_path = '/tmp/reverted-candidate-migration.xlsx';
        const first = open_excel(file_path, store, profile);
        const second = open_excel(file_path, store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        let mark_revert_verified!: () => void;
        const revert_verified = new Promise<void>((resolve) => {
            mark_revert_verified = resolve;
        });
        let reads = 0;
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 4) mark_revert_verified();
            return new Uint8Array([reads <= 2 ? 2 : 1]);
        });
        const close_spy = vi.spyOn(PhysicalExcelSource.prototype, 'close');
        gate_migration = true;
        const blocked_b = vscode_mock.__getWatchers()[0].__fireChange();
        await migration_started;

        // B owns the lease, so the newer A operation queues. After B commits,
        // A replans from B's state and restores the effective A projection.
        const reverted_a = vscode_mock.__getWatchers()[1].__fireChange();
        await revert_verified;
        for (let i = 0; i < 10; i++) await Promise.resolve();
        release_migration();
        await Promise.all([blocked_b, reverted_a]);

        expect(persisted).toMatchObject({
            rowHeights: [undefined],
            scrollPosition: [undefined],
            excelFirstRowHeaderActive: { People: false },
            excelFirstRowHeaderVersion: 1,
        });
        expect(close_spy).toHaveBeenCalled();
        const latest = messages_of(second, 'metaReload').at(-1)
            ?? messages_of(second, 'sheetMeta').at(-1)!;
        expect(latest.meta.sheets[0].excelFirstRowHeader.active).toBe(false);
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
        expect(reload.projectionChange).toBe('excelHeader');
        expect(reload.headerRequestId).toBe('header:1');
    });

    it('terminally resynchronizes after every ordinary header metadata post fails', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-delivery.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let terminal_attempts = 0;
        const post_spy = vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') return false;
                    if (message.type === 'metaReloadRecovery') {
                        terminal_attempts += 1;
                        if (terminal_attempts <= 2) return false;
                    }
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'delivery',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(500);
        await request;
        vi.useRealTimers();

        expect(terminal_attempts).toBe(3);
        const reload_attempts = post_spy.mock.calls
            .map(([message]) => message)
            .filter((message): message is Extract<HostMessage, { type: 'metaReload' }> => (
                typeof message === 'object'
                && message !== null
                && 'type' in message
                && message.type === 'metaReload'
            ));
        expect(reload_attempts).toHaveLength(7);
        expect(reload_attempts.map((message) => [
            message.generation,
            message.sourceGeneration,
        ])).toEqual([
            [initial.generation + 1, initial.sourceGeneration + 1],
            [initial.generation + 1, initial.sourceGeneration + 1],
            [initial.generation + 1, initial.sourceGeneration + 1],
            [initial.generation + 2, initial.sourceGeneration + 2],
            [initial.generation + 3, initial.sourceGeneration + 3],
            [initial.generation + 4, initial.sourceGeneration + 4],
            [initial.generation + 5, initial.sourceGeneration + 5],
        ]);
        const recovery = messages_of(panel, 'metaReloadRecovery').at(-1)!;
        expect(recovery).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'delivery',
            error: expect.stringContaining('saved'),
            meta: { sheets: [{ rowCount: 3 }] },
            state: expect.any(Object),
        });
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);

        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'after-recovery-row',
            generation: recovery.generation,
        });
        expect(messages_of(panel, 'rowData').at(-1)).toMatchObject({
            requestId: 'after-recovery-row',
            rows: [[{ raw: 'Name' }, { raw: 'Age' }]],
        });

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            },
            requestId: 'after-recovery-transform',
            generation: recovery.generation,
            sourceGeneration: recovery.sourceGeneration,
            intent: 'user',
        });
        const transform = messages_of(panel, 'transformApplied').at(-1)!;
        expect(transform).toMatchObject({
            requestId: 'after-recovery-transform',
        });
        expect(transform.error).toBeUndefined();

        post_spy.mockRestore();
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'after-recovery-header',
            generation: transform.generation,
            sourceGeneration: transform.sourceGeneration,
        });
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'after-recovery-header',
        });
    });

    it('lets a newer cross-tab header operation supersede dormant correlation', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/header-operation-recency.xlsx', state.store, profile);
        const second = open_excel('/tmp/header-operation-recency.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const second_meta = messages_of(second, 'sheetMeta')[0];
        const original_post = second.webview.postMessage.bind(second.webview);
        let fail_a = true;
        vi.spyOn(second.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    fail_a
                    && typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && (message.type === 'metaReload'
                        || message.type === 'metaReloadRecovery')
                ) return false;
                return original_post(message);
            },
        );

        const request_a = second.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'operation-a',
            generation: second_meta.generation,
            sourceGeneration: second_meta.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await request_a;
        expect(messages_of(second, 'metaReload')).toHaveLength(0);
        expect(messages_of(second, 'metaReloadRecovery')).toHaveLength(0);

        fail_a = false;
        const first_after_a = messages_of(first, 'metaReload').at(-1)!;
        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'operation-b',
            generation: first_after_a.generation,
            sourceGeneration: first_after_a.sourceGeneration,
        });
        vi.useRealTimers();

        expect(first_meta.sourceGeneration).toBeLessThan(first_after_a.sourceGeneration);
        expect(messages_of(second, 'metaReload')).toHaveLength(1);
        expect(messages_of(second, 'metaReload')[0]).toMatchObject({
            headerRequestId: 'operation-b',
            projectionChange: 'excelHeader',
            meta: { sheets: [{ excelFirstRowHeader: { active: true, mode: 'on' } }] },
        });
        expect(messages_of(second, 'metaReload')
            .some((message) => message.headerRequestId === 'operation-a')).toBe(false);
        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'on' });
    });

    it('bounds terminal synchronization attempts when delivery stays unavailable', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-terminal-exhausted.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let terminal_attempts = 0;
        const post_spy = vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') return false;
                    if (message.type === 'metaReloadRecovery') {
                        terminal_attempts += 1;
                        return false;
                    }
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'terminal-exhausted',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        await request;

        expect(terminal_attempts).toBe(4);
        expect(messages_of(panel, 'metaReloadRecovery')).toHaveLength(0);
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);
        expect(vi.getTimerCount()).toBe(0);

        post_spy.mockRestore();
        vi.useRealTimers();
        await vscode_mock.__getWatchers()[0].__fireChange();
        const settlement = messages_of(panel, 'metaReload').at(-1)!;
        expect(settlement).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'terminal-exhausted',
            state: expect.any(Object),
        });

        await panel.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'dormant-row',
            generation: settlement.generation,
        });
        expect(messages_of(panel, 'rowData').at(-1)).toMatchObject({
            requestId: 'dormant-row',
        });
        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            },
            requestId: 'dormant-transform',
            generation: settlement.generation,
            sourceGeneration: settlement.sourceGeneration,
            intent: 'user',
        });
        const transform = messages_of(panel, 'transformApplied').at(-1)!;
        expect(transform.requestId).toBe('dormant-transform');
        expect(transform.error).toBeUndefined();
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'dormant-header',
            generation: transform.generation,
            sourceGeneration: transform.sourceGeneration,
        });
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'dormant-header',
        });
    });

    it('cancels terminal synchronization backoff on disposal', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-terminal-dispose.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let terminal_attempts = 0;
        let resolve_terminal_attempt!: () => void;
        const terminal_attempted = new Promise<void>((resolve) => {
            resolve_terminal_attempt = resolve;
        });
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') return false;
                    if (message.type === 'metaReloadRecovery') {
                        terminal_attempts += 1;
                        resolve_terminal_attempt();
                        return false;
                    }
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'terminal-dispose',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(200);
        await terminal_attempted;
        panel.dispose();
        await request;

        expect(terminal_attempts).toBe(1);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('does not resurrect a consumed settlement after the final forced build rejects', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-final-build-consumed.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    reload_attempts += 1;
                    if (reload_attempts <= 3) return false;
                }
                return original_post(message);
            },
        );

        let reject_final_read!: (error: Error) => void;
        const final_read = new Promise<Uint8Array>((_resolve, reject) => {
            reject_final_read = reject;
        });
        let resolve_final_started!: () => void;
        const final_started = new Promise<void>((resolve) => {
            resolve_final_started = resolve;
        });
        let recovery_reads = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => {
            recovery_reads += 1;
            if (recovery_reads <= 3) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (recovery_reads === 4) {
                resolve_final_started();
                return final_read;
            }
            return new Uint8Array([2]);
        });

        const request_a = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'consumed-a',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(200);
        await final_started;

        await vscode_mock.__getWatchers()[0].__fireChange();
        const watcher_settlement = messages_of(panel, 'metaReload').at(-1)!;
        expect(watcher_settlement).toMatchObject({
            headerRequestId: 'consumed-a',
            projectionChange: 'excelHeader',
        });
        reject_final_read(Object.assign(new Error('busy'), { code: 'EBUSY' }));
        await request_a;
        expect(messages_of(panel, 'metaReloadRecovery')).toHaveLength(0);

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'consumed-b',
            generation: watcher_settlement.generation,
            sourceGeneration: watcher_settlement.sourceGeneration,
        });
        vi.useRealTimers();

        expect(builds.count).toBe(2);
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'consumed-b',
            meta: { sheets: [{ excelFirstRowHeader: { active: true } }] },
        });
        expect(messages_of(panel, 'metaReload')
            .filter((message) => message.headerRequestId === 'consumed-a'))
            .toHaveLength(1);
    });

    it('drops a blocked forced recovery after a newer request supersedes it', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-forced-superseded.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const close_spy = vi.spyOn(PhysicalExcelSource.prototype, 'close');
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        let latest_failed_meta: Record<string, any> | undefined;
        let allow_posts = false;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    reload_attempts += 1;
                    if (!allow_posts) {
                        latest_failed_meta = message as Record<string, any>;
                        return false;
                    }
                }
                return original_post(message);
            },
        );

        let resolve_recovery_read!: (bytes: Uint8Array) => void;
        const recovery_read = new Promise<Uint8Array>((resolve) => {
            resolve_recovery_read = resolve;
        });
        let resolve_recovery_started!: () => void;
        const recovery_started = new Promise<void>((resolve) => {
            resolve_recovery_started = resolve;
        });
        let reads = 0;
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 1) {
                resolve_recovery_started();
                return recovery_read;
            }
            return new Uint8Array([1]);
        });

        const request_a = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'forced-a',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(50);
        await recovery_started;
        allow_posts = true;
        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'forced-b',
            generation: latest_failed_meta!.generation,
            sourceGeneration: latest_failed_meta!.sourceGeneration,
        });
        resolve_recovery_read(new Uint8Array([1]));
        await request_a;
        await vi.waitFor(() => expect(builds.count).toBe(2));
        vi.useRealTimers();

        expect(builds.count).toBe(2);
        expect(close_spy).toHaveBeenCalledTimes(1);
        expect(messages_of(panel, 'metaReload')).toHaveLength(1);
        expect(messages_of(panel, 'metaReload')[0]).toMatchObject({
            headerRequestId: 'forced-b',
            meta: { sheets: [{ excelFirstRowHeader: { active: true } }] },
        });
        expect(messages_of(panel, 'metaReload')
            .some((message) => message.headerRequestId === 'forced-a')).toBe(false);
        expect(messages_of(panel, 'metaReloadRecovery')).toHaveLength(0);
        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'on' });
    });

    it('lets a watcher consume dormant correlation during terminal backoff', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-terminal-watcher.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        let terminal_attempts = 0;
        let watcher_done: Promise<void> | undefined;
        let resolve_watcher_post!: () => void;
        const watcher_post_release = new Promise<void>((resolve) => {
            resolve_watcher_post = resolve;
        });
        let resolve_watcher_post_started!: () => void;
        const watcher_post_started = new Promise<void>((resolve) => {
            resolve_watcher_post_started = resolve;
        });
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') {
                        reload_attempts += 1;
                        if (reload_attempts <= 7) return false;
                        resolve_watcher_post_started();
                        await watcher_post_release;
                    }
                    if (message.type === 'metaReloadRecovery') {
                        terminal_attempts += 1;
                        if (terminal_attempts === 1) {
                            watcher_done = watcher.__fireChange();
                        }
                        return false;
                    }
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'terminal-watcher',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(200);
        await watcher_post_started;
        const terminal_advance = vi.advanceTimersByTimeAsync(50);
        await Promise.resolve();
        resolve_watcher_post();
        await terminal_advance;
        await request;
        await watcher_done;
        vi.useRealTimers();

        expect(terminal_attempts).toBe(1);
        expect(messages_of(panel, 'metaReloadRecovery')).toHaveLength(0);
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'terminal-watcher',
            state: expect.any(Object),
        });
    });

    it('preserves a pre-existing watcher retry across failed header recovery', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-preexisting-watcher-retry.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let allow_meta_reload = false;
        let resolve_external_delivery!: () => void;
        const external_delivered = new Promise<void>((resolve) => {
            resolve_external_delivery = resolve;
        });
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    if (!allow_meta_reload) return false;
                    resolve_external_delivery();
                }
                return original_post(message);
            },
        );

        let resolve_retry_read!: (bytes: Uint8Array) => void;
        const retry_read = new Promise<Uint8Array>((resolve) => {
            resolve_retry_read = resolve;
        });
        let reads = 0;
        let allow_successful_reads = false;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (reads === 2) return retry_read;
            if (!allow_successful_reads) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return new Uint8Array([2]);
        });
        await vscode_mock.__getWatchers()[0].__fireChange();

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'preexisting-watcher-retry',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(500);
        await request;
        const terminal = messages_of(panel, 'metaReloadRecovery').at(-1)!;

        allow_meta_reload = true;
        allow_successful_reads = true;
        resolve_retry_read(new Uint8Array([2]));
        await external_delivered;
        vi.useRealTimers();

        expect(builds.count).toBe(2);
        expect(messages_of(panel, 'metaReload').at(-1)!.sourceGeneration)
            .toBeGreaterThan(terminal.sourceGeneration);
    });

    it('keeps physical retry budget bounded after forced recovery succeeds', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-forced-budget.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    reload_attempts += 1;
                    if (reload_attempts <= 3) return false;
                }
                return original_post(message);
            },
        );

        let reject_retry_read!: (error: Error) => void;
        const retry_read = new Promise<Uint8Array>((_resolve, reject) => {
            reject_retry_read = reject;
        });
        let reads = 0;
        let fail_remaining_physical_reads = false;
        let remaining_physical_failures = 0;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (reads === 2) return retry_read;
            if (fail_remaining_physical_reads) {
                remaining_physical_failures += 1;
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return new Uint8Array([2]);
        });
        await vscode_mock.__getWatchers()[0].__fireChange();

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'forced-budget',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(100);
        await request;
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'forced-budget',
        });

        fail_remaining_physical_reads = true;
        reject_retry_read(Object.assign(new Error('busy'), { code: 'EBUSY' }));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(500);

        expect(builds.count).toBe(2);
        expect(remaining_physical_failures).toBe(2);
        expect(vi.getTimerCount()).toBe(0);
        vi.useRealTimers();
    });

    it('preserves physical retry budget after an in-flight retry fails', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-watcher-budget.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let allow_meta_reload = false;
        let resolve_external_delivery!: () => void;
        const external_delivered = new Promise<void>((resolve) => {
            resolve_external_delivery = resolve;
        });
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    if (!allow_meta_reload) return false;
                    resolve_external_delivery();
                }
                return original_post(message);
            },
        );

        let reject_retry_read!: (error: Error) => void;
        const retry_read = new Promise<Uint8Array>((_resolve, reject) => {
            reject_retry_read = reject;
        });
        let reads = 0;
        let allow_successful_reads = false;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => {
            reads += 1;
            if (reads === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            if (reads === 2) return retry_read;
            if (!allow_successful_reads) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return new Uint8Array([2]);
        });
        await vscode_mock.__getWatchers()[0].__fireChange();

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'watcher-budget',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(500);
        await request;

        allow_meta_reload = true;
        allow_successful_reads = true;
        reject_retry_read(Object.assign(new Error('busy'), { code: 'EBUSY' }));
        await Promise.resolve();
        await vi.advanceTimersByTimeAsync(50);
        await external_delivered;
        vi.useRealTimers();

        expect(builds.count).toBe(2);
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            meta: { sheets: [{ excelFirstRowHeader: { active: false } }] },
        });
    });

    it('does not let terminal success cancel a watcher retry', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-terminal-watcher-retry.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let allow_meta_reload = false;
        let terminal_attempts = 0;
        let resolve_first_terminal!: () => void;
        const first_terminal = new Promise<void>((resolve) => {
            resolve_first_terminal = resolve;
        });
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload' && !allow_meta_reload) {
                        return false;
                    }
                    if (message.type === 'metaReloadRecovery') {
                        terminal_attempts += 1;
                        if (terminal_attempts === 1) {
                            resolve_first_terminal();
                            return false;
                        }
                    }
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'terminal-watcher-retry',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(200);
        await first_terminal;

        let watcher_reads = 0;
        allow_meta_reload = true;
        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => {
            watcher_reads += 1;
            if (watcher_reads === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return new Uint8Array([2]);
        });
        await vscode_mock.__getWatchers()[0].__fireChange();
        await vi.advanceTimersByTimeAsync(50);
        await request;
        vi.useRealTimers();

        expect(terminal_attempts).toBe(2);
        expect(builds.count).toBe(6);
        const terminal = messages_of(panel, 'metaReloadRecovery').at(-1)!;
        const watcher_reload = messages_of(panel, 'metaReload').at(-1)!;
        expect(watcher_reload.sourceGeneration)
            .toBeGreaterThan(terminal.sourceGeneration);
    });

    it('preserves header correlation when a watcher supersedes recovery', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-watcher-supersession.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const watcher = vscode_mock.__getWatchers()[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        let watcher_done: Promise<void> | undefined;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    reload_attempts += 1;
                    if (reload_attempts === 4) {
                        watcher_done = watcher.__fireChange();
                        return false;
                    }
                    if (reload_attempts < 4) return false;
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'watcher-supersession',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(HEADER_RELOAD_RETRY_TEST_MS);
        await request;
        await watcher_done;
        vi.useRealTimers();

        expect(reload_attempts).toBe(4);
        expect(messages_of(panel, 'metaReloadRecovery').at(-1)).toMatchObject({
            headerRequestId: 'watcher-supersession',
            projectionChange: 'excelHeader',
            error: expect.stringContaining('saved'),
        });
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);
    });

    it('uses a correlated forced reload before reporting header failure', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const panel = open_excel(
            '/tmp/header-recovery.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];
        const original_post = panel.webview.postMessage.bind(panel.webview);
        let reload_attempts = 0;
        vi.spyOn(panel.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                    && message.type === 'metaReload'
                ) {
                    reload_attempts += 1;
                    if (reload_attempts <= 4) return false;
                }
                return original_post(message);
            },
        );

        const request = panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'recovery',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(HEADER_RELOAD_RETRY_TEST_MS);
        await request;
        vi.useRealTimers();

        expect(reload_attempts).toBe(5);
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);
        expect(messages_of(panel, 'metaReload').at(-1)).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'recovery',
            state: expect.any(Object),
        });
    });

    it('does not cancel an unrelated watcher retry after header delivery', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const panel = open_excel(
            '/tmp/header-during-retry.xlsx',
            state.store,
            excel_profile(builds),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];

        let stat_calls = 0;
        vscode_mock.__setStatImplementation(async () => {
            stat_calls += 1;
            if (stat_calls === 1) {
                throw Object.assign(new Error('busy'), { code: 'EBUSY' });
            }
            return { size: 10, mtime: 2 };
        });
        vscode_mock.__setReadFileImplementation(async () => new Uint8Array([2]));
        await vscode_mock.__getWatchers()[0].__fireChange();

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'during-retry',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(50);

        expect(builds.count).toBe(2);
        expect(messages_of(panel, 'metaReload')).toHaveLength(2);
        expect(messages_of(panel, 'metaReload')[0]).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'during-retry',
        });
        expect(messages_of(panel, 'metaReload')[1].sourceGeneration).toBe(3);
        vi.useRealTimers();
    });

    it('broadcasts a committed toggle when the requesting tab closes mid-write', async () => {
        const state = gated_state_store({
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/closing-header.xlsx', state.store, profile);
        const second = open_excel('/tmp/closing-header.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const initial = messages_of(first, 'sheetMeta')[0];
        const update_started = state.block_next_update();

        const request = first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'closing',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await update_started;
        first.dispose();
        state.release_update();
        await request;

        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'off' });
        expect(messages_of(second, 'metaReload')).toHaveLength(1);
        expect(messages_of(second, 'metaReload')[0].projectionChange)
            .toBe('excelHeader');
    });

    it('migrates a persisted active transform to the toggled header schema', async () => {
        const old_schema = '["People",2,["Name","Age"]]';
        const state = mutable_state_store({
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: old_schema,
            }],
            excelFirstRowHeaderVersion: 1,
        });
        const panel = open_excel(
            '/tmp/transformed.xlsx',
            state.store,
            excel_profile({ count: 0 }),
        );
        await panel.__receive({ type: 'ready' });
        const initial = messages_of(panel, 'sheetMeta')[0];

        await panel.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: (state.value() as PerFileState).transforms![0]!,
            requestId: 'sort',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
            intent: 'restore',
        });
        const applied = messages_of(panel, 'transformApplied')[0];

        await panel.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'header:1',
            generation: applied.generation,
            sourceGeneration: applied.sourceGeneration,
        });

        expect((state.value() as PerFileState).transforms?.[0]).toEqual({
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: '["People",2,null]',
        });
        expect(messages_of(panel, 'excelFirstRowHeaderError')).toHaveLength(0);
        expect(messages_of(panel, 'metaReload')).toHaveLength(1);
    });

    it('reports an error when a transform commits from a stale physical source', async () => {
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/stale-physical.xlsx', state.store, profile);
        const second = open_excel('/tmp/stale-physical.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const second_meta = messages_of(second, 'sheetMeta')[0];

        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => new Uint8Array([2]));
        await vscode_mock.__getWatchers()[0].__fireChange();
        await second.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'desc' }],
                filters: [],
                schema: '["People",2,["Name","Age"]]',
            },
            requestId: 'stale-source',
            generation: second_meta.generation,
            sourceGeneration: second_meta.sourceGeneration,
            intent: 'user',
        });

        expect(messages_of(second, 'transformApplied').at(-1)).toMatchObject({
            requestId: 'stale-source',
            error: expect.stringContaining('source changed'),
        });
        expect((state.value() as PerFileState).transforms?.[0]).toBeUndefined();
    });

    it('does not let a canceled old-source transform overwrite migrated state', async () => {
        const old_schema = '["People",2,["Name","Age"]]';
        const state = mutable_state_store({
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: old_schema,
            }],
            excelFirstRowHeaderVersion: 1,
        });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/transform-race.xlsx', state.store, profile);
        const second = open_excel('/tmp/transform-race.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const second_meta = messages_of(second, 'sheetMeta')[0];

        const transform_request = second.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'desc' }],
                filters: [],
                schema: old_schema,
            },
            requestId: 'stale-transform',
            generation: second_meta.generation,
            sourceGeneration: second_meta.sourceGeneration,
            intent: 'user',
        });
        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'header',
            generation: first_meta.generation,
            sourceGeneration: first_meta.sourceGeneration,
        });
        await transform_request;

        expect((state.value() as PerFileState).transforms?.[0]).toEqual({
            sort: [{ colIndex: 1, direction: 'asc' }],
            filters: [],
            schema: '["People",2,null]',
        });
        expect(messages_of(second, 'transformApplied')
            .some((message) => message.requestId === 'stale-transform')).toBe(false);
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

    it('rejects a queued visibility update from the pre-toggle source', async () => {
        const old_schema = '["People",2,["Name","Age"]]';
        const state = mutable_state_store({
            columnVisibility: [{ hiddenColumns: [1], schema: old_schema }],
            excelFirstRowHeaderVersion: 1,
        });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/stale-visibility.xlsx', state.store, profile);
        const second = open_excel('/tmp/stale-visibility.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const second_meta = messages_of(second, 'sheetMeta')[0];

        const header_request = first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'header',
            generation: first_meta.generation,
            sourceGeneration: first_meta.sourceGeneration,
        });
        const stale_visibility = second.__receive({
            type: 'setColumnVisibility',
            sheetIndex: 0,
            sheetName: 'People',
            state: undefined,
            sourceGeneration: second_meta.sourceGeneration,
        });
        await Promise.all([header_request, stale_visibility]);

        expect((state.value() as PerFileState).columnVisibility?.[0]).toBeUndefined();
    });

    it('rejects stale cross-tab row layout after a header projection change', async () => {
        const projected_schema = '["People",2,["Name","Age"]]';
        const physical_schema = '["People",2,null]';
        const state = mutable_state_store({
            rowHeights: [{ 0: 44 }],
            scrollPosition: [{ top: 100, left: 20 }],
            transforms: [{
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: projected_schema,
            }],
            columnVisibility: [{ hiddenColumns: [1], schema: projected_schema }],
            excelFirstRowHeaderActive: { People: true },
            excelFirstRowHeaderVersion: 1,
        });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/stale-row-layout.xlsx', state.store, profile);
        const second = open_excel('/tmp/stale-row-layout.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const second_meta = messages_of(second, 'sheetMeta')[0];

        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'layout-header',
            generation: first_meta.generation,
            sourceGeneration: first_meta.sourceGeneration,
        });
        const second_reload = messages_of(second, 'metaReload').at(-1)!;

        await second.__receive({
            type: 'stateChanged',
            sourceGeneration: second_meta.sourceGeneration,
            state: {
                rowHeights: [{ 0: 44 }],
                scrollPosition: [{ top: 100, left: 20 }],
                transforms: [{
                    sort: [{ colIndex: 0, direction: 'desc' }],
                    filters: [],
                    schema: projected_schema,
                }],
                columnVisibility: [undefined],
            },
        });

        expect(state.value()).toMatchObject({
            rowHeights: [undefined],
            scrollPosition: [undefined],
            transforms: [{ schema: physical_schema }],
            columnVisibility: [{ hiddenColumns: [1], schema: physical_schema }],
            excelFirstRowHeaders: { People: 'off' },
            excelFirstRowHeaderActive: { People: false },
            excelFirstRowHeaderVersion: 1,
        });

        await second.__receive({
            type: 'stateChanged',
            sourceGeneration: second_reload.sourceGeneration,
            state: {
                rowHeights: [{ 0: 55 }],
                scrollPosition: [{ top: 10, left: 5 }],
                transforms: [undefined],
                columnVisibility: [undefined],
            },
        });

        expect(state.value()).toMatchObject({
            rowHeights: [{ 0: 55 }],
            scrollPosition: [{ top: 10, left: 5 }],
            transforms: [{ schema: physical_schema }],
            columnVisibility: [{ hiddenColumns: [1], schema: physical_schema }],
            excelFirstRowHeaders: { People: 'off' },
        });
    });

    it('lets a newer same-basis header supersede an unrequested older one', async () => {
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/concurrent-header.xlsx', state.store, profile);
        const second = open_excel('/tmp/concurrent-header.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const second_meta = messages_of(second, 'sheetMeta')[0];

        const first_request = first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'first',
            generation: first_meta.generation,
            sourceGeneration: first_meta.sourceGeneration,
        });
        const stale_request = second.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'second',
            generation: second_meta.generation,
            sourceGeneration: second_meta.sourceGeneration,
        });
        await Promise.all([first_request, stale_request]);

        expect((state.value() as PerFileState).excelFirstRowHeaders)
            .toEqual({ People: 'off' });
        expect(messages_of(first, 'metaReload')).toHaveLength(1);
        expect(messages_of(second, 'metaReload')).toHaveLength(1);
        expect(messages_of(first, 'excelFirstRowHeaderError')).toMatchObject([{
            requestId: 'first',
        }]);
        expect(messages_of(second, 'excelFirstRowHeaderError')).toHaveLength(0);
        expect(messages_of(first, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'second',
        });
    });

    it('uses correlated sheetMeta when direct broadcast is the first delivery', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({
            activeSheetIndex: 0,
            tabOrientation: 'vertical',
            rowHeights: [{ 1: 44 }],
            excelFirstRowHeaderVersion: 1,
        });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/first-terminal-meta.xlsx', state.store, profile);
        const second = open_excel('/tmp/first-terminal-meta.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        const first_meta = messages_of(first, 'sheetMeta')[0];
        const original_post = second.webview.postMessage.bind(second.webview);
        vi.spyOn(second.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') return false;
                    if (
                        message.type === 'sheetMeta'
                        && (!('headerRequestId' in message)
                            || message.headerRequestId !== 'first-terminal-meta')
                    ) return false;
                }
                return original_post(message);
            },
        );
        await second.__receive({ type: 'ready' });
        await vi.advanceTimersByTimeAsync(200);
        expect(messages_of(second, 'sheetMeta')).toHaveLength(0);

        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'first-terminal-meta',
            generation: first_meta.generation,
            sourceGeneration: first_meta.sourceGeneration,
        });
        vi.useRealTimers();

        const delivered = messages_of(second, 'sheetMeta');
        expect(delivered).toHaveLength(1);
        expect(messages_of(second, 'metaReload')).toHaveLength(0);
        expect(messages_of(second, 'metaReloadRecovery')).toHaveLength(0);
        expect(delivered[0]).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'first-terminal-meta',
            defaultTabOrientation: expect.any(String),
            state: {
                activeSheetIndex: 0,
                tabOrientation: 'vertical',
            },
            meta: {
                sheets: [{ excelFirstRowHeader: { active: false, mode: 'off' } }],
            },
        });

        vi.restoreAllMocks();
        await vscode_mock.__getWatchers()[1].__fireChange();
        expect(messages_of(second, 'sheetMeta')).toHaveLength(1);
        const current_metadata = messages_of(second, 'metaReload').at(-1)
            ?? delivered[0];
        await second.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'first-terminal-row',
            generation: current_metadata.generation,
        });
        expect(messages_of(second, 'rowData').at(-1)).toMatchObject({
            requestId: 'first-terminal-row',
        });
        await second.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            },
            requestId: 'first-terminal-transform',
            generation: current_metadata.generation,
            sourceGeneration: current_metadata.sourceGeneration,
            intent: 'user',
        });
        const transform = messages_of(second, 'transformApplied').at(-1)!;
        expect(transform.error).toBeUndefined();
        await second.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'first-terminal-header',
            generation: transform.generation,
            sourceGeneration: transform.sourceGeneration,
        });
        expect(messages_of(second, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'first-terminal-header',
        });
    });

    it('defers stale secondary settlement until a later successful adoption', async () => {
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const profile = excel_profile({ count: 0 });
        const first = open_excel('/tmp/stale-secondary-recovery.xlsx', state.store, profile);
        const second = open_excel('/tmp/stale-secondary-recovery.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });

        vscode_mock.__setStatImplementation(async () => ({ size: 10, mtime: 2 }));
        vscode_mock.__setReadFileImplementation(async () => new Uint8Array([2]));
        await vscode_mock.__getWatchers()[0].__fireChange();
        const first_current = messages_of(first, 'metaReload').at(-1)!;

        vi.useFakeTimers();
        let failed_reads = 0;
        vscode_mock.__setReadFileImplementation(async () => {
            failed_reads += 1;
            throw Object.assign(new Error('busy'), { code: 'EBUSY' });
        });
        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'stale-secondary',
            generation: first_current.generation,
            sourceGeneration: first_current.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(1_000);
        vi.useRealTimers();

        expect(failed_reads).toBeGreaterThanOrEqual(4);
        expect(messages_of(second, 'metaReload')).toHaveLength(0);
        expect(messages_of(second, 'metaReloadRecovery')).toHaveLength(0);

        vscode_mock.__setReadFileImplementation(async () => new Uint8Array([2]));
        await vscode_mock.__getWatchers()[1].__fireChange();
        const settlement = messages_of(second, 'metaReload').at(-1)!;
        expect(settlement).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'stale-secondary',
            state: expect.any(Object),
            meta: {
                sheets: [{
                    excelFirstRowHeader: { active: false, mode: 'off' },
                }],
            },
        });

        await second.__receive({
            type: 'setTransform',
            sheetIndex: 0,
            state: {
                sort: [{ colIndex: 1, direction: 'asc' }],
                filters: [],
                schema: '["People",2,null]',
            },
            requestId: 'stale-secondary-transform',
            generation: settlement.generation,
            sourceGeneration: settlement.sourceGeneration,
            intent: 'user',
        });
        const transform = messages_of(second, 'transformApplied').at(-1)!;
        expect(transform.error).toBeUndefined();
        await second.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: true,
            requestId: 'stale-secondary-header',
            generation: transform.generation,
            sourceGeneration: transform.sourceGeneration,
        });
        expect(messages_of(second, 'metaReload').at(-1)).toMatchObject({
            headerRequestId: 'stale-secondary-header',
        });
    });

    it('terminally resynchronizes a secondary tab after exhausted delivery', async () => {
        vi.useFakeTimers();
        const state = mutable_state_store({ excelFirstRowHeaderVersion: 1 });
        const builds = { count: 0 };
        const profile = excel_profile(builds);
        const first = open_excel('/tmp/shared-rejection.xlsx', state.store, profile);
        const second = open_excel('/tmp/shared-rejection.xlsx', state.store, profile);
        await first.__receive({ type: 'ready' });
        await second.__receive({ type: 'ready' });
        const initial = messages_of(first, 'sheetMeta')[0];
        const original_post = second.webview.postMessage.bind(second.webview);
        let secondary_attempts = 0;
        let secondary_terminal_attempts = 0;
        let resolve_secondary_recovery!: () => void;
        const secondary_recovered = new Promise<void>((resolve) => {
            resolve_secondary_recovery = resolve;
        });
        vi.spyOn(second.webview, 'postMessage').mockImplementation(
            async (message: unknown) => {
                if (
                    typeof message === 'object'
                    && message !== null
                    && 'type' in message
                ) {
                    if (message.type === 'metaReload') {
                        secondary_attempts += 1;
                        throw new Error('post rejected');
                    }
                    if (message.type === 'metaReloadRecovery') {
                        secondary_terminal_attempts += 1;
                        if (secondary_terminal_attempts === 1) return false;
                        resolve_secondary_recovery();
                    }
                }
                return original_post(message);
            },
        );
        vi.spyOn(console, 'error').mockImplementation(() => {});

        await first.__receive({
            type: 'setExcelFirstRowHeader',
            sheetIndex: 0,
            sheetName: 'People',
            enabled: false,
            requestId: 'secondary-recovery',
            generation: initial.generation,
            sourceGeneration: initial.sourceGeneration,
        });
        await vi.advanceTimersByTimeAsync(500);
        await secondary_recovered;
        vi.useRealTimers();

        expect(secondary_attempts).toBe(5);
        expect(secondary_terminal_attempts).toBe(2);
        const recovery = messages_of(second, 'metaReloadRecovery').at(-1)!;
        expect(recovery).toMatchObject({
            projectionChange: 'excelHeader',
            headerRequestId: 'secondary-recovery',
            sourceGeneration: 6,
            error: undefined,
        });
        await second.__receive({
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 0,
            count: 1,
            requestId: 'secondary-row',
            generation: recovery.generation,
        });
        expect(messages_of(second, 'rowData').at(-1)).toMatchObject({
            requestId: 'secondary-row',
            rows: [[{ raw: 'Name' }, { raw: 'Age' }]],
        });
        expect(messages_of(first, 'excelFirstRowHeaderError')).toHaveLength(0);
        expect(builds.count).toBe(6);
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

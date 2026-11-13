/**
 * The worksheet structural store: one worksheet's session-owned structure
 * beside the adopted DataSource. It owns the row layout, the column layout,
 * Pending Rows (both origins), Pending Columns, and the append band's tail
 * removals. Source-cell edits remain in EditSessionStore, a sibling that keeps
 * `row:column` source keys only; keeping the two apart prevents temporary row
 * and column IDs from leaking into source keys.
 *
 * Structural gestures (Insert, Delete, Restore, Move) are the pure functions
 * at the end of this module. They plan against a snapshot and return the next
 * one with its history change; the store only commits what they planned.
 */

import { referenced_pending_ids } from '../formula-anchor-layout';
import {
    advance_pending_append_basis,
    appended_rows,
    inserted_rows,
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    has_pending_structural_changes,
    is_inserted_row,
    MAX_PENDING_APPENDED_ROWS,
    MAX_PENDING_CHANGES_ENCODED_BYTES,
    MAX_PENDING_COLUMNS,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
    own_pending_structural_changes,
    pending_rows,
    pending_structure_error,
    type PendingAppendedRow,
    type PendingAppendBasis,
    type PendingColumn,
    type PendingRowCell,
    type PendingRowFormatTemplate,
    type PendingRowId,
    type PendingStructuralChanges,
    type PendingTailRemoval,
    type RowIdentity,
    type StructuralBasis,
} from '../pending-changes';
import { MAX_SHEET_COLUMNS } from '../spreadsheet-safety';
import {
    delete_columns as delete_layout_columns,
    delete_rows as delete_layout_rows,
    drop_unreferenced_column_tombstones,
    drop_unreferenced_row_tombstones,
    has_live_column_layout_change,
    has_live_row_layout_change,
    index_column_layout,
    index_row_layout,
    insert_columns as insert_layout_columns,
    insert_rows as insert_layout_rows,
    move_columns as move_layout_columns,
    move_rows as move_layout_rows,
    restore_columns as restore_layout_columns,
    restore_rows as restore_layout_rows,
    source_column_layout,
    source_row_layout,
    type AxisLayoutIndex,
    type ColumnIdentity,
    type ColumnLayout,
    type LayoutRefusal,
    type LayoutRefusalReason,
    type PendingColumnId,
    type RowLayout,
    type SourceInterval,
} from '../worksheet-layout';
import type { EditSessionIdentity } from './edit-session-store';
import type { CellHighlightColor } from '../cell-highlight-colors';
import type { CsvDirtyMap, MergeRange, WorksheetTarget } from '../types';
import type {
    BasisTransition,
    LayoutHistoryChange,
    PendingEntryTransition,
} from './history-stack-model';
import { stage_mutation, type StagedMutation } from './staged-mutation';

export interface PendingRowStore {
    snapshot(): PendingStructuralChanges;
    /** O(1) stable-row lookup for render/history hot paths. */
    row_index(pending_row_id: string): number | undefined;
    subscribe(listener: (change: PendingRowStoreChange) => void): () => void;
    identity(): EditSessionIdentity | null;
    set_envelope_context(
        worksheet: WorksheetTarget,
        read_cells: () => PendingCellsEnvelope,
        on_refused?: () => void,
    ): () => void;
    envelope_fits(
        cells: CsvDirtyMap,
        changes?: PendingStructuralChanges,
    ): boolean;
    install(identity: EditSessionIdentity, changes?: unknown): boolean;
    reconcile(identity: EditSessionIdentity, changes?: unknown): boolean;
    adopt_session(session_id: string | undefined): void;
    adopt_append_basis(
        session_id: string | undefined,
        basis: PendingAppendBasis,
    ): boolean;
    append_rows(
        session_id: string | undefined,
        row_ids: readonly string[],
        format_template: PendingRowFormatTemplate,
        first_created_order: number,
        append_basis?: PendingAppendBasis,
        /**
         * Cells the new rows carry from birth, one entry per `row_ids` index,
         * keyed by source column. A caller that already knows a row's values —
         * the guided composer — seeds them here rather than writing them after
         * the append: two mutations are two notifications, and subscribers see
         * the row blank before they see it filled.
         */
        initial_cells?: readonly Readonly<Record<number, PendingRowCell>>[],
    ): boolean;
    set_cell(
        session_id: string | undefined,
        pending_row_id: string,
        source_column: number,
        cell: PendingRowCell | undefined,
    ): boolean;
    /** Change only hyperlink membership, preserving value/formula/move metadata. */
    set_hyperlink(
        session_id: string | undefined,
        pending_row_id: string,
        source_column: number,
        link: PendingRowCell['link'],
    ): boolean;
    set_cells(
        session_id: string | undefined,
        edits: readonly {
            readonly pendingRowId: string;
            readonly sourceColumn: number;
            readonly cell: PendingRowCell | undefined;
        }[],
        row_heights?: ReadonlyMap<string, number>,
    ): boolean;
    clear_formula_conflict(
        session_id: string | undefined,
        row_identity: import('../pending-changes').RowIdentity,
        source_column: number,
    ): boolean;
    stage_clear_formula_conflicts(
        session_id: string | undefined,
        cells: readonly {
            readonly rowIdentity: import('../pending-changes').RowIdentity;
            readonly sourceColumn: number;
        }[],
    ): { readonly next: PendingStructuralChanges; readonly mutation: StagedMutation } | undefined;
    set_row_heights(
        session_id: string | undefined,
        pending_row_ids: ReadonlySet<string>,
        height: number,
    ): boolean;
    set_highlights(
        session_id: string | undefined,
        pending_row_ids: ReadonlySet<string>,
        source_columns: readonly number[],
        color: CellHighlightColor | undefined,
    ): boolean;
    remove_rows(
        session_id: string | undefined,
        pending_row_ids: ReadonlySet<string>,
    ): readonly PendingAppendedRow[] | undefined;
    restore_rows(
        session_id: string | undefined,
        rows: readonly PendingAppendedRow[],
        templates: readonly PendingRowFormatTemplate[],
    ): boolean;
    replace_tail_removals(
        session_id: string | undefined,
        removals: readonly PendingTailRemoval[],
    ): boolean;
    clear_saved(
        session_id: string | undefined,
        pending_row_ids: ReadonlySet<string>,
        removed_source_rows: ReadonlySet<number>,
        /**
         * The save wrote this worksheet's live layout change: drop the row and
         * column layouts, Pending Columns, and Structural Basis with the rows.
         */
        clear_layout?: boolean,
    ): void;
    clear(session_id: string | undefined): void;
    stage_clear(session_id: string | undefined): StagedMutation | undefined;
    /**
     * Commit a planned structure outcome if the store still holds the snapshot
     * it was planned against, within the worksheet envelope bound.
     */
    apply_structure(session_id: string | undefined, outcome: StructureOutcome): boolean;
    /** Stage an exact compare-and-swap used by structural history replay. */
    stage_replace(
        session_id: string | undefined,
        expected: PendingStructuralChanges,
        next: PendingStructuralChanges,
        /** The caller already validated the complete worksheet envelope. */
        envelope_prevalidated?: boolean,
    ): StagedMutation | undefined;
}

export interface PendingCellsEnvelope {
    readonly cells: CsvDirtyMap;
    /** UTF-8 byte length of JSON.stringify(cells), cached by the cell owner. */
    readonly encodedBytes: number;
}

export type PendingRowStoreChange =
    | { readonly kind: 'reset' }
    | { readonly kind: 'rows'; readonly rows: readonly PendingAppendedRow[] };

const RESET_CHANGE: PendingRowStoreChange = Object.freeze({ kind: 'reset' });

interface StructuralByteMeasure {
    readonly propertyBytes: number;
    readonly propertyCount: number;
    readonly appendedRowsBytes: number;
}

const byte_encoder = new TextEncoder();

function json_bytes(value: unknown): number {
    return byte_encoder.encode(JSON.stringify(value)).byteLength;
}

function json_property_bytes(key: string, value: unknown): number {
    return json_bytes(key) + 1 + json_bytes(value);
}

function json_array_bytes(values: readonly unknown[]): number {
    return 2 + Math.max(0, values.length - 1)
        + values.reduce<number>((total, value) => total + json_bytes(value), 0);
}

function structural_byte_measure(changes: PendingStructuralChanges): StructuralByteMeasure {
    const appendedRowsBytes = json_array_bytes(pending_rows(changes));
    const properties: Array<readonly [string, unknown]> = [
        ['formatTemplates', changes.formatTemplates],
        ['appendedRows', pending_rows(changes)],
        ['tailRemovals', changes.tailRemovals],
        ['conflicts', changes.conflicts],
    ];
    if (changes.appendBasis !== undefined) {
        properties.splice(3, 0, ['appendBasis', changes.appendBasis]);
    }
    // Layout fields count against the same envelope bound.
    for (const key of ['rowLayout', 'columnLayout', 'pendingColumns', 'structuralBasis'] as const) {
        if (changes[key] !== undefined) properties.push([key, changes[key]]);
    }
    return {
        propertyBytes: properties.reduce((total, [key, value]) => total + (
            key === 'appendedRows'
                ? json_bytes(key) + 1 + appendedRowsBytes
                : json_property_bytes(key, value)
        ), 0),
        propertyCount: properties.length,
        appendedRowsBytes,
    };
}

function object_bytes(property_bytes: number, property_count: number): number {
    return 2 + property_bytes + Math.max(0, property_count - 1);
}

function structural_input(value: unknown): {
    readonly formatTemplates?: unknown;
    readonly appendedRows?: unknown;
    readonly tailRemovals?: unknown;
    readonly appendBasis?: unknown;
    readonly conflicts?: unknown;
} | undefined {
    if (value === undefined) return {};
    if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined;
    return value as Record<string, unknown>;
}

function snapshots_equal(left: PendingStructuralChanges, right: PendingStructuralChanges): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function retained_templates(
    templates: readonly PendingRowFormatTemplate[],
    rows: readonly PendingAppendedRow[],
): readonly PendingRowFormatTemplate[] {
    const used = new Set(rows.map((row) => row.formatTemplateId));
    return templates.filter((template) => used.has(template.id));
}

export function create_pending_row_store(
    initial_identity?: EditSessionIdentity,
): PendingRowStore {
    let state = EMPTY_PENDING_STRUCTURAL_CHANGES;
    let row_index_by_id = new Map<string, number>();
    let byte_measure = structural_byte_measure(state);
    let stamp: EditSessionIdentity | null = initial_identity ?? null;
    let envelope_context: {
        readonly worksheet: WorksheetTarget;
        readonly read_cells: () => PendingCellsEnvelope;
        readonly on_refused?: () => void;
    } | undefined;
    const listeners = new Set<(change: PendingRowStoreChange) => void>();

    const session_matches = (session_id: string | undefined): boolean =>
        stamp !== null && stamp.session_id === session_id;
    const rebuild_row_index = (): void => {
        row_index_by_id = new Map(pending_rows(state).map((row, index) => [row.id, index]));
    };
    const envelope_bytes = (
        cells: CsvDirtyMap,
        measure: StructuralByteMeasure,
        cells_encoded_bytes = json_bytes(cells),
    ): number => {
        if (envelope_context === undefined) {
            return object_bytes(measure.propertyBytes, measure.propertyCount);
        }
        const worksheet_properties = Object.entries(envelope_context.worksheet).filter(
            ([, value]) => value !== undefined,
        );
        const worksheet_bytes = worksheet_properties.reduce(
            (total, [key, value]) => total + json_property_bytes(key, value),
            0,
        );
        const cells_bytes = json_bytes('cells') + 1 + cells_encoded_bytes;
        return object_bytes(
            worksheet_bytes + cells_bytes + measure.propertyBytes,
            worksheet_properties.length + 1 + measure.propertyCount,
        );
    };
    const measure_with_row_replacements = (
        replacements: readonly {
            readonly before: PendingAppendedRow;
            readonly after: PendingAppendedRow;
        }[],
    ): StructuralByteMeasure => {
        const delta = replacements.reduce((total, replacement) => total
            - json_bytes(replacement.before)
            + json_bytes(replacement.after), 0);
        return {
            ...byte_measure,
            propertyBytes: byte_measure.propertyBytes + delta,
            appendedRowsBytes: byte_measure.appendedRowsBytes + delta,
        };
    };
    const without_pending_row_conflicts = (
        pending_row_ids: ReadonlySet<string>,
        all_reasons: boolean,
    ): PendingStructuralChanges['conflicts'] => {
        let changed = false;
        const next = state.conflicts.flatMap((conflict) => {
            if (!all_reasons && conflict.reason !== 'ambiguousPendingFormula') return [conflict];
            const remaining = conflict.pendingRowIds.filter((id) => !pending_row_ids.has(id));
            const formulaCells = conflict.formulaCells?.filter((cell) =>
                cell.rowIdentity.kind !== 'pending'
                || !pending_row_ids.has(cell.rowIdentity.pendingRowId));
            if (remaining.length === conflict.pendingRowIds.length
                && formulaCells?.length === conflict.formulaCells?.length) return [conflict];
            changed = true;
            if (remaining.length === 0
                && conflict.tailRemovalIds.length === 0
                && (formulaCells?.length ?? 0) === 0) return [];
            return [Object.freeze({
                ...conflict,
                pendingRowIds: Object.freeze(remaining),
                ...(formulaCells === undefined ? {} : {
                    formulaCells: Object.freeze(formulaCells),
                }),
            })];
        });
        return changed ? next : state.conflicts;
    };
    const without_formula_cell_conflict = (
        row_identity: import('../pending-changes').RowIdentity,
        source_column: number,
        conflicts: PendingStructuralChanges['conflicts'] = state.conflicts,
    ): PendingStructuralChanges['conflicts'] => {
        let changed = false;
        const next = conflicts.flatMap((conflict) => {
            if (conflict.reason !== 'ambiguousPendingFormula'
                || conflict.formulaCells === undefined) return [conflict];
            const formulaCells = conflict.formulaCells.filter((cell) => !(
                cell.sourceColumn === source_column
                && (row_identity.kind === 'source'
                    ? cell.rowIdentity.kind === 'source'
                        && cell.rowIdentity.sourceRow === row_identity.sourceRow
                    : cell.rowIdentity.kind === 'pending'
                        && cell.rowIdentity.pendingRowId === row_identity.pendingRowId)
            ));
            if (formulaCells.length === conflict.formulaCells.length) return [conflict];
            changed = true;
            const pendingRowIds = row_identity.kind === 'pending'
                && !formulaCells.some((cell) => cell.rowIdentity.kind === 'pending'
                    && cell.rowIdentity.pendingRowId === row_identity.pendingRowId)
                ? conflict.pendingRowIds.filter((id) => id !== row_identity.pendingRowId)
                : conflict.pendingRowIds;
            if (formulaCells.length === 0
                && pendingRowIds.length === 0
                && conflict.tailRemovalIds.length === 0) return [];
            return [Object.freeze({
                ...conflict,
                pendingRowIds: Object.freeze(pendingRowIds),
                formulaCells: Object.freeze(formulaCells),
            })];
        });
        return changed ? next : conflicts;
    };
    const publish = (
        next: PendingStructuralChanges,
        compare_contents = false,
        change: PendingRowStoreChange = RESET_CHANGE,
        row_order_changed = true,
        next_measure = structural_byte_measure(next),
    ): boolean => {
        if (state === next || (compare_contents && snapshots_equal(state, next))) return false;
        state = next;
        byte_measure = next_measure;
        if (row_order_changed) rebuild_row_index();
        notify(change);
        return true;
    };
    const publish_local = (
        next: PendingStructuralChanges,
        change: PendingRowStoreChange = RESET_CHANGE,
        row_order_changed = true,
        next_measure = structural_byte_measure(next),
        allow_hard_bounded_reduction = false,
    ): boolean => {
        // Local mutation inputs are already typed and gesture-validated. Retain
        // the one aggregate safety check without reparsing and cloning every one
        // of up to 10,000 untouched rows; the host independently owns the complete
        // publication before persisting it.
        const cells = envelope_context?.read_cells();
        const bytes = envelope_bytes(
            cells?.cells ?? {},
            next_measure,
            cells?.encodedBytes,
        );
        const current_bytes = allow_hard_bounded_reduction
            ? envelope_bytes(
                cells?.cells ?? {},
                byte_measure,
                cells?.encodedBytes,
            )
            : 0;
        const allowed_reduction = allow_hard_bounded_reduction
            && bytes < current_bytes
            && bytes <= MAX_PENDING_CHANGES_ENCODED_BYTES;
        if (bytes > MAX_PENDING_USER_CHANGES_ENCODED_BYTES && !allowed_reduction) {
            envelope_context?.on_refused?.();
            return false;
        }
        return publish(next, false, change, row_order_changed, next_measure);
    };
    const notify = (change: PendingRowStoreChange = RESET_CHANGE): void => {
        for (const listener of listeners) listener(change);
    };
    const own = (value: unknown): PendingStructuralChanges | undefined => {
        const input = structural_input(value);
        if (input === undefined) return undefined;
        try {
            return own_pending_structural_changes(input);
        } catch {
            return undefined;
        }
    };
    const mutate = (
        session_id: string | undefined,
        build: () => unknown,
        change: PendingRowStoreChange = RESET_CHANGE,
        row_order_changed = true,
    ): boolean => {
        if (!session_matches(session_id)) return false;
        const next = own(build());
        return next !== undefined && publish_local(next, change, row_order_changed);
    };

    return {
        snapshot: () => state,
        row_index: (pending_row_id) => row_index_by_id.get(pending_row_id),
        subscribe: (listener) => {
            listeners.add(listener);
            return () => { listeners.delete(listener); };
        },
        identity: () => stamp,
        set_envelope_context: (worksheet, read_cells, on_refused) => {
            const context = { worksheet, read_cells, on_refused };
            envelope_context = context;
            return () => {
                if (envelope_context === context) envelope_context = undefined;
            };
        },
        envelope_fits: (cells, changes = state) => {
            const measure = changes === state ? byte_measure : structural_byte_measure(changes);
            return envelope_bytes(cells, measure) <= MAX_PENDING_USER_CHANGES_ENCODED_BYTES;
        },
        install: (identity, changes) => {
            const next = own(changes);
            if (next === undefined) return false;
            stamp = { session_id: identity.session_id };
            publish(next, true);
            return true;
        },
        reconcile: (identity, changes) => {
            if (!session_matches(identity.session_id)) return false;
            const next = own(changes);
            if (next === undefined) return false;
            publish(next, true);
            return true;
        },
        adopt_session: (session_id) => { stamp = { session_id }; },
        adopt_append_basis: (session_id, basis) => {
            if (!session_matches(session_id)) return false;
            if (state.appendBasis !== undefined) {
                const advanced = advance_pending_append_basis(state.appendBasis, basis);
                if (advanced === undefined) return false;
                return advanced === state.appendBasis || mutate(
                    session_id,
                    () => ({ ...state, appendBasis: advanced }),
                    RESET_CHANGE,
                    false,
                );
            }
            return mutate(
                session_id,
                () => ({ ...state, appendBasis: basis }),
                RESET_CHANGE,
                false,
            );
        },
        append_rows: (
            session_id,
            row_ids,
            format_template,
            first_created_order,
            append_basis,
            initial_cells,
        ) => {
            if (
                row_ids.length === 0
                || pending_rows(state).length + row_ids.length > MAX_PENDING_APPENDED_ROWS
                || !Number.isSafeInteger(first_created_order)
                || first_created_order < 0
            ) return false;
            const templates = state.formatTemplates.some(
                (template) => template.id === format_template.id,
            )
                ? state.formatTemplates
                : [...state.formatTemplates, format_template];
            const existing_template = state.formatTemplates.find(
                (template) => template.id === format_template.id,
            );
            if (
                existing_template !== undefined
                && JSON.stringify(existing_template) !== JSON.stringify(format_template)
            ) return false;
            if (
                state.appendBasis !== undefined
                && append_basis !== undefined
                && advance_pending_append_basis(state.appendBasis, append_basis) === undefined
            ) return false;
            const next_basis = state.appendBasis === undefined
                ? append_basis
                : append_basis === undefined
                    ? state.appendBasis
                    : advance_pending_append_basis(state.appendBasis, append_basis);
            const rows = row_ids.map((id, index): PendingAppendedRow => ({
                id,
                cells: { ...(initial_cells?.[index] ?? {}) },
                formatTemplateId: format_template.id,
                createdOrder: first_created_order + index,
            }));
            return mutate(session_id, () => ({
                ...state,
                formatTemplates: templates,
                appendedRows: [...pending_rows(state), ...rows],
                ...(next_basis === undefined
                    ? {}
                    : { appendBasis: next_basis }),
            }), RESET_CHANGE);
        },
        set_cell: (session_id, pending_row_id, source_column, cell) => {
            const index = row_index_by_id.get(pending_row_id);
            if (index === undefined || !Number.isSafeInteger(source_column)
                || source_column < 0 || source_column >= MAX_SHEET_COLUMNS) return false;
            const current = pending_rows(state)[index];
            const cells = { ...current.cells };
            if (cell === undefined) delete cells[source_column];
            else cells[source_column] = cell;
            const rows = pending_rows(state).slice();
            rows[index] = { ...current, cells };
            const conflicts = without_formula_cell_conflict(
                { kind: 'pending', pendingRowId: pending_row_id },
                source_column,
            );
            const next = { ...state, appendedRows: rows, conflicts };
            const row_measure = measure_with_row_replacements([{
                before: current,
                after: rows[index],
            }]);
            const next_measure = conflicts === state.conflicts
                ? row_measure
                : structural_byte_measure(next);
            return session_matches(session_id)
                && publish_local(
                    next,
                    { kind: 'rows', rows: [rows[index]] },
                    false,
                    next_measure,
                );
        },
        set_hyperlink: (session_id, pending_row_id, source_column, link) => {
            if (!session_matches(session_id)) return false;
            const index = row_index_by_id.get(pending_row_id);
            if (index === undefined || !Number.isSafeInteger(source_column)
                || source_column < 0 || source_column >= MAX_SHEET_COLUMNS) return false;
            const current = pending_rows(state)[index];
            const previous_cell = current.cells[source_column];
            const next_cell = link === null && previous_cell === undefined
                ? undefined
                : { ...(previous_cell ?? { value: '' }), link };
            const cells = { ...current.cells };
            if (next_cell === undefined) delete cells[source_column];
            else cells[source_column] = next_cell;
            const row = { ...current, cells };
            const appendedRows = pending_rows(state).slice();
            appendedRows[index] = row;
            return publish_local(
                { ...state, appendedRows },
                { kind: 'rows', rows: [row] },
                false,
                measure_with_row_replacements([{ before: current, after: row }]),
            );
        },
        set_cells: (session_id, edits, row_heights = new Map()) => {
            if (!session_matches(session_id) || (edits.length === 0 && row_heights.size === 0)) {
                return false;
            }
            const rows = pending_rows(state).slice();
            const copied = new Set<number>();
            for (const edit of edits) {
                const index = row_index_by_id.get(edit.pendingRowId);
                if (
                    index === undefined
                    || !Number.isSafeInteger(edit.sourceColumn)
                    || edit.sourceColumn < 0
                    || edit.sourceColumn >= MAX_SHEET_COLUMNS
                ) return false;
                if (!copied.has(index)) {
                    rows[index] = { ...rows[index], cells: { ...rows[index].cells } };
                    copied.add(index);
                }
                const cells = rows[index].cells as Record<string, PendingRowCell>;
                if (edit.cell === undefined) delete cells[edit.sourceColumn];
                else cells[edit.sourceColumn] = edit.cell;
            }
            for (const [pending_row_id, height] of row_heights) {
                const index = row_index_by_id.get(pending_row_id);
                if (index === undefined || !Number.isFinite(height) || height <= 0) return false;
                if (!copied.has(index)) {
                    rows[index] = { ...rows[index], cells: { ...rows[index].cells } };
                    copied.add(index);
                }
                rows[index] = { ...rows[index], viewerRowHeight: height };
            }
            const next_measure = measure_with_row_replacements([...copied].map((index) => ({
                before: pending_rows(state)[index],
                after: rows[index],
            })));
            let conflicts = state.conflicts;
            for (const edit of edits) {
                conflicts = without_formula_cell_conflict(
                    { kind: 'pending', pendingRowId: edit.pendingRowId },
                    edit.sourceColumn,
                    conflicts,
                );
            }
            const next = { ...state, appendedRows: rows, conflicts };
            return publish_local(
                next,
                { kind: 'rows', rows: [...copied].map((index) => rows[index]) },
                false,
                conflicts === state.conflicts ? next_measure : structural_byte_measure(next),
            );
        },
        clear_formula_conflict: (session_id, row_identity, source_column) => {
            if (!session_matches(session_id)) return false;
            const conflicts = without_formula_cell_conflict(row_identity, source_column);
            if (conflicts === state.conflicts) return false;
            return publish_local(
                { ...state, conflicts },
                RESET_CHANGE,
                false,
                structural_byte_measure({ ...state, conflicts }),
            );
        },
        stage_clear_formula_conflicts: (session_id, cells) => {
            if (!session_matches(session_id) || cells.length === 0) return undefined;
            const expected = state;
            let conflicts = state.conflicts;
            for (const cell of cells) {
                conflicts = without_formula_cell_conflict(
                    cell.rowIdentity,
                    cell.sourceColumn,
                    conflicts,
                );
            }
            if (conflicts === state.conflicts) return undefined;
            const next = Object.freeze({
                ...state,
                conflicts: Object.freeze(conflicts),
            });
            const next_measure = structural_byte_measure(next);
            return {
                next,
                mutation: stage_mutation(
                    () => state === expected && session_matches(session_id),
                    () => {
                        if (state !== expected) return false;
                        state = next;
                        byte_measure = next_measure;
                        return true;
                    },
                    () => notify(),
                ),
            };
        },
        set_row_heights: (session_id, pending_row_ids, height) => {
            if (!session_matches(session_id)
                || !Number.isFinite(height) || height <= 0 || pending_row_ids.size === 0) {
                return false;
            }
            const indexes = [...pending_row_ids].map((id) => row_index_by_id.get(id));
            if (indexes.some((index) => index === undefined)) return false;
            const appendedRows = pending_rows(state).slice();
            const replacements = indexes.map((index) => {
                const before = pending_rows(state)[index!];
                const after = { ...before, viewerRowHeight: height };
                appendedRows[index!] = after;
                return { before, after };
            });
            return publish_local(
                { ...state, appendedRows },
                { kind: 'rows', rows: appendedRows.filter((row) => pending_row_ids.has(row.id)) },
                false,
                measure_with_row_replacements(replacements),
            );
        },
        set_highlights: (session_id, pending_row_ids, source_columns, color) => {
            if (
                !session_matches(session_id)
                ||
                pending_row_ids.size === 0
                || source_columns.length === 0
                || source_columns.some((column) =>
                    !Number.isSafeInteger(column) || column < 0)
            ) return false;
            const indexes = [...pending_row_ids].map((id) => row_index_by_id.get(id));
            if (indexes.some((index) => index === undefined)) return false;
            const appendedRows = pending_rows(state).slice();
            const replacements = indexes.map((index) => {
                const row = pending_rows(state)[index!];
                const highlights: Record<string, CellHighlightColor> = {
                    ...(row.highlights ?? {}),
                };
                for (const column of source_columns) {
                    if (color === undefined) delete highlights[column];
                    else highlights[column] = color;
                }
                const after = {
                    ...row,
                    ...(Object.keys(highlights).length === 0
                        ? { highlights: undefined }
                        : { highlights }),
                };
                appendedRows[index!] = after;
                return { before: row, after };
            });
            return publish_local(
                { ...state, appendedRows },
                { kind: 'rows', rows: appendedRows.filter((row) => pending_row_ids.has(row.id)) },
                false,
                measure_with_row_replacements(replacements),
            );
        },
        remove_rows: (session_id, pending_row_ids) => {
            if (!session_matches(session_id)) return undefined;
            const removed = pending_rows(state).filter((row) => pending_row_ids.has(row.id));
            if (removed.length === 0) return [];
            const appendedRows = pending_rows(state).filter((row) => !pending_row_ids.has(row.id));
            const next = own({
                ...state,
                formatTemplates: retained_templates(state.formatTemplates, appendedRows),
                appendedRows,
                // The basis authorizes a provisional append band, so it has no
                // truthful meaning once that band is empty. Clearing it here
                // also makes removal history own the basis transition that Undo
                // must restore with the row.
                appendBasis: appendedRows.length === 0 ? undefined : state.appendBasis,
                conflicts: without_pending_row_conflicts(pending_row_ids, true),
            });
            if (next === undefined) return undefined;
            if (!publish_local(
                next,
                RESET_CHANGE,
                true,
                structural_byte_measure(next),
                true,
            )) return undefined;
            return removed;
        },
        restore_rows: (session_id, rows, templates) => {
            const by_id = new Map(state.formatTemplates.map((template) => [template.id, template]));
            for (const template of templates) if (!by_id.has(template.id)) by_id.set(template.id, template);
            const appendedRows = [...pending_rows(state), ...rows]
                .sort((left, right) => left.createdOrder - right.createdOrder);
            return mutate(session_id, () => ({
                ...state,
                formatTemplates: [...by_id.values()],
                appendedRows,
            }), RESET_CHANGE);
        },
        replace_tail_removals: (session_id, removals) => mutate(
            session_id,
            () => {
                const retained = new Set(removals.map((removal) => removal.appendHistoryId));
                const removed = new Set(state.tailRemovals
                    .map((removal) => removal.appendHistoryId)
                    .filter((id) => !retained.has(id)));
                const conflicts = removed.size === 0 ? state.conflicts : state.conflicts.flatMap(
                    (conflict) => {
                        const tailRemovalIds = conflict.tailRemovalIds.filter(
                            (id) => !removed.has(id),
                        );
                        if (tailRemovalIds.length === conflict.tailRemovalIds.length) {
                            return [conflict];
                        }
                        if (tailRemovalIds.length === 0 && conflict.pendingRowIds.length === 0) {
                            return [];
                        }
                        return [Object.freeze({
                            ...conflict,
                            tailRemovalIds: Object.freeze(tailRemovalIds),
                        })];
                    },
                );
                return { ...state, tailRemovals: removals, conflicts };
            },
            RESET_CHANGE,
            false,
        ),
        clear_saved: (session_id, pending_row_ids, removed_source_rows, clear_layout = false) => {
            if (!session_matches(session_id)) return;
            const appendedRows = pending_rows(state).filter(
                (row) => !pending_row_ids.has(row.id),
            );
            const tailRemovals = state.tailRemovals.filter(
                (removal) => !removed_source_rows.has(removal.sourceRow),
            );
            const {
                rowLayout: _rows,
                columnLayout: _columns,
                pendingColumns: _pending_columns,
                structuralBasis: _basis,
                ...without_layout
            } = state;
            const next = own({
                ...(clear_layout ? without_layout : state),
                formatTemplates: retained_templates(state.formatTemplates, appendedRows),
                appendedRows,
                tailRemovals,
                appendBasis: appendedRows.length === 0 ? undefined : state.appendBasis,
            });
            if (next !== undefined) publish(next);
        },
        clear: (session_id) => {
            if (session_matches(session_id)) publish(EMPTY_PENDING_STRUCTURAL_CHANGES);
        },
        stage_clear: (session_id) => {
            if (!session_matches(session_id)) return undefined;
            const staged_from = state;
            const staged_stamp = stamp;
            let changed = false;
            return stage_mutation(
                () => state === staged_from
                    && stamp === staged_stamp
                    && session_matches(session_id),
                () => {
                    changed = has_pending_structural_changes(state);
                    if (changed) {
                        state = EMPTY_PENDING_STRUCTURAL_CHANGES;
                        byte_measure = structural_byte_measure(state);
                        rebuild_row_index();
                    }
                    return changed;
                },
                () => notify(),
            );
        },
        apply_structure: (session_id, outcome) => {
            if (!session_matches(session_id) || !snapshots_equal(state, outcome.before)) return false;
            return publish_local(
                outcome.next,
                RESET_CHANGE,
                true,
                structural_byte_measure(outcome.next),
                true,
            );
        },
        stage_replace: (session_id, expected, next_input, envelope_prevalidated = false) => {
            if (!session_matches(session_id) || !snapshots_equal(state, expected)) return undefined;
            const next = own(next_input);
            if (next === undefined) return undefined;
            const next_measure = structural_byte_measure(next);
            const cells = envelope_context?.read_cells();
            if (!envelope_prevalidated && envelope_bytes(
                cells?.cells ?? {},
                next_measure,
                cells?.encodedBytes,
            ) > MAX_PENDING_CHANGES_ENCODED_BYTES) {
                envelope_context?.on_refused?.();
                return undefined;
            }
            const staged_from = state;
            return stage_mutation(
                () => state === staged_from && session_matches(session_id),
                () => {
                    if (snapshots_equal(state, next)) return false;
                    state = next;
                    byte_measure = next_measure;
                    rebuild_row_index();
                    return true;
                },
                () => notify(),
            );
        },
    };
}

// ---------------------------------------------------------------------------
// Worksheet structure operations
// ---------------------------------------------------------------------------
//
// Insert, Delete, Restore, and Move for rows and columns, as pure functions of
// one worksheet's structural snapshot. Each returns the next snapshot and the
// layout history change that reaches it, or a refusal with the reason the menu
// shows; none mutates. Layout math is `worksheet-layout.ts`'s; this layer adds
// the Pending Row and Pending Column content, the exclusivity, transform,
// band, merge, and size rules, and the history delta. A caller commits an
// outcome with `PendingRowStore.apply_structure`, or stages it with
// `stage_replace(outcome.before, outcome.next)` beside the cell-edit discards
// that `source_cells_removed_by` names, so both land in one history action.

export const STRUCTURE_TAIL_REMOVAL_MESSAGE = 'Save or redo the row removal first.';
export const STRUCTURE_CELL_MOVE_MESSAGE = 'Save or undo the moved cells first.';
export const STRUCTURE_TRANSFORMED_MESSAGE =
    'Clear sorts, filters, and hidden rows to insert or move rows.';
export const APPENDED_BAND_MESSAGE = 'Appended rows stay at the end until you save.';
export const LAST_LIVE_COLUMN_MESSAGE = 'A sheet needs at least one column.';
export const MERGE_SPLIT_MESSAGE = "Can't move part of a merged cell.";
export const FILTERED_COLUMN_MOVE_MESSAGE = "Can't move a filtered column outside the sheet's filter range.";
export const TOO_MANY_PENDING_ROWS_MESSAGE =
    `A worksheet may keep at most ${MAX_PENDING_APPENDED_ROWS.toLocaleString('en-US')} pending rows.`;
export const TOO_MANY_PENDING_COLUMNS_MESSAGE =
    `A worksheet may add at most ${MAX_PENDING_COLUMNS.toLocaleString('en-US')} columns before saving.`;

export function merge_anchor_message(axis: StructureAxis): string {
    return axis === 'rows'
        ? "Can't delete part of a merged cell's first row."
        : "Can't delete part of a merged cell's first column.";
}

export function merge_destination_message(axis: StructureAxis): string {
    return axis === 'rows'
        ? "Can't move rows into a merged cell."
        : "Can't move columns into a merged cell.";
}

export function too_many_rows_message(maximum: number): string {
    return `Can't insert rows here: the sheet would have more than ${maximum.toLocaleString('en-US')} rows.`;
}

export type StructureAxis = 'rows' | 'columns';

/** What the structure operations need to know about the worksheet besides its snapshot. */
export interface WorksheetStructureContext {
    readonly worksheet: WorksheetTarget;
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart: number;
    /** Canonical source row count; the body is `[bodyStart, sourceRowCount)`. */
    readonly sourceRowCount: number;
    readonly sourceColumnCount: number;
    /**
     * A sort, enabled filter, or hidden body row is installed. Row insert and
     * row move need the display order to equal the physical order.
     */
    readonly bodyViewTransformed: boolean;
    /** Whether a source cell edit on this worksheet is a pending cell move. */
    readonly hasPendingCellMove?: () => boolean;
    /** Merged ranges in canonical source coordinates, for the action-time merge rules. */
    readonly merges?: readonly MergeRange[];
    /**
     * The `.xlsx` worksheet AutoFilter: its range's first and last columns
     * and the 0-based worksheet columns with a `<filterColumn>`, for the
     * action-time filtered-column move rule.
     */
    readonly autoFilter?: {
        readonly firstColumn: number;
        readonly lastColumn: number;
        readonly filteredColumns: readonly number[];
    };
    /**
     * Whether a stored Formula Anchor outside this worksheet's Pending Rows and
     * Pending Columns names a Pending Row of this worksheet: one in any
     * worksheet's cell edits, or in another worksheet's Pending Rows or
     * Pending Columns. The store adds the anchors in this worksheet's own
     * Pending Rows and Pending Columns as the action leaves them. Defaults to
     * false. Every structural action drops the discarded tombstones on its
     * axis that nothing then names.
     */
    readonly isRowReferenced?: (id: PendingRowId) => boolean;
    /** Like `isRowReferenced`, for discarded Pending Columns. */
    readonly isColumnReferenced?: (id: PendingColumnId) => boolean;
    /** Recorded with the worksheet's first live layout change when present. */
    readonly structuralBasis?: StructuralBasis;
    /** Prospective row ceiling, 1,048,576 for `.xlsx`; absent means none. */
    readonly maxProspectiveRows?: number;
}

export type StructureRefusalReason =
    | LayoutRefusalReason
    | 'tail-removal'
    | 'cell-move'
    | 'transformed'
    | 'appended-band'
    | 'merge-anchor'
    | 'merge-split'
    | 'merge-destination'
    | 'filtered-column'
    | 'last-live-column'
    | 'too-many-pending-rows'
    | 'too-many-pending-columns'
    | 'too-many-rows'
    | 'unchanged'
    | 'invalid';

export interface StructureRefusal {
    readonly reason: StructureRefusalReason;
    readonly message: string;
}

export interface StructureOutcome {
    readonly before: PendingStructuralChanges;
    readonly next: PendingStructuralChanges;
    /** The `rowLayout` or `columnLayout` history arm from `before` to `next`. */
    readonly change: LayoutHistoryChange;
    /** Live Pending Rows the action discarded, with their content. */
    readonly discardedRows: readonly PendingAppendedRow[];
    /** Live Pending Columns the action discarded, with their content. */
    readonly discardedColumns: readonly PendingColumn[];
    /** Source rows the action newly made Pending Row Removals. */
    readonly removedSourceRows: readonly SourceInterval[];
    /** Source columns the action newly made Pending Column Removals, ascending. */
    readonly removedSourceColumns: readonly number[];
    /**
     * A second layout arm in the same history action, after `change`: the
     * column half of an action that drops both axes' changes.
     */
    readonly additionalChanges?: readonly LayoutHistoryChange[];
}

export type StructureResult =
    | { readonly ok: true; readonly outcome: StructureOutcome }
    | { readonly ok: false; readonly refusal: StructureRefusal };

function refuse_structure(reason: StructureRefusalReason, message: string): StructureResult {
    return { ok: false, refusal: Object.freeze({ reason, message }) };
}

function layout_refusal(refusal: LayoutRefusal): StructureResult {
    return refuse_structure(refusal.reason, refusal.message);
}

function body_row_count(context: WorksheetStructureContext): number {
    return Math.max(0, context.sourceRowCount - context.bodyStart);
}

function row_layout_of(changes: PendingStructuralChanges, context: WorksheetStructureContext): RowLayout {
    return changes.rowLayout ?? source_row_layout(context.bodyStart, body_row_count(context));
}

function column_layout_of(changes: PendingStructuralChanges, context: WorksheetStructureContext): ColumnLayout {
    return changes.columnLayout ?? source_column_layout(context.sourceColumnCount);
}

function cells_hold_move(cells: Readonly<Record<string, PendingRowCell>>): boolean {
    for (const key in cells) if (cells[key]?.movedFrom !== undefined) return true;
    return false;
}

/**
 * Why no structure item may act on the worksheet right now under the
 * exclusivity rules (a Pending Tail Removal or a pending cell move), or
 * undefined. Menus ask it before any target-specific reason.
 */
export function structure_exclusivity_message(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
): string | undefined {
    const refusal = exclusivity_refusal(changes, context);
    return refusal === undefined || refusal.ok ? undefined : refusal.refusal.message;
}

/** The exclusivity rules every structure item shares (invariant 8). */
function exclusivity_refusal(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
): StructureResult | undefined {
    if (changes.tailRemovals.length > 0) {
        return refuse_structure('tail-removal', STRUCTURE_TAIL_REMOVAL_MESSAGE);
    }
    if (context.hasPendingCellMove?.() === true
        || pending_rows(changes).some((row) => cells_hold_move(row.cells))
        || (changes.pendingColumns ?? []).some((column) => cells_hold_move(column.cells))) {
        return refuse_structure('cell-move', STRUCTURE_CELL_MOVE_MESSAGE);
    }
    return undefined;
}

function is_appended_identity(changes: PendingStructuralChanges, identity: RowIdentity): boolean {
    if (identity.kind !== 'pending') return false;
    const row = pending_rows(changes).find((candidate) => candidate.id === identity.pendingRowId);
    return row !== undefined && !is_inserted_row(row);
}

/** Live source entries of `[start, end]` given sorted removal intervals. */
function live_in_range(removed: readonly SourceInterval[], start: number, end: number): number {
    let live = end - start + 1;
    for (const interval of removed) {
        const low = Math.max(start, interval.start);
        const high = Math.min(end, interval.start + interval.count - 1);
        if (high >= low) live -= high - low + 1;
    }
    return live;
}

function intervals_of_columns(columns: readonly number[]): SourceInterval[] {
    const out: SourceInterval[] = [];
    for (const column of [...new Set(columns)].sort((left, right) => left - right)) {
        const last = out[out.length - 1];
        if (last !== undefined && last.start + last.count === column) {
            out[out.length - 1] = { start: last.start, count: last.count + 1 };
        } else {
            out.push({ start: column, count: 1 });
        }
    }
    return out;
}

function merge_span(merge: MergeRange, axis: StructureAxis): { start: number; end: number } {
    return axis === 'rows'
        ? { start: merge.startRow, end: merge.endRow }
        : { start: merge.startCol, end: merge.endCol };
}

/**
 * Deleting the first row (column) of a merge that keeps at least two live
 * cells is refused; Excel would move the value, this version does not.
 */
function merge_anchor_refusal(
    context: WorksheetStructureContext,
    axis: StructureAxis,
    newly_removed: readonly SourceInterval[],
    removed_rows: readonly SourceInterval[],
    removed_columns: readonly SourceInterval[],
): StructureResult | undefined {
    for (const merge of context.merges ?? []) {
        const anchor = axis === 'rows' ? merge.startRow : merge.startCol;
        if (!newly_removed.some((interval) => anchor >= interval.start && anchor < interval.start + interval.count)) {
            continue;
        }
        const live_cells = live_in_range(removed_rows, merge.startRow, merge.endRow)
            * live_in_range(removed_columns, merge.startCol, merge.endCol);
        if (live_cells >= 2) return refuse_structure('merge-anchor', merge_anchor_message(axis));
    }
    return undefined;
}

/**
 * Moving part of a merge is refused, and so is landing the block strictly
 * inside a merge's span, between two of its live rows (columns).
 */
function merge_move_refusal<I>(
    context: WorksheetStructureContext,
    axis: StructureAxis,
    moved: readonly number[],
    removed: readonly SourceInterval[],
    after: AxisLayoutIndex<I>,
    moved_identities: readonly I[],
    identity_of: (source: number) => I,
): StructureResult | undefined {
    const merges = (context.merges ?? []).filter((merge) => {
        const span = merge_span(merge, axis);
        return span.end > span.start;
    });
    if (merges.length === 0) return undefined;
    const moved_set = new Set(moved);
    for (const merge of merges) {
        const span = merge_span(merge, axis);
        let inside = 0;
        for (const source of moved) if (source >= span.start && source <= span.end) inside++;
        if (inside > 0 && inside < live_in_range(removed, span.start, span.end)) {
            return refuse_structure('merge-split', MERGE_SPLIT_MESSAGE);
        }
    }
    let first = Infinity;
    let last = -Infinity;
    for (const identity of moved_identities) {
        const body_index = after.body_index_of(identity);
        if (body_index === undefined) continue;
        first = Math.min(first, body_index);
        last = Math.max(last, body_index);
    }
    if (first === Infinity) return undefined;
    // A merge's span is everything between its first and last live rows in
    // the layout, inserted rows included: Insert inside a merge expands it.
    const live_body_index = (from: number, to: number, step: 1 | -1): number | undefined => {
        for (let source = from; step > 0 ? source <= to : source >= to; source += step) {
            if (moved_set.has(source)) continue;
            const body_index = after.body_index_of(identity_of(source));
            if (body_index !== undefined) return body_index;
        }
        return undefined;
    };
    for (const merge of merges) {
        const span = merge_span(merge, axis);
        const low = live_body_index(span.start, span.end, 1);
        const high = live_body_index(span.end, span.start, -1);
        if (low !== undefined && high !== undefined && low < first && last < high) {
            return refuse_structure('merge-destination', merge_destination_message(axis));
        }
    }
    return undefined;
}

/**
 * A column move that would leave a filtered column outside the rendered
 * AutoFilter range is refused (design "XLSX" → "AutoFilter"). The range is
 * rendered by interval semantics: everything between its corner columns'
 * positions in the full layout, where each corner moves with its column.
 */
function filtered_column_move_refusal(
    context: WorksheetStructureContext,
    after: ColumnLayout,
): StructureResult | undefined {
    const filter = context.autoFilter;
    if (filter === undefined || filter.filteredColumns.length === 0) return undefined;
    const index = index_column_layout(after);
    const first = index.position_of({ kind: 'source', sourceColumn: filter.firstColumn });
    const last = index.position_of({ kind: 'source', sourceColumn: filter.lastColumn });
    if (first === undefined || last === undefined) return undefined;
    const low = Math.min(first, last);
    const high = Math.max(first, last);
    for (const sourceColumn of filter.filteredColumns) {
        const identity: ColumnIdentity = { kind: 'source', sourceColumn };
        const position = index.position_of(identity);
        if (position === undefined || !index.is_live(identity)) continue;
        if (position < low || position > high) {
            return refuse_structure('filtered-column', FILTERED_COLUMN_MOVE_MESSAGE);
        }
    }
    return undefined;
}

function json_equal(left: unknown, right: unknown): boolean {
    return left === right || JSON.stringify(left) === JSON.stringify(right);
}

function entry_transitions<T extends { readonly id: string }>(
    before: readonly T[],
    after: readonly T[],
): PendingEntryTransition<T>[] {
    const after_by_id = new Map(after.map((entry) => [entry.id, entry]));
    const out: PendingEntryTransition<T>[] = [];
    for (const entry of before) {
        const next = after_by_id.get(entry.id) ?? null;
        after_by_id.delete(entry.id);
        if (next !== entry && !json_equal(next, entry)) {
            out.push({ id: entry.id, before: entry, after: next });
        }
    }
    for (const entry of after_by_id.values()) out.push({ id: entry.id, before: null, after: entry });
    return out;
}

function basis_transition<T>(before: T | undefined, after: T | undefined): BasisTransition<T> | undefined {
    return json_equal(before ?? null, after ?? null)
        ? undefined
        : { before: before ?? null, after: after ?? null };
}

/** Strip conflict references to rows the snapshot no longer holds. */
function conflicts_for_rows(
    conflicts: PendingStructuralChanges['conflicts'],
    rows: readonly PendingAppendedRow[],
): PendingStructuralChanges['conflicts'] {
    const ids = new Set(rows.map((row) => row.id));
    return conflicts.flatMap((conflict) => {
        const pendingRowIds = conflict.pendingRowIds.filter((id) => ids.has(id));
        const formulaCells = conflict.formulaCells?.filter((cell) =>
            cell.rowIdentity.kind !== 'pending' || ids.has(cell.rowIdentity.pendingRowId));
        if (pendingRowIds.length === conflict.pendingRowIds.length
            && formulaCells?.length === conflict.formulaCells?.length) return [conflict];
        if (pendingRowIds.length === 0 && conflict.tailRemovalIds.length === 0
            && (formulaCells?.length ?? 0) === 0) return [];
        return [{ ...conflict, pendingRowIds, ...(formulaCells === undefined ? {} : { formulaCells }) }];
    });
}

interface StructureDraft {
    readonly rowLayout: RowLayout;
    readonly columnLayout: ColumnLayout;
    readonly rows: readonly PendingAppendedRow[];
    readonly columns: readonly PendingColumn[];
    readonly templates?: readonly PendingRowFormatTemplate[];
    readonly appendBasis?: PendingAppendBasis;
    readonly discardedRows?: readonly PendingAppendedRow[];
    readonly discardedColumns?: readonly PendingColumn[];
    readonly removedSourceRows?: readonly SourceInterval[];
    readonly removedSourceColumns?: readonly number[];
}

/**
 * Drop the discarded tombstones on the action's axis that no stored Formula
 * Anchor names once the action is done: the context answers for every anchor
 * outside this worksheet's Pending Rows and Pending Columns, and the draft's
 * own rows and columns supply the rest. Only the acted axis changes, so its
 * history arm restores the tombstones the action dropped.
 */
function without_unreferenced_tombstones(
    context: WorksheetStructureContext,
    axis: StructureAxis,
    draft: StructureDraft,
): StructureDraft {
    const own = referenced_pending_ids(context.worksheet, [{
        target: context.worksheet,
        changes: { appendedRows: draft.rows, pendingColumns: draft.columns },
    }]);
    if (axis === 'rows') {
        if (draft.rowLayout.discardedPendingRows.length === 0) return draft;
        return {
            ...draft,
            rowLayout: drop_unreferenced_row_tombstones(draft.rowLayout, (id) =>
                own.rows.has(id) || (context.isRowReferenced?.(id) ?? false)),
        };
    }
    if (draft.columnLayout.discardedPendingColumns.length === 0) return draft;
    return {
        ...draft,
        columnLayout: drop_unreferenced_column_tombstones(draft.columnLayout, (id) =>
            own.columns.has(id) || (context.isColumnReferenced?.(id) ?? false)),
    };
}

/**
 * Own a draft as the worksheet's next snapshot, check it against the full
 * worksheet context, and build the history arm that reaches it. A source
 * layout normalizes to absence; the Structural Basis is recorded with the
 * first live layout change (when the caller has one) and dropped once none
 * is left, since only a live change records a basis.
 */
function finish_structure(
    before: PendingStructuralChanges,
    context: WorksheetStructureContext,
    axis: StructureAxis,
    drafted: StructureDraft,
): StructureResult {
    const draft = without_unreferenced_tombstones(context, axis, drafted);
    const rows = [...draft.rows].sort((left, right) => left.createdOrder - right.createdOrder);
    const templates_by_id = new Map((draft.templates ?? before.formatTemplates).map((template) =>
        [template.id, template]));
    const used = new Set(rows.map((row) => row.formatTemplateId));
    // Any gesture that grows the sheet (insert, or restore after an insert)
    // must stay under the prospective row ceiling; one that shrinks it may not
    // be refused by it.
    if (context.maxProspectiveRows !== undefined) {
        const prospective_rows = (layout: RowLayout, band: number): number =>
            context.bodyStart + index_row_layout(layout).liveCount + band;
        const after_rows = prospective_rows(
            draft.rowLayout,
            draft.rows.filter((row) => !is_inserted_row(row)).length,
        );
        if (after_rows > context.maxProspectiveRows
            && after_rows > prospective_rows(row_layout_of(before, context), appended_rows(before).length)) {
            return refuse_structure('too-many-rows', too_many_rows_message(context.maxProspectiveRows));
        }
    }
    const live = has_live_row_layout_change(draft.rowLayout)
        || has_live_column_layout_change(draft.columnLayout);
    const structuralBasis = live ? before.structuralBasis ?? context.structuralBasis : undefined;
    const appendBasis = 'appendBasis' in draft ? draft.appendBasis : before.appendBasis;
    let next: PendingStructuralChanges;
    try {
        next = own_pending_structural_changes({
            formatTemplates: [...templates_by_id.values()].filter((template) => used.has(template.id)),
            appendedRows: rows,
            tailRemovals: before.tailRemovals,
            ...(appendBasis === undefined ? {} : { appendBasis }),
            conflicts: conflicts_for_rows(before.conflicts, rows),
            rowLayout: draft.rowLayout,
            columnLayout: draft.columnLayout,
            pendingColumns: draft.columns,
            ...(structuralBasis === undefined ? {} : { structuralBasis }),
        });
    } catch (error) {
        return refuse_structure('invalid', error instanceof Error ? error.message : String(error));
    }
    const error = pending_structure_error(next, undefined, {
        bodyStart: context.bodyStart,
        sourceRowCount: context.sourceRowCount,
        sourceColumnCount: context.sourceColumnCount,
    });
    if (error !== undefined) return refuse_structure('invalid', error);
    if (json_equal(next, before)) return refuse_structure('unchanged', 'Nothing changed.');
    const row_transitions = entry_transitions(pending_rows(before), pending_rows(next));
    const template_ids = new Set<string>();
    for (const transition of row_transitions) {
        for (const row of [transition.before, transition.after]) if (row !== null) template_ids.add(row.formatTemplateId);
    }
    const all_templates = new Map(before.formatTemplates.map((template) => [template.id, template]));
    for (const template of next.formatTemplates) all_templates.set(template.id, template);
    const appendTransition = basis_transition(before.appendBasis, next.appendBasis);
    const basisTransition = basis_transition(before.structuralBasis, next.structuralBasis);
    const common = {
        worksheet: context.worksheet,
        pendingRows: row_transitions,
        pendingColumns: entry_transitions(before.pendingColumns ?? [], next.pendingColumns ?? []),
        formatTemplates: [...template_ids].map((id) => all_templates.get(id)!),
        ...(appendTransition === undefined ? {} : { appendBasis: appendTransition }),
        ...(basisTransition === undefined ? {} : { structuralBasis: basisTransition }),
    };
    const change: LayoutHistoryChange = axis === 'rows'
        ? { kind: 'rowLayout', delta: { ...common, before: before.rowLayout ?? null, after: next.rowLayout ?? null } }
        : {
            kind: 'columnLayout',
            delta: { ...common, before: before.columnLayout ?? null, after: next.columnLayout ?? null },
        };
    return {
        ok: true,
        outcome: Object.freeze({
            before,
            next,
            change,
            discardedRows: Object.freeze([...(draft.discardedRows ?? [])]),
            discardedColumns: Object.freeze([...(draft.discardedColumns ?? [])]),
            removedSourceRows: Object.freeze([...(draft.removedSourceRows ?? [])]),
            removedSourceColumns: Object.freeze([...(draft.removedSourceColumns ?? [])]),
        }),
    };
}

/**
 * Drop the column half of a layout as the second arm of an action whose row
 * arm `rows` already planned: the source column layout, no Pending Columns or
 * tombstones. Without column changes the row outcome stands alone.
 */
function with_columns_dropped(
    rows: StructureResult,
    context: WorksheetStructureContext,
): StructureResult {
    if (!rows.ok) return rows;
    const middle = rows.outcome.next;
    if (middle.columnLayout === undefined && (middle.pendingColumns?.length ?? 0) === 0) return rows;
    const columns = finish_structure(middle, { ...context, structuralBasis: undefined }, 'columns', {
        rowLayout: row_layout_of(middle, context),
        columnLayout: source_column_layout(context.sourceColumnCount),
        rows: pending_rows(middle),
        columns: [],
        discardedColumns: middle.pendingColumns ?? [],
    });
    if (!columns.ok) {
        // Nothing to drop on the column axis after all (a source layout).
        return columns.refusal.reason === 'unchanged' ? rows : columns;
    }
    return {
        ok: true,
        outcome: Object.freeze({
            ...rows.outcome,
            next: columns.outcome.next,
            discardedColumns: columns.outcome.discardedColumns,
            additionalChanges: Object.freeze([columns.outcome.change]),
        }),
    };
}

/** Plan the row arm, tolerating a row axis that is already the source layout. */
function rows_then_columns(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    draft: StructureDraft,
): StructureResult {
    const rows = finish_structure(changes, { ...context, structuralBasis: undefined }, 'rows', draft);
    if (!rows.ok && rows.refusal.reason === 'unchanged') {
        const columns = with_columns_dropped({
            ok: true,
            outcome: Object.freeze({
                before: changes,
                next: changes,
                change: {
                    kind: 'rowLayout' as const,
                    delta: {
                        worksheet: context.worksheet,
                        before: changes.rowLayout ?? null,
                        after: changes.rowLayout ?? null,
                        pendingRows: [],
                        pendingColumns: [],
                        formatTemplates: [],
                    },
                },
                discardedRows: Object.freeze([]),
                discardedColumns: Object.freeze([]),
                removedSourceRows: Object.freeze([]),
                removedSourceColumns: Object.freeze([]),
            }),
        }, context);
        if (!columns.ok || columns.outcome.additionalChanges === undefined) return rows;
        // Only the column arm changes anything: it is the action's one change.
        return {
            ok: true,
            outcome: Object.freeze({
                ...columns.outcome,
                change: columns.outcome.additionalChanges[0]!,
                additionalChanges: undefined,
            }),
        };
    }
    return with_columns_dropped(rows, context);
}

/**
 * Review Changes' "Discard row and column changes on <sheet>", offered when
 * the file changed under a live layout change (`structuralBasisChanged`):
 * drop Pending Inserted Rows, Pending Columns, removals, moves, and
 * tombstones, leaving the source layout of the file as it is now and no
 * Structural Basis. Cell edits on source cells and Pending Appended Rows are
 * kept, and reconcile by today's rules. One history action, holding the row
 * arm and, when columns changed, the column arm after it; the conflict it
 * answers goes with it.
 */
export function discard_layout_changes(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
): StructureResult {
    const result = rows_then_columns(changes, context, {
        rowLayout: source_row_layout(context.bodyStart, body_row_count(context)),
        columnLayout: column_layout_of(changes, context),
        rows: appended_rows(changes),
        columns: changes.pendingColumns ?? [],
        discardedRows: inserted_rows(changes),
    });
    return without_basis_conflict(result);
}

function without_basis_conflict(result: StructureResult): StructureResult {
    if (!result.ok) return result;
    const next = own_pending_structural_changes({
        ...result.outcome.next,
        // A refused structural save's `unsupportedStructure` belongs to the
        // layout too, so the discard answers it as well.
        conflicts: result.outcome.next.conflicts.filter((conflict) =>
            conflict.reason !== 'structuralBasisChanged' && conflict.reason !== 'unsupportedStructure'),
    });
    return { ok: true, outcome: Object.freeze({ ...result.outcome, next }) };
}

/**
 * Review Changes' "Keep new rows at the end", offered beside the discard when
 * the file changed under a live layout change: every live Pending Inserted
 * Row becomes a Pending Appended Row, in layout order, with `origin` set to
 * `append` and fresh `createdOrder`s after every Pending Row's (so after the
 * band's highest), which puts it at the end of `appendedRows` and of the
 * band. Removals, moves, Pending Columns, and tombstones are dropped (Pending
 * Columns by a second, column arm), leaving the source layout and no
 * Structural Basis; `appendBasis` is kept, so the
 * band then reconciles by today's append rules. Typed content in the inserted
 * rows survives. One history action: its `pendingRows` transitions hold each
 * converted row's old origin and order, so Undo puts it back in the layout.
 *
 * `first_created_order` is a floor for the fresh orders, so a caller can keep
 * them on the same clock as the orders it issues for appends.
 */
export function keep_inserted_rows_at_end(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    first_created_order = 0,
): StructureResult {
    const layout = row_layout_of(changes, context);
    const inserted = new Map(inserted_rows(changes).map((row) => [row.id, row]));
    const in_layout_order = index_row_layout(layout).segments.flatMap((segment) =>
        segment.kind === 'pending' && segment.status === 'live' && inserted.has(segment.id)
            ? [inserted.get(segment.id)!]
            : []);
    let highest = -1;
    for (const row of pending_rows(changes)) highest = Math.max(highest, row.createdOrder);
    let next_order = Math.max(highest + 1, first_created_order);
    if (!Number.isSafeInteger(next_order + in_layout_order.length)) {
        return refuse_structure('invalid-created-order', 'New rows need a creation order.');
    }
    const converted = in_layout_order.map((row): PendingAppendedRow => ({
        ...row,
        origin: 'append',
        createdOrder: next_order++,
    }));
    return without_basis_conflict(rows_then_columns(changes, context, {
        rowLayout: source_row_layout(context.bodyStart, body_row_count(context)),
        columnLayout: column_layout_of(changes, context),
        rows: [...appended_rows(changes), ...converted],
        columns: changes.pendingColumns ?? [],
    }));
}

/** Drop Pending Column cells keyed by any of `keys`, keeping untouched columns as they are. */
function columns_without_cells(
    columns: readonly PendingColumn[],
    drop: (key: string) => boolean,
): PendingColumn[] {
    return columns.map((column) => {
        const keys = Object.keys(column.cells).filter(drop);
        if (keys.length === 0) return column;
        const cells: Record<string, PendingRowCell> = { ...column.cells };
        for (const key of keys) delete cells[key];
        return { ...column, cells };
    });
}

function in_intervals(intervals: readonly SourceInterval[], value: number): boolean {
    return intervals.some((interval) => value >= interval.start && value < interval.start + interval.count);
}

/**
 * Insert `ids` as blank Pending Inserted Rows before or after the live body
 * row `anchor`. `ids` and their `createdOrder`s (`first_created_order` and up)
 * come from host admission, which also supplies the row format template and,
 * on the worksheet's first insert, its append basis.
 */
export function insert_rows(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    anchor: RowIdentity,
    side: 'before' | 'after',
    ids: readonly PendingRowId[],
    template: PendingRowFormatTemplate,
    first_created_order: number,
    append_basis?: PendingAppendBasis,
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    if (context.bodyViewTransformed) return refuse_structure('transformed', STRUCTURE_TRANSFORMED_MESSAGE);
    if (is_appended_identity(changes, anchor)) return refuse_structure('appended-band', APPENDED_BAND_MESSAGE);
    const layout = row_layout_of(changes, context);
    if (pending_rows(changes).length + layout.discardedPendingRows.length + ids.length
        > MAX_PENDING_APPENDED_ROWS) {
        return refuse_structure('too-many-pending-rows', TOO_MANY_PENDING_ROWS_MESSAGE);
    }
    if (!Number.isSafeInteger(first_created_order) || first_created_order < 0) {
        return refuse_structure('invalid-created-order', 'New rows need a creation order.');
    }
    const existing = changes.formatTemplates.find((candidate) => candidate.id === template.id);
    if (existing !== undefined && !json_equal(existing, template)) {
        return refuse_structure('invalid', 'The new rows carry a different format template under an existing id.');
    }
    let next_append_basis = changes.appendBasis;
    if (append_basis !== undefined) {
        next_append_basis = changes.appendBasis === undefined
            ? append_basis
            : advance_pending_append_basis(changes.appendBasis, append_basis);
        if (next_append_basis === undefined) {
            return refuse_structure('invalid', 'The new rows were admitted against a different append basis.');
        }
    }
    const result = insert_layout_rows(layout, anchor, side, ids);
    if (!result.ok) return layout_refusal(result.refusal);
    const inserted = ids.map((id, index): PendingAppendedRow => ({
        id,
        origin: 'insert',
        cells: {},
        formatTemplateId: template.id,
        createdOrder: first_created_order + index,
    }));
    return finish_structure(changes, context, 'rows', {
        rowLayout: result.layout,
        columnLayout: column_layout_of(changes, context),
        rows: [...pending_rows(changes), ...inserted],
        columns: changes.pendingColumns ?? [],
        templates: existing === undefined ? [...changes.formatTemplates, template] : changes.formatTemplates,
        appendBasis: next_append_basis,
    });
}

/**
 * Delete body rows: live source rows become Pending Row Removals in place,
 * Pending Inserted Rows become discarded tombstones (dropped unless a Formula
 * Anchor names them), and Pending Appended Rows leave the band, as Remove
 * pending rows does. Every pending value the deleted rows held goes with them
 * into the history change: the rows themselves and their cells in Pending
 * Columns. Source cell edits in the removed rows are the caller's to discard;
 * see `source_cells_removed_by`.
 */
export function delete_rows(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly RowIdentity[],
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const layout = row_layout_of(changes, context);
    const index = index_row_layout(layout);
    const rows_by_id = new Map(pending_rows(changes).map((row) => [row.id, row]));
    const layout_identities: RowIdentity[] = [];
    const removed_ids = new Set<string>();
    const newly_removed: number[] = [];
    for (const identity of identities) {
        if (identity.kind === 'pending') {
            const row = rows_by_id.get(identity.pendingRowId);
            if (row !== undefined && !is_inserted_row(row)) {
                removed_ids.add(row.id);
                continue;
            }
        }
        const status = index.status_of(identity);
        if (status === undefined) return layout_refusal({ reason: 'unknown-identity', message: "That row is not part of this sheet's layout." });
        if (status !== 'live') continue;
        layout_identities.push(identity);
        if (identity.kind === 'source') newly_removed.push(identity.sourceRow);
        else removed_ids.add(identity.pendingRowId);
    }
    if (layout_identities.length === 0 && removed_ids.size === 0) {
        return refuse_structure('no-live-entry', "Select at least one row that isn't deleted.");
    }
    const removed_intervals = intervals_of_columns(newly_removed);
    const result = delete_layout_rows(layout, layout_identities, (id) => rows_by_id.get(id)?.createdOrder ?? NaN);
    if (!result.ok) return layout_refusal(result.refusal);
    const column_layout = column_layout_of(changes, context);
    const merge = merge_anchor_refusal(
        context,
        'rows',
        removed_intervals,
        result.layout.removedSourceRows,
        intervals_of_columns(column_layout.removedSourceColumns),
    );
    if (merge !== undefined) return merge;
    const row_layout = result.layout;
    const rows = pending_rows(changes).filter((row) => !removed_ids.has(row.id));
    const columns = columns_without_cells(changes.pendingColumns ?? [], (key) => {
        if (key.startsWith('p:')) return removed_ids.has(key.slice(2));
        return key.startsWith('s:') && in_intervals(removed_intervals, Number(key.slice(2)));
    });
    return finish_structure(changes, context, 'rows', {
        rowLayout: row_layout,
        columnLayout: column_layout,
        rows,
        columns,
        // The append basis authorizes a pending band; like Remove pending
        // rows, the action that empties every pending row clears it.
        appendBasis: removed_ids.size > 0 && rows.length === 0 ? undefined : changes.appendBasis,
        discardedRows: pending_rows(changes).filter((row) => removed_ids.has(row.id)),
        removedSourceRows: removed_intervals,
    });
}

/** Cancel Pending Row Removals; every listed source row must currently be removed. */
export function restore_rows(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    source_rows: readonly number[],
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const result = restore_layout_rows(row_layout_of(changes, context), source_rows);
    if (!result.ok) return layout_refusal(result.refusal);
    return finish_structure(changes, context, 'rows', {
        rowLayout: result.layout,
        columnLayout: column_layout_of(changes, context),
        rows: pending_rows(changes),
        columns: changes.pendingColumns ?? [],
    });
}

/**
 * Move the live body rows of `identities`, each with its glued tombstones, to
 * just before `before` (`'end'` is the end of the layout, before the append
 * band). Appended rows stay where Append put them.
 */
export function move_rows(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly RowIdentity[],
    before: RowIdentity | 'end',
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    if (context.bodyViewTransformed) return refuse_structure('transformed', STRUCTURE_TRANSFORMED_MESSAGE);
    if (identities.some((identity) => is_appended_identity(changes, identity))
        || (before !== 'end' && is_appended_identity(changes, before))) {
        return refuse_structure('appended-band', APPENDED_BAND_MESSAGE);
    }
    const layout = row_layout_of(changes, context);
    const result = move_layout_rows(layout, identities, before);
    if (!result.ok) return layout_refusal(result.refusal);
    const index = index_row_layout(layout);
    const moved = identities.filter((identity) => index.is_live(identity));
    const merge = merge_move_refusal(
        context,
        'rows',
        moved.flatMap((identity) => identity.kind === 'source' ? [identity.sourceRow] : []),
        layout.removedSourceRows,
        index_row_layout(result.layout),
        moved,
        (sourceRow): RowIdentity => ({ kind: 'source', sourceRow }),
    );
    if (merge !== undefined) return merge;
    return finish_structure(changes, context, 'rows', {
        rowLayout: result.layout,
        columnLayout: column_layout_of(changes, context),
        rows: pending_rows(changes),
        columns: changes.pendingColumns ?? [],
    });
}

/**
 * Insert `columns`, built by the caller from host-minted ids with blank cells,
 * before or after the live column `anchor`.
 */
export function insert_columns(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    anchor: ColumnIdentity,
    side: 'before' | 'after',
    columns: readonly PendingColumn[],
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const layout = column_layout_of(changes, context);
    if ((changes.pendingColumns?.length ?? 0) + layout.discardedPendingColumns.length + columns.length
        > MAX_PENDING_COLUMNS) {
        return refuse_structure('too-many-pending-columns', TOO_MANY_PENDING_COLUMNS_MESSAGE);
    }
    const result = insert_layout_columns(layout, anchor, side, columns.map((column) => column.id));
    if (!result.ok) return layout_refusal(result.refusal);
    return finish_structure(changes, context, 'columns', {
        rowLayout: row_layout_of(changes, context),
        columnLayout: result.layout,
        rows: pending_rows(changes),
        columns: [...(changes.pendingColumns ?? []), ...columns],
    });
}

/**
 * Delete columns: live source columns become Pending Column Removals, live
 * Pending Columns are discarded with their content. Pending Row cells in the
 * removed source columns go into the history change; source cell edits in them
 * are the caller's to discard (`source_cells_removed_by`).
 */
export function delete_columns(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly ColumnIdentity[],
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const layout = column_layout_of(changes, context);
    const index = index_column_layout(layout);
    const columns_by_id = new Map((changes.pendingColumns ?? []).map((column) => [column.id, column]));
    const newly_removed = new Set<number>();
    const discarded_ids = new Set<string>();
    for (const identity of identities) {
        if (!index.is_live(identity)) continue;
        if (identity.kind === 'source') newly_removed.add(identity.sourceColumn);
        else discarded_ids.add(identity.pendingColumnId);
    }
    const result = delete_layout_columns(layout, identities, (id) => columns_by_id.get(id)?.createdOrder ?? NaN);
    if (!result.ok) return layout_refusal(result.refusal);
    if (newly_removed.size === 0 && discarded_ids.size === 0) {
        return refuse_structure('no-live-entry', "Select at least one column that isn't deleted.");
    }
    if (index_column_layout(result.layout).liveCount === 0) {
        return refuse_structure('last-live-column', LAST_LIVE_COLUMN_MESSAGE);
    }
    const removed = [...newly_removed].sort((left, right) => left - right);
    const merge = merge_anchor_refusal(
        context,
        'columns',
        intervals_of_columns(removed),
        row_layout_of(changes, context).removedSourceRows,
        intervals_of_columns(result.layout.removedSourceColumns),
    );
    if (merge !== undefined) return merge;
    const column_layout = result.layout;
    const rows = pending_rows(changes).map((row) => {
        const keys = Object.keys(row.cells).filter((column) => newly_removed.has(Number(column)));
        if (keys.length === 0) return row;
        const cells: Record<string, PendingRowCell> = { ...row.cells };
        for (const key of keys) delete cells[key];
        return { ...row, cells };
    });
    return finish_structure(changes, context, 'columns', {
        rowLayout: row_layout_of(changes, context),
        columnLayout: column_layout,
        rows,
        columns: (changes.pendingColumns ?? []).filter((column) => !discarded_ids.has(column.id)),
        discardedColumns: (changes.pendingColumns ?? []).filter((column) => discarded_ids.has(column.id)),
        removedSourceColumns: removed,
    });
}

/** Cancel Pending Column Removals; every listed source column must currently be removed. */
export function restore_columns(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    source_columns: readonly number[],
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const result = restore_layout_columns(column_layout_of(changes, context), source_columns);
    if (!result.ok) return layout_refusal(result.refusal);
    return finish_structure(changes, context, 'columns', {
        rowLayout: row_layout_of(changes, context),
        columnLayout: result.layout,
        rows: pending_rows(changes),
        columns: changes.pendingColumns ?? [],
    });
}

/** Like `move_rows`, for columns; column moves work under any row transform. */
export function move_columns(
    changes: PendingStructuralChanges,
    context: WorksheetStructureContext,
    identities: readonly ColumnIdentity[],
    before: ColumnIdentity | 'end',
): StructureResult {
    const exclusive = exclusivity_refusal(changes, context);
    if (exclusive !== undefined) return exclusive;
    const layout = column_layout_of(changes, context);
    const result = move_layout_columns(layout, identities, before);
    if (!result.ok) return layout_refusal(result.refusal);
    const index = index_column_layout(layout);
    const moved = identities.filter((identity) => index.is_live(identity));
    const merge = merge_move_refusal(
        context,
        'columns',
        moved.flatMap((identity) => identity.kind === 'source' ? [identity.sourceColumn] : []),
        intervals_of_columns(layout.removedSourceColumns),
        index_column_layout(result.layout),
        moved,
        (sourceColumn): ColumnIdentity => ({ kind: 'source', sourceColumn }),
    );
    if (merge !== undefined) return merge;
    const filtered = filtered_column_move_refusal(context, result.layout);
    if (filtered !== undefined) return filtered;
    return finish_structure(changes, context, 'columns', {
        rowLayout: row_layout_of(changes, context),
        columnLayout: result.layout,
        rows: pending_rows(changes),
        columns: changes.pendingColumns ?? [],
    });
}

/**
 * The source cells, among `cell_keys` (`row:column` keys of the worksheet's
 * cell edits), that an outcome's delete removes. The caller discards those
 * edits in the same history action as the delete, as `cell` deltas.
 */
export function source_cells_removed_by(
    outcome: Pick<StructureOutcome, 'removedSourceRows' | 'removedSourceColumns'>,
    cell_keys: Iterable<string>,
): { readonly key: string; readonly sourceRow: number; readonly sourceColumn: number }[] {
    const columns = new Set(outcome.removedSourceColumns);
    if (outcome.removedSourceRows.length === 0 && columns.size === 0) return [];
    const out: { key: string; sourceRow: number; sourceColumn: number }[] = [];
    for (const key of cell_keys) {
        const separator = key.indexOf(':');
        if (separator < 0) continue;
        const sourceRow = Number(key.slice(0, separator));
        const sourceColumn = Number(key.slice(separator + 1));
        if (!Number.isSafeInteger(sourceRow) || !Number.isSafeInteger(sourceColumn)) continue;
        if (columns.has(sourceColumn) || in_intervals(outcome.removedSourceRows, sourceRow)) {
            out.push({ key, sourceRow, sourceColumn });
        }
    }
    return out;
}

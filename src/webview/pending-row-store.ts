/**
 * Session-owned structural overlay for rows that do not exist in the adopted
 * DataSource. Source-cell edits remain in EditSessionStore; keeping this sibling
 * store separate prevents temporary row IDs from leaking into `row:column`
 * source keys.
 */

import {
    advance_pending_append_basis,
    EMPTY_PENDING_STRUCTURAL_CHANGES,
    has_pending_structural_changes,
    MAX_PENDING_APPENDED_ROWS,
    MAX_PENDING_CHANGES_ENCODED_BYTES,
    MAX_PENDING_USER_CHANGES_ENCODED_BYTES,
    own_pending_structural_changes,
    type PendingAppendedRow,
    type PendingAppendBasis,
    type PendingRowCell,
    type PendingRowFormatTemplate,
    type PendingStructuralChanges,
    type PendingTailRemoval,
} from '../pending-changes';
import { MAX_SHEET_COLUMNS } from '../spreadsheet-safety';
import type { EditSessionIdentity } from './edit-session-store';
import type { CellHighlightColor } from '../cell-highlight-colors';
import type { CsvDirtyMap, WorksheetTarget } from '../types';
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
    ): void;
    clear(session_id: string | undefined): void;
    stage_clear(session_id: string | undefined): StagedMutation | undefined;
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
    const appendedRowsBytes = json_array_bytes(changes.appendedRows);
    const properties: Array<readonly [string, unknown]> = [
        ['formatTemplates', changes.formatTemplates],
        ['appendedRows', changes.appendedRows],
        ['tailRemovals', changes.tailRemovals],
        ['conflicts', changes.conflicts],
    ];
    if (changes.appendBasis !== undefined) {
        properties.splice(3, 0, ['appendBasis', changes.appendBasis]);
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
        row_index_by_id = new Map(state.appendedRows.map((row, index) => [row.id, index]));
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
                || state.appendedRows.length + row_ids.length > MAX_PENDING_APPENDED_ROWS
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
                appendedRows: [...state.appendedRows, ...rows],
                ...(next_basis === undefined
                    ? {}
                    : { appendBasis: next_basis }),
            }), RESET_CHANGE);
        },
        set_cell: (session_id, pending_row_id, source_column, cell) => {
            const index = row_index_by_id.get(pending_row_id);
            if (index === undefined || !Number.isSafeInteger(source_column)
                || source_column < 0 || source_column >= MAX_SHEET_COLUMNS) return false;
            const current = state.appendedRows[index];
            const cells = { ...current.cells };
            if (cell === undefined) delete cells[source_column];
            else cells[source_column] = cell;
            const rows = state.appendedRows.slice();
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
            const current = state.appendedRows[index];
            const previous_cell = current.cells[source_column];
            const next_cell = link === null && previous_cell === undefined
                ? undefined
                : { ...(previous_cell ?? { value: '' }), link };
            const cells = { ...current.cells };
            if (next_cell === undefined) delete cells[source_column];
            else cells[source_column] = next_cell;
            const row = { ...current, cells };
            const appendedRows = state.appendedRows.slice();
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
            const rows = state.appendedRows.slice();
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
                before: state.appendedRows[index],
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
            const appendedRows = state.appendedRows.slice();
            const replacements = indexes.map((index) => {
                const before = state.appendedRows[index!];
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
            const appendedRows = state.appendedRows.slice();
            const replacements = indexes.map((index) => {
                const row = state.appendedRows[index!];
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
            const removed = state.appendedRows.filter((row) => pending_row_ids.has(row.id));
            if (removed.length === 0) return [];
            const appendedRows = state.appendedRows.filter((row) => !pending_row_ids.has(row.id));
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
            const appendedRows = [...state.appendedRows, ...rows]
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
        clear_saved: (session_id, pending_row_ids, removed_source_rows) => {
            if (!session_matches(session_id)) return;
            const appendedRows = state.appendedRows.filter(
                (row) => !pending_row_ids.has(row.id),
            );
            const tailRemovals = state.tailRemovals.filter(
                (removal) => !removed_source_rows.has(removal.sourceRow),
            );
            const next = own({
                ...state,
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

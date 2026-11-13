/**
 * Format-neutral pending-change model shared by the webview edit stores, the
 * durable-state codec, and the host save pipeline.
 *
 * A worksheet's unsaved work has two independent dimensions:
 *   - cell VALUE changes — plain text (CSV, and Excel cells without run
 *     formatting) or rich text (Excel cells with runs);
 *   - cell HYPERLINK changes — add/edit/clear of the whole-cell link, which is
 *     relationship metadata, never part of the text.
 *
 * Both are keyed `"<canonical source row>:<source column>"`. Each change
 * carries the `base` it was made against so the webview can tint conflicts and
 * the host can refuse a save whose source moved underneath it.
 *
 * Structural changes (Pending Rows, Pending Tail Removals, and, with ADR 0004,
 * the Worksheet Layout, Pending Columns, and the Structural Basis) live in
 * `PendingStructuralChanges`. `appendedRows` keeps its persisted name but holds
 * every live Pending Row of both origins, so code outside this module and its
 * codecs reads it only through `pending_rows`, `appended_rows`, and
 * `inserted_rows` (a source scan in `pending-changes.test.ts` enforces that).
 */

import { is_plain_record } from './plain-record';
import { is_cell_highlight_color, type CellHighlightColor } from './cell-highlight-colors';
import { MAX_SHEET_COLUMNS, MAX_PENDING_ROW_INDEX } from './spreadsheet-safety';
import type { XlsxNumberFormat } from './spreadsheet-format';
import type {
    ColumnAnchor,
    FormulaAnchors,
    FormulaReferenceAnchor,
    FormulaReferenceAnchorCorner,
    RowAnchor,
} from './formula-anchors';
import {
    canonical_column_layout,
    canonical_row_layout,
    has_live_column_layout_change,
    has_live_row_layout_change,
    is_source_column_layout,
    is_source_row_layout,
    validate_column_layout,
    validate_row_layout,
    type ColumnIdentity,
    type ColumnLayout,
    type PendingColumnId,
    type RowLayout,
    type RowLayoutRun,
} from './worksheet-layout';
import {
    hyperlinks_equal,
    is_matching_rich_text,
    is_valid_rich_text,
    rich_text_equal,
    rich_text_from_plain,
    rich_text_plain_text,
    type CellHyperlink,
    type RichText,
} from './cell-content';

// Structural rich-text validation lives beside the RichText model in
// cell-content.ts (a leaf), so future codecs can validate without importing
// this higher-level module; re-exported because this is where consumers of the
// *pending-change* validators already look.
export { is_matching_rich_text, is_valid_rich_text } from './cell-content';

/** A value as the editor produces it. `plain` carries exact text (CSV and
 *  typed scalars); `richText` carries normalized runs (Excel text cells). */
export type EditableCellValue =
    | { readonly kind: 'plain'; readonly text: string }
    | { readonly kind: 'richText'; readonly value: RichText };

export interface CellValueChange {
    readonly value: EditableCellValue;
    readonly base: EditableCellValue;
}

/** A whole-cell hyperlink change. `null` = no link. */
export interface HyperlinkChange {
    readonly value: CellHyperlink | null;
    readonly base: CellHyperlink | null;
}

/** Opaque edit-session identity for a row that is not in the source yet. */
export type PendingRowId = string;

/** One row identity throughout editing, before any display/physical projection. */
export type RowIdentity =
    | { readonly kind: 'source'; readonly sourceRow: number }
    | { readonly kind: 'pending'; readonly pendingRowId: PendingRowId };

export interface PendingCellMoveIntent {
    readonly sourceRow: number;
    readonly sourceCol: number;
    readonly destinationRow: number;
    readonly destinationCol: number;
    readonly order: number;
    readonly sourceRowIdentity?: RowIdentity;
    readonly destinationRowIdentity?: RowIdentity;
}

export interface PendingCellMoveProvenance {
    readonly row: number;
    readonly col: number;
    readonly order: number;
    readonly rowIdentity?: RowIdentity;
    readonly previous?: readonly PendingCellMoveIntent[];
}

export const MAX_PENDING_APPENDED_ROWS = 10_000;
export const MAX_PENDING_ROW_ID_LENGTH = 128;
export const MAX_PENDING_FORMAT_TEMPLATES = MAX_PENDING_APPENDED_ROWS;
export const MAX_PENDING_FORMULA_REFERENCE_BASES = 256;
/**
 * The SQLite backend is exercised with 4 MiB full-sync Pending Changes writes.
 * Keep one worksheet below twice that measured payload so one hostile snapshot
 * cannot turn the file-state row or a full-map wire publication into an
 * unbounded allocation.
 */
export const MAX_PENDING_CHANGES_ENCODED_BYTES = 8 * 1024 * 1024;
/** Reserved for a bounded, actionable host conflict after a save preflight. */
export const MAX_PENDING_USER_CHANGES_ENCODED_BYTES
    = MAX_PENDING_CHANGES_ENCODED_BYTES - 4 * 1024;

/** Prospective content for one cell in a Pending Appended Row. */
export interface PendingRowCell {
    readonly value: string;
    readonly valueRuns?: RichText;
    readonly link?: CellHyperlink | null;
    readonly valueEditOrder?: number;
    /** Pending append bands this formula meant at the time it was authored. */
    readonly formulaReferenceBases?: readonly PendingFormulaReferenceBasis[];
    /**
     * Row and column identities the formula's references name, stored when it
     * was committed against a live layout change or named a Pending Row or
     * Pending Column. `.xlsx` only; a cell with anchors has no
     * `formulaReferenceBases`.
     */
    readonly formulaAnchors?: FormulaAnchors;
    /** Stable cut origin; numeric rows are the last resolved physical fallback. */
    readonly movedFrom?: PendingCellMoveProvenance;
}

export interface PendingFormulaReferenceBasis {
    readonly targetSheetIndex: number;
    readonly targetSheetName: string;
    readonly targetWorksheetId?: string;
    readonly provisionalStartRow: number;
    readonly provisionalRowCount: number;
}

export function own_pending_formula_reference_bases(
    value: unknown,
): readonly PendingFormulaReferenceBasis[] | undefined {
    if (!Array.isArray(value) || value.length > MAX_PENDING_FORMULA_REFERENCE_BASES) {
        return undefined;
    }
    const owned = value.map((entry): PendingFormulaReferenceBasis | undefined => {
        if (!is_plain_record(entry)
            || !has_only_keys(entry, [
                'targetSheetIndex',
                'targetSheetName',
                'targetWorksheetId',
                'provisionalStartRow',
                'provisionalRowCount',
            ])
            || !Number.isSafeInteger(entry.targetSheetIndex)
            || (entry.targetSheetIndex as number) < 0
            || typeof entry.targetSheetName !== 'string'
            || entry.targetSheetName.length > 32_767
            || (entry.targetWorksheetId !== undefined
                && (typeof entry.targetWorksheetId !== 'string'
                    || entry.targetWorksheetId.length > 32_767))
            || !Number.isSafeInteger(entry.provisionalStartRow)
            || (entry.provisionalStartRow as number) < 0
            || (entry.provisionalStartRow as number) >= MAX_PENDING_ROW_INDEX
            || !Number.isSafeInteger(entry.provisionalRowCount)
            || (entry.provisionalRowCount as number) <= 0
            || (entry.provisionalRowCount as number) > MAX_PENDING_APPENDED_ROWS
        ) return undefined;
        return Object.freeze({
            targetSheetIndex: entry.targetSheetIndex as number,
            targetSheetName: entry.targetSheetName,
            ...(entry.targetWorksheetId === undefined
                ? {}
                : { targetWorksheetId: entry.targetWorksheetId }),
            provisionalStartRow: entry.provisionalStartRow as number,
            provisionalRowCount: entry.provisionalRowCount as number,
        });
    });
    if (owned.some((entry) => entry === undefined)) return undefined;
    return Object.freeze(owned as PendingFormulaReferenceBasis[]);
}

/** Last 1-based row and column a formula reference can name (`.xlsx`). */
const MAX_ANCHOR_ROW = 1_048_576;
const MAX_ANCHOR_COLUMN = 16_384;
/** Each reference spans at least two characters, so a formula holds at most half its length. */
const MAX_FORMULA_ANCHOR_REFERENCES = 4_096;

function is_anchor_number(value: unknown, minimum: number, maximum: number): value is number {
    return Number.isSafeInteger(value) && (value as number) >= minimum && (value as number) <= maximum;
}

function own_anchor_worksheet(value: unknown): FormulaReferenceAnchor['worksheet'] | undefined {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['sheetIndex', 'sheetName', 'worksheetId'])
        || !is_anchor_number(value.sheetIndex, 0, Number.MAX_SAFE_INTEGER)
        || (value.sheetName !== undefined
            && (typeof value.sheetName !== 'string' || value.sheetName.length > 32_767))
        || (value.worksheetId !== undefined
            && (typeof value.worksheetId !== 'string' || value.worksheetId.length > 32_767))
    ) return undefined;
    return Object.freeze({
        sheetIndex: value.sheetIndex,
        ...(value.sheetName === undefined ? {} : { sheetName: value.sheetName as string }),
        ...(value.worksheetId === undefined ? {} : { worksheetId: value.worksheetId as string }),
    });
}

function own_strict_row_identity(value: unknown): RowIdentity | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'source' && has_only_keys(value, ['kind', 'sourceRow'])) {
        return own_row_identity(value);
    }
    if (value.kind === 'pending' && has_only_keys(value, ['kind', 'pendingRowId'])) {
        return own_row_identity(value);
    }
    return undefined;
}

function own_strict_column_identity(value: unknown): ColumnIdentity | undefined {
    if (is_plain_record(value) && value.kind === 'source'
        && has_only_keys(value, ['kind', 'sourceColumn'])
        && is_anchor_number(value.sourceColumn, 0, MAX_ANCHOR_COLUMN - 1)) {
        return Object.freeze({ kind: 'source', sourceColumn: value.sourceColumn });
    }
    if (is_plain_record(value) && value.kind === 'pending'
        && has_only_keys(value, ['kind', 'pendingColumnId']) && is_pending_id(value.pendingColumnId)) {
        return Object.freeze({ kind: 'pending', pendingColumnId: value.pendingColumnId });
    }
    return undefined;
}

function own_row_anchor(value: unknown): RowAnchor | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'identity' && has_only_keys(value, ['kind', 'row'])) {
        const row = own_strict_row_identity(value.row);
        return row === undefined ? undefined : Object.freeze({ kind: 'identity', row });
    }
    if (value.kind === 'fixed' && has_only_keys(value, ['kind', 'row'])
        && is_anchor_number(value.row, 1, MAX_ANCHOR_ROW)) {
        return Object.freeze({ kind: 'fixed', row: value.row });
    }
    if (value.kind === 'trailing' && has_only_keys(value, ['kind', 'offset'])
        && is_anchor_number(value.offset, 1, MAX_ANCHOR_ROW)) {
        return Object.freeze({ kind: 'trailing', offset: value.offset });
    }
    if (value.kind === 'edge' && has_only_keys(value, ['kind'])) return Object.freeze({ kind: 'edge' });
    return undefined;
}

function own_column_anchor(value: unknown): ColumnAnchor | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'identity' && has_only_keys(value, ['kind', 'column'])) {
        const column = own_strict_column_identity(value.column);
        return column === undefined ? undefined : Object.freeze({ kind: 'identity', column });
    }
    if (value.kind === 'trailing' && has_only_keys(value, ['kind', 'offset'])
        && is_anchor_number(value.offset, 1, MAX_ANCHOR_COLUMN)) {
        return Object.freeze({ kind: 'trailing', offset: value.offset });
    }
    if (value.kind === 'edge' && has_only_keys(value, ['kind'])) return Object.freeze({ kind: 'edge' });
    return undefined;
}

function own_anchor_corner(value: unknown): FormulaReferenceAnchorCorner | undefined {
    if (!is_plain_record(value) || !has_only_keys(value, ['row', 'column'])) return undefined;
    if (value.row === undefined && value.column === undefined) return undefined;
    const row = value.row === undefined ? undefined : own_row_anchor(value.row);
    const column = value.column === undefined ? undefined : own_column_anchor(value.column);
    if ((value.row !== undefined && row === undefined) || (value.column !== undefined && column === undefined)) {
        return undefined;
    }
    return Object.freeze({
        ...(row === undefined ? {} : { row }),
        ...(column === undefined ? {} : { column }),
    });
}

/**
 * Own stored Formula Anchors for `text`, strictly, or `undefined` when any
 * part is malformed: spans that lie inside the formula and do not overlap,
 * one corner for a cell or two for a range, every corner naming the same
 * axes, known anchor kinds, valid row and column identities, and a strict
 * worksheet target. Whether each span is a reference the tokenizer reads is
 * checked when the formula renders, which needs the workbook.
 */
export function own_formula_anchors(value: unknown, text: string): FormulaAnchors | undefined {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['references'])
        || !Array.isArray(value.references)
        || value.references.length === 0
        || value.references.length > MAX_FORMULA_ANCHOR_REFERENCES
        || !text.startsWith('=')
    ) return undefined;
    const references: FormulaReferenceAnchor[] = [];
    let previous_end = 1;
    for (const entry of value.references as unknown[]) {
        if (
            !is_plain_record(entry)
            || !has_only_keys(entry, ['start', 'end', 'worksheet', 'corners'])
            || !is_anchor_number(entry.start, previous_end, text.length)
            || !is_anchor_number(entry.end, (entry.start as number) + 1, text.length)
            || !Array.isArray(entry.corners)
            || entry.corners.length < 1
            || entry.corners.length > 2
        ) return undefined;
        const worksheet = entry.worksheet === undefined ? undefined : own_anchor_worksheet(entry.worksheet);
        if (entry.worksheet !== undefined && worksheet === undefined) return undefined;
        const corners = (entry.corners as unknown[]).map(own_anchor_corner);
        if (corners.some((corner) => corner === undefined)) return undefined;
        const shape = (corner: FormulaReferenceAnchorCorner | undefined) =>
            `${corner!.row !== undefined}:${corner!.column !== undefined}`;
        if (corners.some((corner) => shape(corner) !== shape(corners[0]))) return undefined;
        references.push(Object.freeze({
            start: entry.start as number,
            end: entry.end as number,
            ...(worksheet === undefined ? {} : { worksheet }),
            corners: Object.freeze(corners as FormulaReferenceAnchorCorner[]),
        }));
        previous_end = entry.end as number;
    }
    return Object.freeze({ references: Object.freeze(references) });
}

/** CSV/TSV rows have no presentation state to copy. */
export interface PlainPendingRowFormat {
    readonly kind: 'none';
}

/**
 * Exact XLSX presentation dependency captured when append is admitted.
 *
 * Style indexes are meaningful only while `styleFingerprint` still identifies
 * the same style table. The save planner refuses a changed fingerprint rather
 * than attaching an old index to a different style definition.
 */
export interface XlsxPendingRowFormat {
    readonly kind: 'xlsx';
    /** Physical source row the template came from. Null for a header-only body. */
    readonly templateSourceRow: number | null;
    readonly styleFingerprint: string;
    readonly cellStyleIndexes: readonly (number | null)[];
    /** Independently comparable dependency hash for each presentation slot. */
    readonly cellStyleFingerprints?: readonly string[];
    /** Render recipe for responsive pending-cell display; parallel to styles. */
    readonly cellNumberFormats?: readonly (XlsxNumberFormat | null)[];
    readonly cellFontStyles?: readonly {
        readonly bold: boolean;
        readonly italic: boolean;
    }[];
    /** Effective row-level cell style (`s` with `customFormat="1"`). */
    readonly rowStyleIndex?: number;
    /** Display recipe inherited by a newly added blank column. */
    readonly rowNumberFormat?: XlsxNumberFormat | null;
    readonly rowFontStyle?: {
        readonly bold: boolean;
        readonly italic: boolean;
    };
    /** Safe presentation-only CT_Row flags. */
    readonly thickTop?: true;
    readonly thickBottom?: true;
    readonly phonetic?: true;
    readonly nativeRowHeight?: number;
    readonly viewerRowHeight?: number;
}

export type PendingRowFormat = PlainPendingRowFormat | XlsxPendingRowFormat;

/** Interned because a large paste normally gives every row the same format. */
export interface PendingRowFormatTemplate {
    readonly id: string;
    readonly format: PendingRowFormat;
}

/** Which request minted a Pending Row. Absent on a stored row means `append`. */
export type PendingRowOrigin = 'append' | 'insert';

/**
 * One live Pending Row. The persisted name predates inserting: a row of origin
 * `insert` is a Pending Inserted Row, placed by the row layout; every other row
 * is a Pending Appended Row in the append band.
 */
export interface PendingAppendedRow {
    readonly id: PendingRowId;
    /** Absent means `append`; writers omit it for appends. */
    readonly origin?: PendingRowOrigin;
    /** Sparse column-indexed content. Missing = blank with no hyperlink. */
    readonly cells: Readonly<Record<string, PendingRowCell>>;
    readonly formatTemplateId: string;
    readonly createdOrder: number;
    /** User override after admission; inherited height remains in the template. */
    readonly viewerRowHeight?: number;
    /** Sparse source-column highlights owned by the temporary row identity. */
    readonly highlights?: Readonly<Record<string, CellHighlightColor>>;
}

/** Complete saved content needed to validate and restore a cross-save Undo. */
export interface SavedAppendedRowSnapshot {
    readonly cells: Readonly<Record<string, PendingRowCell>>;
    readonly format: PendingRowFormat;
    readonly viewerRowHeight?: number;
    readonly highlights?: Readonly<Record<string, CellHighlightColor>>;
}

/** Undo-only removal of a saved append that still resolves as a safe suffix. */
export interface PendingTailRemoval {
    readonly appendHistoryId: string;
    readonly sourceRow: number;
    readonly savedFingerprint: string;
    readonly savedRow: SavedAppendedRowSnapshot;
}

/**
 * Source facts an admitted append was attached to. A later row-count change may
 * rebase its destination, while a schema or style mismatch requires review.
 */
export interface PendingAppendBasis {
    readonly sourceRowCount: number;
    /** Physical row where this pending band was first projected. */
    readonly provisionalStartRow?: number;
    /** High-water number of provisional coordinates ever occupied by this band. */
    readonly provisionalRowCount?: number;
    readonly columnCount: number;
    readonly schemaFingerprint: string;
    readonly styleFingerprint?: string;
}

/** Accept only the one monotonic evolution an append basis permits. */
export function advance_pending_append_basis(
    current: PendingAppendBasis,
    next: PendingAppendBasis,
): PendingAppendBasis | undefined {
    const { provisionalRowCount: current_count = 0, ...current_fixed } = current;
    const { provisionalRowCount: next_count = 0, ...next_fixed } = next;
    if (
        JSON.stringify(current_fixed) !== JSON.stringify(next_fixed)
        || next_count < current_count
    ) return undefined;
    return next;
}

export type PendingStructuralConflictReason =
    | 'worksheetReplaced'
    | 'rowLimitExceeded'
    | 'templateChanged'
    | 'ambiguousColumns'
    | 'ambiguousPendingFormula'
    | 'savedSuffixChanged'
    /** The file changed under a worksheet's live layout change. */
    | 'structuralBasisChanged'
    /** An `.xlsx` worksheet gained a structure the structural writer cannot shift. */
    | 'unsupportedStructure';

/** Every conflict reason, for the strict codecs. */
export const PENDING_STRUCTURAL_CONFLICT_REASONS: ReadonlySet<PendingStructuralConflictReason> =
    new Set<PendingStructuralConflictReason>([
        'worksheetReplaced',
        'rowLimitExceeded',
        'templateChanged',
        'ambiguousColumns',
        'ambiguousPendingFormula',
        'savedSuffixChanged',
        'structuralBasisChanged',
        'unsupportedStructure',
    ]);

/**
 * Release gate for inserting, deleting, and moving rows and columns. While it
 * is false the host refuses any publication or save that carries layout
 * fields (`pending_changes_carry_layout`), so an intermediate release never
 * accepts layout data it cannot write. Tests turn it on per controller through
 * `ViewerControllerOptions.structuralEditingEnabled`.
 */
export const STRUCTURAL_EDITING_ENABLED = false;

/** `.xlsx` column formatting a Pending Column copies, fixed when it is inserted. */
export type PendingColumnFormat =
    | { readonly kind: 'none' }
    | { readonly kind: 'source'; readonly sourceColumn: number }
    | { readonly kind: 'default' };

/** A column held in an editing session that is not yet part of the workbook on disk. */
export interface PendingColumn {
    readonly id: PendingColumnId;
    /** Header cell value, used when the worksheet has an active Header Row. */
    readonly header: string;
    /**
     * Cells in this column, keyed by row identity key: `s:<sourceRow>`,
     * `p:<pendingRowId>`, or `f:<row>` for a fixed row at or above the Header Row.
     */
    readonly cells: Readonly<Record<string, PendingRowCell>>;
    readonly highlights?: Readonly<Record<string, CellHighlightColor>>;
    readonly viewerWidth?: number;
    readonly format: PendingColumnFormat;
    readonly createdOrder: number;
}

/** At most this many Pending Column admissions per worksheet per session. */
export const MAX_PENDING_COLUMNS = MAX_SHEET_COLUMNS;

const MAX_STRUCTURAL_DIGEST_LENGTH = 256;
const MAX_PENDING_COLUMN_HEADER_LENGTH = 32_767;

/**
 * The file content a worksheet's layout changes were authored against.
 * `sourceRowCount` is the worksheet's canonical source row count, the same
 * number as `SheetMeta.sourceRowCount`, so the body is
 * `[bodyStart, sourceRowCount)`.
 */
export type StructuralBasis =
    | {
        readonly kind: 'delimited';
        readonly byteLength: number;
        readonly digest: string;
        readonly sourceRowCount: number;
        readonly sourceColumnCount: number;
    }
    | {
        readonly kind: 'xlsx';
        readonly worksheetPartDigest: string;
        readonly sharedStringsDigest: string | null;
        readonly stylesDigest: string | null;
        readonly workbookDigest: string;
        readonly sourceRowCount: number;
        readonly sourceColumnCount: number;
    };

/** Durable refusal state: a reload must not hide why Save is still closed. */
export interface PendingStructuralConflict {
    readonly reason: PendingStructuralConflictReason;
    readonly pendingRowIds: readonly PendingRowId[];
    readonly tailRemovalIds: readonly string[];
    /** Exact edited formula cells responsible for a provisional-row conflict. */
    readonly formulaCells?: readonly {
        readonly rowIdentity: RowIdentity;
        readonly sourceColumn: number;
    }[];
}

export interface PendingStructuralChanges {
    readonly formatTemplates: readonly PendingRowFormatTemplate[];
    /** Every live Pending Row, both origins. Read through the accessors below. */
    readonly appendedRows: readonly PendingAppendedRow[];
    readonly tailRemovals: readonly PendingTailRemoval[];
    readonly appendBasis?: PendingAppendBasis;
    readonly conflicts: readonly PendingStructuralConflict[];
    /** Absent means the source layout. */
    readonly rowLayout?: RowLayout;
    /** Absent means the source layout. */
    readonly columnLayout?: ColumnLayout;
    /** Absent means none. Writers omit an empty list. */
    readonly pendingColumns?: readonly PendingColumn[];
    readonly structuralBasis?: StructuralBasis;
}

export const EMPTY_PENDING_STRUCTURAL_CHANGES: PendingStructuralChanges = Object.freeze({
    formatTemplates: Object.freeze([]),
    appendedRows: Object.freeze([]),
    tailRemovals: Object.freeze([]),
    conflicts: Object.freeze([]),
});

// --- Pending Row accessors ---------------------------------------------------
//
// `appendedRows` holds both origins. Every consumer outside this module and
// its codecs says which rows it means. Both filtered accessors return the
// stored array itself when it holds no inserted row, and otherwise a filtered
// array, so identity-based memoization behaves as it did before inserting
// existed. The split is cached per stored array: render paths call these once
// per row, so a scan per call would be quadratic. Stored arrays are replaced,
// not mutated, on change; the length check is a cheap guard against a caller
// that grew one in place.

type PendingRowsHolder = { readonly appendedRows?: readonly PendingAppendedRow[] } | undefined;

const EMPTY_PENDING_ROWS: readonly PendingAppendedRow[] = Object.freeze([]);
const pending_row_split_cache = new WeakMap<readonly PendingAppendedRow[], {
    readonly length: number;
    readonly appended: readonly PendingAppendedRow[];
    readonly inserted: readonly PendingAppendedRow[];
}>();

function split_pending_rows(rows: readonly PendingAppendedRow[]) {
    const cached = pending_row_split_cache.get(rows);
    if (cached !== undefined && cached.length === rows.length) return cached;
    const split = rows.some(is_inserted_row)
        ? {
            length: rows.length,
            appended: Object.freeze(rows.filter((row) => !is_inserted_row(row))),
            inserted: Object.freeze(rows.filter(is_inserted_row)),
        }
        : { length: rows.length, appended: rows, inserted: EMPTY_PENDING_ROWS };
    pending_row_split_cache.set(rows, split);
    return split;
}

/** Every live Pending Row, both origins, in stored order. */
export function pending_rows(changes: PendingRowsHolder): readonly PendingAppendedRow[] {
    return changes?.appendedRows ?? EMPTY_PENDING_ROWS;
}

/** Whether a stored row is a Pending Inserted Row. */
export function is_inserted_row(row: Pick<PendingAppendedRow, 'origin'>): boolean {
    return row.origin === 'insert';
}

/** The append band: live Pending Appended Rows in `createdOrder`. */
export function appended_rows(changes: PendingRowsHolder): readonly PendingAppendedRow[] {
    const rows = pending_rows(changes);
    return rows.length === 0 ? rows : split_pending_rows(rows).appended;
}

/** Live Pending Inserted Rows, in stored order (the row layout places them). */
export function inserted_rows(changes: PendingRowsHolder): readonly PendingAppendedRow[] {
    const rows = pending_rows(changes);
    return rows.length === 0 ? EMPTY_PENDING_ROWS : split_pending_rows(rows).inserted;
}

/** The layout fields a release without structural editing must refuse. */
export type PendingLayoutFields = Pick<
    PendingStructuralChanges,
    'rowLayout' | 'columnLayout' | 'pendingColumns' | 'structuralBasis'
> & { readonly appendedRows?: readonly PendingAppendedRow[] };

/** Just the layout fields that are present, for spreading into a rebuilt slot. */
export function pending_layout_fields(
    changes: PendingLayoutFields | undefined,
): Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout' | 'pendingColumns' | 'structuralBasis'> {
    return {
        ...(changes?.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
        ...(changes?.columnLayout === undefined ? {} : { columnLayout: changes.columnLayout }),
        ...(changes?.pendingColumns === undefined ? {} : { pendingColumns: changes.pendingColumns }),
        ...(changes?.structuralBasis === undefined ? {} : { structuralBasis: changes.structuralBasis }),
    };
}

/**
 * Whether changes carry any layout field: a row or column layout, a Pending
 * Column, a Structural Basis, or a Pending Row of origin `insert`.
 */
export function pending_changes_carry_layout(changes: PendingLayoutFields | undefined): boolean {
    return changes !== undefined && (
        changes.rowLayout !== undefined
        || changes.columnLayout !== undefined
        || (changes.pendingColumns?.length ?? 0) > 0
        || changes.structuralBasis !== undefined
        || inserted_rows(changes).length > 0
    );
}

export function plain_value(text: string): EditableCellValue {
    return { kind: 'plain', text };
}

export function rich_value(value: RichText): EditableCellValue {
    return { kind: 'richText', value };
}

/** The plain text a value renders/saves as. */
export function editable_value_text(value: EditableCellValue): string {
    return value.kind === 'plain' ? value.text : rich_text_plain_text(value.value);
}

/**
 * Semantic equality. A plain value and a rich value with the same text are
 * equal only when the rich side carries no styles — a formatting-only edit is
 * a real change.
 */
export function editable_values_equal(
    left: EditableCellValue,
    right: EditableCellValue,
): boolean {
    if (left.kind === 'plain' && right.kind === 'plain') return left.text === right.text;
    if (left.kind === 'richText' && right.kind === 'richText') {
        return rich_text_equal(left.value, right.value);
    }
    const plain = left.kind === 'plain' ? left : (right as Extract<EditableCellValue, { kind: 'plain' }>);
    const rich = left.kind === 'richText' ? left : (right as Extract<EditableCellValue, { kind: 'richText' }>);
    return rich_text_equal(rich.value, rich_text_from_plain(plain.text));
}

export function hyperlink_changes_equal(
    left: HyperlinkChange,
    right: HyperlinkChange,
): boolean {
    return hyperlinks_equal(left.value, right.value) && hyperlinks_equal(left.base, right.base);
}

// --- Validation (durable state and wire payloads are untrusted) ---

export const MAX_HYPERLINK_LENGTH = 8 * 1024;

export function is_valid_editable_value(value: unknown): value is EditableCellValue {
    if (!is_plain_record(value)) return false;
    if (value.kind === 'plain') return typeof value.text === 'string';
    if (value.kind === 'richText') return is_valid_rich_text(value.value);
    return false;
}

export function is_valid_hyperlink(value: unknown): value is CellHyperlink {
    if (!is_plain_record(value)) return false;
    if (value.tooltip !== undefined
        && (typeof value.tooltip !== 'string' || value.tooltip.length > MAX_HYPERLINK_LENGTH)) {
        return false;
    }
    if (value.kind === 'external') {
        return typeof value.target === 'string'
            && value.target.length > 0
            && value.target.length <= MAX_HYPERLINK_LENGTH;
    }
    if (value.kind === 'internal') {
        return typeof value.location === 'string'
            && value.location.length > 0
            && value.location.length <= MAX_HYPERLINK_LENGTH;
    }
    return false;
}

export function is_valid_hyperlink_change(value: unknown): value is HyperlinkChange {
    if (!is_plain_record(value)) return false;
    const ok = (side: unknown): boolean => side === null || is_valid_hyperlink(side);
    return ok(value.value) && ok(value.base);
}

function pending_row_error(message: string): never {
    throw new TypeError(`Pending structural changes ${message}`);
}

function is_pending_id(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_PENDING_ROW_ID_LENGTH;
}

function own_row_identity(value: unknown): RowIdentity | undefined {
    if (!is_plain_record(value)) return undefined;
    if (value.kind === 'source'
        && Number.isSafeInteger(value.sourceRow)
        && (value.sourceRow as number) >= 0
        && (value.sourceRow as number) < MAX_PENDING_ROW_INDEX) {
        return Object.freeze({ kind: 'source', sourceRow: value.sourceRow as number });
    }
    if (value.kind === 'pending' && is_pending_id(value.pendingRowId)) {
        return Object.freeze({ kind: 'pending', pendingRowId: value.pendingRowId });
    }
    return undefined;
}

function own_pending_move(value: unknown): PendingCellMoveProvenance | undefined {
    if (!is_plain_record(value)) return undefined;
    const integer = (entry: unknown, max: number): entry is number =>
        Number.isSafeInteger(entry) && (entry as number) >= 0 && (entry as number) < max;
    if (!integer(value.row, MAX_PENDING_ROW_INDEX)
        || !integer(value.col, MAX_SHEET_COLUMNS)
        || !Number.isSafeInteger(value.order) || (value.order as number) < 0
        || (value.rowIdentity !== undefined && own_row_identity(value.rowIdentity) === undefined)
        || (value.previous !== undefined && (!Array.isArray(value.previous)
            || value.previous.length > MAX_PENDING_APPENDED_ROWS))) return undefined;
    const previous = (value.previous ?? []).map((entry): PendingCellMoveIntent | undefined => {
        if (!is_plain_record(entry)
            || !integer(entry.sourceRow, MAX_PENDING_ROW_INDEX)
            || !integer(entry.sourceCol, MAX_SHEET_COLUMNS)
            || !integer(entry.destinationRow, MAX_PENDING_ROW_INDEX)
            || !integer(entry.destinationCol, MAX_SHEET_COLUMNS)
            || !Number.isSafeInteger(entry.order) || (entry.order as number) < 0
            || (entry.sourceRowIdentity !== undefined
                && own_row_identity(entry.sourceRowIdentity) === undefined)
            || (entry.destinationRowIdentity !== undefined
                && own_row_identity(entry.destinationRowIdentity) === undefined)) return undefined;
        return Object.freeze({
            sourceRow: entry.sourceRow as number,
            sourceCol: entry.sourceCol as number,
            destinationRow: entry.destinationRow as number,
            destinationCol: entry.destinationCol as number,
            order: entry.order as number,
            ...(entry.sourceRowIdentity === undefined ? {} : {
                sourceRowIdentity: own_row_identity(entry.sourceRowIdentity)!,
            }),
            ...(entry.destinationRowIdentity === undefined ? {} : {
                destinationRowIdentity: own_row_identity(entry.destinationRowIdentity)!,
            }),
        });
    });
    if (previous.some((entry) => entry === undefined)) return undefined;
    return Object.freeze({
        row: value.row as number,
        col: value.col as number,
        order: value.order as number,
        ...(value.rowIdentity === undefined ? {} : {
            rowIdentity: own_row_identity(value.rowIdentity)!,
        }),
        ...(previous.length === 0 ? {} : {
            previous: Object.freeze(previous as PendingCellMoveIntent[]),
        }),
    });
}

function has_only_keys(value: Record<string, unknown>, allowed: readonly string[]): boolean {
    const allowed_keys = new Set(allowed);
    return Object.keys(value).every((key) => allowed_keys.has(key));
}

function own_pending_row_cell(value: unknown): PendingRowCell {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, [
            'value',
            'valueRuns',
            'link',
            'valueEditOrder',
            'formulaReferenceBases',
            'formulaAnchors',
            'movedFrom',
        ])
        || typeof value.value !== 'string'
    ) {
        pending_row_error('contain an invalid cell');
    }
    if (value.valueRuns !== undefined && !is_matching_rich_text(value.valueRuns, value.value)) {
        pending_row_error('contain rich text that does not match its cell value');
    }
    if (value.link !== undefined && value.link !== null && !is_valid_hyperlink(value.link)) {
        pending_row_error('contain an invalid hyperlink');
    }
    if (value.valueEditOrder !== undefined && !(
        Number.isSafeInteger(value.valueEditOrder) && (value.valueEditOrder as number) >= 0
    )) pending_row_error('contain an invalid edit order');
    const formulaReferenceBases = value.formulaReferenceBases === undefined
        ? undefined
        : own_pending_formula_reference_bases(value.formulaReferenceBases);
    if (value.formulaReferenceBases !== undefined && formulaReferenceBases === undefined) {
        pending_row_error('contain invalid formula reference bases');
    }
    const formulaAnchors = value.formulaAnchors === undefined
        ? undefined
        : own_formula_anchors(value.formulaAnchors, value.value);
    if (value.formulaAnchors !== undefined && formulaAnchors === undefined) {
        pending_row_error('contain invalid formula anchors');
    }
    if (formulaAnchors !== undefined && formulaReferenceBases !== undefined) {
        pending_row_error('contain a formula with both anchors and reference bases');
    }
    const movedFrom = value.movedFrom === undefined
        ? undefined
        : own_pending_move(value.movedFrom);
    if (value.movedFrom !== undefined && movedFrom === undefined) {
        pending_row_error('contain invalid cut provenance');
    }
    return Object.freeze({
        value: value.value,
        ...(value.valueRuns !== undefined ? { valueRuns: structuredClone(value.valueRuns) } : {}),
        ...(value.link !== undefined ? { link: structuredClone(value.link) } : {}),
        ...(value.valueEditOrder !== undefined
            ? { valueEditOrder: value.valueEditOrder as number }
            : {}),
        ...(formulaReferenceBases === undefined ? {} : { formulaReferenceBases }),
        ...(formulaAnchors === undefined ? {} : { formulaAnchors }),
        ...(movedFrom === undefined ? {} : { movedFrom }),
    });
}

function own_pending_row_format(value: unknown): PendingRowFormat {
    if (!is_plain_record(value)) pending_row_error('contain an invalid format template');
    if (value.kind === 'none' && has_only_keys(value, ['kind'])) {
        return Object.freeze({ kind: 'none' });
    }
    if (
        value.kind !== 'xlsx'
        || !has_only_keys(value, [
            'kind',
            'templateSourceRow',
            'styleFingerprint',
            'cellStyleIndexes',
            'cellStyleFingerprints',
            'cellNumberFormats',
            'cellFontStyles',
            'rowStyleIndex',
            'rowNumberFormat',
            'rowFontStyle',
            'thickTop',
            'thickBottom',
            'phonetic',
            'nativeRowHeight',
            'viewerRowHeight',
        ])
        || !(value.templateSourceRow === null
            || (Number.isSafeInteger(value.templateSourceRow)
                && (value.templateSourceRow as number) >= 0))
        || typeof value.styleFingerprint !== 'string'
        || value.styleFingerprint.length === 0
        || value.styleFingerprint.length > 256
        || !Array.isArray(value.cellStyleIndexes)
        || value.cellStyleIndexes.length > MAX_SHEET_COLUMNS
        || value.cellStyleIndexes.some((entry) => entry !== null && !(
            Number.isSafeInteger(entry) && (entry as number) >= 0
        ))
    ) pending_row_error('contain an invalid XLSX format template');
    if (
        value.cellStyleFingerprints !== undefined
        && (!Array.isArray(value.cellStyleFingerprints)
            || value.cellStyleFingerprints.length !== value.cellStyleIndexes.length
            || value.cellStyleFingerprints.some((entry) =>
                typeof entry !== 'string' || entry.length === 0 || entry.length > 256))
    ) pending_row_error('contain invalid XLSX cell-style fingerprints');
    if (
        value.cellNumberFormats !== undefined
        && (!Array.isArray(value.cellNumberFormats)
            || value.cellNumberFormats.length !== value.cellStyleIndexes.length
            || value.cellNumberFormats.some((entry) => entry !== null && (
                !is_plain_record(entry)
                || !has_only_keys(entry, ['code', 'date1904'])
                || typeof entry.code !== 'string'
                || entry.code.length === 0
                || entry.code.length > 32_767
                || (entry.date1904 !== undefined && entry.date1904 !== true)
            )))
    ) pending_row_error('contain invalid XLSX number-format recipes');
    if (
        value.cellFontStyles !== undefined
        && (!Array.isArray(value.cellFontStyles)
            || value.cellFontStyles.length !== value.cellStyleIndexes.length
            || value.cellFontStyles.some((entry) =>
                !is_plain_record(entry)
                || !has_only_keys(entry, ['bold', 'italic'])
                || typeof entry.bold !== 'boolean'
                || typeof entry.italic !== 'boolean'))
    ) pending_row_error('contain invalid XLSX font-style recipes');
    if (value.rowStyleIndex !== undefined && !(
        Number.isSafeInteger(value.rowStyleIndex) && (value.rowStyleIndex as number) >= 0
    )) pending_row_error('contain an invalid XLSX row style');
    if (value.rowNumberFormat !== undefined && value.rowNumberFormat !== null && (
        !is_plain_record(value.rowNumberFormat)
        || !has_only_keys(value.rowNumberFormat, ['code', 'date1904'])
        || typeof value.rowNumberFormat.code !== 'string'
        || value.rowNumberFormat.code.length === 0
        || value.rowNumberFormat.code.length > 32_767
        || (value.rowNumberFormat.date1904 !== undefined
            && value.rowNumberFormat.date1904 !== true)
    )) pending_row_error('contain an invalid XLSX row number-format recipe');
    if (value.rowFontStyle !== undefined && (
        !is_plain_record(value.rowFontStyle)
        || !has_only_keys(value.rowFontStyle, ['bold', 'italic'])
        || typeof value.rowFontStyle.bold !== 'boolean'
        || typeof value.rowFontStyle.italic !== 'boolean'
    )) pending_row_error('contain an invalid XLSX row font-style recipe');
    for (const flag of [value.thickTop, value.thickBottom, value.phonetic]) {
        if (flag !== undefined && flag !== true) {
            pending_row_error('contain an invalid XLSX row-format flag');
        }
    }
    for (const height of [value.nativeRowHeight, value.viewerRowHeight]) {
        if (height !== undefined && !(
            typeof height === 'number' && Number.isFinite(height) && height > 0
        )) pending_row_error('contain an invalid row height');
    }
    return Object.freeze({
        kind: 'xlsx',
        templateSourceRow: value.templateSourceRow as number | null,
        styleFingerprint: value.styleFingerprint,
        cellStyleIndexes: Object.freeze([...(value.cellStyleIndexes as (number | null)[])]),
        ...(value.cellStyleFingerprints === undefined ? {} : {
            cellStyleFingerprints: Object.freeze([...(value.cellStyleFingerprints as string[])]),
        }),
        ...(value.cellNumberFormats === undefined ? {} : {
            cellNumberFormats: Object.freeze((value.cellNumberFormats as Array<
                XlsxNumberFormat | null
            >).map((entry) => entry === null ? null : Object.freeze({ ...entry }))),
        }),
        ...(value.cellFontStyles === undefined ? {} : {
            cellFontStyles: Object.freeze((value.cellFontStyles as Array<{
                bold: boolean;
                italic: boolean;
            }>).map((entry) => Object.freeze({
                bold: entry.bold,
                italic: entry.italic,
            }))),
        }),
        ...(value.rowStyleIndex === undefined
            ? {}
            : { rowStyleIndex: value.rowStyleIndex as number }),
        ...(value.rowNumberFormat === undefined ? {} : {
            rowNumberFormat: value.rowNumberFormat === null
                ? null
                : Object.freeze({
                    code: value.rowNumberFormat.code as string,
                    ...(value.rowNumberFormat.date1904 === true
                        ? { date1904: true as const }
                        : {}),
                }),
        }),
        ...(value.rowFontStyle === undefined ? {} : {
            rowFontStyle: Object.freeze({
                bold: (value.rowFontStyle as { bold: boolean }).bold,
                italic: (value.rowFontStyle as { italic: boolean }).italic,
            }),
        }),
        ...(value.thickTop === true ? { thickTop: true as const } : {}),
        ...(value.thickBottom === true ? { thickBottom: true as const } : {}),
        ...(value.phonetic === true ? { phonetic: true as const } : {}),
        ...(value.nativeRowHeight !== undefined
            ? { nativeRowHeight: value.nativeRowHeight as number }
            : {}),
        ...(value.viewerRowHeight !== undefined
            ? { viewerRowHeight: value.viewerRowHeight as number }
            : {}),
    });
}

/** Own one template without requiring it to be attached to a live pending row. */
export function own_pending_row_format_template(value: unknown): PendingRowFormatTemplate {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['id', 'format'])
        || !is_pending_id(value.id)
    ) pending_row_error('contain an invalid format-template identity');
    return Object.freeze({ id: value.id, format: own_pending_row_format(value.format) });
}

function own_pending_cells(value: unknown): Readonly<Record<string, PendingRowCell>> {
    if (!is_plain_record(value)) pending_row_error('contain an invalid appended-cell map');
    const cells: Record<string, PendingRowCell> = Object.create(null);
    for (const [column, cell] of Object.entries(value)) {
        if (!/^(0|[1-9]\d*)$/.test(column) || Number(column) >= MAX_SHEET_COLUMNS) {
            pending_row_error('contain an out-of-range appended cell');
        }
        cells[column] = own_pending_row_cell(cell);
    }
    return Object.freeze(cells);
}

function own_pending_highlights(
    value: unknown,
): Readonly<Record<string, CellHighlightColor>> | undefined {
    if (value === undefined) return undefined;
    if (!is_plain_record(value)) pending_row_error('contain invalid appended-row highlights');
    const highlights: Record<string, CellHighlightColor> = Object.create(null);
    for (const [column, color] of Object.entries(value)) {
        if (
            !/^(0|[1-9]\d*)$/.test(column)
            || Number(column) >= MAX_SHEET_COLUMNS
            || !is_cell_highlight_color(color)
        ) pending_row_error('contain invalid appended-row highlights');
        highlights[column] = color;
    }
    return Object.freeze(highlights);
}

function own_saved_appended_row(value: unknown): SavedAppendedRowSnapshot {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['cells', 'format', 'viewerRowHeight', 'highlights'])
    ) pending_row_error('contain an invalid saved-row snapshot');
    if (value.viewerRowHeight !== undefined && !(
        typeof value.viewerRowHeight === 'number'
        && Number.isFinite(value.viewerRowHeight)
        && value.viewerRowHeight > 0
    )) pending_row_error('contain an invalid saved-row height');
    const highlights = own_pending_highlights(value.highlights);
    return Object.freeze({
        cells: own_pending_cells(value.cells),
        format: own_pending_row_format(value.format),
        ...(value.viewerRowHeight !== undefined
            ? { viewerRowHeight: value.viewerRowHeight as number }
            : {}),
        ...(highlights !== undefined && Object.keys(highlights).length > 0
            ? { highlights }
            : {}),
    });
}

/**
 * Whether valid changes hold a live layout change: a live Pending Inserted Row
 * or Pending Column, a removal, or a moved run. Discarded tombstones alone are
 * not one.
 */
export function has_live_layout_change(
    changes: Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout'>,
): boolean {
    return (changes.rowLayout !== undefined && has_live_row_layout_change(changes.rowLayout))
        || (changes.columnLayout !== undefined && has_live_column_layout_change(changes.columnLayout));
}

/** Own a saved appended-row snapshot (a cross-save Undo payload or a receipt entry). */
export function own_saved_appended_row_snapshot(value: unknown): SavedAppendedRowSnapshot {
    return own_saved_appended_row(value);
}

/** Own a sparse column-keyed Pending Row cell map. */
export function own_pending_row_cells(value: unknown): Readonly<Record<string, PendingRowCell>> {
    return own_pending_cells(value);
}

// --- Layout, Pending Column, and Structural Basis ownership --------------------

const WHOLE_NUMBER_KEY = /^(0|[1-9]\d*)$/;

function is_whole_number(value: unknown, maximum = MAX_PENDING_ROW_INDEX): value is number {
    return Number.isSafeInteger(value) && (value as number) >= 0 && (value as number) <= maximum;
}

/** Strict shape, then canonical form. Invariants needing the source come later. */
export function own_row_layout(value: unknown): RowLayout {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['runs', 'removedSourceRows', 'discardedPendingRows'])
        || !Array.isArray(value.runs)
        || !Array.isArray(value.removedSourceRows)
        || !Array.isArray(value.discardedPendingRows)
    ) pending_row_error('contain an invalid row layout');
    const runs = value.runs.map((run): RowLayoutRun => {
        if (is_plain_record(run) && run.kind === 'source' && has_only_keys(run, ['kind', 'start', 'count'])
            && is_whole_number(run.start) && is_whole_number(run.count)) {
            return { kind: 'source', start: run.start, count: run.count };
        }
        if (is_plain_record(run) && run.kind === 'pending' && has_only_keys(run, ['kind', 'ids'])
            && Array.isArray(run.ids) && run.ids.length <= MAX_PENDING_APPENDED_ROWS
            && run.ids.every(is_pending_id)) {
            return { kind: 'pending', ids: [...(run.ids as string[])] };
        }
        return pending_row_error('contain an invalid row layout run');
    });
    const removedSourceRows = value.removedSourceRows.map((interval) => {
        if (!is_plain_record(interval) || !has_only_keys(interval, ['start', 'count'])
            || !is_whole_number(interval.start) || !is_whole_number(interval.count)) {
            pending_row_error('contain an invalid removed-row interval');
        }
        return { start: interval.start as number, count: interval.count as number };
    });
    const discardedPendingRows = value.discardedPendingRows.map((row) => {
        if (!is_plain_record(row) || !has_only_keys(row, ['id', 'createdOrder'])
            || !is_pending_id(row.id) || !is_whole_number(row.createdOrder)) {
            pending_row_error('contain an invalid discarded pending row');
        }
        return { id: row.id as string, createdOrder: row.createdOrder as number };
    });
    const layout: RowLayout = { runs, removedSourceRows, discardedPendingRows };
    const canonical = canonical_row_layout(layout);
    if (JSON.stringify(canonical) !== JSON.stringify(layout)) {
        pending_row_error('contain a row layout that is not in canonical form');
    }
    return canonical;
}

function own_column_identity(value: unknown): ColumnIdentity {
    if (is_plain_record(value) && value.kind === 'source'
        && has_only_keys(value, ['kind', 'sourceColumn']) && is_whole_number(value.sourceColumn)) {
        return { kind: 'source', sourceColumn: value.sourceColumn };
    }
    if (is_plain_record(value) && value.kind === 'pending'
        && has_only_keys(value, ['kind', 'pendingColumnId']) && is_pending_id(value.pendingColumnId)) {
        return { kind: 'pending', pendingColumnId: value.pendingColumnId };
    }
    return pending_row_error('contain an invalid column layout entry');
}

export function own_column_layout(value: unknown): ColumnLayout {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, ['columns', 'removedSourceColumns', 'discardedPendingColumns'])
        || !Array.isArray(value.columns)
        || !Array.isArray(value.removedSourceColumns)
        || !Array.isArray(value.discardedPendingColumns)
        // Bounded before cloning; the validator applies the exact limits.
        || value.columns.length > 1_000_000
        || value.discardedPendingColumns.length > MAX_PENDING_COLUMNS
    ) pending_row_error('contain an invalid column layout');
    const columns = value.columns.map(own_column_identity);
    const removedSourceColumns = value.removedSourceColumns.map((column) => {
        if (!is_whole_number(column)) pending_row_error('contain an invalid removed column');
        return column as number;
    });
    const discardedPendingColumns = value.discardedPendingColumns.map((column) => {
        if (!is_plain_record(column) || !has_only_keys(column, ['id', 'createdOrder'])
            || !is_pending_id(column.id) || !is_whole_number(column.createdOrder)) {
            pending_row_error('contain an invalid discarded pending column');
        }
        return { id: column.id as string, createdOrder: column.createdOrder as number };
    });
    const layout: ColumnLayout = { columns, removedSourceColumns, discardedPendingColumns };
    const canonical = canonical_column_layout(layout);
    if (JSON.stringify(canonical) !== JSON.stringify(layout)) {
        pending_row_error('contain a column layout that is not in canonical form');
    }
    return canonical;
}

/** `s:<sourceRow>`, `p:<pendingRowId>`, or `f:<row>`. */
function parse_row_identity_key(
    key: string,
): { readonly kind: 's' | 'f'; readonly row: number } | { readonly kind: 'p'; readonly id: string } | undefined {
    const prefix = key.slice(0, 2);
    const rest = key.slice(2);
    if (prefix === 'p:') return is_pending_id(rest) ? { kind: 'p', id: rest } : undefined;
    if ((prefix === 's:' || prefix === 'f:') && WHOLE_NUMBER_KEY.test(rest)) {
        const row = Number(rest);
        return Number.isSafeInteger(row) ? { kind: prefix[0] as 's' | 'f', row } : undefined;
    }
    return undefined;
}

function own_pending_column_format(value: unknown): PendingColumnFormat {
    if (is_plain_record(value) && (value.kind === 'none' || value.kind === 'default')
        && has_only_keys(value, ['kind'])) {
        return Object.freeze({ kind: value.kind });
    }
    if (is_plain_record(value) && value.kind === 'source'
        && has_only_keys(value, ['kind', 'sourceColumn']) && is_whole_number(value.sourceColumn)) {
        return Object.freeze({ kind: 'source', sourceColumn: value.sourceColumn });
    }
    return pending_row_error('contain an invalid pending column format');
}

/** Own one Pending Column, strictly; throws on any malformed field. */
export function own_pending_column(value: unknown): PendingColumn {
    if (
        !is_plain_record(value)
        || !has_only_keys(value, [
            'id',
            'header',
            'cells',
            'highlights',
            'viewerWidth',
            'format',
            'createdOrder',
        ])
        || !is_pending_id(value.id)
        || typeof value.header !== 'string'
        || value.header.length > MAX_PENDING_COLUMN_HEADER_LENGTH
        || !is_plain_record(value.cells)
        || !is_whole_number(value.createdOrder)
        || (value.viewerWidth !== undefined && !(
            typeof value.viewerWidth === 'number'
            && Number.isFinite(value.viewerWidth)
            && value.viewerWidth > 0
        ))
        || (value.highlights !== undefined && !is_plain_record(value.highlights))
    ) pending_row_error('contain an invalid pending column');
    const cells: Record<string, PendingRowCell> = Object.create(null);
    for (const [key, cell] of Object.entries(value.cells as Record<string, unknown>)) {
        if (parse_row_identity_key(key) === undefined) {
            pending_row_error('contain a pending column cell with an invalid row key');
        }
        cells[key] = own_pending_row_cell(cell);
    }
    const highlights: Record<string, CellHighlightColor> = Object.create(null);
    for (const [key, color] of Object.entries((value.highlights ?? {}) as Record<string, unknown>)) {
        if (parse_row_identity_key(key) === undefined || !is_cell_highlight_color(color)) {
            pending_row_error('contain invalid pending column highlights');
        }
        highlights[key] = color;
    }
    return Object.freeze({
        id: value.id,
        header: value.header,
        cells: Object.freeze(cells),
        ...(Object.keys(highlights).length > 0 ? { highlights: Object.freeze(highlights) } : {}),
        ...(value.viewerWidth !== undefined ? { viewerWidth: value.viewerWidth as number } : {}),
        format: own_pending_column_format(value.format),
        createdOrder: value.createdOrder as number,
    });
}

function is_structural_digest(value: unknown): value is string {
    return typeof value === 'string'
        && value.length > 0
        && value.length <= MAX_STRUCTURAL_DIGEST_LENGTH;
}

/** Own one Structural Basis, strictly; throws on any malformed field. */
export function own_structural_basis(value: unknown): StructuralBasis {
    if (!is_plain_record(value)
        || !is_whole_number(value.sourceRowCount)
        || !is_whole_number(value.sourceColumnCount)) {
        pending_row_error('contain an invalid structural basis');
    }
    const counts = {
        sourceRowCount: value.sourceRowCount as number,
        sourceColumnCount: value.sourceColumnCount as number,
    };
    if (
        value.kind === 'delimited'
        && has_only_keys(value, ['kind', 'byteLength', 'digest', 'sourceRowCount', 'sourceColumnCount'])
        && is_whole_number(value.byteLength)
        && is_structural_digest(value.digest)
    ) {
        return Object.freeze({
            kind: 'delimited',
            byteLength: value.byteLength,
            digest: value.digest,
            ...counts,
        });
    }
    const nullable_digest = (entry: unknown): entry is string | null =>
        entry === null || is_structural_digest(entry);
    if (
        value.kind === 'xlsx'
        && has_only_keys(value, [
            'kind',
            'worksheetPartDigest',
            'sharedStringsDigest',
            'stylesDigest',
            'workbookDigest',
            'sourceRowCount',
            'sourceColumnCount',
        ])
        && is_structural_digest(value.worksheetPartDigest)
        && nullable_digest(value.sharedStringsDigest)
        && nullable_digest(value.stylesDigest)
        && is_structural_digest(value.workbookDigest)
    ) {
        return Object.freeze({
            kind: 'xlsx',
            worksheetPartDigest: value.worksheetPartDigest,
            sharedStringsDigest: value.sharedStringsDigest,
            stylesDigest: value.stylesDigest,
            workbookDigest: value.workbookDigest,
            ...counts,
        });
    }
    return pending_row_error('contain an invalid structural basis');
}

/**
 * What the structure validator knows about the worksheet besides the changes.
 * Every field is optional: the durable and wire codecs run without the source
 * (see `pending_structure_error`), and publication and save supply all of it.
 */
export interface PendingStructureContext {
    /** First body source row: the Header Row's 1-based number, or 0 without one. */
    readonly bodyStart?: number;
    /** Canonical source row count; the body is `[bodyStart, sourceRowCount)`. */
    readonly sourceRowCount?: number;
    readonly sourceColumnCount?: number;
    /** Whether the session's admission ledger minted `id` for an insert. */
    readonly mintedAsInsert?: (id: PendingRowId) => boolean;
}

function cell_has_move(cell: unknown): boolean {
    return is_plain_record(cell) && cell.movedFrom !== undefined;
}

/**
 * Check one worksheet's complete Pending Changes against the layout
 * invariants: the row and column validators of `worksheet-layout.ts`, inserted
 * rows and Pending Columns placed by a layout, the exclusivity rule (a live
 * layout change has no Pending Tail Removal and no pending cell move), and no
 * pending cell addressed to a removed row or column. Returns why it fails.
 *
 * Context the caller lacks is derived from the changes, which is what the
 * durable and wire codecs do: they cannot see the source, so a row layout's
 * body is taken from its own source runs, its end from the Structural Basis
 * when one is recorded, and a column layout's source count from the basis or
 * from the source columns it lists; discarded rows are trusted as inserts.
 * That still checks shape, canonical form, coverage of a contiguous body,
 * membership, creation orders, and the limits. Whether the body starts at the
 * Header Row and matches the file, and whether the ledger minted each ID, is
 * checked at publication and save, which pass the full context.
 */
export function pending_structure_error(
    changes: PendingStructuralChanges,
    cells: Readonly<Record<string, unknown>> | undefined,
    context: PendingStructureContext = {},
): string | undefined {
    const rows = pending_rows(changes);
    const { rowLayout, columnLayout } = changes;
    const pendingColumns = changes.pendingColumns ?? [];
    if (rowLayout === undefined && rows.some(is_inserted_row)) {
        return 'Inserted pending rows need a row layout.';
    }
    if (columnLayout === undefined && pendingColumns.length > 0) {
        return 'Pending columns need a column layout.';
    }
    const source_row_count = context.sourceRowCount ?? changes.structuralBasis?.sourceRowCount;
    let body_start = context.bodyStart;
    let body_end = source_row_count;
    if (rowLayout !== undefined) {
        let first: number | undefined;
        let last: number | undefined;
        for (const run of rowLayout.runs) {
            if (run.kind !== 'source') continue;
            first = Math.min(first ?? run.start, run.start);
            last = Math.max(last ?? run.start + run.count, run.start + run.count);
        }
        body_start ??= first ?? source_row_count ?? 0;
        body_end ??= last ?? body_start;
        if (body_end < body_start) return 'Row layout lies outside the worksheet body.';
        const error = validate_row_layout(rowLayout, {
            bodyStart: body_start,
            bodyRowCount: body_end - body_start,
            pendingRows: rows,
            mintedAsInsert: context.mintedAsInsert ?? (() => true),
        });
        if (error !== undefined) return error.message;
    }
    if (columnLayout !== undefined) {
        const error = validate_column_layout(columnLayout, {
            sourceColumnCount: context.sourceColumnCount
                ?? changes.structuralBasis?.sourceColumnCount
                ?? columnLayout.columns.filter((column) => column.kind === 'source').length,
            pendingColumns,
        });
        if (error !== undefined) return error.message;
    }

    const live_change = has_live_layout_change(changes);
    if (live_change) {
        if (changes.tailRemovals.length > 0) {
            return 'A worksheet with row or column changes cannot also undo a saved append.';
        }
        const moved = Object.values(cells ?? {}).some(cell_has_move)
            || rows.some((row) => Object.values(row.cells).some(cell_has_move))
            || pendingColumns.some((column) => Object.values(column.cells).some(cell_has_move));
        if (moved) return 'A worksheet with row or column changes cannot also hold a pending cell move.';
    }

    const removed_intervals = rowLayout?.removedSourceRows ?? [];
    const row_removed = (row: number): boolean => removed_intervals.some(
        (interval) => row >= interval.start && row < interval.start + interval.count);
    const removed_columns = new Set(columnLayout?.removedSourceColumns ?? []);
    for (const key of Object.keys(cells ?? {})) {
        const separator = key.indexOf(':');
        const row = Number(key.slice(0, separator));
        const column = Number(key.slice(separator + 1));
        if (row_removed(row) || removed_columns.has(column)) {
            return 'A pending cell change addresses a removed row or column.';
        }
    }
    if (removed_columns.size > 0 && rows.some((row) =>
        Object.keys(row.cells).some((column) => removed_columns.has(Number(column))))) {
        return 'A pending row cell addresses a removed column.';
    }
    // Fixed rows and body bounds are only known from the source, never derived.
    const known_body = context.bodyStart !== undefined && context.sourceRowCount !== undefined
        ? { start: context.bodyStart, end: context.sourceRowCount }
        : undefined;
    const known_pending_rows = new Set([
        ...rows.map((row) => row.id),
        ...(rowLayout?.discardedPendingRows ?? []).map((row) => row.id),
    ]);
    for (const column of pendingColumns) {
        for (const key of Object.keys(column.cells)) {
            const parsed = parse_row_identity_key(key)!;
            if (parsed.kind === 'p') {
                if (!known_pending_rows.has(parsed.id)) {
                    return `Pending column ${column.id} has a cell for unknown pending row ${parsed.id}.`;
                }
            } else if (parsed.kind === 's') {
                if (row_removed(parsed.row)) {
                    return `Pending column ${column.id} has a cell in a removed row.`;
                }
                if (known_body !== undefined
                    && (parsed.row < known_body.start || parsed.row >= known_body.end)) {
                    return `Pending column ${column.id} has a cell outside the worksheet body.`;
                }
            } else if (known_body !== undefined && parsed.row >= known_body.start) {
                return `Pending column ${column.id} has a fixed-row cell inside the worksheet body.`;
            }
        }
    }
    return undefined;
}

function json_string_bytes(value: string, stop_after: number): number {
    let bytes = 2; // quotes
    for (let index = 0; index < value.length; index += 1) {
        const code = value.charCodeAt(index);
        if (code === 0x22 || code === 0x5c || code === 0x08 || code === 0x09
            || code === 0x0a || code === 0x0c || code === 0x0d) {
            bytes += 2;
        } else if (code < 0x20) {
            bytes += 6;
        } else if (code < 0x80) {
            bytes += 1;
        } else if (code < 0x800) {
            bytes += 2;
        } else if (code >= 0xd800 && code <= 0xdbff) {
            const low = value.charCodeAt(index + 1);
            if (low >= 0xdc00 && low <= 0xdfff) {
                bytes += 4;
                index += 1;
            } else {
                // JSON.stringify escapes a lone surrogate as `\ud800`.
                bytes += 6;
            }
        } else if (code >= 0xdc00 && code <= 0xdfff) {
            bytes += 6;
        } else {
            bytes += 3;
        }
        if (bytes > stop_after) return bytes;
    }
    return bytes;
}

/**
 * Measure JSON bytes without first materializing a second multi-megabyte
 * string. Used both before ownership at hostile wire boundaries and after
 * structural/cell validation at durable boundaries.
 */
export function assert_json_encoded_bound(
    value: unknown,
    maximum_bytes: number,
): void {
    const ancestors = new Set<object>();
    const string_byte_cache = new Map<string, number>();
    const measure_string = (entry: string): number => {
        const cached = string_byte_cache.get(entry);
        if (cached !== undefined) return cached;
        const measured = json_string_bytes(entry, maximum_bytes);
        string_byte_cache.set(entry, measured);
        return measured;
    };
    const measure = (entry: unknown, array_slot = false): number => {
        if (entry === null) return 4;
        if (typeof entry === 'string') return measure_string(entry);
        if (typeof entry === 'boolean') return entry ? 4 : 5;
        if (typeof entry === 'number') {
            return Number.isFinite(entry) ? String(entry).length : 4;
        }
        if (entry === undefined) return array_slot ? 4 : 0;
        if (typeof entry !== 'object') pending_row_error('cannot be JSON encoded');
        if (ancestors.has(entry)) pending_row_error('cannot contain cycles');
        ancestors.add(entry);
        let bytes = 2;
        if (Array.isArray(entry)) {
            for (let index = 0; index < entry.length; index += 1) {
                if (index > 0) bytes += 1;
                bytes += measure(entry[index], true);
                if (bytes > maximum_bytes) break;
            }
        } else {
            let written = 0;
            for (const [key, child] of Object.entries(entry)) {
                if (child === undefined) continue;
                if (written > 0) bytes += 1;
                bytes += measure_string(key) + 1 + measure(child);
                written += 1;
                if (bytes > maximum_bytes) break;
            }
        }
        ancestors.delete(entry);
        return bytes;
    };
    if (measure(value) > maximum_bytes) {
        pending_row_error('exceed the encoded-byte safety bound');
    }
}

/** Full durable-leaf cap, including the host's reserved conflict diagnostic. */
export function assert_pending_changes_encoded_bound(value: unknown): void {
    assert_json_encoded_bound(value, MAX_PENDING_CHANGES_ENCODED_BYTES);
}

/** Renderer/non-conflict cap. The remaining bytes belong to one host conflict. */
export function assert_pending_user_changes_encoded_bound(value: unknown): void {
    assert_json_encoded_bound(value, MAX_PENDING_USER_CHANGES_ENCODED_BYTES);
}

/**
 * Validate and own one worksheet's structural pending state.
 *
 * Missing fields are the legacy cell-only spelling and normalize to empty
 * arrays. Any malformed structural field rejects the whole durable leaf.
 *
 * The layout fields are optional. A stored source layout, an empty Pending
 * Column list, and `origin: 'append'` normalize to absence, so the owned value
 * is the canonical spelling writers produce. When the input also carries the
 * worksheet's `cells` (a durable slot or a wire snapshot), they take part in
 * the structure check; see `pending_structure_error` for what is checked
 * without the source.
 */
function cell_has_formula_anchors(cell: unknown): boolean {
    return is_plain_record(cell) && cell.formulaAnchors !== undefined;
}

/** Whether any Pending Row cell or Pending Column cell carries Formula Anchors. */
export function pending_structure_carries_formula_anchors(
    changes: Pick<PendingStructuralChanges, 'appendedRows'> & Partial<Pick<PendingStructuralChanges, 'pendingColumns'>>,
): boolean {
    return pending_rows(changes).some((row) => Object.values(row.cells).some(cell_has_formula_anchors))
        || (changes.pendingColumns ?? []).some((column) =>
            Object.values(column.cells).some(cell_has_formula_anchors));
}

/** Whether any cell entry of a worksheet's `cells` map carries Formula Anchors. */
export function pending_cells_carry_formula_anchors(
    cells: Readonly<Record<string, unknown>> | undefined,
): boolean {
    return Object.values(cells ?? {}).some(cell_has_formula_anchors);
}

/**
 * Whether Pending Changes show their worksheet is CSV or TSV: a delimited
 * Structural Basis, or a Pending Row or Pending Column format that only
 * delimited worksheets use. Changes holding only cell edits show nothing, so
 * a codec that knows the format says so through `PendingChangesFormat`.
 */
export function pending_changes_show_delimited(
    changes: Pick<PendingStructuralChanges, 'formatTemplates'>
        & Partial<Pick<PendingStructuralChanges, 'pendingColumns' | 'structuralBasis'>>,
): boolean {
    return changes.structuralBasis?.kind === 'delimited'
        || changes.formatTemplates.some((template) => template.format.kind === 'none')
        || (changes.pendingColumns ?? []).some((column) => column.format.kind === 'none');
}

/** What a codec knows about the worksheet's table format. */
export interface PendingChangesFormat {
    /** The worksheet is CSV or TSV, so no value may carry Formula Anchors. */
    readonly delimited?: boolean;
}

export const DELIMITED_FORMULA_ANCHORS_MESSAGE =
    'CSV and TSV values are text, so they cannot carry formula anchors.';

export function own_pending_structural_changes(value: {
    readonly formatTemplates?: unknown;
    readonly appendedRows?: unknown;
    readonly tailRemovals?: unknown;
    readonly appendBasis?: unknown;
    readonly conflicts?: unknown;
    readonly rowLayout?: unknown;
    readonly columnLayout?: unknown;
    readonly pendingColumns?: unknown;
    readonly structuralBasis?: unknown;
    readonly cells?: unknown;
}, format: PendingChangesFormat = {}): PendingStructuralChanges {
    // Bound hostile wire/storage input before any of its collections are cloned.
    // The measurer stops as soon as the cap is crossed, so this is also a bound on
    // the amount of input we inspect before taking ownership.
    assert_pending_changes_encoded_bound(value);
    const templates_value = value.formatTemplates ?? [];
    const appended_value = value.appendedRows ?? [];
    const removals_value = value.tailRemovals ?? [];
    const conflicts_value = value.conflicts ?? [];
    if (
        !Array.isArray(templates_value)
        || !Array.isArray(appended_value)
        || !Array.isArray(removals_value)
        || !Array.isArray(conflicts_value)
        || templates_value.length > MAX_PENDING_FORMAT_TEMPLATES
        || appended_value.length > MAX_PENDING_APPENDED_ROWS
        || removals_value.length > MAX_PENDING_APPENDED_ROWS
        || conflicts_value.length > MAX_PENDING_APPENDED_ROWS
    ) pending_row_error('exceed their collection bounds');

    let appendBasis: PendingAppendBasis | undefined;
    if (value.appendBasis !== undefined) {
        const basis = value.appendBasis;
        if (
            !is_plain_record(basis)
            || !has_only_keys(basis, [
                'sourceRowCount',
                'provisionalStartRow',
                'provisionalRowCount',
                'columnCount',
                'schemaFingerprint',
                'styleFingerprint',
            ])
            || !Number.isSafeInteger(basis.sourceRowCount)
            || (basis.sourceRowCount as number) < 0
            || (basis.sourceRowCount as number) > MAX_PENDING_ROW_INDEX
            || (basis.provisionalStartRow !== undefined && (
                !Number.isSafeInteger(basis.provisionalStartRow)
                || (basis.provisionalStartRow as number) < 0
                || (basis.provisionalStartRow as number) > (basis.sourceRowCount as number)
            ))
            || (basis.provisionalRowCount !== undefined && (
                !Number.isSafeInteger(basis.provisionalRowCount)
                || (basis.provisionalRowCount as number) < 0
                || (basis.provisionalRowCount as number) > MAX_PENDING_APPENDED_ROWS
                || ((basis.provisionalStartRow as number | undefined) !== undefined
                    && (basis.provisionalStartRow as number)
                        + (basis.provisionalRowCount as number) > MAX_PENDING_ROW_INDEX)
            ))
            || !Number.isSafeInteger(basis.columnCount)
            || (basis.columnCount as number) <= 0
            || (basis.columnCount as number) > MAX_SHEET_COLUMNS
            || typeof basis.schemaFingerprint !== 'string'
            || basis.schemaFingerprint.length === 0
            || basis.schemaFingerprint.length > 512
            || (basis.styleFingerprint !== undefined && (
                typeof basis.styleFingerprint !== 'string'
                || basis.styleFingerprint.length === 0
                || basis.styleFingerprint.length > 256
            ))
        ) pending_row_error('contain an invalid append basis');
        appendBasis = Object.freeze({
            sourceRowCount: basis.sourceRowCount as number,
            ...(basis.provisionalStartRow === undefined
                ? {}
                : { provisionalStartRow: basis.provisionalStartRow as number }),
            ...(basis.provisionalRowCount === undefined
                ? {}
                : { provisionalRowCount: basis.provisionalRowCount as number }),
            columnCount: basis.columnCount as number,
            schemaFingerprint: basis.schemaFingerprint,
            ...(basis.styleFingerprint !== undefined
                ? { styleFingerprint: basis.styleFingerprint }
                : {}),
        });
    }

    const template_ids = new Set<string>();
    const formatTemplates = templates_value.map((entry): PendingRowFormatTemplate => {
        if (
            !is_plain_record(entry)
            || !has_only_keys(entry, ['id', 'format'])
            || !is_pending_id(entry.id)
            || template_ids.has(entry.id)
        ) {
            pending_row_error('contain an invalid or duplicate format-template identity');
        }
        template_ids.add(entry.id);
        return own_pending_row_format_template(entry);
    });

    const row_ids = new Set<string>();
    const orders = new Set<number>();
    let previous_order = -1;
    const appendedRows = appended_value.map((entry): PendingAppendedRow => {
        if (
            !is_plain_record(entry)
            || !has_only_keys(entry, [
                'id',
                'origin',
                'cells',
                'formatTemplateId',
                'createdOrder',
                'viewerRowHeight',
                'highlights',
            ])
            || !is_pending_id(entry.id)
            || row_ids.has(entry.id)
            || (entry.origin !== undefined && entry.origin !== 'append' && entry.origin !== 'insert')
            || typeof entry.formatTemplateId !== 'string'
            || !template_ids.has(entry.formatTemplateId)
            || !Number.isSafeInteger(entry.createdOrder)
            || (entry.createdOrder as number) < 0
            || orders.has(entry.createdOrder as number)
            || (entry.createdOrder as number) <= previous_order
            || (entry.viewerRowHeight !== undefined && !(
                typeof entry.viewerRowHeight === 'number'
                && Number.isFinite(entry.viewerRowHeight)
                && entry.viewerRowHeight > 0
            ))
        ) pending_row_error('contain an invalid appended row');
        row_ids.add(entry.id);
        orders.add(entry.createdOrder as number);
        previous_order = entry.createdOrder as number;
        const highlights = own_pending_highlights(entry.highlights);
        return Object.freeze({
            id: entry.id,
            ...(entry.origin === 'insert' ? { origin: 'insert' as const } : {}),
            cells: own_pending_cells(entry.cells),
            formatTemplateId: entry.formatTemplateId,
            createdOrder: entry.createdOrder as number,
            ...(entry.viewerRowHeight !== undefined
                ? { viewerRowHeight: entry.viewerRowHeight as number }
                : {}),
            ...(highlights !== undefined && Object.keys(highlights).length > 0
                ? { highlights }
                : {}),
        });
    });

    const removal_ids = new Set<string>();
    const removal_rows = new Set<number>();
    let previous_removal_row = -1;
    const tailRemovals = removals_value.map((entry): PendingTailRemoval => {
        if (
            !is_plain_record(entry)
            || !has_only_keys(entry, [
                'appendHistoryId',
                'sourceRow',
                'savedFingerprint',
                'savedRow',
            ])
            || !is_pending_id(entry.appendHistoryId)
            || removal_ids.has(entry.appendHistoryId)
            || !Number.isSafeInteger(entry.sourceRow)
            || (entry.sourceRow as number) < 0
            || (entry.sourceRow as number) >= MAX_PENDING_ROW_INDEX
            || removal_rows.has(entry.sourceRow as number)
            || (entry.sourceRow as number) <= previous_removal_row
            || typeof entry.savedFingerprint !== 'string'
            || entry.savedFingerprint.length === 0
            || entry.savedFingerprint.length > 256
        ) pending_row_error('contain an invalid tail removal');
        removal_ids.add(entry.appendHistoryId);
        removal_rows.add(entry.sourceRow as number);
        previous_removal_row = entry.sourceRow as number;
        return Object.freeze({
            appendHistoryId: entry.appendHistoryId,
            sourceRow: entry.sourceRow as number,
            savedFingerprint: entry.savedFingerprint,
            savedRow: own_saved_appended_row(entry.savedRow),
        });
    });

    const conflict_reasons = PENDING_STRUCTURAL_CONFLICT_REASONS;
    const conflicts = conflicts_value.map((entry): PendingStructuralConflict => {
        if (
            !is_plain_record(entry)
            || !has_only_keys(entry, [
                'reason',
                'pendingRowIds',
                'tailRemovalIds',
                'formulaCells',
            ])
            || !conflict_reasons.has(entry.reason as PendingStructuralConflictReason)
            || !Array.isArray(entry.pendingRowIds)
            || !Array.isArray(entry.tailRemovalIds)
            || entry.pendingRowIds.length > MAX_PENDING_APPENDED_ROWS
            || entry.tailRemovalIds.length > MAX_PENDING_APPENDED_ROWS
            || entry.pendingRowIds.some((id) => !is_pending_id(id))
            || entry.tailRemovalIds.some((id) => !is_pending_id(id))
            || new Set(entry.pendingRowIds).size !== entry.pendingRowIds.length
            || new Set(entry.tailRemovalIds).size !== entry.tailRemovalIds.length
        ) pending_row_error('contain an invalid structural conflict');
        const formula_cells = entry.formulaCells ?? [];
        const owned_formula_cells = Array.isArray(formula_cells)
            ? formula_cells.map((cell) => {
                if (!is_plain_record(cell)) return undefined;
                const rowIdentity = own_row_identity(cell.rowIdentity);
                if (
                    !has_only_keys(cell, ['rowIdentity', 'sourceColumn'])
                    || rowIdentity === undefined
                    || !Number.isSafeInteger(cell.sourceColumn)
                    || (cell.sourceColumn as number) < 0
                    || (cell.sourceColumn as number) >= MAX_SHEET_COLUMNS
                ) return undefined;
                return Object.freeze({
                    rowIdentity,
                    sourceColumn: cell.sourceColumn as number,
                });
            })
            : [];
        if (
            !Array.isArray(formula_cells)
            || owned_formula_cells.some((cell) => cell === undefined)
        ) pending_row_error('contain invalid formula conflict cells');
        const formula_keys = new Set(owned_formula_cells.map((cell) => cell!.rowIdentity.kind === 'source'
            ? `source:${cell!.rowIdentity.sourceRow}:${cell!.sourceColumn}`
            : `pending:${cell!.rowIdentity.pendingRowId}:${cell!.sourceColumn}`));
        if (formula_keys.size !== formula_cells.length) {
            pending_row_error('contain duplicate formula conflict cells');
        }
        return Object.freeze({
            reason: entry.reason as PendingStructuralConflictReason,
            pendingRowIds: Object.freeze([...(entry.pendingRowIds as string[])]),
            tailRemovalIds: Object.freeze([...(entry.tailRemovalIds as string[])]),
            ...(formula_cells.length === 0 ? {} : {
                formulaCells: Object.freeze(owned_formula_cells as Array<{
                    readonly rowIdentity: RowIdentity;
                    readonly sourceColumn: number;
                }>),
            }),
        });
    });

    // A template without a row is stale payload, not useful retained state.
    const referenced_templates = new Set(appendedRows.map((row) => row.formatTemplateId));
    if (formatTemplates.some((template) => !referenced_templates.has(template.id))) {
        pending_row_error('contain an unreferenced format template');
    }
    for (const conflict of conflicts) {
        if (conflict.pendingRowIds.some((id) => !row_ids.has(id))) {
            pending_row_error('contain a conflict for an unknown appended row');
        }
        if (conflict.tailRemovalIds.some((id) => !removal_ids.has(id))) {
            pending_row_error('contain a conflict for an unknown tail removal');
        }
    }

    let rowLayout = value.rowLayout === undefined ? undefined : own_row_layout(value.rowLayout);
    if (rowLayout !== undefined && is_source_row_layout(rowLayout)) rowLayout = undefined;
    let columnLayout = value.columnLayout === undefined
        ? undefined
        : own_column_layout(value.columnLayout);
    if (columnLayout !== undefined && is_source_column_layout(columnLayout)) columnLayout = undefined;
    const columns_value = value.pendingColumns ?? [];
    if (!Array.isArray(columns_value) || columns_value.length > MAX_PENDING_COLUMNS) {
        pending_row_error('contain an invalid pending column list');
    }
    const column_ids = new Set<string>();
    const column_orders = new Set<number>();
    const pendingColumns = columns_value.map((entry) => {
        const column = own_pending_column(entry);
        if (column_ids.has(column.id) || column_orders.has(column.createdOrder)) {
            pending_row_error('contain a duplicate pending column');
        }
        column_ids.add(column.id);
        column_orders.add(column.createdOrder);
        return column;
    });
    const structuralBasis = value.structuralBasis === undefined
        ? undefined
        : own_structural_basis(value.structuralBasis);

    const owned: PendingStructuralChanges = Object.freeze({
        formatTemplates: Object.freeze(formatTemplates),
        appendedRows: Object.freeze(appendedRows),
        tailRemovals: Object.freeze(tailRemovals),
        ...(appendBasis === undefined ? {} : { appendBasis }),
        conflicts: Object.freeze(conflicts),
        ...(rowLayout === undefined ? {} : { rowLayout }),
        ...(columnLayout === undefined ? {} : { columnLayout }),
        ...(pendingColumns.length === 0 ? {} : { pendingColumns: Object.freeze(pendingColumns) }),
        ...(structuralBasis === undefined ? {} : { structuralBasis }),
    });
    const structure_error = pending_structure_error(
        owned,
        is_plain_record(value.cells) ? value.cells : undefined,
    );
    if (structure_error !== undefined) pending_row_error(`are inconsistent: ${structure_error}`);
    if (
        (format.delimited === true || pending_changes_show_delimited(owned))
        && (pending_structure_carries_formula_anchors(owned)
            || pending_cells_carry_formula_anchors(is_plain_record(value.cells) ? value.cells : undefined))
    ) pending_row_error(`are invalid: ${DELIMITED_FORMULA_ANCHORS_MESSAGE}`);
    assert_pending_changes_encoded_bound(owned);
    return owned;
}

export function has_pending_structural_changes(
    value: Pick<PendingStructuralChanges, 'appendedRows' | 'tailRemovals' | 'conflicts'>
        & Partial<Pick<PendingStructuralChanges, 'rowLayout' | 'columnLayout' | 'pendingColumns'>>,
): boolean {
    return pending_rows(value).length > 0
        || value.tailRemovals.length > 0
        || value.conflicts.length > 0
        || value.rowLayout !== undefined
        || value.columnLayout !== undefined
        || (value.pendingColumns?.length ?? 0) > 0;
}

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
 */

import { is_plain_record } from './plain-record';
import { is_cell_highlight_color, type CellHighlightColor } from './cell-highlight-colors';
import { MAX_SHEET_COLUMNS, MAX_SHEET_ROWS } from './spreadsheet-safety';
import type { XlsxNumberFormat } from './spreadsheet-format';
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
            || (entry.provisionalStartRow as number) >= MAX_SHEET_ROWS
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

export interface PendingAppendedRow {
    readonly id: PendingRowId;
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
    | 'savedSuffixChanged';

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
    readonly appendedRows: readonly PendingAppendedRow[];
    readonly tailRemovals: readonly PendingTailRemoval[];
    readonly appendBasis?: PendingAppendBasis;
    readonly conflicts: readonly PendingStructuralConflict[];
}

export const EMPTY_PENDING_STRUCTURAL_CHANGES: PendingStructuralChanges = Object.freeze({
    formatTemplates: Object.freeze([]),
    appendedRows: Object.freeze([]),
    tailRemovals: Object.freeze([]),
    conflicts: Object.freeze([]),
});

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
        && (value.sourceRow as number) < MAX_SHEET_ROWS) {
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
    if (!integer(value.row, MAX_SHEET_ROWS)
        || !integer(value.col, MAX_SHEET_COLUMNS)
        || !Number.isSafeInteger(value.order) || (value.order as number) < 0
        || (value.rowIdentity !== undefined && own_row_identity(value.rowIdentity) === undefined)
        || (value.previous !== undefined && (!Array.isArray(value.previous)
            || value.previous.length > MAX_PENDING_APPENDED_ROWS))) return undefined;
    const previous = (value.previous ?? []).map((entry): PendingCellMoveIntent | undefined => {
        if (!is_plain_record(entry)
            || !integer(entry.sourceRow, MAX_SHEET_ROWS)
            || !integer(entry.sourceCol, MAX_SHEET_COLUMNS)
            || !integer(entry.destinationRow, MAX_SHEET_ROWS)
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
 */
export function own_pending_structural_changes(value: {
    readonly formatTemplates?: unknown;
    readonly appendedRows?: unknown;
    readonly tailRemovals?: unknown;
    readonly appendBasis?: unknown;
    readonly conflicts?: unknown;
}): PendingStructuralChanges {
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
            || (basis.sourceRowCount as number) > MAX_SHEET_ROWS
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
                        + (basis.provisionalRowCount as number) > MAX_SHEET_ROWS)
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
                'cells',
                'formatTemplateId',
                'createdOrder',
                'viewerRowHeight',
                'highlights',
            ])
            || !is_pending_id(entry.id)
            || row_ids.has(entry.id)
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
            || (entry.sourceRow as number) >= MAX_SHEET_ROWS
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

    const conflict_reasons = new Set<PendingStructuralConflictReason>([
        'worksheetReplaced',
        'rowLimitExceeded',
        'templateChanged',
        'ambiguousColumns',
        'ambiguousPendingFormula',
        'savedSuffixChanged',
    ]);
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

    const owned = Object.freeze({
        formatTemplates: Object.freeze(formatTemplates),
        appendedRows: Object.freeze(appendedRows),
        tailRemovals: Object.freeze(tailRemovals),
        ...(appendBasis === undefined ? {} : { appendBasis }),
        conflicts: Object.freeze(conflicts),
    });
    assert_pending_changes_encoded_bound(owned);
    return owned;
}

export function has_pending_structural_changes(
    value: Pick<PendingStructuralChanges, 'appendedRows' | 'tailRemovals' | 'conflicts'>,
): boolean {
    return value.appendedRows.length > 0
        || value.tailRemovals.length > 0
        || value.conflicts.length > 0;
}

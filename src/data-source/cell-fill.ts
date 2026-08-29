// Shared cell-fill helpers used by BOTH the .xlsx and .xls parsers.
//
// Both formats parse a worksheet into the same sparse "working set" shape —
// a Map of non-blank cells keyed "r:c", a Set of merge-covered (non-anchor)
// keys, plus row/col dimensions. This module is the SINGLE place that encodes:
//   - the null/blank resolution rule (`cell_at`)
//   - the raw normalization (`raw === null -> ''`, else `String(raw)`)
//   - direct-to-sink population (`fill_store`) that avoids the dense
//     (CellData|null)[][] intermediate
//   - the legacy densification (`densify`) kept for back-compat callers
//   - the workbook-level hasFormatting computation (`working_has_formatting`)
//
// Import direction: parsers import this helper + columnar-store; this helper
// imports only `../types` and `../cell-display` (which itself imports only
// `../types`). No parser is imported here, so there is no import cycle.

import { get_raw_cell_text } from '../cell-display';
import { rich_text_has_styles } from '../cell-content';
import type { CellData, MergeRange } from '../types';
import type {
    PackedFormulaDependencies,
    PackedFormulaCells,
    PackedPendingFormulaCells,
    RenderedCell,
} from './interface';

/**
 * The sparse working set for one parsed worksheet, before densification.
 * `cells` holds only the non-blank cells that appeared in the source; `merged_cells`
 * holds the "r:c" keys covered by (but not anchoring) a merge. Both the .xlsx and
 * .xls parsers produce this exact shape.
 */
export interface WorkingSet {
    cells: Map<string, CellData>;
    merged_cells: Set<string>;
    row_count: number;
    col_count: number;
}

/**
 * A minimal builder seam: anything that can be sized by (rows, cols) and accept
 * `set(r, c, cell)` calls. ColumnarStore.Builder satisfies this structurally.
 */
export interface CellSink {
    set(r: number, c: number, cell: RenderedCell | null): void;
}

/**
 * Per-sheet streaming entry: sheet meta plus a `fill` that writes the sheet's
 * cells into a {@link CellSink}. Both the .xlsx and .xls streaming parsers
 * produce this exact shape; `fill` applies the SAME cell_at null/blank rule and
 * raw normalization (`raw === null -> ''`, else `String(raw)`) the densify path
 * uses, so the resulting store is byte-identical to the legacy output.
 */
export interface StreamingSheet {
    name: string;
    /** Stable format-neutral worksheet identity when the source exposes one. */
    worksheetId?: string;
    rowCount: number;
    columnCount: number;
    merges: MergeRange[];
    formulaDependencies?: PackedFormulaDependencies;
    formulaCells?: PackedFormulaCells;
    pendingFormulaCells?: PackedPendingFormulaCells;
    fill(sink: CellSink): void;
}

/**
 * The result of a streaming parse: per-sheet fill seams plus the workbook-level
 * hasFormatting flag and any warnings. Shared by both format parsers.
 */
export interface StreamingWorkbook {
    sheets: StreamingSheet[];
    hasFormatting: boolean;
    warnings: string[];
}

/**
 * Resolve the cell at (r, c) for a parsed worksheet's working set, applying the
 * exact null/blank contract:
 *   - merged-covered (non-anchor) cell  -> null
 *   - cell present in the source        -> that CellData
 *   - otherwise (blank)                 -> { raw: null, formatted: '', bold: false, italic: false }
 * This is the ONLY place this rule lives; both the densify path and the
 * direct-to-sink streaming path call it so they cannot diverge.
 */
function cell_at(working: WorkingSet, r: number, c: number): CellData | null {
    const key = `${r}:${c}`;
    if (working.merged_cells.has(key)) return null;
    return working.cells.get(key) ?? { raw: null, formatted: '', bold: false, italic: false };
}

/**
 * Fill `sink` (sized row_count x col_count) directly from the working set,
 * applying the SAME cell_at null/blank rule and the SAME raw normalization
 * (raw === null -> '', else String(raw)) that the legacy densify-then-copy path
 * used. Never allocates the intermediate (CellData|null)[][], so the parse
 * working-set and the columnar store never co-exist as two full representations.
 */
function fill_store(working: WorkingSet, sink: CellSink): void {
    for (let r = 0; r < working.row_count; r++) {
        for (let c = 0; c < working.col_count; c++) {
            const cell = cell_at(working, r, c);
            if (cell === null) {
                sink.set(r, c, null);
                continue;
            }
            const rendered: RenderedCell = {
                raw: cell.raw === null ? '' : String(cell.raw),
                formatted: cell.formatted,
                ...(cell.formula !== undefined ? { formula: cell.formula } : {}),
                ...(cell.formulaResultPending ? { formulaResultPending: true as const } : {}),
                ...(cell.numericRaw !== undefined
                    ? { numericRaw: cell.numericRaw }
                    : {}),
                bold: cell.bold,
                italic: cell.italic,
                rawType: cell.raw === null
                    ? 'empty'
                    : cell.rawType === 'date'
                        ? 'date'
                    : cell.rawType === 'error'
                        ? 'error'
                    : typeof cell.raw === 'number'
                        ? 'number'
                        : typeof cell.raw === 'boolean'
                            ? 'boolean'
                            : 'string',
            };
            if (cell.underline) rendered.underline = true;
            if (cell.strikethrough) rendered.strikethrough = true;
            if (cell.numberFormat) rendered.numberFormat = cell.numberFormat;
            if (cell.xlsxIsoDate) rendered.xlsxIsoDate = true;
            if (cell.richText) rendered.richText = cell.richText;
            if (cell.hyperlink) rendered.hyperlink = cell.hyperlink;
            sink.set(r, c, rendered);
        }
    }
}

/**
 * Build the {@link StreamingSheet} seam for one parsed worksheet. Captures
 * `working` in a `fill` closure that writes it into a sink via {@link fill_store}
 * exactly once, then releases the reference so the working-set can be GC'd before
 * the next sheet is filled. Both the .xlsx and .xls streaming parsers produce this
 * identical seam, so it lives here rather than being copied into each parser.
 */
export function make_streaming_sheet(
    name: string,
    working: WorkingSet,
    merges: MergeRange[],
    worksheetId?: string,
    formulaDependencies?: PackedFormulaDependencies,
    formulaCells?: PackedFormulaCells,
    pendingFormulaCells?: PackedPendingFormulaCells,
): StreamingSheet {
    let pending: WorkingSet | null = working;
    return {
        name,
        worksheetId,
        rowCount: working.row_count,
        columnCount: working.col_count,
        merges,
        ...(formulaDependencies?.length ? { formulaDependencies } : {}),
        ...(formulaCells?.length ? { formulaCells } : {}),
        ...(pendingFormulaCells?.length ? { pendingFormulaCells } : {}),
        fill(sink: CellSink): void {
            if (!pending) throw new Error('StreamingSheet.fill called after its working-set was released');
            fill_store(pending, sink);
            pending = null;
        },
    };
}

/**
 * Densify a worksheet working set into the legacy (CellData|null)[][] shape.
 * Kept so the non-streaming public parsers (and their tests / other callers)
 * behave byte-identically; the streaming path avoids this allocation entirely.
 */
export function densify(working: WorkingSet): (CellData | null)[][] {
    const { row_count, col_count } = working;
    const rows: (CellData | null)[][] = [];
    for (let r = 0; r < row_count; r++) {
        const row_data: (CellData | null)[] = [];
        for (let c = 0; c < col_count; c++) {
            row_data.push(cell_at(working, r, c));
        }
        rows.push(row_data);
    }
    return rows;
}

/**
 * Compute the workbook-level hasFormatting flag directly from sheet working sets,
 * without densifying. Number-format recipes count even on currently blank or
 * visually unchanged cells because they can change how the next edit paints.
 * Merged-covered cells remain excluded because densification removes them.
 */
export function working_has_formatting(workings: WorkingSet[]): boolean {
    for (const working of workings) {
        for (const [key, cell] of working.cells) {
            if (working.merged_cells.has(key)) continue; // densified -> null, skipped
            // A retained recipe can affect the next edit even when the current
            // scalar happens to render identically (for example, `1` under `0`).
            if (cell.numberFormat) return true;
            if (cell.raw === null) continue;
            if (cell.formatted !== get_raw_cell_text(cell.raw)) return true;
            if (cell.bold || cell.italic || cell.underline || cell.strikethrough) return true;
            // A hyperlink alone deliberately does NOT flip the flag: link
            // styling is semantic and stays visible with formatting off.
            if (cell.richText && rich_text_has_styles(cell.richText)) return true;
        }
    }
    return false;
}

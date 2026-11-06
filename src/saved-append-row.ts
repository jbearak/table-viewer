// Saved appended rows (ADR-0003): the snapshot a recorded Append Row leaves
// on disk, its fingerprints, and whether the worksheet tail still holds it.
// Saving a Pending Tail Removal, validating one for the webview, and replaying
// one from history all ask the same question through `saved_row_unchanged`, so
// the rule for what counts as "unchanged" lives here once.
import { createHash } from 'crypto';
import { get_raw_cell_text } from './cell-display';
import { projected_row_for_source, type DataSource } from './data-source/interface';
import type {
    PendingAppendedRow,
    PendingRowCell,
    PendingRowFormat,
    SavedAppendedRowSnapshot,
} from './pending-changes';
import { capture_xlsx_append_row_format } from './xlsx-package';

function content_digest(bytes: Uint8Array): string {
    return createHash('sha256').update(bytes).digest('hex');
}

function canonical_saved_row_physical_cells(
    cells: Readonly<Record<string, PendingRowCell>>,
): readonly unknown[] {
    return Object.entries(cells)
        .map(([column, cell]) => [Number(column), cell] as const)
        .filter(([, cell]) => cell.value !== '' || cell.valueRuns !== undefined || cell.link != null)
        .sort(([left], [right]) => left - right)
        .map(([column, cell]) => [column, {
            value: cell.value,
            ...(cell.valueRuns === undefined ? {} : { valueRuns: cell.valueRuns }),
            ...(cell.link == null ? {} : { link: cell.link }),
        }]);
}

function canonical_saved_row_format(
    format: PendingRowFormat,
    include_viewer_height = true,
): unknown {
    if (format.kind === 'none') return format;
    return {
        kind: format.kind,
        templateSourceRow: format.templateSourceRow,
        styleFingerprint: format.styleFingerprint,
        cellStyleIndexes: format.cellStyleIndexes,
        ...(format.cellStyleFingerprints === undefined ? {} : {
            cellStyleFingerprints: format.cellStyleFingerprints,
        }),
        ...(format.cellNumberFormats === undefined ? {} : {
            cellNumberFormats: format.cellNumberFormats,
        }),
        ...(format.cellFontStyles === undefined ? {} : {
            cellFontStyles: format.cellFontStyles,
        }),
        ...(format.rowStyleIndex === undefined ? {} : {
            rowStyleIndex: format.rowStyleIndex,
        }),
        ...(format.rowNumberFormat === undefined ? {} : {
            rowNumberFormat: format.rowNumberFormat,
        }),
        ...(format.rowFontStyle === undefined ? {} : {
            rowFontStyle: format.rowFontStyle,
        }),
        ...(format.thickTop === undefined ? {} : { thickTop: true }),
        ...(format.thickBottom === undefined ? {} : { thickBottom: true }),
        ...(format.phonetic === undefined ? {} : { phonetic: true }),
        ...(format.nativeRowHeight === undefined ? {} : {
            nativeRowHeight: format.nativeRowHeight,
        }),
        ...(!include_viewer_height || format.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: format.viewerRowHeight,
        }),
    };
}

function saved_row_physical_fingerprint(
    row: Pick<SavedAppendedRowSnapshot, 'cells' | 'format'>,
): string {
    return content_digest(new TextEncoder().encode(JSON.stringify({
        cells: canonical_saved_row_physical_cells(row.cells),
        format: canonical_saved_row_format(row.format, false),
    })));
}

export function saved_row_snapshot_fingerprint(
    row: SavedAppendedRowSnapshot,
): string {
    const cells = Object.entries(row.cells)
        .map(([column, cell]) => [Number(column), cell] as const)
        .sort(([left], [right]) => left - right);
    const highlights = Object.entries(row.highlights ?? {})
        .map(([column, color]) => [Number(column), color] as const)
        .sort(([left], [right]) => left - right);
    return content_digest(new TextEncoder().encode(JSON.stringify({
        cells,
        format: canonical_saved_row_format(row.format),
        ...(row.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: row.viewerRowHeight,
        }),
        ...(highlights.length === 0 ? {} : { highlights }),
    })));
}

export function saved_pending_row_fingerprint(
    row: PendingAppendedRow,
    format: PendingRowFormat,
): string {
    return saved_row_snapshot_fingerprint({
        cells: row.cells,
        format,
        ...(row.viewerRowHeight === undefined ? {} : {
            viewerRowHeight: row.viewerRowHeight,
        }),
        ...(row.highlights === undefined ? {} : { highlights: row.highlights }),
    });
}

export function persisted_saved_row_snapshot(
    row: Pick<
        PendingAppendedRow,
        'cells' | 'viewerRowHeight' | 'highlights'
    >,
    format: PendingRowFormat,
    physical_cells: Readonly<Record<string, PendingRowCell>>,
): SavedAppendedRowSnapshot {
    const cells: Record<string, PendingRowCell> = {};
    const columns = new Set([
        ...Object.keys(row.cells),
        ...Object.keys(physical_cells),
    ]);
    for (const column of columns) {
        const physical = physical_cells[column] ?? { value: '' };
        const metadata = row.cells[column];
        cells[column] = Object.freeze({
            value: physical.value,
            ...(physical.valueRuns === undefined ? {} : { valueRuns: physical.valueRuns }),
            ...(physical.link === undefined ? {} : { link: physical.link }),
            ...(metadata?.valueEditOrder === undefined ? {} : {
                valueEditOrder: metadata.valueEditOrder,
            }),
            ...(metadata?.formulaReferenceBases === undefined ? {} : {
                formulaReferenceBases: metadata.formulaReferenceBases,
            }),
            ...(metadata?.movedFrom === undefined ? {} : { movedFrom: metadata.movedFrom }),
        });
    }
    const viewer_row_height = row.viewerRowHeight
        ?? (format.kind === 'xlsx' ? format.viewerRowHeight : undefined);
    return Object.freeze({
        cells: Object.freeze(cells),
        format,
        ...(viewer_row_height === undefined ? {} : {
            viewerRowHeight: viewer_row_height,
        }),
        ...(row.highlights === undefined ? {} : { highlights: row.highlights }),
    });
}

export function source_row_cells_for_fingerprint(
    src: DataSource,
    sheet_index: number,
    source_row: number,
): Readonly<Record<string, PendingRowCell>> {
    const projected_row = projected_row_for_source(src, sheet_index, source_row);
    const row = projected_row === undefined
        ? (() => {
            const column_count = src.meta().sheets[sheet_index]?.columnCount ?? 0;
            if (!src.read_canonical_columns || column_count === 0) return undefined;
            return src.read_canonical_columns(
                sheet_index,
                source_row,
                1,
                Array.from({ length: column_count }, (_, column) => column),
            ).rows[0];
        })()
        : (() => {
            const window = src.read_rows(sheet_index, projected_row, 1);
            return window.startRow === projected_row && window.rows.length === 1
                ? window.rows[0]
                : undefined;
        })();
    if (row === undefined) {
        throw new Error('A saved appended row is no longer available.');
    }
    const cells: Record<string, PendingRowCell> = {};
    for (const [column, cell] of row.entries()) {
        if (cell === null) continue;
        const value = cell.formula ?? get_raw_cell_text(cell.raw);
        if (value === '' && cell.richText === undefined && cell.hyperlink == null) continue;
        cells[column] = {
            value,
            ...(cell.richText === undefined ? {} : { valueRuns: cell.richText }),
            ...(cell.hyperlink == null ? {} : { link: cell.hyperlink }),
        };
    }
    return cells;
}

/**
 * The format a worksheet row has on disk now: captured from the workbook
 * package for XLSX (`xlsx_bytes`), and `{ kind: 'none' }` for formats without
 * row presentation (CSV/TSV), which pass no bytes.
 */
export function physical_row_format(
    source: DataSource,
    sheet_index: number,
    source_row: number,
    xlsx_bytes: Uint8Array | undefined,
): PendingRowFormat {
    if (xlsx_bytes === undefined) return { kind: 'none' };
    const sheet = source.meta().sheets[sheet_index];
    if (!sheet) throw new Error('A saved appended row lost its worksheet.');
    return capture_xlsx_append_row_format(
        xlsx_bytes,
        sheet_index,
        source_row + 1,
        sheet.columnCount,
        sheet.excelFirstRowHeader?.active === true
            ? sheet.excelFirstRowHeader.sourceRow
            : undefined,
    );
}

/**
 * Whether the worksheet row at `sourceRow` still holds exactly the cells and
 * physical format that were saved there. Viewer-only state (row height,
 * highlights) is not compared. `source` and `xlsx_bytes` must describe the
 * same verified file; CSV/TSV pass no bytes. Throws when the row cannot be
 * read at all.
 */
export function saved_row_unchanged(
    source: DataSource,
    sheet_index: number,
    saved: {
        readonly sourceRow: number;
        readonly savedRow: Pick<SavedAppendedRowSnapshot, 'cells' | 'format'>;
    },
    xlsx_bytes: Uint8Array | undefined,
): boolean {
    // Format first, as every caller did before this was shared: when both
    // reads fail, the package error is the one reported.
    const format = physical_row_format(source, sheet_index, saved.sourceRow, xlsx_bytes);
    const current = saved_row_physical_fingerprint({
        cells: source_row_cells_for_fingerprint(source, sheet_index, saved.sourceRow),
        format,
    });
    return current === saved_row_physical_fingerprint(saved.savedRow);
}

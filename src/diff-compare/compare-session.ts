// Compare-session DataSource wrapper. Pure (no vscode import): binds the
// modified-side source to its git original so one object owns both lifetimes,
// pads matched sheets' row counts to max(original, modified) so trailing
// added/deleted rows render as full grid bands, and answers per-page diffs.
import {
    read_source_rows_indexed,
    type DataSource,
    type IndexedRows,
    type RowWindow,
    type WorkbookMeta,
} from '../data-source/interface';
import {
    diff_column_names,
    diff_row_window,
    pair_sheets,
    type CompareDiffWindow,
    type SheetPairing,
} from './compare-source';

export class CompareDataSource implements DataSource {
    readonly pairings: SheetPairing[];
    /** Per modified sheet, positionally matching `meta.sheets`; empty for
     *  sheets without a header change or without a matched original. */
    readonly changedColumnNames: readonly (readonly { col: number; base: string }[])[];
    private readonly matched_by_modified_index: ReadonlyMap<
        number,
        Extract<SheetPairing, { status: 'matched' }>
    >;
    private readonly padded_meta: WorkbookMeta;

    constructor(
        private readonly modified: DataSource,
        private readonly original: DataSource,
    ) {
        this.pairings = pair_sheets(original.meta(), modified.meta());
        this.matched_by_modified_index = new Map(
            this.pairings.flatMap((pairing) =>
                pairing.status === 'matched' ? [[pairing.modifiedIndex, pairing]] : []),
        );
        const original_sheets = original.meta().sheets;
        const modified_meta = modified.meta();
        this.changedColumnNames = modified_meta.sheets.map((sheet, sheet_index) => {
            const pairing = this.matched_by_modified_index.get(sheet_index);
            return pairing
                ? diff_column_names(original_sheets[pairing.originalIndex], sheet)
                : [];
        });
        this.padded_meta = {
            ...modified_meta,
            sheets: modified_meta.sheets.map((sheet, sheet_index) => {
                const pairing = this.matched_by_modified_index.get(sheet_index);
                if (!pairing) return sheet;
                const original_sheet = original_sheets[pairing.originalIndex];
                const row_count = Math.max(sheet.rowCount, original_sheet.rowCount);
                const column_count = Math.max(sheet.columnCount, original_sheet.columnCount);
                return row_count === sheet.rowCount && column_count === sheet.columnCount
                    ? sheet
                    : {
                        ...sheet,
                        rowCount: row_count,
                        sourceRowCount: Math.max(sheet.sourceRowCount, row_count),
                        columnCount: column_count,
                    };
            }),
        };
    }

    meta(): WorkbookMeta {
        return this.padded_meta;
    }

    /** Per-page diff for the modified sheet at `sheet_index`; undefined for
     *  sheets with no matched original (added sheets have nothing to diff). */
    diff_page(sheet_index: number, start_row: number, count: number): CompareDiffWindow | undefined {
        const pairing = this.matched_by_modified_index.get(sheet_index);
        if (!pairing) return undefined;
        return diff_row_window(this.original, this.modified, pairing, start_row, count);
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const real = this.modified.meta().sheets[sheet_index];
        const padded = this.padded_meta.sheets[sheet_index];
        if (!real || !padded) return this.modified.read_rows(sheet_index, start_row, count);
        const start = Math.max(0, Math.min(start_row, padded.rowCount));
        const end = Math.min(padded.rowCount, start + count);
        const real_end = Math.min(end, real.rowCount);
        const rows = real_end > start
            ? this.modified.read_rows(sheet_index, start, real_end - start).rows.slice()
            : [];
        // Pad deleted-band rows (beyond the modified side) with empty rows.
        for (let row = Math.max(start, real.rowCount); row < end; row++) rows.push([]);
        return { startRow: start, rows };
    }

    read_rows_indexed(sheet_index: number, row_indices: ArrayLike<number>): IndexedRows {
        const real = this.modified.meta().sheets[sheet_index];
        // One batched read of the in-range indices keeps the underlying source's
        // indexed batching; padded (deleted-band) positions merge back as empties.
        const in_range: number[] = [];
        for (let position = 0; position < row_indices.length; position++) {
            const row = row_indices[position];
            if (real && row < real.rowCount) in_range.push(row);
        }
        const batched = in_range.length > 0
            ? read_source_rows_indexed(this.modified, sheet_index, in_range).rows
            : [];
        const rows: RowWindow['rows'] = [];
        let batched_position = 0;
        for (let position = 0; position < row_indices.length; position++) {
            const row = row_indices[position];
            rows.push(
                real && row < real.rowCount
                    ? batched[batched_position++] ?? []
                    : [],
            );
        }
        return { rows };
    }

    close(): void {
        try {
            this.modified.close();
        } finally {
            this.original.close();
        }
    }

    get truncationMessage(): string | undefined {
        return this.modified.truncationMessage;
    }

    get warnings(): string[] | undefined {
        return this.modified.warnings;
    }
}

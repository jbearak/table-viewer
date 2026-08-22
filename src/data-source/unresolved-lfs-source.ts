// The stand-in for a table whose bytes were never fetched: a Git LFS pointer
// file. One empty sheet, so the grid renders honestly — no rows, because there
// is genuinely no data — under the banner offering to resolve it.
//
// The alternative is what the viewer did before pointers were detected: hand
// the pointer's own text to the parser. For `.csv` that produces a convincing
// three-row, one-column grid of LFS metadata, which is worse than an error
// because nothing about it looks wrong. This source exists so that path is
// never taken.
import type { DataSource, RowWindow, WorkbookMeta } from './interface';

export class UnresolvedLfsDataSource implements DataSource {
    private readonly _meta: WorkbookMeta;

    constructor(sheet_name = 'Sheet1') {
        this._meta = {
            hasFormatting: false,
            sheets: [{
                name: sheet_name,
                // Delimited-style identity: there is no workbook here to read
                // worksheet names out of, and the name is this class's
                // invention, which is exactly what the flag records.
                unnamedSingleSheet: true,
                rowCount: 0,
                sourceRowCount: 0,
                columnCount: 0,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    meta(): WorkbookMeta {
        return this._meta;
    }

    read_rows(_sheet_index: number, start_row: number): RowWindow {
        return { startRow: start_row, rows: [] };
    }

    close(): void {
        // No buffers or handles: the pointer's bytes are not retained.
    }
}

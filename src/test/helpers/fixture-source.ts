// In-memory DataSource fixture shared by the compare-mode suites, so a change
// to the DataSource contract lands in one place.
import type { MergeRange } from '../../types';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    SheetMeta,
    WorkbookMeta,
} from '../../data-source/interface';

export const cell = (raw: string): RenderedCell => ({
    raw,
    formatted: raw,
    bold: false,
    italic: false,
    rawType: 'string',
});

export interface FixtureSheet {
    name: string;
    worksheetId?: string;
    /** Marks the sheet the way a delimited reader does: one grid, placeholder name. */
    unnamedSingleSheet?: boolean;
    /** Merged ranges in this sheet's own row space, for compare projection tests. */
    merges?: MergeRange[];
    hasFormatting?: boolean;
    /** Reported the way an ExcelHeaderDataSource sheet reports it, so the
     *  compare wrapper's withholding of the capability can be observed. */
    excelFirstRowHeader?: SheetMeta['excelFirstRowHeader'];
    rows: string[][];
}

export class FixtureSource implements DataSource {
    closed = false;

    constructor(private readonly fixture_sheets: FixtureSheet[]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: this.fixture_sheets.some((sheet) => sheet.hasFormatting === true),
            sheets: this.fixture_sheets.map((sheet) => ({
                name: sheet.name,
                ...(sheet.worksheetId !== undefined
                    ? { worksheetId: sheet.worksheetId }
                    : {}),
                ...(sheet.unnamedSingleSheet ? { unnamedSingleSheet: true } : {}),
                ...(sheet.excelFirstRowHeader !== undefined
                    ? { excelFirstRowHeader: sheet.excelFirstRowHeader }
                    : {}),
                rowCount: sheet.rows.length,
                sourceRowCount: sheet.rows.length,
                columnCount: sheet.rows.reduce(
                    // Reduced rather than spread into Math.max: a large fixture
                    // would overflow the argument list.
                    (widest, row) => Math.max(widest, row.length),
                    0,
                ),
                merges: sheet.merges ?? [],
                hasFormatting: sheet.hasFormatting === true,
            })),
        };
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const rows = this.fixture_sheets[sheet_index].rows;
        const start = Math.max(0, Math.min(start_row, rows.length));
        return {
            startRow: start,
            rows: rows.slice(start, start + count)
                .map((row) => row.map((value) => (value === '' ? null : cell(value)))),
        };
    }

    close(): void {
        this.closed = true;
    }
}

// In-memory DataSource fixture shared by the compare-mode suites, so a change
// to the DataSource contract lands in one place.
import type {
    DataSource,
    RenderedCell,
    RowWindow,
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
    rows: string[][];
}

export class FixtureSource implements DataSource {
    closed = false;

    constructor(private readonly fixture_sheets: FixtureSheet[]) {}

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: this.fixture_sheets.map((sheet) => ({
                name: sheet.name,
                ...(sheet.worksheetId !== undefined
                    ? { worksheetId: sheet.worksheetId }
                    : {}),
                rowCount: sheet.rows.length,
                sourceRowCount: sheet.rows.length,
                columnCount: Math.max(0, ...sheet.rows.map((row) => row.length)),
                merges: [],
                hasFormatting: false,
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

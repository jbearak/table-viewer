// Format-dispatching DataSource factory shared by the normal load path and the
// git-compare session, so both sides of a compare parse identically.
import type { DataSource, SheetMeta } from './interface';
import { CsvDataSource } from './csv-source';
import { XlsxDataSource } from './xlsx-source';
import { XlsDataSource } from './xls-source';
import { ExcelHeaderDataSource } from './excel-header-source';
import { get_delimiter } from '../host-ports';
import type { ExcelHeaderOverride } from './interface';
import { parser_format_for } from '../table-format';

export interface FromBufferOptions {
    /** CSV/TSV row cap; callers pass the configured limit. Default: unlimited. */
    readonly csvMaxRows?: number;
    /** Excel first-row-header persisted overrides (auto-detect when absent). */
    readonly excelHeaderOverrides?: Record<string, ExcelHeaderOverride>;
    /** Rows hidden by transforms, consulted by Excel header planning. Computed
     *  from the parsed physical sheets, which only exist inside this factory. */
    readonly excelHiddenRows?: (
        physical_sheets: readonly SheetMeta[],
    ) => readonly (readonly number[] | undefined)[] | undefined;
}

/** CSV/TSV files conventionally carry column names in their first row, so the
 *  grid promotes it to the column header rather than showing letters. */
export function csv_source_from_buffer(
    raw: Uint8Array,
    file_path: string,
    max_rows: number = Number.MAX_SAFE_INTEGER,
): Promise<CsvDataSource> {
    return CsvDataSource.create(raw, get_delimiter(file_path), max_rows, {
        firstRowIsHeader: true,
    });
}

/**
 * Build a DataSource for raw file bytes, dispatched on the path's
 * `parser_format_for` — the same dispatch `profile_for` makes: CSV/TSV (first
 * row is the header), Stata, Parquet, OOXML `.xlsx`, and BIFF `.xls` for
 * everything else.
 */
export async function build_source_from_buffer(
    raw: Uint8Array,
    file_path: string,
    options: FromBufferOptions = {},
): Promise<DataSource> {
    const format = parser_format_for(file_path);
    switch (format.id) {
        case 'csv':
        case 'tsv':
            return csv_source_from_buffer(raw, file_path, options.csvMaxRows);
        case 'dta': {
            const { DtaDataSource } = await import('./dta-source');
            return DtaDataSource.create(raw);
        }
        case 'parquet': {
            const { ParquetDataSource } = await import('./parquet-source');
            return ParquetDataSource.create(raw);
        }
        case 'xlsx':
        case 'xls': {
            const physical = format.id === 'xlsx'
                ? await XlsxDataSource.create(raw)
                : await XlsDataSource.create(
                    Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength),
                );
            return new ExcelHeaderDataSource(
                physical,
                options.excelHeaderOverrides,
                options.excelHiddenRows?.(physical.meta().sheets),
            );
        }
    }
}

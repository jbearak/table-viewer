import { CsvDataSource } from './data-source/csv-source';
import { get_delimiter } from './host-ports';
import { MAX_CSV_ROWS } from './spreadsheet-safety';

/**
 * Build the editable CSV/TSV source shared by previews, the self-managed desktop
 * controller, and the unwired custom-document core. The row limit is normalized
 * before CsvDataSource uses it as an array length.
 */
export function build_csv_source(
    raw: Uint8Array,
    file_path: string,
    csv_max_rows: number = MAX_CSV_ROWS,
): Promise<CsvDataSource> {
    return build_csv_source_with_delimiter(
        raw,
        get_delimiter(file_path),
        csv_max_rows,
    );
}

export function normalize_csv_max_rows(csv_max_rows: number): number {
    const requested_max_rows = Number.isFinite(csv_max_rows)
        ? Math.floor(csv_max_rows)
        : MAX_CSV_ROWS;
    return Math.max(0, Math.min(requested_max_rows, MAX_CSV_ROWS));
}

export function build_csv_source_with_delimiter(
    raw: Uint8Array,
    delimiter: ',' | '\t',
    csv_max_rows: number = MAX_CSV_ROWS,
): Promise<CsvDataSource> {
    const max_rows = normalize_csv_max_rows(csv_max_rows);
    return CsvDataSource.create(raw, delimiter, max_rows, {
        firstRowIsHeader: true,
    });
}

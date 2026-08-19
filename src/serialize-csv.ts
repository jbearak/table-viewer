import { parse_cell_key } from './cell-key';
import { get_raw_cell_text } from './cell-display';
import type { CellData } from './types';

export interface CsvSerializationOptions {
    readonly delimiter: ',' | '\t';
    readonly edits?: Readonly<Record<string, string>>;
    readonly originalColumnCounts?: readonly number[];
    readonly lineEnding?: '\r\n' | '\r' | '\n';
    readonly headerLine?: string;
}

export interface PreparedCsvSerializer {
    /** Complete promoted-header contribution, including its row terminator. */
    readonly headerPrefix: string;
    /** Serialize data rows using their absolute, header-excluded source offset. */
    serialize_rows(
        rows: Iterable<readonly (CellData | null)[]>,
        start_row: number,
    ): string;
}

/**
 * Prepare the row-local CSV/TSV rules shared by whole-document and windowed
 * serialization. Edit metadata is indexed once for the complete save; callers
 * can then serialize independent source windows without resetting absolute row
 * identity or rescanning every edit for every window.
 */
export function prepare_csv_serializer(
    options: CsvSerializationOptions,
): PreparedCsvSerializer {
    const {
        delimiter,
        edits,
        originalColumnCounts: original_column_counts,
        lineEnding: line_ending = '\n',
        headerLine: header_line,
    } = options;

    // Retain only one numeric maximum per edited row. The edit record already
    // owns every value; duplicating it into one nested Map per row makes a
    // million-row paste consume hundreds of megabytes before serialization.
    let max_edit_column_by_row: Map<number, number> | undefined;
    if (edits) {
        for (const key in edits) {
            if (!Object.prototype.hasOwnProperty.call(edits, key)) continue;
            const coordinates = parse_cell_key(key);
            if (!coordinates) continue;
            const { sourceRow: row, sourceColumn: column } = coordinates;
            const current = max_edit_column_by_row?.get(row);
            if (current === undefined || column > current) {
                (max_edit_column_by_row ??= new Map()).set(row, column);
            }
        }
    }

    const serialize_row = (r: number, row: readonly (CellData | null)[]): string => {
        const fields: string[] = [];
        let col_count = original_column_counts?.[r] ?? row.length;
        const max_edit_column = max_edit_column_by_row?.get(r);
        if (max_edit_column !== undefined && max_edit_column >= col_count) {
            col_count = max_edit_column + 1;
        }
        for (let c = 0; c < col_count; c++) {
            const key = `${r}:${c}`;
            const value = edits && Object.prototype.hasOwnProperty.call(edits, key)
                ? edits[key]
                : get_raw_cell_text(row[c]?.raw ?? null);
            fields.push(quote_field(value, delimiter));
        }
        return fields.join(delimiter);
    };

    return Object.freeze({
        // `undefined` means no header was consumed; '' is a real blank header
        // whose complete contribution is one line terminator.
        headerPrefix: header_line === undefined
            ? ''
            : header_line + line_ending,
        serialize_rows(
            rows: Iterable<readonly (CellData | null)[]>,
            start_row: number,
        ): string {
            const lines: string[] = [];
            let absolute_row = start_row;
            for (const row of rows) {
                lines.push(serialize_row(absolute_row, row));
                absolute_row += 1;
            }
            // Every emitted record owns its terminator. Independently serialized
            // contiguous windows therefore concatenate without a boundary separator.
            return lines.length === 0 ? '' : lines.join(line_ending) + line_ending;
        },
    });
}

/**
 * Serialize rows to one CSV/TSV string.
 *
 * This remains the small-input compatibility API and the byte-parity oracle for
 * tests. The production save path uses {@link prepare_csv_serializer} directly,
 * serializing and encoding one source window at a time so it never retains this
 * document-sized string.
 *
 * An edit keyed past the last source row is **dropped**, not appended. Under
 * source-keyed edit identity a stale edit at row 90,000 in a file that shrank to
 * 10 rows would have padded ~89,990 blank lines out to it — and because
 * `build_line_index` counts a field per LF, those blank lines re-parse as rows, so
 * a 10-row CSV would reopen as a 90,001-row table. Nothing in `src/` uses
 * `WorkspaceEdit`/`applyEdit`, so `write_file` is a raw filesystem write with
 * nothing on VS Code's undo stack: that outcome is unrecoverable. Saves carrying
 * such an edit are rejected before serialization instead — see
 * `validate_dirty_bases` (csv-base-validation.ts), whose `removedRows` outcome
 * covers exactly this case — so dropping here is the safe residual behavior for a
 * caller that skipped validation, not the policy the user ever sees.
 */
export function serialize_csv(
    rows: Iterable<(CellData | null)[]>,
    delimiter: ',' | '\t',
    edits?: Record<string, string>,
    original_column_counts?: number[],
    line_ending: '\r\n' | '\r' | '\n' = '\n',
    header_line?: string,
): string {
    const serializer = prepare_csv_serializer({
        delimiter,
        edits,
        originalColumnCounts: original_column_counts,
        lineEnding: line_ending,
        headerLine: header_line,
    });
    return serializer.headerPrefix + serializer.serialize_rows(rows, 0);
}

function quote_field(value: string, delimiter: string): string {
    if (
        value.includes(delimiter) ||
        value.includes('\n') ||
        value.includes('\r') ||
        value.includes('"')
    ) {
        return '"' + value.replace(/"/g, '""') + '"';
    }
    return value;
}

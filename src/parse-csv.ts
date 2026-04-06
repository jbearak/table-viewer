import Papa from 'papaparse';
import type { WorkbookData, CellData } from './types';

export interface CsvParseResult {
    data: WorkbookData;
    line_map: number[];
    truncationMessage?: string;
    originalColumnCounts: number[];
}

export function parse_csv(
    source: string,
    delimiter: ',' | '\t',
    max_rows: number
): CsvParseResult {
    const result = Papa.parse(source, {
        delimiter,
        header: false,
        skipEmptyLines: false,
    });

    let parsed_rows = result.data as string[][];

    // Remove trailing empty row produced by papaparse when source ends with newline.
    // Only strip if source actually ends with a line terminator — otherwise the
    // trailing [''] is a legitimate row with one empty field.
    const ends_with_newline = source.length > 0 &&
        (source[source.length - 1] === '\n' || source[source.length - 1] === '\r');

    if (
        ends_with_newline &&
        parsed_rows.length > 0 &&
        parsed_rows[parsed_rows.length - 1].length === 1 &&
        parsed_rows[parsed_rows.length - 1][0] === ''
    ) {
        parsed_rows = parsed_rows.slice(0, -1);
    }

    const total_rows = parsed_rows.length;

    // Compute line_map before truncation
    const full_line_map = build_line_map(source, parsed_rows);

    // Truncate if needed
    let truncationMessage: string | undefined;
    if (total_rows > max_rows) {
        parsed_rows = parsed_rows.slice(0, max_rows);
        truncationMessage = `Showing ${max_rows.toLocaleString()} of ${total_rows.toLocaleString()} rows`;
    }

    const line_map = full_line_map.slice(0, parsed_rows.length);

    // Record original column counts before padding
    const originalColumnCounts = parsed_rows.map(row => row.length);

    // Determine max column count
    let column_count = 0;
    for (const row of parsed_rows) {
        if (row.length > column_count) column_count = row.length;
    }

    // Build rows as CellData arrays
    const rows: (CellData | null)[][] = parsed_rows.map((row) => {
        const cells: (CellData | null)[] = [];
        for (let c = 0; c < column_count; c++) {
            if (c < row.length && row[c] !== '') {
                cells.push({
                    raw: row[c],
                    formatted: row[c],
                    bold: false,
                    italic: false,
                });
            } else {
                cells.push(null);
            }
        }
        return cells;
    });

    return {
        data: {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rows,
                merges: [],
                columnCount: column_count,
                rowCount: parsed_rows.length,
            }],
        },
        line_map,
        truncationMessage,
        originalColumnCounts,
    };
}

/**
 * Build a mapping from row index to source line number.
 * Walk the source string tracking newlines and match each parsed row
 * to its starting line. Multi-line quoted fields span multiple source
 * lines; the map points to the first line of each row.
 */
function build_line_map(source: string, parsed_rows: string[][]): number[] {
    if (parsed_rows.length === 0) return [];

    const line_map: number[] = [];
    let current_line = 0;
    let pos = 0;

    for (const row of parsed_rows) {
        line_map.push(current_line);

        const row_text = reconstruct_row_text(row, source, pos);
        for (let i = 0; i < row_text.length; i++) {
            const ch = row_text[i];
            if (ch === '\n') {
                current_line++;
                continue;
            }
            if (ch === '\r') {
                if (i + 1 < row_text.length && row_text[i + 1] === '\n') {
                    i++;
                }
                current_line++;
            }
        }
        pos += row_text.length;

        // Skip the row delimiter (\n or \r\n)
        if (pos < source.length) {
            if (source[pos] === '\r' && pos + 1 < source.length && source[pos + 1] === '\n') {
                current_line++;
                pos += 2;
            } else if (source[pos] === '\n' || source[pos] === '\r') {
                current_line++;
                pos += 1;
            }
        }
    }

    return line_map;
}

/**
 * Given a parsed row and the current position in source, extract the
 * source text that corresponds to this row (up to but not including
 * the row-terminating newline).
 */
function reconstruct_row_text(
    _row: string[],
    source: string,
    start_pos: number
): string {
    let pos = start_pos;
    let in_quotes = false;

    while (pos < source.length) {
        const ch = source[pos];
        if (ch === '"') {
            in_quotes = !in_quotes;
        } else if (!in_quotes && (ch === '\n' || ch === '\r')) {
            break;
        }
        pos++;
    }

    return source.slice(start_pos, pos);
}

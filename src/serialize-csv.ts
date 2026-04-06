import type { CellData } from './types';

export function serialize_csv(
    rows: (CellData | null)[][],
    delimiter: ',' | '\t',
    edits?: Record<string, string>,
    original_column_counts?: number[]
): string {
    const lines: string[] = [];

    for (let r = 0; r < rows.length; r++) {
        const fields: string[] = [];
        let col_count = original_column_counts?.[r] ?? rows[r].length;
        // Extend if any edit targets a column beyond original count
        if (edits) {
            for (const key of Object.keys(edits)) {
                const [er, ec] = key.split(':').map(Number);
                if (er === r && ec >= col_count) {
                    col_count = ec + 1;
                }
            }
        }
        for (let c = 0; c < col_count; c++) {
            const key = `${r}:${c}`;
            let value: string;
            if (edits && key in edits) {
                value = edits[key];
            } else {
                const cell = rows[r][c];
                value = cell !== null ? String(cell.raw ?? '') : '';
            }
            fields.push(quote_field(value, delimiter));
        }
        lines.push(fields.join(delimiter));
    }

    return lines.join('\n') + '\n';
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

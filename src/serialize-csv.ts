import type { CellData } from './types';

export function serialize_csv(
    rows: (CellData | null)[][],
    delimiter: ',' | '\t',
    edits?: Record<string, string>
): string {
    const lines: string[] = [];

    for (let r = 0; r < rows.length; r++) {
        const fields: string[] = [];
        for (let c = 0; c < rows[r].length; c++) {
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

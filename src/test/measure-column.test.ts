// @vitest-environment jsdom

import { describe, it, expect, afterEach } from 'vitest';
import { measure_column_fit_width } from '../webview/measure-column';
import type { MergeRange } from '../types';

function build_table(rows: string[][], merges: MergeRange[] = []): HTMLTableElement {
    const table = document.createElement('table');
    const tbody = document.createElement('tbody');
    table.appendChild(tbody);

    const hidden = new Set<string>();
    const span_map = new Map<string, { rowSpan: number; colSpan: number }>();
    for (const m of merges) {
        span_map.set(`${m.startRow}:${m.startCol}`, {
            rowSpan: m.endRow - m.startRow + 1,
            colSpan: m.endCol - m.startCol + 1,
        });
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r !== m.startRow || c !== m.startCol) {
                    hidden.add(`${r}:${c}`);
                }
            }
        }
    }

    for (let r = 0; r < rows.length; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < rows[r].length; c++) {
            if (hidden.has(`${r}:${c}`)) continue;
            const td = document.createElement('td');
            td.textContent = rows[r][c];
            const spans = span_map.get(`${r}:${c}`);
            if (spans) {
                td.rowSpan = spans.rowSpan;
                td.colSpan = spans.colSpan;
            }
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }

    document.body.appendChild(table);
    return table;
}

describe('measure_column_fit_width', () => {
    afterEach(() => {
        document.body.innerHTML = '';
    });

    it('returns minimum width of 40 for empty cells', () => {
        const table = build_table([[''], [''], ['']]);
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBe(40);
    });

    it('measures the widest cell in the column plus padding', () => {
        const table = build_table([
            ['short', 'x'],
            ['a much longer cell value', 'y'],
            ['mid', 'z'],
        ]);
        // We can't assert exact pixel values in jsdom (no layout engine),
        // but we can verify it returns at least the minimum
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBeGreaterThanOrEqual(40);
    });

    it('skips merged header row when it spans multiple columns', () => {
        const merges: MergeRange[] = [
            { startRow: 0, startCol: 0, endRow: 0, endCol: 1 },
        ];
        const table = build_table(
            [
                ['Very long merged header text', ''],
                ['A', 'B'],
                ['C', 'D'],
            ],
            merges
        );
        // Should not throw and should return a valid width
        const width = measure_column_fit_width(table, 0, merges);
        expect(width).toBeGreaterThanOrEqual(40);
    });

    it('includes header row when it is not merged across columns', () => {
        const table = build_table([
            ['Header Col 0', 'Header Col 1'],
            ['A', 'B'],
        ]);
        const width = measure_column_fit_width(table, 0, []);
        expect(width).toBeGreaterThanOrEqual(40);
    });
});

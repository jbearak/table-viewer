import type { MergeRange } from '../types';

const MIN_WIDTH = 40;
const PADDING = 16;

export function measure_column_fit_width(
    table: HTMLTableElement,
    col: number,
    merges: MergeRange[]
): number {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return MIN_WIDTH;

    // Build a set of merge-hidden cells and a map of multi-column merges
    const hidden = new Set<string>();
    const multi_col_merges = new Set<string>();
    for (const m of merges) {
        if (m.endCol > m.startCol) {
            for (let r = m.startRow; r <= m.endRow; r++) {
                for (let c = m.startCol; c <= m.endCol; c++) {
                    multi_col_merges.add(`${r}:${c}`);
                }
            }
        }
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r !== m.startRow || c !== m.startCol) {
                    hidden.add(`${r}:${c}`);
                }
            }
        }
    }

    // Create an off-screen measurement element
    const measurer = document.createElement('span');
    measurer.style.position = 'absolute';
    measurer.style.visibility = 'hidden';
    measurer.style.whiteSpace = 'nowrap';
    measurer.style.left = '-9999px';
    document.body.appendChild(measurer);

    let max_width = 0;

    rows.forEach((tr, row_index) => {
        // Skip hidden cells
        if (hidden.has(`${row_index}:${col}`)) return;

        // Skip row 0 if it's a multi-column merge at this column
        if (row_index === 0 && multi_col_merges.has(`0:${col}`)) return;

        // Find the td for this column. Since hidden cells are not rendered,
        // we need to count visible columns up to our target.
        let visible_col = 0;
        let target_td: HTMLTableCellElement | null = null;
        const tds = tr.querySelectorAll('td');
        for (const td of tds) {
            const col_span = td.colSpan || 1;
            if (visible_col <= col && col < visible_col + col_span) {
                // Only measure if this td is exactly for our column
                // (not a multi-column span that happens to cover it)
                if (col_span === 1) {
                    target_td = td;
                }
                break;
            }
            visible_col += col_span;
        }

        if (!target_td) return;

        // Copy font styles from the cell
        const computed = window.getComputedStyle(target_td);
        measurer.style.fontFamily = computed.fontFamily;
        measurer.style.fontSize = computed.fontSize;
        measurer.style.fontWeight = computed.fontWeight;
        measurer.style.fontStyle = computed.fontStyle;

        measurer.textContent = target_td.textContent;
        const measured = measurer.offsetWidth;
        if (measured > max_width) {
            max_width = measured;
        }
    });

    document.body.removeChild(measurer);

    return Math.max(MIN_WIDTH, max_width + PADDING);
}

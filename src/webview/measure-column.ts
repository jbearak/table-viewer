import type { MergeRange } from '../types';

const MIN_WIDTH = 40;
const PADDING = 16;

function get_measurement_element(
    target_td: HTMLTableCellElement
): HTMLElement {
    const text_walker = document.createTreeWalker(
        target_td,
        NodeFilter.SHOW_TEXT
    );

    let node = text_walker.nextNode();
    while (node) {
        if ((node.textContent ?? '').trim().length > 0) {
            return node.parentElement ?? target_td;
        }
        node = text_walker.nextNode();
    }

    return target_td;
}

export function measure_column_fit_width(
    table: HTMLTableElement,
    col: number,
    merges: MergeRange[]
): number {
    const rows = table.querySelectorAll('tbody tr');
    if (rows.length === 0) return MIN_WIDTH;

    // Build a set of merge-hidden cells (non-anchor cells of each merge)
    const hidden = new Set<string>();
    for (const m of merges) {
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

    try {
        rows.forEach((tr, row_index) => {
            // Skip hidden cells
            if (hidden.has(`${row_index}:${col}`)) return;

            // Find the td for this column. Since hidden cells are not rendered,
            // we need to count visible columns up to our target.
            // Multi-column spans are naturally excluded by the col_span === 1
            // check, which handles both merged headers and interior merges.
            let visible_col = 0;
            let target_td: HTMLTableCellElement | null = null;
            const tds = tr.querySelectorAll('td');
            for (const td of tds) {
                const col_span = td.colSpan || 1;
                if (visible_col <= col && col < visible_col + col_span) {
                    if (col_span === 1) {
                        target_td = td;
                    }
                    break;
                }
                visible_col += col_span;
            }

            if (!target_td) return;

            const measurement_element = get_measurement_element(target_td);

            // Copy font styles from the rendered text container so bold/italic
            // cells are measured using their actual display font.
            const computed = window.getComputedStyle(
                measurement_element
            );
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
    } finally {
        document.body.removeChild(measurer);
    }

    return Math.max(MIN_WIDTH, max_width + PADDING);
}

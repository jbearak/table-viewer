export function auto_resize_row_after_edit(
    table: HTMLTableElement,
    row: number,
    row_heights: Record<number, number>,
    on_row_resize: (row: number, height: number) => void,
): void {
    const tr = table.querySelector(`tbody tr:nth-child(${row + 1})`) as HTMLTableRowElement | null;
    if (!tr) return;

    const current = row_heights[row];
    if (current === undefined) return;

    const measured = tr.scrollHeight;
    if (measured > current) {
        on_row_resize(row, measured);
    }
}

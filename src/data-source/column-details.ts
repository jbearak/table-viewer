import { Buffer } from 'node:buffer';
import type { Variable } from '@jbearak/dta-parser';
import type { ColumnDetails } from './interface';

/**
 * `columnDetails` crosses to the webview with `SheetMeta` in every snapshot,
 * so its size is capped: past this many bytes (of JSON, as UTF-8), the
 * remaining columns get no details.
 */
export const MAX_COLUMN_DETAILS_BYTES = 1024 * 1024;

/**
 * Details for columns `0` to `count - 1`, built one at a time by `build`
 * (null for a column with nothing to say) until the next one would pass
 * `MAX_COLUMN_DETAILS_BYTES`; undefined when no column has any.
 */
export function capped_column_details(
    count: number,
    build: (column: number) => ColumnDetails | null,
    max_bytes = MAX_COLUMN_DETAILS_BYTES,
): (ColumnDetails | null)[] | undefined {
    const details: (ColumnDetails | null)[] = [];
    // The array's brackets.
    let bytes = 2;
    let any = false;
    for (let column = 0; column < count; column++) {
        const entry = build(column);
        // The entry and the comma before it.
        const size = Buffer.byteLength(JSON.stringify(entry)) + (column > 0 ? 1 : 0);
        if (bytes + size > max_bytes) break;
        bytes += size;
        details.push(entry);
        if (entry !== null) any = true;
    }
    if (!any) return undefined;
    // Trailing columns with nothing to say need no entries.
    while (details.length > 0 && details[details.length - 1] === null) details.pop();
    return details;
}

/** A Stata variable's details: its label, storage type and display format, and value label set. */
export function stata_column_details(variable: Variable): ColumnDetails {
    const details: ColumnDetails = {};
    if (variable.label !== '') details.label = variable.label;
    details.type = variable.format === '' ? variable.type : `${variable.type}, ${variable.format}`;
    if (variable.valueLabels !== '') details.valueLabels = variable.valueLabels;
    return details;
}

/** "a", "a and b", or "a, b, and c". */
export function list_text(items: readonly string[]): string {
    if (items.length <= 2) return items.join(' and ');
    return `${items.slice(0, -1).join(', ')}, and ${items[items.length - 1]}`;
}

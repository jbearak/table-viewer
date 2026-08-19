import {
    find_tag_end,
    get_attr,
    ignorable_end,
    ignorable_ranges,
    is_tag_boundary,
    is_self_closing,
} from './ooxml-xml';

const ROW_NUMBER_RE = /^\d+$/;
const MAX_WORKSHEET_ROWS = 1_048_576;
const MAX_WORKSHEET_COLUMNS = 16_384;

/** How one cell opening tag spells (or omits) its coordinate. */
export type ScannedCellReference =
    | { readonly kind: 'valid'; readonly row: number; readonly col: number; readonly start: number }
    | { readonly kind: 'missing'; readonly start: number }
    | { readonly kind: 'invalid'; readonly reference: string; readonly start: number };

/**
 * Resolve one decoded `r` value without normalizing malformed spellings.
 *
 * SpreadsheetML coordinates are canonical uppercase letters followed by a
 * one-based row with no leading zeroes. The format itself ends at XFD1048576;
 * these are format limits, distinct from Table Viewer's smaller product caps.
 */
function resolve_cell_reference(ref: string | null, start: number): ScannedCellReference {
    if (ref === null) return { kind: 'missing', start };

    let i = 0;
    let column = 0;
    while (i < ref.length) {
        const code = ref.charCodeAt(i);
        if (code < 0x41 || code > 0x5a) break;
        column = column * 26 + code - 0x40;
        if (column > MAX_WORKSHEET_COLUMNS) {
            return { kind: 'invalid', reference: ref, start };
        }
        i++;
    }
    if (i === 0 || i === ref.length || ref.charCodeAt(i) === 0x30) {
        return { kind: 'invalid', reference: ref, start };
    }

    let row = 0;
    for (; i < ref.length; i++) {
        const digit = ref.charCodeAt(i) - 0x30;
        if (digit < 0 || digit > 9) return { kind: 'invalid', reference: ref, start };
        row = row * 10 + digit;
        if (row > MAX_WORKSHEET_ROWS) return { kind: 'invalid', reference: ref, start };
    }
    return { kind: 'valid', row: row - 1, col: column - 1, start };
}

/** A located element in the worksheet XML: [start, end) UTF-16 string indices of the whole element. */
export interface Span {
    readonly start: number;
    readonly end: number;
    /** Offset just past the opening tag's `>`; equals `end` for self-closing elements. */
    readonly inner_start: number;
    readonly open_tag: string;
    /**
     * Where the element's content ends, i.e. the start of its end tag. Equals
     * `end` for a self-closing element.
     *
     * Carried rather than derived: an end tag may legally be written `</row\n>`, so
     * `end - '</row>'.length` is not where it starts. Computing it that way put an
     * insertion *inside* the end tag and emitted malformed XML.
     */
    readonly inner_end: number;
}

/**
 * The first live `<name>` element in `[from, to)`, including its exact spans.
 *
 * This is the shared element boundary rule for worksheet reads and writes. In
 * particular, closing tags may contain XML whitespace before `>`, and apparent
 * tags inside comments, CDATA sections, or processing instructions are text.
 */
export function find_first_element(
    xml: string,
    name: string,
    from = 0,
    to = xml.length,
): Span | null {
    const ranges = ignorable_ranges(xml, from, to);
    for (const [start, open_tag] of live_tags(xml, name, from, to, ranges)) {
        const tag_end = start + open_tag.length - 1;
        if (tag_end >= to) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return {
                start,
                end: tag_end + 1,
                inner_start: tag_end + 1,
                inner_end: tag_end + 1,
                open_tag,
            };
        }
        const end_tag = end_tag_after(xml, name, tag_end + 1, ranges);
        if (end_tag === null || end_tag[1] > to) return null;
        return {
            start,
            end: end_tag[1],
            inner_start: tag_end + 1,
            inner_end: end_tag[0],
            open_tag,
        };
    }
    return null;
}

/** The verbatim content of {@link find_first_element}, or null when absent. */
export function element_content(
    xml: string,
    name: string,
    from = 0,
    to = xml.length,
): string | null {
    const element = find_first_element(xml, name, from, to);
    return element === null ? null : xml.slice(element.inner_start, element.inner_end);
}

type ScannedCellCallback = (
    reference: ScannedCellReference,
    end: number,
    inner_start: number,
    inner_end: number,
    open_tag: string,
) => void;

/** Every complete, live `<c>` in one row, in document order. */
function scan_cell_elements(
    xml: string,
    from: number,
    to: number,
    ranges: ReadonlyArray<[number, number]>,
    callback: ScannedCellCallback,
): void {
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<c', pos);
        if (start === -1 || start >= to) return;
        const skip_to = ignorable_end(ranges, start);
        if (skip_to !== undefined) { pos = skip_to; continue; }
        if (!is_tag_boundary(xml[start + 2])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1 || tag_end >= to) return;
        const open_tag = xml.slice(start, tag_end + 1);
        const reference = resolve_cell_reference(get_attr(open_tag, 'r'), start);
        let end: number;
        let inner_end: number;
        if (is_self_closing(xml, start, tag_end)) {
            end = tag_end + 1;
            inner_end = end;
        } else {
            const end_tag = end_tag_after(xml, 'c', tag_end + 1, ranges);
            if (end_tag === null || end_tag[1] > to) return;
            [inner_end, end] = end_tag;
        }
        pos = end;
        callback(reference, end, tag_end + 1, inner_end, open_tag);
    }
}

/** Optional consumers of the row scan; absent callbacks allocate no cell spans. */
export interface ScanRowsOptions {
    /** Every complete row, including empty and self-closing rows. */
    readonly on_row?: (row: Span) => void;
    /** Every complete cell, including missing and invalid references. */
    readonly on_reference?: (
        reference: ScannedCellReference,
        open_tag: string,
        owner: Span,
    ) => void;
    readonly on_coordinate?: (row: number, col: number, owner: Span) => void;
    readonly capture_cell?: (row: number, col: number) => boolean;
    readonly on_cell?: (
        row: number,
        col: number,
        cell: Span,
        owner: Span,
    ) => void;
}

/**
 * Every real `<name …>` opening tag in a whole document, quote- and comment-aware.
 *
 * The package layer's `matchAll(/<sheet\b[^>]*>/g)` had the same defect as the
 * writer's scans: a legal raw `>` inside a sheet name truncated the tag, the
 * `name="` test then failed, and that worksheet dropped out of the numbering —
 * so an edit aimed at sheet 0 was written into sheet 1. Silent, and valid on disk.
 */
export function* live_tags_in(xml: string, name: string): Generator<[number, string]> {
    yield* live_tags(xml, name, 0, xml.length, ignorable_ranges(xml, 0, xml.length));
}

/**
 * Every real `<name …>` opening tag in `[from, to)`, as [offset, whole tag].
 *
 * The one way to scan tags here. `matchAll(/<f\b[^>]*>/g)` gets both halves of
 * this wrong: `[^>]*` stops at the first `>`, and a `>` inside a quoted attribute
 * value is legal XML — `x:note="1 > 0"` need not be escaped — so the "tag" it
 * yields is a fragment, which made the safety guard refuse a perfectly editable
 * worksheet and made a sheet named `Welcome > Intro` shift the workbook's
 * worksheet numbering, writing an edit into the wrong sheet. And a bare regex has
 * no idea what a comment is, so a commented-out element read as live.
 * `find_tag_end` is the reader's own quote-aware scan; `ignorable_ranges` is what
 * makes "live" mean live.
 */
export function* live_tags(
    xml: string,
    name: string,
    from: number,
    to: number,
    ranges: ReadonlyArray<[number, number]>,
): Generator<[number, string]> {
    let pos = from;
    while (pos < to) {
        const at = indexOf_live(xml, `<${name}`, pos, ranges);
        if (at === -1 || at >= to) return;
        if (!is_tag_boundary(xml[at + name.length + 1])) { pos = at + 1; continue; }
        const tag_end = find_tag_end(xml, at);
        if (tag_end === -1) return;
        yield [at, xml.slice(at, tag_end + 1)];
        pos = tag_end + 1;
    }
}

/**
 * The first `needle` at or after `from` that is real markup rather than quoted text.
 *
 * Every raw `indexOf` in these scanners needs this, not just the ones that find
 * opening tags. Skipping a commented-out `<row>` but then closing the *live* row
 * at a `</row>` inside a comment is the same bug wearing the other shoe: the span
 * ends early, and the edit splices into the comment (silent no-op) or across it
 * (malformed XML, which is worse than either).
 */
export function indexOf_live(
    xml: string,
    needle: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): number {
    let pos = from;
    while (true) {
        const at = xml.indexOf(needle, pos);
        if (at === -1) return -1;
        const skip_to = ignorable_end(ranges, at);
        if (skip_to === undefined) return at;
        pos = skip_to;
    }
}

/**
 * The span of the first live `</name>` end tag at or after `from`, as
 * `[start, end)`, or null if there is none.
 *
 * Not an `indexOf('</c>')`: XML permits whitespace between the name and the `>`,
 * so `</c\n>` is an ordinary end tag that a pretty-printer may well write.
 * Missing it made the element look unterminated, the cell took the
 * synthesize-a-new-one path, and the row came out with *two* `<c r="A1">` — a
 * file whose displayed value depends on which one the reader keeps.
 *
 * The name boundary is checked rather than assumed, because `</c` is also a
 * prefix of `</calcChain`; a prefix match resumes the search instead of ending
 * the element in the wrong place.
 */
export function end_tag_after(
    xml: string,
    name: string,
    from: number,
    ranges: ReadonlyArray<[number, number]>,
): [number, number] | null {
    let pos = from;
    while (true) {
        const at = indexOf_live(xml, `</${name}`, pos, ranges);
        if (at === -1) return null;
        const after = at + name.length + 2;
        if (xml[after] === '>') return [at, after + 1];
        const gt = xml.indexOf('>', after);
        if (gt !== -1 && after < gt && !/\S/.test(xml.slice(after, gt))) return [at, gt + 1];
        pos = at + 1;
    }
}

/**
 * Locate the `<row>` elements in `sheetData`, keyed by row index, **in document
 * order and plural**.
 *
 * A row index can name more than one element — SpreadsheetML does not forbid two
 * `<row r="1">`, and unnumbered rows can be attributed to a row by their cells.
 * Keeping only one of them made the writer disagree with the reader, which never
 * resolves a whole row at all: `parse_xlsx` keys every `<c r=…>` into a map as it
 * scans, so precedence is settled independently *per coordinate*. With a styled
 * `A1` in the first element and a `D1` in the second, the reader shows the first
 * element's `A1`, while a writer that had picked one span saw no `A1` in it and
 * inserted a fresh, unstyled one — the visible number kept its value but lost its
 * currency format, and the sheet gained a duplicate coordinate.
 */
export function scan_rows(
    xml: string,
    from: number,
    to: number,
    options?: ScanRowsOptions,
): Map<number, Span[]> {
    const out = new Map<number, Span[]>();
    const add = (index: number, span: Span): void => {
        const list = out.get(index);
        if (list) list.push(span);
        else out.set(index, [span]);
    };
    const ignorable = ignorable_ranges(xml, from, to);
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<row', pos);
        if (start === -1 || start >= to) break;
        const skip_to = ignorable_end(ignorable, start);
        if (skip_to !== undefined) { pos = skip_to; continue; }
        if (!is_tag_boundary(xml[start + 4])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1 || tag_end >= to) break;
        const open_tag = xml.slice(start, tag_end + 1);
        const r = get_attr(open_tag, 'r');
        const row_index = r !== null && ROW_NUMBER_RE.test(r) ? Number(r) - 1 : null;
        if (is_self_closing(xml, start, tag_end)) {
            // Nothing inside to infer a row number from, and nothing to edit either.
            if (row_index !== null || options?.on_row) {
                const span = {
                    start,
                    end: tag_end + 1,
                    inner_start: tag_end + 1,
                    inner_end: tag_end + 1,
                    open_tag,
                };
                options?.on_row?.(span);
                if (row_index !== null) add(row_index, span);
            }
            pos = tag_end + 1;
            continue;
        }
        const end_tag = end_tag_after(xml, 'row', tag_end, ignorable);
        if (end_tag === null || end_tag[1] > to) break;
        const [close, after_close] = end_tag;
        // `<c r>` is the sole coordinate authority. Claim this span for every row
        // its cells name as well as for a written `<row r>`: otherwise a legal
        // `<row r="1"><c r="A2"/></row>` is visible at A2 to the reader but absent
        // from the writer's row map, and editing it synthesizes a duplicate A2.
        // Plural because one row element may contain cells naming several rows.
        const span = { start, end: after_close, inner_start: tag_end + 1, inner_end: close, open_tag };
        options?.on_row?.(span);
        if (row_index !== null) add(row_index, span);
        let cell_rows: Set<number> | undefined;
        scan_cell_elements(
            xml,
            tag_end + 1,
            close,
            ignorable,
            (reference, cell_end, inner_start, inner_end, cell_open_tag) => {
                options?.on_reference?.(reference, cell_open_tag, span);
                if (reference.kind !== 'valid') return;
                const { row, col } = reference;
                options?.on_coordinate?.(row, col, span);
                cell_rows ??= new Set();
                cell_rows.add(row);
                if (options?.on_cell && (options.capture_cell?.(row, col) ?? true)) {
                    options.on_cell(row, col, {
                        start: reference.start,
                        end: cell_end,
                        inner_start,
                        inner_end,
                        open_tag: cell_open_tag,
                    }, span);
                }
            },
        );
        if (cell_rows) {
            for (const index of cell_rows) {
                if (index !== row_index) add(index, span);
            }
        }
        pos = after_close;
    }
    return out;
}

/**
 * Locate every `<c>` element inside one row's inner range, keyed by column index.
 *
 * With `row`, cells naming a different row are skipped. Without it, the earliest
 * cell for each column is returned so a writer can place a new cell in column order
 * across a mixed-row owner. One row element may contain cells naming several rows,
 * whether or not its own `r` attribute is present or agrees.
 */
export function scan_cells(xml: string, from: number, to: number, row?: number): Map<number, Span> {
    const out = new Map<number, Span>();
    scan_cell_elements(
        xml,
        from,
        to,
        ignorable_ranges(xml, from, to),
        (reference, end, inner_start, inner_end, open_tag) => {
            if (reference.kind !== 'valid' || (row !== undefined && reference.row !== row)) return;
            const span = {
                start: reference.start,
                end,
                inner_start,
                inner_end,
                open_tag,
            };
            const existing = out.get(reference.col);
            if (row !== undefined || existing === undefined || span.start < existing.start) {
                out.set(reference.col, span);
            }
        },
    );
    return out;
}

export function letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
}

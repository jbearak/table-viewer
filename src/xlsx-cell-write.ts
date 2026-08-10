import { find_tag_end, is_tag_boundary, is_self_closing } from './parse-xlsx';

/**
 * Surgical, `putexcel`-style cell writes into a worksheet's OOXML.
 *
 * The design constraint that shapes this whole file: **we never deserialize the
 * worksheet into a model and re-serialize it.** A round-trip through any object
 * model — ours or a library's — can only preserve the features that model knows
 * about, so every unmodelled feature (conditional formatting, data validation,
 * sparklines, pivot caches, drawing anchors, autofilter state, protection,
 * custom XML) is silently dropped on save. Here, an untouched byte range of the
 * worksheet XML is copied through verbatim, so preservation is a property of the
 * algorithm rather than a checklist we have to keep up to date. Parts other than
 * the edited worksheet are never even read (see `xlsx-package.ts`).
 *
 * The unit of edit is one `<c>` element. For each edited cell we either splice a
 * replacement `<c>` over the existing one, or synthesize a new `<c>` (and, if
 * needed, a new `<row>`) at the correct sorted position. Everything between
 * splices is untouched original text.
 */

/** A single cell edit, in canonical source coordinates (0-based, unprojected). */
export interface XlsxCellEdit {
    readonly row: number;
    readonly col: number;
    /** The raw text the user typed. Empty string clears the cell's value. */
    readonly value: string;
}

/** Strings written to the workbook go inline, so the writer never needs the shared string table. */
export interface XlsxWriteOptions {
    /** 0 = 1900 date system, 1 = 1904. Governs date → serial conversion. */
    readonly datemode: 0 | 1;
    /**
     * True when the existing style at this cell renders as a date. The writer
     * consults this to decide whether a date-looking input should become a
     * serial (keeping the cell's date format) or a plain string.
     */
    readonly is_date_style: (xf_index: number) => boolean;
}

const MS_PER_DAY = 86400000;
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function encode_xml(s: string): string {
    return s
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        // Control characters XML 1.0 forbids outright: they have no escape, so a
        // numeric reference would be just as invalid as the raw byte. Excel drops
        // them on paste too. A user pasting from a terminal or a PDF can carry
        // one in without ever seeing it, and the result would be a worksheet part
        // no reader accepts — a corrupt workbook from one invisible character.
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** Convert a 0-based column index to its letter form (0 → A, 26 → AA). */
export function col_index_to_letter(index: number): string {
    let n = index + 1;
    let out = '';
    while (n > 0) {
        const rem = (n - 1) % 26;
        out = String.fromCharCode(65 + rem) + out;
        n = Math.floor((n - 1) / 26);
    }
    return out;
}

/**
 * Excel accepts a narrow set of unambiguous date spellings. We deliberately do
 * NOT attempt locale-sensitive parsing: `03/04/2024` is March 4th to one user and
 * April 3rd to another, and silently picking one would corrupt data in a way the
 * user cannot see. Ambiguous input stays a string, which is visible and
 * correctable; a wrong date is neither.
 */
const ISO_DATE_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?Z?)?$/;

/**
 * Convert an ISO date string to an Excel serial, or null if not an ISO date.
 *
 * The 1900 system reserves serial 60 for 1900-02-29, a day that never existed —
 * Lotus 1-2-3 had the bug and Excel kept it for compatibility. That makes the
 * serial→date map non-injective around the boundary, so going backwards needs a
 * deliberate tie-break: dates on or after 1900-03-01 get the +1 shift, and
 * 1900-02-28 maps to 59 (the real day) rather than 60 (the fictitious one).
 * Nothing round-trips to 60; a workbook containing it still reads back as
 * 1900-02-28, we just never write it.
 */
export function iso_to_serial(text: string, datemode: 0 | 1): number | null {
    const m = ISO_DATE_RE.exec(text.trim());
    if (!m) return null;
    const [, y, mo, d, hh, mm, ss, ms] = m;
    const year = Number(y), month = Number(mo), day = Number(d);
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const utc = Date.UTC(
        year, month - 1, day,
        hh ? Number(hh) : 0,
        mm ? Number(mm) : 0,
        ss ? Number(ss) : 0,
        ms ? Number(ms.padEnd(3, '0')) : 0,
    );
    if (!Number.isFinite(utc)) return null;
    // Reject inputs that rolled over (e.g. 2024-02-31 → March 2nd). Silently
    // accepting a rollover would write a date the user never typed.
    const back = new Date(utc);
    if (back.getUTCFullYear() !== year || back.getUTCMonth() !== month - 1 || back.getUTCDate() !== day) {
        return null;
    }
    if (datemode === 1) {
        return (utc - EXCEL_1904_EPOCH_MS) / MS_PER_DAY;
    }
    const serial = (utc - EXCEL_1900_EPOCH_MS) / MS_PER_DAY;
    // See the doc comment: only dates strictly after the fictitious 1900-02-29
    // carry the compatibility shift.
    return serial >= 60 ? serial + 1 : serial;
}

/**
 * Excel's own numeric literal grammar — deliberately stricter than `Number()`.
 *
 * Redundant leading zeros are excluded on purpose: `007`, a zip code, a phone
 * extension and an account id are all things a user types *as typed*, and
 * storing them as numbers loses the zeros visibly and irreversibly. `0`, `0.5`
 * and `-0.5` are still numbers — a single leading zero before a decimal point is
 * a spelling of the value, not padding. This matches what editing the same text
 * in a CSV does, where it round-trips verbatim.
 */
const NUMBER_RE = /^[+-]?((0|[1-9]\d*)(\.\d*)?|\.\d+)([eE][+-]?\d+)?$/;

/**
 * Decide how one typed string is stored, given the cell's existing style.
 *
 * Per the agreed `putexcel` semantics the cell keeps its existing `s=` style
 * index in every case — we are changing the value, not the formatting. Type
 * inference only decides what goes between `<v>` and `</v>` and what `t=` says.
 */
export function classify_value(
    value: string,
    xf_index: number,
    options: XlsxWriteOptions,
): { kind: 'empty' } | { kind: 'number'; text: string } | { kind: 'string'; text: string } {
    if (value === '') return { kind: 'empty' };

    // A date spelling is stored as a serial only when the cell is already
    // formatted as a date. Writing a bare serial into a General cell would show
    // the user "45000" where they typed a date — visibly wrong. Under a date
    // style the serial and the format agree, so it renders as they typed it.
    const serial = iso_to_serial(value, options.datemode);
    if (serial !== null && options.is_date_style(xf_index)) {
        return { kind: 'number', text: String(serial) };
    }

    if (NUMBER_RE.test(value.trim())) {
        const n = Number(value.trim());
        if (Number.isFinite(n)) return { kind: 'number', text: value.trim() };
    }

    return { kind: 'string', text: value };
}

/**
 * Build the replacement `<c>` element for one cell.
 *
 * Strings are written as `t="inlineStr"` rather than appended to
 * `xl/sharedStrings.xml`. That keeps the edit local to a single part: touching
 * the SST would mean rewriting it, bumping its `count`/`uniqueCount`, and — since
 * every other sheet's `t="s"` cells index into it — accepting that a mistake
 * there corrupts sheets the user never opened. `inlineStr` is fully standard,
 * Excel writes it itself, and it confines the blast radius of an edit to the one
 * worksheet being saved.
 */
function build_cell_xml(
    row: number,
    col: number,
    value: string,
    xf_index: number | null,
    options: XlsxWriteOptions,
): string {
    const ref = `${col_index_to_letter(col)}${row + 1}`;
    const style_attr = xf_index !== null && xf_index !== 0 ? ` s="${xf_index}"` : '';
    const classified = classify_value(value, xf_index ?? 0, options);
    switch (classified.kind) {
        case 'empty':
            // A styled-but-valueless `<c>` is retained rather than deleted so the
            // cell keeps its formatting, borders and fill after being cleared —
            // exactly what Delete does in Excel, and what `putexcel` leaves behind.
            return `<c r="${ref}"${style_attr}/>`;
        case 'number':
            return `<c r="${ref}"${style_attr}><v>${classified.text}</v></c>`;
        case 'string':
            return `<c r="${ref}"${style_attr} t="inlineStr"><is><t xml:space="preserve">${encode_xml(classified.text)}</t></is></c>`;
    }
}

/** A located element in the worksheet XML: [start, end) byte offsets of the whole element. */
interface Span {
    readonly start: number;
    readonly end: number;
    /** Offset just past the opening tag's `>`; equals `end` for self-closing elements. */
    readonly inner_start: number;
    readonly open_tag: string;
}

/** Locate every `<row>` element in `sheetData`, in document order. */
function scan_rows(xml: string, from: number, to: number): Map<number, Span> {
    const out = new Map<number, Span>();
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<row', pos);
        if (start === -1 || start >= to) break;
        if (!is_tag_boundary(xml[start + 4])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) break;
        const open_tag = xml.slice(start, tag_end + 1);
        const r = /\br="(\d+)"/.exec(open_tag);
        if (is_self_closing(xml, start, tag_end)) {
            if (r) out.set(Number(r[1]) - 1, { start, end: tag_end + 1, inner_start: tag_end + 1, open_tag });
            pos = tag_end + 1;
            continue;
        }
        const close = xml.indexOf('</row>', tag_end);
        if (close === -1) break;
        if (r) out.set(Number(r[1]) - 1, { start, end: close + 6, inner_start: tag_end + 1, open_tag });
        pos = close + 6;
    }
    return out;
}

/** Locate every `<c>` element inside one row's inner range, keyed by column index. */
function scan_cells(xml: string, from: number, to: number): Map<number, Span> {
    const out = new Map<number, Span>();
    let pos = from;
    while (pos < to) {
        const start = xml.indexOf('<c', pos);
        if (start === -1 || start >= to) break;
        if (!is_tag_boundary(xml[start + 2])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1 || tag_end >= to) break;
        const open_tag = xml.slice(start, tag_end + 1);
        const r = /\br="([A-Z]+)(\d+)"/.exec(open_tag);
        const col = r ? letter_to_index(r[1]) : null;
        if (is_self_closing(xml, start, tag_end)) {
            if (col !== null) out.set(col, { start, end: tag_end + 1, inner_start: tag_end + 1, open_tag });
            pos = tag_end + 1;
            continue;
        }
        const close = xml.indexOf('</c>', tag_end);
        if (close === -1) break;
        if (col !== null) out.set(col, { start, end: close + 4, inner_start: tag_end + 1, open_tag });
        pos = close + 4;
    }
    return out;
}

function letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
}

/** A grouped formula's `ref` range, half-inclusive of nothing — both corners count. */
interface GroupedRange {
    readonly kind: 'shared' | 'array';
    readonly start_row: number;
    readonly start_col: number;
    readonly end_row: number;
    readonly end_col: number;
}

/**
 * The `ref` range of every shared/array formula on the sheet.
 *
 * An array formula writes one `<f t="array" ref="A1:B2">` on its top-left cell;
 * the other cells in that range hold a value and no `<f>` at all. So the
 * per-cell check below cannot see them, and an edit to one would drop a member
 * of the group without ever meeting a formula. A shared master's `ref` spans its
 * followers the same way — those *do* carry an `<f>`, but scanning the range
 * catches them uniformly and costs one pass either way.
 *
 * Kept as bounds rather than expanded into a set of coordinates: a `ref` is
 * whatever the writing application put there, and a whole-column or
 * whole-sheet range (`A1:XFD1048576`) is legal and not rare. Materializing that
 * is billions of entries for a workbook we may not even be editing near.
 */
function grouped_formula_ranges(xml: string): GroupedRange[] {
    const ranges: GroupedRange[] = [];
    for (const m of xml.matchAll(/<f\b[^>]*>/g)) {
        const type = /\bt="([^"]*)"/.exec(m[0]);
        const kind = type?.[1];
        if (kind !== 'shared' && kind !== 'array') continue;
        const ref = /\bref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(m[0]);
        if (!ref) continue;
        const start_col = letter_to_index(ref[1]);
        const start_row = Number(ref[2]) - 1;
        ranges.push({
            kind,
            start_row,
            start_col,
            end_col: ref[3] !== undefined ? letter_to_index(ref[3]) : start_col,
            end_row: ref[4] !== undefined ? Number(ref[4]) - 1 : start_row,
        });
    }
    return ranges;
}

/**
 * Why an edit inside a shared or array formula is refused.
 *
 * Its `<f>` is not local to the cell: a shared master defines the formula its
 * followers reference by `si`, and an array formula's `ref` spans a range.
 * Dropping either leaves the rest of the group pointing at a definition that no
 * longer exists — cells that silently stop calculating, or a workbook Excel
 * offers to repair. Handling those groups properly means rewriting cells the
 * user did not edit, which is the opposite of a surgical save, so this refuses
 * and says why instead of quietly corrupting the sheet.
 */
function grouped_formula_error(row: number, col: number, kind: 'shared' | 'array'): Error {
    return new Error(
        `Cannot edit ${cell_reference(row, col)}: it is part of `
        + `${kind === 'array' ? 'an array' : 'a shared'} formula. `
        + 'Clear the formula in Excel first.',
    );
}

/** `'shared'` / `'array'` when `row`/`col` falls inside some group's `ref`. */
function grouped_range_kind(
    ranges: readonly GroupedRange[],
    row: number,
    col: number,
): 'shared' | 'array' | null {
    for (const r of ranges) {
        if (row >= r.start_row && row <= r.end_row && col >= r.start_col && col <= r.end_col) {
            return r.kind;
        }
    }
    return null;
}

/**
 * `'shared'` / `'array'` when the cell's `<f>` belongs to a multi-cell group.
 *
 * Both a shared master (`t="shared"` with an `si`) and a shared *follower* (an
 * empty `<f t="shared" si="..."/>`) count: replacing either breaks the group.
 */
function grouped_formula_kind(cell_inner: string): 'shared' | 'array' | null {
    const open = /<f\b[^>]*>/.exec(cell_inner);
    if (!open) return null;
    const type = /\bt="([^"]*)"/.exec(open[0]);
    if (type?.[1] === 'shared') return 'shared';
    if (type?.[1] === 'array') return 'array';
    return null;
}

/** `A1`-style reference for a message a user will read. */
function cell_reference(row: number, col: number): string {
    return `${col_index_to_letter(col)}${row + 1}`;
}

function existing_style(open_tag: string): number | null {
    const m = /\bs="(\d+)"/.exec(open_tag);
    return m ? Number(m[1]) : null;
}

/**
 * Did applying edits drop a formula?
 *
 * Counted rather than tracked through `apply_cell_edits`, which stays a pure
 * string→string function. `<f>` is the only element in a worksheet part whose
 * name is exactly `f`, so a boundary-anchored count is exact; the tag-boundary
 * test is what keeps `<filters>` and friends out of it.
 */
export function formula_count(xml: string): number {
    let count = 0;
    let pos = 0;
    while (true) {
        const at = xml.indexOf('<f', pos);
        if (at === -1) return count;
        if (is_tag_boundary(xml[at + 2])) count += 1;
        pos = at + 2;
    }
}

/** One pending splice: replace `[start, end)` with `text`. */
interface Splice { start: number; end: number; text: string }

/**
 * Apply cell edits to one worksheet's XML, returning the new XML.
 *
 * Throws if the document has no `<sheetData>` — that is not a worksheet we
 * understand well enough to edit safely, and refusing is better than writing a
 * file Excel will reject.
 */
export function apply_cell_edits(
    xml: string,
    edits: readonly XlsxCellEdit[],
    options: XlsxWriteOptions,
): string {
    if (edits.length === 0) return xml;

    const sd_open = find_sheet_data_open(xml);
    if (!sd_open) throw new Error('Worksheet XML has no <sheetData> element');
    const { inner_start, inner_end, self_closing, element_start, element_end } = sd_open;

    // An empty `<sheetData/>` has nowhere to splice into, so expand it to a pair
    // first and re-derive the offsets from the expanded document.
    if (self_closing) {
        const expanded = xml.slice(0, element_start) + '<sheetData></sheetData>' + xml.slice(element_end);
        return apply_cell_edits(expanded, edits, options);
    }

    const rows = scan_rows(xml, inner_start, inner_end);

    // Group edits by row so each row is scanned for cells at most once.
    const by_row = new Map<number, XlsxCellEdit[]>();
    for (const e of edits) {
        const list = by_row.get(e.row);
        if (list) list.push(e);
        else by_row.set(e.row, [e]);
    }

    const splices: Splice[] = [];
    const new_rows: Array<{ row: number; text: string }> = [];
    // Scanned once for the whole sheet, because an array formula's members are
    // only identifiable from the master's `ref` — see `grouped_formula_ranges`.
    const grouped_ranges = grouped_formula_ranges(xml);

    // Ahead of every row and cell lookup, because a grouped formula's range can
    // cover coordinates that have no `<c>` — and, if the whole row is sparse, no
    // `<row>` either. Left inside the existing-cell branch, those edits reached
    // the insertion paths instead and wrote a literal into the middle of an array
    // formula's result range, which is the corruption the refusal exists to stop.
    for (const e of edits) {
        const grouped = grouped_range_kind(grouped_ranges, e.row, e.col);
        if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
    }

    for (const [row, row_edits] of by_row) {
        const row_span = rows.get(row);
        if (!row_span) {
            // Whole row absent: synthesize it, with its cells in column order.
            const cells = [...row_edits]
                .sort((a, b) => a.col - b.col)
                .map((e) => build_cell_xml(e.row, e.col, e.value, null, options))
                .join('');
            new_rows.push({ row, text: `<row r="${row + 1}">${cells}</row>` });
            continue;
        }

        const cells = scan_cells(xml, row_span.inner_start, row_span.end);
        const inserts: Array<{ col: number; text: string }> = [];

        for (const e of row_edits) {
            const cell_span = cells.get(e.col);
            if (cell_span) {
                // Existing cell: keep its style index, replace the element. Any
                // plain `<f>` it carried is dropped with it — the agreed putexcel
                // behavior, where writing a value replaces the formula.
                //
                // A *shared* or *array* formula is different, and refused. Its `<f>`
                // is not local to the cell: a shared master defines the formula its
                // followers reference by `si`, and an array formula's `ref` spans a
                // range of cells. Dropping either leaves the rest of the group
                // pointing at a definition that no longer exists — cells that
                // silently stop calculating, or a workbook Excel offers to repair.
                // Handling those groups properly means rewriting cells the user did
                // not edit, which is the opposite of a surgical save, so this
                // refuses and says why instead of quietly corrupting the sheet.
                // The range sweep above already covered every cell a group's `ref`
                // names. This catches the one it cannot see: a shared *follower*,
                // whose `<f t="shared" si="…"/>` carries no `ref` of its own.
                const grouped = grouped_formula_kind(
                    xml.slice(cell_span.inner_start, cell_span.end),
                );
                if (grouped) throw grouped_formula_error(e.row, e.col, grouped);
                const xf = existing_style(cell_span.open_tag);
                splices.push({
                    start: cell_span.start,
                    end: cell_span.end,
                    text: build_cell_xml(e.row, e.col, e.value, xf, options),
                });
            } else {
                inserts.push({ col: e.col, text: build_cell_xml(e.row, e.col, e.value, null, options) });
            }
        }

        // New cells within an existing row must land in ascending column order:
        // Excel tolerates out-of-order `<c>` in many builds but the schema
        // specifies sorted, and some consumers (and Excel's own repair check) do
        // not. Insert each before the first existing cell of a higher column,
        // falling back to the row's end.
        // Sorted, because several inserts landing in the same gap share a splice
        // offset and `apply_splices` then keeps them in the order they arrived —
        // which is the caller's edit order, not the column order the schema wants.
        inserts.sort((a, b) => a.col - b.col);
        if (inserts.length > 0 && row_span.inner_start === row_span.end) {
            // `<row r="5" ht="20"/>` — a valid empty row, which is what a row given
            // a height or a format but no cells looks like. There is no `</row>` to
            // insert before, so the element is replaced by a paired one keeping its
            // attributes; computing an offset from `'</row>'.length` here would
            // splice into the middle of the opening tag and emit malformed XML.
            const attributes = row_span.open_tag.slice(
                '<row'.length,
                row_span.open_tag.length - '/>'.length,
            );
            splices.push({
                start: row_span.start,
                end: row_span.end,
                text: `<row${attributes}>${inserts.map((i) => i.text).join('')}</row>`,
            });
            continue;
        }
        for (const ins of inserts) {
            let at = row_span.end - '</row>'.length;
            let best: number | undefined;
            for (const [col, span] of cells) {
                if (col > ins.col && (best === undefined || span.start < best)) best = span.start;
            }
            if (best !== undefined) at = best;
            splices.push({ start: at, end: at, text: ins.text });
        }
    }

    // New rows are likewise inserted in ascending row order — and sorted for the
    // same reason: several new rows before the same existing row share an offset.
    new_rows.sort((a, b) => a.row - b.row);
    for (const nr of new_rows) {
        let at = inner_end;
        let best: number | undefined;
        for (const [r, span] of rows) {
            if (r > nr.row && (best === undefined || span.start < best)) best = span.start;
        }
        if (best !== undefined) at = best;
        splices.push({ start: at, end: at, text: nr.text });
    }

    return apply_splices(xml, splices);
}

/**
 * Apply splices right-to-left so each splice's offsets stay valid — they were all
 * computed against the original string. Ties (two zero-width inserts at the same
 * offset) keep their relative order, which matters when two new cells insert
 * before the same existing cell.
 *
 * A replacement and an insert can share a start offset: inserting a new cell
 * before existing `C1` puts the insert at `C1`'s start, and editing `C1` itself
 * replaces from there. Applying right-to-left, the *replacement* has to go first
 * — otherwise the insert lands at that offset and the replacement, still holding
 * the original `[start, end)`, overwrites the text just inserted. So among ties,
 * nonzero-width splices sort ahead of zero-width ones.
 */
function apply_splices(xml: string, splices: Splice[]): string {
    const is_insert = (s: Splice) => (s.end > s.start ? 0 : 1);
    const ordered = splices
        .map((s, i) => ({ s, i }))
        .sort((a, b) => (b.s.start - a.s.start)
            || (is_insert(a.s) - is_insert(b.s))
            || (b.i - a.i));
    let out = xml;
    for (const { s } of ordered) {
        out = out.slice(0, s.start) + s.text + out.slice(s.end);
    }
    return out;
}

function find_sheet_data_open(xml: string): {
    inner_start: number;
    inner_end: number;
    self_closing: boolean;
    element_start: number;
    element_end: number;
} | null {
    let pos = 0;
    while (true) {
        const start = xml.indexOf('<sheetData', pos);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + 10])) { pos = start + 1; continue; }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return {
                inner_start: tag_end + 1,
                inner_end: tag_end + 1,
                self_closing: true,
                element_start: start,
                element_end: tag_end + 1,
            };
        }
        const close = xml.indexOf('</sheetData>', tag_end);
        if (close === -1) return null;
        return {
            inner_start: tag_end + 1,
            inner_end: close,
            self_closing: false,
            element_start: start,
            element_end: close + '</sheetData>'.length,
        };
    }
}

/**
 * Widen `<dimension ref="...">` to cover newly written cells.
 *
 * Excel treats `dimension` as a hint and recomputes it on load, but a stale one
 * makes Ctrl+End land short of the user's new data and confuses other readers —
 * including our own `parse_dimension`. Only widening is safe: shrinking would
 * require knowing that no other cell still occupies the old extent.
 */
export function widen_dimension(
    xml: string,
    min_row: number,
    min_col: number,
    max_row: number,
    max_col: number,
): string {
    const start = xml.indexOf('<dimension');
    if (start === -1 || !is_tag_boundary(xml[start + 10])) return xml;
    const tag_end = find_tag_end(xml, start);
    if (tag_end === -1) return xml;
    const open_tag = xml.slice(start, tag_end + 1);
    const m = /\bref="([A-Z]+)(\d+)(?::([A-Z]+)(\d+))?"/.exec(open_tag);
    if (!m) return xml;
    const cur_start_col = letter_to_index(m[1]);
    const cur_start_row = Number(m[2]) - 1;
    const cur_end_col = m[3] !== undefined ? letter_to_index(m[3]) : cur_start_col;
    const cur_end_row = m[4] !== undefined ? Number(m[4]) - 1 : cur_start_row;
    // Both corners, not just the bottom-right one: a sheet whose used range starts
    // at C3 and gets a value written into A1 still has to grow up and to the left,
    // or the recorded range excludes the cell we just wrote and readers that trust
    // `<dimension>` never see it.
    const start_col = Math.min(cur_start_col, min_col);
    const start_row = Math.min(cur_start_row, min_row);
    const end_col = Math.max(cur_end_col, max_col);
    const end_row = Math.max(cur_end_row, max_row);
    if (
        start_col === cur_start_col && start_row === cur_start_row
        && end_col === cur_end_col && end_row === cur_end_row
    ) return xml;
    const ref = `${col_index_to_letter(start_col)}${start_row + 1}:${col_index_to_letter(end_col)}${end_row + 1}`;
    const replaced = open_tag.replace(/\bref="[^"]*"/, `ref="${ref}"`);
    return xml.slice(0, start) + replaced + xml.slice(tag_end + 1);
}

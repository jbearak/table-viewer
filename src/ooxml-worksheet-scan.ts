import { decode_xml } from './ooxml-xml';

const LESS_THAN = 0x3c;
const GREATER_THAN = 0x3e;
const SLASH = 0x2f;
const EQUALS = 0x3d;
const DOUBLE_QUOTE = 0x22;
const SINGLE_QUOTE = 0x27;
const AMPERSAND = 0x26;
const ROW_NUMBER_RE = /^\d+$/;
const MAX_WORKSHEET_ROWS = 1_048_576;
const MAX_WORKSHEET_COLUMNS = 16_384;

/**
 * A package worksheet entry in the representation consumed by the shared
 * scanner. CFB already supplies bytes, so the byte-native boundary is an
 * identity operation rather than a whole-part UTF-8 decode.
 */
export function worksheet_scan_input(content: Uint8Array): Uint8Array {
    return content;
}

/** Decode only the byte range a caller actually consumes. */
export function utf8_text(xml: Uint8Array, from = 0, to = xml.length): string {
    return Buffer.from(xml.buffer, xml.byteOffset + from, to - from).toString('utf8');
}

function bytes_view(xml: Uint8Array): Buffer {
    return Buffer.isBuffer(xml)
        ? xml
        : Buffer.from(xml.buffer, xml.byteOffset, xml.byteLength);
}

const ASCII_NEEDLES = new Map<string, Buffer>();

/** Native byte search for an ASCII XML token in `[from, to)`. */
export function index_of_bytes(
    xml: Uint8Array,
    needle: string,
    from = 0,
    to = xml.length,
): number {
    const source = bytes_view(xml);
    const bytes = to < source.length ? source.subarray(0, to) : source;
    if (needle.length === 1) return bytes.indexOf(needle.charCodeAt(0), from);
    let encoded = ASCII_NEEDLES.get(needle);
    if (encoded === undefined) {
        encoded = Buffer.from(needle, 'ascii');
        ASCII_NEEDLES.set(needle, encoded);
    }
    return bytes.indexOf(encoded, from);
}

export function starts_with_bytes(xml: Uint8Array, needle: string, at: number): boolean {
    if (at < 0 || at + needle.length > xml.length) return false;
    for (let i = 0; i < needle.length; i++) {
        if (xml[at + i] !== needle.charCodeAt(i)) return false;
    }
    return true;
}

function is_xml_whitespace(code: number | undefined): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** Check whether the byte after a tag-name match is a valid tag delimiter. */
export function is_tag_boundary(code: number | undefined): boolean {
    return code === GREATER_THAN || code === SLASH || is_xml_whitespace(code);
}

/** Find the `>` closing a tag inside `[start, to)`, skipping quoted values. */
export function find_tag_end(xml: Uint8Array, start: number, to = xml.length): number {
    let quote = 0;
    for (let i = start; i < to; i++) {
        const code = xml[i];
        if (quote !== 0) {
            if (code === quote) quote = 0;
        } else if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
            quote = code;
        } else if (code === GREATER_THAN) {
            return i;
        }
    }
    return -1;
}

/** Whether `[start, tag_end]` is a self-closing opening tag. */
export function is_self_closing(xml: Uint8Array, start: number, tag_end: number): boolean {
    for (let i = tag_end - 1; i > start; i--) {
        const code = xml[i];
        if (code === SLASH) return true;
        if (!is_xml_whitespace(code)) return false;
    }
    return false;
}

/** A quoted attribute value's raw byte range. */
export interface AttributeValueSpan {
    readonly start: number;
    readonly end: number;
}

/** Locate one exact attribute on an opening tag without decoding the tag. */
export function attribute_value_span(
    xml: Uint8Array,
    tag_start: number,
    tag_end: number,
    attr: string,
): AttributeValueSpan | null {
    if (xml[tag_start] !== LESS_THAN) return null;
    let i = tag_start + (xml[tag_start + 1] === SLASH ? 2 : 1);
    while (i < tag_end) {
        const code = xml[i];
        if (is_xml_whitespace(code) || code === SLASH || code === GREATER_THAN) break;
        i++;
    }
    while (i < tag_end) {
        while (i < tag_end && is_xml_whitespace(xml[i])) i++;
        if (i >= tag_end || xml[i] === SLASH || xml[i] === GREATER_THAN) return null;

        const name_start = i;
        while (i < tag_end) {
            const code = xml[i];
            if (is_xml_whitespace(code) || code === EQUALS || code === SLASH || code === GREATER_THAN) break;
            i++;
        }
        const name_end = i;
        while (i < tag_end && is_xml_whitespace(xml[i])) i++;
        if (xml[i] !== EQUALS) {
            if (i === name_start) i++;
            continue;
        }
        i++;
        while (i < tag_end && is_xml_whitespace(xml[i])) i++;
        const quote = xml[i];
        if (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE) {
            while (i < tag_end && !is_xml_whitespace(xml[i])) i++;
            continue;
        }
        const value_start = ++i;
        while (i < tag_end && xml[i] !== quote) i++;
        if (i >= tag_end) return null;
        if (name_end - name_start === attr.length) {
            let matches = true;
            for (let j = 0; j < attr.length; j++) {
                if (xml[name_start + j] !== attr.charCodeAt(j)) { matches = false; break; }
            }
            if (matches) return { start: value_start, end: i };
        }
        i++;
    }
    return null;
}

/** Read and XML-decode one exact opening-tag attribute. */
export function get_tag_attr(
    xml: Uint8Array,
    tag_start: number,
    tag_end: number,
    attr: string,
): string | null {
    const value = attribute_value_span(xml, tag_start, tag_end, attr);
    if (value === null) return null;
    const text = utf8_text(xml, value.start, value.end);
    return text.indexOf('&') === -1 ? text : decode_xml(text);
}

function raw_value_has_ampersand(xml: Uint8Array, value: AttributeValueSpan): boolean {
    for (let i = value.start; i < value.end; i++) if (xml[i] === AMPERSAND) return true;
    return false;
}

/** How one cell opening tag spells (or omits) its coordinate. */
export type ScannedCellReference =
    | { readonly kind: 'valid'; readonly row: number; readonly col: number; readonly start: number }
    | { readonly kind: 'missing'; readonly start: number }
    | { readonly kind: 'invalid'; readonly reference: string; readonly start: number };

function invalid_reference(xml: Uint8Array, value: AttributeValueSpan, start: number): ScannedCellReference {
    return { kind: 'invalid', reference: utf8_text(xml, value.start, value.end), start };
}

/**
 * Resolve one decoded `r` value without normalizing malformed spellings.
 *
 * SpreadsheetML coordinates are canonical uppercase letters followed by a
 * one-based row with no leading zeroes. The format itself ends at XFD1048576;
 * these are format limits, distinct from Table Viewer's smaller product caps.
 */
function resolve_cell_reference_bytes(
    xml: Uint8Array,
    value: AttributeValueSpan | null,
    start: number,
): ScannedCellReference {
    if (value === null) return { kind: 'missing', start };
    if (raw_value_has_ampersand(xml, value)) {
        return resolve_cell_reference(decode_xml(utf8_text(xml, value.start, value.end)), start);
    }

    let i = value.start;
    let column = 0;
    while (i < value.end) {
        const code = xml[i];
        if (code < 0x41 || code > 0x5a) break;
        column = column * 26 + code - 0x40;
        if (column > MAX_WORKSHEET_COLUMNS) return invalid_reference(xml, value, start);
        i++;
    }
    if (i === value.start || i === value.end || xml[i] === 0x30) {
        return invalid_reference(xml, value, start);
    }

    let row = 0;
    for (; i < value.end; i++) {
        const digit = xml[i] - 0x30;
        if (digit < 0 || digit > 9) return invalid_reference(xml, value, start);
        row = row * 10 + digit;
        if (row > MAX_WORKSHEET_ROWS) return invalid_reference(xml, value, start);
    }
    return { kind: 'valid', row: row - 1, col: column - 1, start };
}

/** Resolve a decoded coordinate, used only when its raw spelling contains entities. */
function resolve_cell_reference(ref: string, start: number): ScannedCellReference {
    let i = 0;
    let column = 0;
    while (i < ref.length) {
        const code = ref.charCodeAt(i);
        if (code < 0x41 || code > 0x5a) break;
        column = column * 26 + code - 0x40;
        if (column > MAX_WORKSHEET_COLUMNS) return { kind: 'invalid', reference: ref, start };
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

/** A located element in worksheet XML: true `[start, end)` UTF-8 byte offsets. */
export interface Span {
    readonly start: number;
    readonly end: number;
    /** Offset just past the opening tag's `>`; equals `end` for self-closing elements. */
    readonly inner_start: number;
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

export interface OpeningTagSpan {
    readonly start: number;
    readonly end: number;
}

/** Decode one span's opening tag only. */
export function opening_tag_text(xml: Uint8Array, span: Span): string {
    return utf8_text(xml, span.start, span.inner_start);
}

export interface IgnorableRangeIndex {
    readonly length: number;
    start_at(index: number): number;
    end_at(index: number): number;
}

const IGNORABLE_RANGES_PER_CHUNK = 4_096;

class CompactIgnorableRanges implements IgnorableRangeIndex {
    private readonly chunks: Uint32Array[] = [];
    private tail: number[] = [];
    private count = 0;

    get length(): number { return this.count; }

    start_at(index: number): number {
        const chunk_index = Math.floor(index / IGNORABLE_RANGES_PER_CHUNK);
        const offset = (index % IGNORABLE_RANGES_PER_CHUNK) * 2;
        return chunk_index < this.chunks.length
            ? this.chunks[chunk_index][offset]
            : this.tail[offset];
    }

    end_at(index: number): number {
        const chunk_index = Math.floor(index / IGNORABLE_RANGES_PER_CHUNK);
        const offset = (index % IGNORABLE_RANGES_PER_CHUNK) * 2 + 1;
        return chunk_index < this.chunks.length
            ? this.chunks[chunk_index][offset]
            : this.tail[offset];
    }

    append(xml: Uint8Array, start: number, end: number): void {
        if (this.count > 0) {
            const previous = this.count - 1;
            const previous_end = this.end_at(previous);
            // Every scanner needle begins with `<`, so a gap without one can be
            // folded into the surrounding ignored ranges without hiding markup.
            if (start <= previous_end || index_of_bytes(xml, '<', previous_end, start) === -1) {
                this.set_end(previous, end);
                return;
            }
        }
        this.tail.push(start, end);
        this.count++;
        if (this.tail.length === IGNORABLE_RANGES_PER_CHUNK * 2) {
            this.chunks.push(Uint32Array.from(this.tail));
            this.tail = [];
        }
    }

    private set_end(index: number, end: number): void {
        const chunk_index = Math.floor(index / IGNORABLE_RANGES_PER_CHUNK);
        const offset = (index % IGNORABLE_RANGES_PER_CHUNK) * 2 + 1;
        if (chunk_index < this.chunks.length) this.chunks[chunk_index][offset] = end;
        else this.tail[offset] = end;
    }
}

/** Ranges inside `[from, to)` whose contents are text rather than markup. */
export function ignorable_ranges(xml: Uint8Array, from: number, to: number): IgnorableRangeIndex {
    const cursors = [
        { open: '<!--', close: '-->', start: index_of_bytes(xml, '<!--', from, to) },
        { open: '<![CDATA[', close: ']]>', start: index_of_bytes(xml, '<![CDATA[', from, to) },
        { open: '<?', close: '?>', start: index_of_bytes(xml, '<?', from, to) },
    ];
    const out = new CompactIgnorableRanges();
    let resume = from;
    while (resume < to) {
        let candidate: typeof cursors[number] | undefined;
        for (const cursor of cursors) {
            if (cursor.start === -1) continue;
            if (!candidate || cursor.start < candidate.start) candidate = cursor;
        }
        if (!candidate) break;
        const close_start = index_of_bytes(
            xml,
            candidate.close,
            candidate.start + candidate.open.length,
            to,
        );
        const end = close_start === -1 ? to : Math.min(to, close_start + candidate.close.length);
        out.append(xml, candidate.start, end);
        resume = end;

        // Opener-shaped text inside the ignored range is text. Jump every cursor
        // directly to `resume` so memory follows emitted ranges, not raw matches.
        for (const cursor of cursors) {
            if (cursor.start !== -1 && cursor.start < resume) {
                cursor.start = index_of_bytes(xml, cursor.open, resume, to);
            }
        }
    }
    return out;
}

/** Where to resume if `at` falls inside an ignorable range. */
export function ignorable_end(ranges: IgnorableRangeIndex, at: number): number | undefined {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const start = ranges.start_at(mid);
        const end = ranges.end_at(mid);
        if (at < start) hi = mid - 1;
        else if (at < end) return end;
        else lo = mid + 1;
    }
    return undefined;
}

/**
 * The first `needle` at or after `from` that is real markup rather than quoted text.
 *
 * Every raw search in these scanners needs this, not just the ones that find
 * opening tags. Skipping a commented-out `<row>` but then closing the *live* row
 * at a `</row>` inside a comment is the same bug wearing the other shoe: the span
 * ends early, and the edit splices into the comment (silent no-op) or across it
 * (malformed XML, which is worse than either).
 */
export function indexOf_live(
    xml: Uint8Array,
    needle: string,
    from: number,
    ranges: IgnorableRangeIndex,
    to = xml.length,
): number {
    let pos = from;
    while (pos < to) {
        const at = index_of_bytes(xml, needle, pos, to);
        if (at === -1) return -1;
        const skip_to = ignorable_end(ranges, at);
        if (skip_to === undefined) return at;
        pos = skip_to;
    }
    return -1;
}

export function index_of_markup(xml: Uint8Array, needle: string, from = 0): number {
    return indexOf_live(xml, needle, from, ignorable_ranges(xml, 0, xml.length));
}

export function last_index_of_markup(xml: Uint8Array, needle: string): number {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    let found = -1;
    let pos = 0;
    while (true) {
        const at = indexOf_live(xml, needle, pos, ranges);
        if (at === -1) return found;
        found = at;
        pos = at + needle.length;
    }
}

/**
 * Every real `<name …>` opening tag in `[from, to)`.
 *
 * The one way to scan tags here. `matchAll(/<f\b[^>]*>/g)` gets both halves of
 * this wrong: `[^>]*` stops at the first `>`, and a `>` inside a quoted attribute
 * value is legal XML — `x:note="1 > 0"` need not be escaped — so the "tag" it
 * yields is a fragment. And a bare regex has no idea what a comment is, so a
 * commented-out element reads as live. The quote-aware end scan and ignorable
 * ranges together make "live" mean live.
 */
export function* live_tags(
    xml: Uint8Array,
    name: string,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
): Generator<OpeningTagSpan> {
    let pos = from;
    while (pos < to) {
        const at = indexOf_live(xml, `<${name}`, pos, ranges, to);
        if (at === -1 || at >= to) return;
        if (!is_tag_boundary(xml[at + name.length + 1])) { pos = at + 1; continue; }
        const tag_end = find_tag_end(xml, at, to);
        if (tag_end === -1 || tag_end >= to) return;
        yield { start: at, end: tag_end + 1 };
        pos = tag_end + 1;
    }
}

/** Every real whole-document `<name …>` opening tag. */
export function* live_tags_in(xml: Uint8Array, name: string): Generator<OpeningTagSpan> {
    yield* live_tags(xml, name, 0, xml.length, ignorable_ranges(xml, 0, xml.length));
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
 */
export function end_tag_after(
    xml: Uint8Array,
    name: string,
    from: number,
    ranges: IgnorableRangeIndex,
    to = xml.length,
): [number, number] | null {
    let pos = from;
    while (pos < to) {
        const at = indexOf_live(xml, `</${name}`, pos, ranges, to);
        if (at === -1) return null;
        const after = at + name.length + 2;
        if (after < to && xml[after] === GREATER_THAN) return [at, after + 1];
        let gt = after;
        while (gt < to && xml[gt] !== GREATER_THAN) gt++;
        if (gt < to && after < gt) {
            let whitespace_only = true;
            for (let i = after; i < gt; i++) {
                if (!is_xml_whitespace(xml[i])) { whitespace_only = false; break; }
            }
            if (whitespace_only) return [at, gt + 1];
        }
        pos = at + 1;
    }
    return null;
}

/** The first live `<name>` in `[from, to)`, with exact byte spans. */
export function find_first_element(
    xml: Uint8Array,
    name: string,
    from = 0,
    to = xml.length,
): Span | null {
    if (!name.includes(':')) {
        return find_first_element_by_local_name(xml, name, from, to)?.element ?? null;
    }
    const ranges = ignorable_ranges(xml, from, to);
    for (const tag of live_tags(xml, name, from, to, ranges)) {
        const tag_end = tag.end - 1;
        if (is_self_closing(xml, tag.start, tag_end)) {
            return {
                start: tag.start,
                end: tag.end,
                inner_start: tag.end,
                inner_end: tag.end,
            };
        }
        const end_tag = end_tag_after(xml, name, tag.end, ranges, to);
        if (end_tag === null) return null;
        return {
            start: tag.start,
            end: end_tag[1],
            inner_start: tag.end,
            inner_end: end_tag[0],
        };
    }
    return null;
}

/** A live element together with the qualified name used by its opening tag. */
export interface QualifiedElementSpan {
    readonly name: string;
    readonly element: Span;
}

/** Complete direct child elements of `parent`, in document order. */
export function direct_child_elements(
    xml: Uint8Array,
    parent: Span,
): QualifiedElementSpan[] {
    const out: QualifiedElementSpan[] = [];
    const ranges = ignorable_ranges(xml, parent.inner_start, parent.inner_end);
    let position = parent.inner_start;
    while (position < parent.inner_end) {
        const start = indexOf_live(xml, '<', position, ranges, parent.inner_end);
        if (start === -1) break;
        const first = xml[start + 1];
        if (first === undefined || first === SLASH || first === 0x21 || first === 0x3f) {
            position = start + 1;
            continue;
        }
        let name_end = start + 1;
        while (name_end < parent.inner_end && !is_tag_boundary(xml[name_end])) name_end += 1;
        if (name_end >= parent.inner_end || name_end === start + 1) break;
        const name = utf8_text(xml, start + 1, name_end);
        const tag_end = find_tag_end(xml, name_end, parent.inner_end);
        if (tag_end === -1) break;
        if (is_self_closing(xml, start, tag_end)) {
            const end = tag_end + 1;
            out.push({ name, element: { start, end, inner_start: end, inner_end: end } });
            position = end;
            continue;
        }
        const close = end_tag_after(xml, name, tag_end + 1, ranges, parent.inner_end);
        if (close === null) break;
        out.push({
            name,
            element: {
                start,
                end: close[1],
                inner_start: tag_end + 1,
                inner_end: close[0],
            },
        });
        position = close[1];
    }
    return out;
}

/**
 * The first live element whose qualified name has `local_name` as its local
 * part. Worksheet parts may use either the default spreadsheet namespace or an
 * explicit prefix, and opener-shaped text in comments/CDATA is not markup.
 */
export function find_first_element_by_local_name(
    xml: Uint8Array,
    local_name: string,
    from = 0,
    to = xml.length,
): QualifiedElementSpan | null {
    if (local_name.length === 0 || local_name.includes(':')) return null;
    const ranges = ignorable_ranges(xml, from, to);
    for (let start = from; start < to; start += 1) {
        if (xml[start] !== LESS_THAN) continue;
        const skip_to = ignorable_end(ranges, start);
        if (skip_to !== undefined) {
            start = skip_to - 1;
            continue;
        }
        const first = xml[start + 1];
        if (first === undefined || first === SLASH || first === 0x21 || first === 0x3f) continue;
        let name_end = start + 1;
        while (name_end < to && !is_tag_boundary(xml[name_end])) name_end += 1;
        if (name_end === start + 1 || name_end >= to) continue;
        const name = utf8_text(xml, start + 1, name_end);
        const colon = name.lastIndexOf(':');
        if (name.slice(colon + 1) !== local_name || (colon === 0)) continue;
        const tag_end = find_tag_end(xml, name_end, to);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return {
                name,
                element: {
                    start,
                    end: tag_end + 1,
                    inner_start: tag_end + 1,
                    inner_end: tag_end + 1,
                },
            };
        }
        const end_tag = end_tag_after(xml, name, tag_end + 1, ranges, to);
        if (end_tag === null) return null;
        return {
            name,
            element: {
                start,
                end: end_tag[1],
                inner_start: tag_end + 1,
                inner_end: end_tag[0],
            },
        };
    }
    return null;
}

/**
 * The first live section with the legacy reader's exact literal end tag rule.
 * Hyperlinks deliberately keep this distinct from the broader worksheet element
 * scanner because reader/writer agreement includes malformed close spellings.
 */
export function find_element_section(xml: Uint8Array, name: string): Span | null {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    for (const tag of live_tags(xml, name, 0, xml.length, ranges)) {
        const tag_end = tag.end - 1;
        if (is_self_closing(xml, tag.start, tag_end)) {
            return {
                start: tag.start,
                end: tag.end,
                inner_start: tag.end,
                inner_end: tag.end,
            };
        }
        const close = `</${name}>`;
        const close_start = indexOf_live(xml, close, tag.end, ranges);
        if (close_start === -1) return null;
        return {
            start: tag.start,
            end: close_start + close.length,
            inner_start: tag.end,
            inner_end: close_start,
        };
    }
    return null;
}

/** A view over the verbatim content of the first live element. */
export function element_content(
    xml: Uint8Array,
    name: string,
    from = 0,
    to = xml.length,
): Uint8Array | null {
    const element = find_first_element(xml, name, from, to);
    return element === null ? null : xml.subarray(element.inner_start, element.inner_end);
}

type ScannedCellCallback = (
    reference: ScannedCellReference,
    end: number,
    inner_start: number,
    inner_end: number,
) => void;

function next_element_start_by_local_name(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
    local_name: string,
): { readonly start: number; readonly name: string } | null {
    for (let i = from; i + local_name.length + 1 < to; i++) {
        if (xml[i] !== LESS_THAN) continue;
        const skip_to = ignorable_end(ranges, i);
        if (skip_to !== undefined) { i = skip_to - 1; continue; }
        const first = xml[i + 1];
        if (first === undefined || first === SLASH || first === 0x21 || first === 0x3f) continue;
        let name_end = i + 1;
        while (name_end < to && !is_tag_boundary(xml[name_end])) name_end += 1;
        if (name_end >= to || name_end === i + 1) continue;
        const name = utf8_text(xml, i + 1, name_end);
        const colon = name.lastIndexOf(':');
        if (colon !== 0 && name.slice(colon + 1) === local_name) return { start: i, name };
    }
    return null;
}

/** Every complete live `<c>` in one row, in document order. */
function scan_cell_elements(
    xml: Uint8Array,
    from: number,
    to: number,
    ranges: IgnorableRangeIndex,
    callback: ScannedCellCallback,
): void {
    let pos = from;
    while (pos < to) {
        const next = next_element_start_by_local_name(xml, pos, to, ranges, 'c');
        if (next === null) return;
        const { start, name } = next;
        const tag_end = find_tag_end(xml, start, to);
        if (tag_end === -1 || tag_end >= to) return;
        const reference = resolve_cell_reference_bytes(
            xml,
            attribute_value_span(xml, start, tag_end + 1, 'r'),
            start,
        );
        let end: number;
        let inner_end: number;
        if (is_self_closing(xml, start, tag_end)) {
            end = tag_end + 1;
            inner_end = end;
        } else {
            const end_tag = end_tag_after(xml, name, tag_end + 1, ranges, to);
            if (end_tag === null) return;
            [inner_end, end] = end_tag;
        }
        pos = end;
        callback(reference, end, tag_end + 1, inner_end);
    }
}

/** Optional consumers of the row scan; absent callbacks allocate no cell spans. */
export interface ScanRowsOptions {
    /** Every complete cell, including missing and invalid references. */
    readonly on_reference?: (reference: ScannedCellReference) => void;
    readonly on_coordinate?: (row: number, col: number, owner: Span) => void;
    readonly capture_cell?: (row: number, col: number) => boolean;
    readonly on_cell?: (row: number, col: number, cell: Span, owner: Span) => void;
}

function row_index_from_tag(xml: Uint8Array, start: number, tag_end: number): number | null {
    const value = attribute_value_span(xml, start, tag_end + 1, 'r');
    if (value === null) return null;
    if (raw_value_has_ampersand(xml, value)) {
        const decoded = decode_xml(utf8_text(xml, value.start, value.end));
        return ROW_NUMBER_RE.test(decoded) ? Number(decoded) - 1 : null;
    }
    if (value.start === value.end) return null;
    let row = 0;
    for (let i = value.start; i < value.end; i++) {
        const digit = xml[i] - 0x30;
        if (digit < 0 || digit > 9) return null;
        row = row * 10 + digit;
    }
    return row - 1;
}

/**
 * Locate the `<row>` elements in `sheetData`, keyed by row index, **in document
 * order and plural**.
 *
 * A row index can name more than one element — SpreadsheetML does not forbid two
 * `<row r="1">`, and unnumbered rows can be attributed to a row by their cells.
 * Keeping only one of them made the writer disagree with the reader, which never
 * resolves a whole row at all: precedence is settled independently *per
 * coordinate*. With a styled `A1` in the first element and a `D1` in the second,
 * picking one row span synthesized a duplicate A1 and silently lost its style.
 */
export function scan_rows(
    xml: Uint8Array,
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
        const next = next_element_start_by_local_name(xml, pos, to, ignorable, 'row');
        if (next === null) break;
        const { start, name } = next;
        const tag_end = find_tag_end(xml, start, to);
        if (tag_end === -1 || tag_end >= to) break;
        const row_index = row_index_from_tag(xml, start, tag_end);
        if (is_self_closing(xml, start, tag_end)) {
            if (row_index !== null) {
                add(row_index, {
                    start,
                    end: tag_end + 1,
                    inner_start: tag_end + 1,
                    inner_end: tag_end + 1,
                });
            }
            pos = tag_end + 1;
            continue;
        }
        const end_tag = end_tag_after(xml, name, tag_end + 1, ignorable, to);
        if (end_tag === null || end_tag[1] > to) break;
        const [close, after_close] = end_tag;
        const span = { start, end: after_close, inner_start: tag_end + 1, inner_end: close };
        if (row_index !== null) add(row_index, span);
        let cell_rows: Set<number> | undefined;
        scan_cell_elements(xml, tag_end + 1, close, ignorable, (reference, cell_end, inner_start, inner_end) => {
            options?.on_reference?.(reference);
            if (reference.kind !== 'valid') return;
            const { row, col } = reference;
            options?.on_coordinate?.(row, col, span);
            if (row !== row_index) {
                cell_rows ??= new Set();
                cell_rows.add(row);
            }
            if (options?.on_cell && (options.capture_cell?.(row, col) ?? true)) {
                options.on_cell(row, col, {
                    start: reference.start,
                    end: cell_end,
                    inner_start,
                    inner_end,
                }, span);
            }
        });
        if (cell_rows) for (const index of cell_rows) add(index, span);
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
export function scan_cells(
    xml: Uint8Array,
    from: number,
    to: number,
    row?: number,
): Map<number, Span> {
    const out = new Map<number, Span>();
    scan_cell_elements(
        xml,
        from,
        to,
        ignorable_ranges(xml, from, to),
        (reference, end, inner_start, inner_end) => {
            if (reference.kind !== 'valid' || (row !== undefined && reference.row !== row)) return;
            const span = { start: reference.start, end, inner_start, inner_end };
            if (row !== undefined || !out.has(reference.col)) out.set(reference.col, span);
        },
    );
    return out;
}

export function letter_to_index(letters: string): number {
    let index = 0;
    for (let i = 0; i < letters.length; i++) index = index * 26 + (letters.charCodeAt(i) - 64);
    return index - 1;
}

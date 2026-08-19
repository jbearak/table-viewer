/**
 * Shared OOXML XML scanning primitives, extracted from parse-xlsx.ts so the
 * rich-text and hyperlink parsers use the exact same scans as the worksheet
 * reader. The project rule (see parse_styles in parse-xlsx.ts) applies here
 * too: being right about XML matters less than every consumer agreeing, so
 * there is exactly one implementation of each scan.
 *
 * These scanners are deliberately lightweight rather than standards-complete:
 * not namespace-aware, and `get_attr` lexes only an element's opening tag.
 */

/** Expand the five predefined XML entities and numeric character references.
 *
 *  Numeric references belong here because a writer may emit any character that
 *  way — `Id="R1&#54;f42588"` is the same relationship id as `Id="R16f42588"`,
 *  and comparing the raw text made them different strings. `&amp;` is expanded
 *  last so `&amp;#60;`, which *means* the six characters `&#60;`, is not
 *  re-decoded into `<`. */
export function decode_xml(s: string): string {
    if (s.indexOf('&') === -1) return s;
    return s
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&quot;/g, '"')
        .replace(/&apos;/g, "'")
        .replace(/&#(?:x([0-9a-fA-F]+)|(\d+));/g, (whole, hex: string | undefined, dec: string | undefined) => {
            const code = hex !== undefined ? parseInt(hex, 16) : Number(dec);
            return Number.isFinite(code) && code >= 0 && code <= 0x10ffff
                ? String.fromCodePoint(code)
                : whole;
        })
        .replace(/&amp;/g, '&');
}

function is_xml_whitespace(code: number): boolean {
    return code === 0x20 || code === 0x09 || code === 0x0a || code === 0x0d;
}

/** The start of an exact attribute's quoted value, or -1 when it is absent. */
function attr_value_start(tag: string, attr: string): number {
    if (tag.charCodeAt(0) !== 0x3c) return -1; // `<`

    let i = tag.charCodeAt(1) === 0x2f ? 2 : 1; // `/`
    // Skip the element name. Any XML whitespace may introduce attributes; a
    // pretty-printer commonly puts the first one on the next line.
    while (i < tag.length) {
        const code = tag.charCodeAt(i);
        if (is_xml_whitespace(code) || code === 0x2f || code === 0x3e) break; // `/`, `>`
        i++;
    }

    while (i < tag.length) {
        while (i < tag.length && is_xml_whitespace(tag.charCodeAt(i))) i++;
        if (i === tag.length) return -1;
        const code = tag.charCodeAt(i);
        if (code === 0x2f || code === 0x3e) return -1;

        const name_start = i;
        while (i < tag.length) {
            const name_code = tag.charCodeAt(i);
            if (
                is_xml_whitespace(name_code)
                || name_code === 0x3d || name_code === 0x2f || name_code === 0x3e
            ) break; // `=`, `/`, `>`
            i++;
        }
        const name_end = i;

        while (i < tag.length && is_xml_whitespace(tag.charCodeAt(i))) i++;
        if (tag.charCodeAt(i) !== 0x3d) { // `=`
            // Malformed XML. Advance past this token so a later, well-formed
            // attribute cannot make the lexer stall.
            if (i === name_start) i++;
            continue;
        }
        i++;
        while (i < tag.length && is_xml_whitespace(tag.charCodeAt(i))) i++;

        const quote = tag[i];
        if (quote !== '"' && quote !== "'") {
            // XML attribute values must be quoted. Skip the malformed token and
            // resume at the next XML whitespace rather than reading through it.
            while (i < tag.length && !is_xml_whitespace(tag.charCodeAt(i))) i++;
            continue;
        }
        const value_start = i + 1;
        if (
            name_end - name_start === attr.length
            && tag.startsWith(attr, name_start)
        ) return value_start;
        const value_end = tag.indexOf(quote, value_start);
        if (value_end === -1) return -1;
        i = value_end + 1;
    }
    return -1;
}

/** Read one exact attribute name from an opening tag.
 *
 * This is a lexer rather than a regular expression so attribute-shaped text
 * inside a quoted value cannot be mistaken for markup. XML permits either
 * quote form and XML whitespace around `=`, all of which are accepted here.
 */
export function get_attr(tag: string, attr: string): string | null {
    const start = attr_value_start(tag, attr);
    if (start === -1) return null;
    const end = tag.indexOf(tag[start - 1], start);
    return end === -1 ? null : decode_xml(tag.slice(start, end));
}

/** Replace one exact attribute's raw value while preserving its quote and spacing. */
export function replace_attr_value(tag: string, attr: string, value: string): string {
    const start = attr_value_start(tag, attr);
    if (start === -1) return tag;
    const end = tag.indexOf(tag[start - 1], start);
    return end === -1 ? tag : tag.slice(0, start) + value + tag.slice(end);
}

/** Remove one exact attribute and the XML whitespace that introduces it. */
export function remove_attr(tag: string, attr: string): string {
    const value_start = attr_value_start(tag, attr);
    if (value_start === -1) return tag;
    const value_end = tag.indexOf(tag[value_start - 1], value_start);
    if (value_end === -1) return tag;

    let before_name = value_start - 2;
    while (before_name >= 0 && is_xml_whitespace(tag.charCodeAt(before_name))) before_name--;
    if (tag.charCodeAt(before_name) !== 0x3d) return tag; // `=`
    before_name--;
    while (before_name >= 0 && is_xml_whitespace(tag.charCodeAt(before_name))) before_name--;

    let start = before_name - attr.length + 1;
    while (start > 0 && is_xml_whitespace(tag.charCodeAt(start - 1))) start--;
    return tag.slice(0, start) + tag.slice(value_end + 1);
}

/** Find the index of '>' that closes an opening tag, skipping '>' inside quoted attribute values. Returns -1 if not found. */
export function find_tag_end(xml: string, start: number): number {
    let in_quote: string | null = null;
    for (let i = start; i < xml.length; i++) {
        const ch = xml[i];
        if (in_quote) {
            if (ch === in_quote) in_quote = null;
        } else if (ch === '"' || ch === "'") {
            in_quote = ch;
        } else if (ch === '>') {
            return i;
        }
    }
    return -1;
}

/** Check whether the character after a tag-name match is a valid tag delimiter. */
export function is_tag_boundary(ch: string | undefined): boolean {
    return ch === '>' || ch === ' ' || ch === '/' || ch === '\t' || ch === '\n' || ch === '\r';
}

/** Check whether the region between start and tag_end represents a self-closing tag (handles `<tag/>` and `<tag />`). */
export function is_self_closing(xml: string, start: number, tag_end: number): boolean {
    for (let i = tag_end - 1; i > start; i--) {
        const ch = xml[i];
        if (ch === '/') return true;
        if (ch !== ' ' && ch !== '\t' && ch !== '\n' && ch !== '\r') return false;
    }
    return false;
}

/**
 * Iterate every occurrence of `<tag ...>...</tag>` or self-closing `<tag .../>`.
 * Calls `cb` with the full opening tag string and inner content (empty for self-closing).
 */
export function iter_elements(xml: string, tag: string, cb: (open_tag: string, inner: string) => void): void {
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = xml.indexOf(open, pos);
        if (start === -1) break;

        // Verify full tag name match (not just a prefix)
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }

        // Find end of opening tag
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) break;

        const open_tag = xml.substring(start, tag_end + 1);

        if (is_self_closing(xml, start, tag_end)) {
            // Self-closing
            cb(open_tag, '');
            pos = tag_end + 1;
        } else {
            const close = `</${tag}>`;
            const close_pos = xml.indexOf(close, tag_end);
            if (close_pos === -1) {
                pos = tag_end + 1;
                continue;
            }
            const inner = xml.substring(tag_end + 1, close_pos);
            cb(open_tag, inner);
            pos = close_pos + close.length;
        }
    }
}

/**
 * The index of `needle` in `xml` at or after `from`, skipping any occurrence
 * that falls inside a comment, a CDATA section, or a processing instruction —
 * see {@link ignorable_ranges} for why those three and what goes wrong without
 * them.
 *
 * Use this when you have one needle to find. When scanning repeatedly over the
 * same text, hoist {@link ignorable_ranges} out of the loop and pair it with
 * {@link ignorable_end} instead, so the ranges are computed once.
 */
export function index_of_markup(xml: string, needle: string, from = 0): number {
    return index_of_markup_in(xml, needle, from, ignorable_ranges(xml, 0, xml.length));
}

/** {@link index_of_markup} against ranges the caller already computed. */
function index_of_markup_in(
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

/** {@link String.lastIndexOf} with the same ignored-region rule. */
export function last_index_of_markup(xml: string, needle: string): number {
    // Ranges hoisted, not recomputed per hit: this walks every occurrence, and
    // each range scan is a pass over the whole part. A worksheet with many
    // matches would otherwise be quadratic in an untrusted file's size.
    const ranges = ignorable_ranges(xml, 0, xml.length);
    let found = -1;
    let pos = 0;
    while (true) {
        const hit = index_of_markup_in(xml, needle, pos, ranges);
        if (hit === -1) return found;
        found = hit;
        pos = hit + needle.length;
    }
}

/**
 * {@link iter_elements}, but an element that begins inside a comment, a CDATA
 * section, or a processing instruction is not reported — while ignored content
 * *nested inside* a live element is passed through untouched, because `inner`
 * is sliced from the original text.
 *
 * That second half is why this is not "strip the ignorable ranges, then scan":
 * a writer that rebuilds a section from what it read would then drop a vendor
 * `extLst` payload out of an element it never meant to touch. It also keeps
 * offsets meaningful, since nothing is rewritten.
 *
 * Deliberately not the default inside {@link iter_elements}: that one runs over
 * whole `<sheetData>` bodies, where the extra range scan would cost a full pass
 * on every parse. Use this on the small sections whose scans are structural
 * (`<hyperlinks>`, a `.rels` part), where reading a commented-out element is a
 * correctness problem and the section is short.
 */
export function iter_elements_markup(
    xml: string,
    tag: string,
    cb: (open_tag: string, inner: string) => void,
): void {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    if (ranges.length === 0) {
        iter_elements(xml, tag, cb);
        return;
    }
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = xml.indexOf(open, pos);
        if (start === -1) return;
        // Only the element's *start* is tested against the ranges: an ignorable
        // range that opens inside a live element is that element's content.
        const skip_to = ignorable_end(ranges, start);
        if (skip_to !== undefined) {
            pos = skip_to;
            continue;
        }
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return;
        const open_tag = xml.substring(start, tag_end + 1);
        if (is_self_closing(xml, start, tag_end)) {
            cb(open_tag, '');
            pos = tag_end + 1;
            continue;
        }
        const close = `</${tag}>`;
        const close_pos = index_of_markup_in(xml, close, tag_end, ranges);
        if (close_pos === -1) {
            pos = tag_end + 1;
            continue;
        }
        cb(open_tag, xml.substring(tag_end + 1, close_pos));
        pos = close_pos + close.length;
    }
}

/**
 * The live `<tag>…</tag>` section: `[start, end)` over the whole element plus
 * its verbatim inner text, or null when the XML declares none.
 *
 * Distinct from {@link get_text}, which matches the first literal `<tag`, live
 * or not. Extracting the inner text first and filtering afterwards cannot
 * recover this: the delimiters that would prove the section was commented out
 * are outside the substring, so a wholly commented-out section reads as an
 * empty live one. A reader and a writer that disagree on which section is live
 * lose data silently, so both call this.
 */
export function find_element_section(
    xml: string,
    tag: string,
): { start: number; end: number; inner: string } | null {
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = index_of_markup(xml, open, pos);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) {
            return { start, end: tag_end + 1, inner: '' };
        }
        const close = `</${tag}>`;
        const close_pos = index_of_markup(xml, close, tag_end);
        if (close_pos === -1) return null;
        return {
            start,
            end: close_pos + close.length,
            inner: xml.substring(tag_end + 1, close_pos),
        };
    }
}

/**
 * Ranges inside `[from, to)` whose contents are text, not markup: XML comments,
 * CDATA sections, and processing instructions.
 *
 * The surgical writers match on raw `<row`/`<c`/`<hyperlink` substrings, which is
 * exact for real markup and wrong for anything quoting it. A commented-out row — the shape a
 * generator leaves behind, and one Excel preserves on round-trip — looked like a
 * live row to `scan_rows`, so an edit to a cell it names spliced the new value
 * *into the comment*: the file stays valid, the save reports success, and the
 * cell on screen never changes. Skipping these ranges makes the writer agree with
 * an XML parser about what a row is, without needing one.
 *
 * A processing instruction is the third spelling of the same hazard. Everything
 * between `<?` and `?>` is opaque data to a parser and its content is
 * unconstrained, so element-shaped text in there is text — but reading it as
 * markup let an edit rewrite a cell *inside the PI* while the live cell of that
 * name kept its old value.
 */
export function ignorable_ranges(xml: string, from: number, to: number): Array<[number, number]> {
    const out: Array<[number, number]> = [];
    let pos = from;
    // One monotonic scan on `<`, classifying by the characters that follow.
    // Deliberately not a search per opener kind: with `indexOf` per kind, a
    // part full of one kind (`<?x?><?x?>…`) re-scans the whole remaining
    // string for the absent kinds on every iteration, which is quadratic in
    // the part size — and these parts come from an untrusted workbook.
    while (pos < to) {
        const at = xml.indexOf('<', pos);
        if (at === -1 || at >= to) break;
        let end: number;
        if (xml.startsWith('<!--', at)) {
            const close = xml.indexOf('-->', at + 4);
            end = close === -1 ? to : close + 3;
        } else if (xml.startsWith('<![CDATA[', at)) {
            const close = xml.indexOf(']]>', at + 9);
            end = close === -1 ? to : close + 3;
        } else if (xml.startsWith('<?', at)) {
            const close = xml.indexOf('?>', at + 2);
            end = close === -1 ? to : close + 2;
        } else {
            pos = at + 1;
            continue;
        }
        out.push([at, Math.min(end, to)]);
        pos = end;
    }
    return out;
}

/** Where to resume from if `at` falls inside an ignorable range, else undefined.
 *
 *  Binary search, not a walk: `ignorable_ranges` returns disjoint ranges in
 *  ascending order, and this is called once per candidate position in scans
 *  that have many of both. Walking made that the product of the two counts,
 *  which a crafted workbook controls. */
export function ignorable_end(ranges: ReadonlyArray<[number, number]>, at: number): number | undefined {
    let lo = 0;
    let hi = ranges.length - 1;
    while (lo <= hi) {
        const mid = (lo + hi) >> 1;
        const [start, end] = ranges[mid];
        if (at < start) hi = mid - 1;
        else if (at < end) return end;
        else lo = mid + 1;
    }
    return undefined;
}

export function get_text(xml: string, tag: string): string | null {
    const open = `<${tag}`;
    let pos = 0;
    while (true) {
        const start = xml.indexOf(open, pos);
        if (start === -1) return null;
        if (!is_tag_boundary(xml[start + open.length])) {
            pos = start + 1;
            continue;
        }
        const tag_end = find_tag_end(xml, start);
        if (tag_end === -1) return null;
        if (is_self_closing(xml, start, tag_end)) return '';
        const close = `</${tag}>`;
        const close_pos = xml.indexOf(close, tag_end);
        if (close_pos === -1) return null;
        return xml.substring(tag_end + 1, close_pos);
    }
}

/**
 * Strip the characters XML 1.0 forbids outright — the C0 controls with no
 * escape, the two non-characters, and unpaired surrogates. Shared by every
 * writer because the policy must not differ between the parts of one file:
 * a numeric reference would be just as invalid as the raw byte, so removal is
 * the only option, and a single invisible character left in is the difference
 * between a workbook that opens and one that does not. Both arrive the same
 * unseen way — a paste from a terminal, a PDF, or a program that split a code
 * point. Excel drops them on paste too.
 */
export function strip_illegal_xml_chars(s: string): string {
    return s
        // eslint-disable-next-line no-control-regex
        .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/g, '')
        .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, '');
}

/**
 * Encode text for an XML **attribute value**: the markup-significant
 * characters plus the double quote, then the whitespace an attribute-value
 * normalization would otherwise flatten to spaces (XML 1.0 §3.3.3) — numeric
 * references are exempt from that normalization, which is what makes them the
 * only spelling of a deliberate tab/newline that round-trips.
 */
export function encode_xml_attr(s: string): string {
    return strip_illegal_xml_chars(
        s
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/\t/g, '&#9;')
            .replace(/\r/g, '&#13;')
            .replace(/\n/g, '&#10;'),
    );
}

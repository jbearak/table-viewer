/**
 * Shared OOXML XML scanning primitives, extracted from parse-xlsx.ts so the
 * rich-text and hyperlink parsers use the exact same scans as the worksheet
 * reader. The project rule (see parse_styles in parse-xlsx.ts) applies here
 * too: being right about XML matters less than every consumer agreeing, so
 * there is exactly one implementation of each scan.
 *
 * These scanners are deliberately lightweight rather than standards-complete:
 * not namespace-aware, and `get_attr` reads only double-quoted values.
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

export function get_attr(tag: string, attr: string): string | null {
    // Both quote forms: XML 1.0 §3.1 allows either, and a writer that emits
    // single quotes produces a perfectly legal part. Reading only one form
    // made such an attribute invisible — benign in a reader that then skips
    // the element, but silently destructive in a writer that rebuilds a
    // section from what it could see.
    const re = new RegExp(`\\b${attr}=(?:"([^"]*)"|'([^']*)')`, '');
    const m = tag.match(re);
    if (!m) return null;
    return decode_xml(m[1] ?? m[2] ?? '');
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

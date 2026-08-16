/**
 * External URL validation shared by the webview (immediate dialog feedback)
 * and the host (the authoritative security boundary before openExternal).
 * Workbook contents are untrusted input: only plain http(s) URLs may reach the
 * OS opener.
 */

/** Longest accepted URL. Anything longer is rejected outright. */
const MAX_URL_LENGTH = 8 * 1024;

/**
 * Validate a candidate external URL. Returns the normalized URL string, or
 * null when the value must not be opened (wrong type, malformed, oversized,
 * control characters, or any scheme other than exactly http/https).
 */
export function parse_http_external_url(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    // Trim only plain spaces; any other whitespace is a control character and
    // rejects below (trimming first would hide embedded-control smuggling at
    // the ends).
    const trimmed = value.replace(/^ +| +$/g, '');
    if (trimmed === '' || trimmed.length > MAX_URL_LENGTH) return null;
    // eslint-disable-next-line no-control-regex
    if (/[\x00-\x1f\x7f]/.test(trimmed)) return null;
    let url: URL;
    try {
        url = new URL(trimmed);
    } catch {
        return null;
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    // Normalization percent-encodes, which can expand well past the input
    // length — enforce the cap on what we actually return.
    if (url.href.length > MAX_URL_LENGTH) return null;
    return url.href;
}

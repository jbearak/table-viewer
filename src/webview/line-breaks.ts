/**
 * Canonical hard-line-break rule for cell text (issue #202).
 *
 * Cell values can carry LF (webview edits, ordinary Excel Alt+Enter), CRLF
 * (imported / programmatically generated workbooks), or a bare CR (CHAR(13),
 * VBA `vbCr`, external producers). The vendored Glide renderer and measurer
 * split only on `\n`, so every layout decision the app makes — column fit,
 * overflow detection, row sizing, the wrap flag on a grid cell — must agree on
 * one interpretation or rendering and sizing drift apart.
 *
 * The rule: CRLF, bare CR, and LF are all the same hard visual break. Grid
 * cells have their *displayed* text normalized to LF at the grid boundary
 * (see `build_grid_cell`), which is what makes Glide's LF-only wrapping and
 * header-border auto-size agree with the models here; the raw value is left
 * untouched so editing, copy, and file round-trips (XLSX deliberately
 * preserves CR as `&#13;`) see the source text.
 */

/** Matches one hard line break: CRLF as a unit, else a lone CR or LF. */
export const LINE_BREAK_RE = /\r\n|[\r\n]/;

const LINE_BREAK_RE_GLOBAL = /\r\n|[\r\n]/g;

/** True when `text` contains any hard line break (LF, CRLF, or bare CR). */
export function has_line_break(text: string): boolean {
    return text.includes('\n') || text.includes('\r');
}

/** Split `text` into its visual lines at every hard line break. */
export function split_lines(text: string): string[] {
    return text.split(LINE_BREAK_RE);
}

/** Number of visual lines in `text` (a trailing break yields a final empty line). */
export function count_lines(text: string): number {
    return split_lines(text).length;
}

/** Rewrite every CRLF / bare CR to LF, leaving LF-only text identical. */
export function normalize_line_breaks(text: string): string {
    if (!text.includes('\r')) return text;
    return text.replace(LINE_BREAK_RE_GLOBAL, '\n');
}

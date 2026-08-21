/**
 * Pure word-level diff for the Diff toolbar toggle. Decides how a dirty
 * cell's before/after is presented (`choose_diff_mode`) and produces the
 * word-granular segments for the inline form (`word_diff`). Canvas-free and
 * theme-free so it is unit-tested directly; cell-renderer.ts turns the
 * segments into styled rich-text lines.
 */

export interface DiffWordSegment {
    readonly text: string;
    readonly kind: 'unchanged' | 'deleted' | 'added';
}

/** How a dirty cell shows before/after: the whole values joined by an arrow,
 *  or an inline word diff. */
export type DiffMode = 'arrow' | 'inline';

/** Inline diffing is quadratic in token count; past this, per-cell text is no
 *  longer something a word diff clarifies anyway, so fall back to the arrow. */
const MAX_DIFF_TOKENS = 500;

/** Words for the ≤2-words rule: whitespace-delimited, ignoring leading and
 *  trailing runs. */
export function word_count(text: string): number {
    const trimmed = text.trim();
    return trimmed === '' ? 0 : trimmed.split(/\s+/).length;
}

/** Numeric in the sense of `Number()` — covers integers, decimals, exponent
 *  and hex forms. Blank is not numeric (`Number('')` is 0, but a cleared cell
 *  is not the number zero). */
export function is_numeric_text(text: string): boolean {
    const trimmed = text.trim();
    return trimmed !== '' && Number.isFinite(Number(trimmed));
}

/**
 * Arrow form for numbers (the cell's loaded scalar type, or both sides
 * parsing as numbers — a freshly typed value has no loaded type) and for
 * short values, where `old → new` reads better than an inline splice; the
 * word diff is for text long enough that spotting the change matters.
 */
export function choose_diff_mode(
    base: string,
    value: string,
    raw_type: string | undefined,
): DiffMode {
    if (raw_type === 'number') return 'arrow';
    if (is_numeric_text(base) && is_numeric_text(value)) return 'arrow';
    if (word_count(base) <= 2 && word_count(value) <= 2) return 'arrow';
    if (tokenize(base).length > MAX_DIFF_TOKENS
        || tokenize(value).length > MAX_DIFF_TOKENS) return 'arrow';
    return 'inline';
}

/** Words and whitespace runs, each its own token, so concatenating tokens
 *  reproduces the input exactly — a whitespace-only edit must still surface
 *  as a visible del/add rather than vanish. */
function tokenize(text: string): string[] {
    return text.split(/(\s+)/).filter((t) => t.length > 0);
}

/**
 * Token-level LCS diff of `old_text` against `new_text`. Concatenating the
 * `deleted`+`unchanged` segments reproduces `old_text`; `added`+`unchanged`
 * reproduces `new_text`. Adjacent same-kind tokens are merged into one
 * segment. O(n·m) over tokens — inputs are cell text, capped by
 * `choose_diff_mode` before this is ever called on something pathological.
 */
export function word_diff(old_text: string, new_text: string): DiffWordSegment[] {
    const a = tokenize(old_text);
    const b = tokenize(new_text);
    // LCS length table: lcs[i][j] = LCS of a[i..] and b[j..].
    const lcs: number[][] = Array.from(
        { length: a.length + 1 },
        () => new Array<number>(b.length + 1).fill(0),
    );
    for (let i = a.length - 1; i >= 0; i--) {
        for (let j = b.length - 1; j >= 0; j--) {
            lcs[i][j] = a[i] === b[j]
                ? lcs[i + 1][j + 1] + 1
                : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
        }
    }
    const segments: { text: string; kind: DiffWordSegment['kind'] }[] = [];
    const push = (text: string, kind: DiffWordSegment['kind']): void => {
        const last = segments[segments.length - 1];
        if (last?.kind === kind) last.text += text;
        else segments.push({ text, kind });
    };
    let i = 0;
    let j = 0;
    while (i < a.length && j < b.length) {
        if (a[i] === b[j]) {
            push(a[i], 'unchanged');
            i++;
            j++;
        } else if (lcs[i + 1][j] >= lcs[i][j + 1]) {
            push(a[i], 'deleted');
            i++;
        } else {
            push(b[j], 'added');
            j++;
        }
    }
    while (i < a.length) push(a[i++], 'deleted');
    while (j < b.length) push(b[j++], 'added');
    return segments;
}

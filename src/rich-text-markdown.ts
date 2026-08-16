import {
    normalize_rich_text,
    normalize_text_style,
    type CellTextStyle,
    type RichText,
    type RichTextRun,
} from './cell-content';

/**
 * The Markdown editor codec: the ONLY place where the editing syntax exists.
 * Isomorphic (no DOM/VS Code/Glide imports) so the webview editor and host-side
 * tests share one implementation.
 *
 * Syntax: `**bold**`, `*italic*`, `<u>underline</u>`, `~~strike~~`, backslash
 * escapes. Nothing else — headings, links, code spans etc. are literal text.
 * Unmatched delimiters stay literal. Round-trip invariant:
 * `markdown_to_rich_text(rich_text_to_markdown(x))` equals `normalize_rich_text(x)`.
 */

/** Characters the serializer escapes so literal text survives the round trip. */
const ESCAPED = new Set(['\\', '*', '~', '<', '>']);

function escape_literal(text: string): string {
    let out = '';
    for (const ch of text) out += ESCAPED.has(ch) ? '\\' + ch : ch;
    return out;
}

/** Deterministic nesting order: bold, italic, underline, strikethrough. */
const STYLE_ORDER = ['bold', 'italic', 'underline', 'strikethrough'] as const;
type StyleKey = (typeof STYLE_ORDER)[number];
const OPEN: Record<StyleKey, string> = {
    bold: '**', italic: '*', underline: '<u>', strikethrough: '~~',
};
const CLOSE: Record<StyleKey, string> = {
    bold: '**', italic: '*', underline: '</u>', strikethrough: '~~',
};

export function rich_text_to_markdown(value: RichText): string {
    const runs = normalize_rich_text(value).runs;
    let out = '';
    // Currently-open styles, in STYLE_ORDER. Between runs we close down to the
    // common prefix and reopen, so output nesting is always canonical.
    const open: StyleKey[] = [];
    const wanted = (run: RichTextRun): StyleKey[] =>
        STYLE_ORDER.filter((key) => run.style?.[key]);
    for (const run of runs) {
        const target = wanted(run);
        let common = 0;
        while (common < open.length && common < target.length && open[common] === target[common]) {
            common++;
        }
        for (let i = open.length - 1; i >= common; i--) out += CLOSE[open[i]];
        open.length = common;
        for (let i = common; i < target.length; i++) {
            out += OPEN[target[i]];
            open.push(target[i]);
        }
        out += escape_literal(run.text);
    }
    for (let i = open.length - 1; i >= 0; i--) out += CLOSE[open[i]];
    return out;
}

// --- Parsing ---
//
// Two passes over a token list, CommonMark-flavored but reduced to this codec's
// four constructs. Star runs use nearest-opener matching with CommonMark's
// "rule of three" and flanking simplified to: can open iff the next character
// exists and is not whitespace, can close iff the previous character exists and
// is not whitespace. Styles are flat (a character's style is the union of the
// spans covering it), so cross-type spans may overlap freely and no tree is
// built.

interface TextToken { kind: 'text'; text: string }
interface StarToken {
    kind: 'star';
    n: number;          // original run length (rule of three)
    left: number;       // delimiter chars still unconsumed
    can_open: boolean;
    can_close: boolean;
}
interface TildeToken { kind: 'tilde'; left: number; can_open: boolean; can_close: boolean }
interface UToken { kind: 'uopen' | 'uclose'; left: number }
type Token = TextToken | StarToken | TildeToken | UToken;

interface Span { open: number; close: number; style: StyleKey }

const is_space = (ch: string | undefined): boolean =>
    ch === undefined || ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r';

function tokenize(markdown: string): Token[] {
    const tokens: Token[] = [];
    let literal = '';
    const flush = (): void => {
        if (literal !== '') { tokens.push({ kind: 'text', text: literal }); literal = ''; }
    };
    let i = 0;
    while (i < markdown.length) {
        const ch = markdown[i];
        if (ch === '\\' && i + 1 < markdown.length) {
            literal += markdown[i + 1];
            i += 2;
        } else if (ch === '*') {
            let n = 1;
            while (markdown[i + n] === '*') n++;
            flush();
            tokens.push({
                kind: 'star', n, left: n,
                can_open: !is_space(markdown[i + n]),
                can_close: !is_space(markdown[i - 1]),
            });
            i += n;
        } else if (markdown.startsWith('~~', i)) {
            flush();
            tokens.push({
                kind: 'tilde', left: 2,
                can_open: !is_space(markdown[i + 2]),
                can_close: !is_space(markdown[i - 1]),
            });
            i += 2;
        } else if (markdown.startsWith('<u>', i)) {
            flush();
            tokens.push({ kind: 'uopen', left: 3 });
            i += 3;
        } else if (markdown.startsWith('</u>', i)) {
            flush();
            tokens.push({ kind: 'uclose', left: 4 });
            i += 4;
        } else {
            literal += ch;
            i += 1;
        }
    }
    flush();
    return tokens;
}

export function markdown_to_rich_text(markdown: string): RichText {
    const tokens = tokenize(markdown);
    const spans: Span[] = [];

    // Star matching. Stack entries index into `tokens`.
    const star_stack: number[] = [];
    const tilde_stack: number[] = [];
    const u_stack: number[] = [];
    for (let idx = 0; idx < tokens.length; idx++) {
        const token = tokens[idx];
        if (token.kind === 'star') {
            if (token.can_close) {
                while (token.left > 0 && star_stack.length > 0) {
                    const need = Math.min(2, token.left);
                    // Nearest opener passing the rule of three; among those,
                    // prefer the nearest that can supply `need` chars so `**`
                    // closes a bold opener across a stranded `*`.
                    let chosen = -1;
                    let fallback = -1;
                    for (let s = star_stack.length - 1; s >= 0; s--) {
                        const opener = tokens[star_stack[s]] as StarToken;
                        const one_can_both = token.can_open || opener.can_close;
                        if (one_can_both
                            && (opener.n + token.n) % 3 === 0
                            && !(opener.n % 3 === 0 && token.n % 3 === 0)) {
                            continue;
                        }
                        if (fallback === -1) fallback = s;
                        if (opener.left >= need) { chosen = s; break; }
                    }
                    if (chosen === -1) chosen = fallback;
                    if (chosen === -1) break;
                    const opener_idx = star_stack[chosen];
                    const opener = tokens[opener_idx] as StarToken;
                    const k = Math.min(need, opener.left);
                    spans.push({
                        open: opener_idx, close: idx,
                        style: k === 2 ? 'bold' : 'italic',
                    });
                    opener.left -= k;
                    token.left -= k;
                    // Openers between the matched pair can no longer close
                    // anything inside the span; drop them (their chars stay
                    // literal via `left`).
                    star_stack.length = chosen + (opener.left > 0 ? 1 : 0);
                }
            }
            if (token.left > 0 && token.can_open) star_stack.push(idx);
        } else if (token.kind === 'tilde') {
            if (token.can_close && tilde_stack.length > 0) {
                const opener_idx = tilde_stack.pop()!;
                (tokens[opener_idx] as TildeToken).left = 0;
                token.left = 0;
                spans.push({ open: opener_idx, close: idx, style: 'strikethrough' });
            } else if (token.can_open) {
                tilde_stack.push(idx);
            }
        } else if (token.kind === 'uopen') {
            u_stack.push(idx);
        } else if (token.kind === 'uclose') {
            if (u_stack.length > 0) {
                const opener_idx = u_stack.pop()!;
                (tokens[opener_idx] as UToken).left = 0;
                token.left = 0;
                spans.push({ open: opener_idx, close: idx, style: 'underline' });
            }
        }
    }
    // Anything still on a stack (or with chars left) is literal via `left`.

    // Assembly: walk tokens; a token's style is the union of spans that
    // strictly contain it. Leftover delimiter characters become literal text.
    const runs: RichTextRun[] = [];
    for (let idx = 0; idx < tokens.length; idx++) {
        const token = tokens[idx];
        let text: string;
        if (token.kind === 'text') {
            text = token.text;
        } else if (token.left === 0) {
            continue;
        } else if (token.kind === 'star') {
            text = '*'.repeat(token.left);
        } else if (token.kind === 'tilde') {
            text = '~~';
        } else {
            text = token.kind === 'uopen' ? '<u>' : '</u>';
        }
        const style: { -readonly [K in keyof CellTextStyle]?: true } = {};
        for (const span of spans) {
            if (span.open < idx && idx < span.close) style[span.style] = true;
        }
        const normalized = normalize_text_style(style);
        runs.push(normalized ? { text, style: normalized } : { text });
    }
    return normalize_rich_text({ runs });
}

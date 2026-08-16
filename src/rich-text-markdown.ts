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
 * `markdown_to_rich_text(rich_text_to_markdown(x))` equals `normalize_rich_text(x)`,
 * EXCEPT that whitespace at a style boundary loses the styles that change
 * there: CommonMark flanking rules make `** x**` unparseable, so the
 * serializer emits boundary whitespace outside the delimiters. Bold/italic on
 * a space are invisible anyway; underline/strikethrough on a boundary space
 * is the one visible loss, accepted for v1.
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
    // Closers may not follow whitespace: peel trailing whitespace off `out`,
    // emit the closers, then re-append it. Safe because whitespace is never
    // part of an escape sequence or delimiter.
    const close_to = (target_len: number): void => {
        if (open.length <= target_len) return;
        const trail = out.match(/[ \t\n\r]+$/)?.[0] ?? '';
        if (trail) out = out.slice(0, out.length - trail.length);
        for (let i = open.length - 1; i >= target_len; i--) out += CLOSE[open[i]];
        open.length = target_len;
        out += trail;
    };
    for (const run of runs) {
        const target = wanted(run);
        let common = 0;
        while (common < open.length && common < target.length && open[common] === target[common]) {
            common++;
        }
        close_to(common);
        let text = run.text;
        if (target.length > common) {
            // Openers may not precede whitespace: emit leading whitespace
            // before them, and skip opening entirely for an all-whitespace
            // run (its unopened styles are the documented boundary-whitespace
            // loss).
            const lead = text.match(/^[ \t\n\r]+/)?.[0] ?? '';
            if (lead) {
                out += lead;
                text = text.slice(lead.length);
            }
            if (text !== '') {
                for (let i = common; i < target.length; i++) {
                    out += OPEN[target[i]];
                    open.push(target[i]);
                }
            }
        }
        out += escape_literal(text);
    }
    close_to(0);
    return out;
}

// --- Parsing ---
//
// Two passes over a token list, CommonMark-flavored but reduced to this codec's
// four constructs. Flanking is simplified to: can open iff the next character
// exists and is not whitespace, can close iff the previous character exists
// and is not whitespace.
//
// Star matching is by WHOLE UNITS, not raw characters: an opening star run is
// unitized bottom-up into bold(2)/italic(1) units (3 = bold then italic — the
// serializer's canonical nesting), and a closer may only close complete units,
// preferring the nearest opener whose top unit matches its own supply
// (min(2, chars left)). This deliberately replaces CommonMark's rule of three:
// units are what make the serializer's output for style transitions (merged
// runs like `*a****b*c**` or `a**b*c***`) parse back to exactly the original
// runs, which the rule of three breaks. Styles are flat (a character's style
// is the union of the spans covering it), so spans may overlap freely — a
// closer can close an outer unit across a still-open inner opener — and no
// tree is built.

interface TextToken { kind: 'text'; text: string }
interface StarToken {
    kind: 'star';
    left: number;       // delimiter chars still unconsumed
    can_open: boolean;
    can_close: boolean;
    /** Set when the token is pushed as an opener: unclosed unit sizes,
     *  bottom (outermost) first. */
    units?: number[];
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
                kind: 'star', left: n,
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
                    // Nearest opener whose TOP unit matches `need` exactly
                    // (so `**` closes a bold across a stranded `*`); else the
                    // nearest whose top unit fits at all. Whole units only —
                    // a lone `*` never eats one char of a bold opener.
                    let chosen = -1;
                    for (let s = star_stack.length - 1; s >= 0; s--) {
                        const units = (tokens[star_stack[s]] as StarToken).units!;
                        if (units[units.length - 1] === need) { chosen = s; break; }
                    }
                    if (chosen === -1) {
                        for (let s = star_stack.length - 1; s >= 0; s--) {
                            const units = (tokens[star_stack[s]] as StarToken).units!;
                            if (units[units.length - 1] <= token.left) { chosen = s; break; }
                        }
                    }
                    if (chosen === -1) break;
                    const opener_idx = star_stack[chosen];
                    const opener = tokens[opener_idx] as StarToken;
                    const k = opener.units!.pop()!;
                    spans.push({
                        open: opener_idx, close: idx,
                        style: k === 2 ? 'bold' : 'italic',
                    });
                    opener.left -= k;
                    token.left -= k;
                    // Remove the opener only when exhausted; openers ABOVE it
                    // stay — they may still close a later span overlapping
                    // this one (styles are flat unions, so crossing spans are
                    // fine).
                    if (opener.units!.length === 0) star_stack.splice(chosen, 1);
                }
            }
            if (token.left > 0 && token.can_open) {
                // Unitize bottom-up as the serializer opens: bold pairs first,
                // a trailing odd char is an italic on top.
                const units: number[] = [];
                let n = token.left;
                while (n >= 2) { units.push(2); n -= 2; }
                if (n === 1) units.push(1);
                // Odd runs open [bold…, italic]; the serializer's canonical
                // 3-star open is exactly bold-then-italic.
                token.units = units;
                star_stack.push(idx);
            }
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

    // Assembly: walk tokens once; a token's style is the union of spans that
    // strictly contain it, tracked with per-style active counters driven by
    // open/close events indexed by token position (O(tokens + spans) rather
    // than checking every span against every token). Leftover delimiter
    // characters become literal text.
    const opens_at = new Map<number, (keyof CellTextStyle)[]>();
    const closes_at = new Map<number, (keyof CellTextStyle)[]>();
    const push_event = (map: Map<number, (keyof CellTextStyle)[]>, at: number, style: keyof CellTextStyle) => {
        const list = map.get(at);
        if (list) list.push(style); else map.set(at, [style]);
    };
    for (const span of spans) {
        push_event(opens_at, span.open, span.style);
        push_event(closes_at, span.close, span.style);
    }
    const active: Record<keyof CellTextStyle, number> = {
        bold: 0, italic: 0, underline: 0, strikethrough: 0,
    };
    const runs: RichTextRun[] = [];
    for (let idx = 0; idx < tokens.length; idx++) {
        // Containment is strict, so a close event takes effect AT its token
        // and an open event only after its token.
        for (const s of closes_at.get(idx) ?? []) active[s]--;
        const token = tokens[idx];
        let text: string | undefined;
        if (token.kind === 'text') {
            text = token.text;
        } else if (token.left === 0) {
            text = undefined;
        } else if (token.kind === 'star') {
            text = '*'.repeat(token.left);
        } else if (token.kind === 'tilde') {
            text = '~~';
        } else {
            text = token.kind === 'uopen' ? '<u>' : '</u>';
        }
        if (text !== undefined) {
            const style: { -readonly [K in keyof CellTextStyle]?: true } = {};
            if (active.bold > 0) style.bold = true;
            if (active.italic > 0) style.italic = true;
            if (active.underline > 0) style.underline = true;
            if (active.strikethrough > 0) style.strikethrough = true;
            const normalized = normalize_text_style(style);
            runs.push(normalized ? { text, style: normalized } : { text });
        }
        for (const s of opens_at.get(idx) ?? []) active[s]++;
    }
    return normalize_rich_text({ runs });
}

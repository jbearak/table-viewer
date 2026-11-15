import SSF from 'ssf';
import { classify_xlsx_cell_value, iso_to_serial } from './xlsx-cell-value';

export interface FontEntry {
    bold: boolean;
    italic: boolean;
    /** Sparse: present (true) only when the font sets it, so cells without
     *  these styles keep their exact legacy object shape. */
    underline?: true;
    strikethrough?: true;
}
export interface XfEntry { font_index: number; format_index: number }
export type DateMode = 0 | 1;

/** Compact recipe retained on editable XLSX cells for formatting dirty values. */
export interface XlsxNumberFormat {
    readonly code: string;
    /** Sparse: the default 1900 date system is represented by absence. */
    readonly date1904?: true;
}

/** XLSX-only scalar metadata shared by parsed and rendered cells. */
export interface XlsxCellFormatFields {
    /** Recipe for formatting a newly edited scalar before save. */
    numberFormat?: XlsxNumberFormat;
    /** The source cell used OOXML's ISO-date `t="d"` representation. */
    xlsxIsoDate?: true;
}

const MS_PER_DAY = 86400000;
const MIN_JS_DATE_MS = Date.UTC(-271821, 3, 20);
const MAX_JS_DATE_MS = Date.UTC(275760, 8, 13);
const EXCEL_1900_EPOCH_MS = Date.UTC(1899, 11, 31);
const EXCEL_1904_EPOCH_MS = Date.UTC(1904, 0, 1);

function get_excel_date_serial_bounds(datemode: DateMode): { min: number; max: number } {
    if (datemode === 1) {
        return {
            min: (MIN_JS_DATE_MS - EXCEL_1904_EPOCH_MS) / MS_PER_DAY,
            max: (MAX_JS_DATE_MS - EXCEL_1904_EPOCH_MS) / MS_PER_DAY,
        };
    }

    return {
        min: (MIN_JS_DATE_MS - EXCEL_1900_EPOCH_MS) / MS_PER_DAY,
        max: (MAX_JS_DATE_MS - EXCEL_1900_EPOCH_MS) / MS_PER_DAY + 1,
    };
}

export function is_valid_excel_date_serial(serial: number, datemode: DateMode): boolean {
    if (!Number.isFinite(serial)) return false;

    const bounds = get_excel_date_serial_bounds(datemode);
    return serial >= bounds.min && serial <= bounds.max;
}

/** Convert an Excel date serial number to an ISO 8601 string. */
export function serial_to_iso(serial: number, datemode: DateMode): string {
    if (!Number.isFinite(serial)) {
        throw new Error('Excel date serial must be a finite number');
    }
    if (!is_valid_excel_date_serial(serial, datemode)) {
        throw new Error('Excel date serial is out of range for JS Date');
    }

    if (datemode === 1) {
        const ms = EXCEL_1904_EPOCH_MS + serial * MS_PER_DAY;
        return new Date(ms).toISOString();
    }

    let adjusted_serial = serial;
    if (adjusted_serial >= 60) {
        adjusted_serial -= 1;
    }

    const ms = EXCEL_1900_EPOCH_MS + adjusted_serial * MS_PER_DAY;
    return new Date(ms).toISOString();
}

/** Elapsed-time formats use bracketed hour/minute/second tokens like [h], [mm], [ss]. */
const ELAPSED_TIME_RE = /\[[hms]+\]/i;
const BUILTIN_FORMATS = SSF.get_table();

/** Effective fallback code SSF uses when an OOXML built-in ID has no table entry. */
function builtin_format_code(id: number): string | undefined {
    const direct = BUILTIN_FORMATS?.[id];
    if (direct !== undefined) return direct;

    let mapped: number | undefined;
    if (id >= 5 && id <= 8) mapped = id + 32;
    else if (id >= 27 && id <= 31) mapped = 14;
    else if (id >= 50 && id <= 58) mapped = 14;
    else if (id >= 59 && id <= 62) mapped = id - 58;
    else if (id >= 67 && id <= 68) mapped = id - 57;
    else if (id >= 72 && id <= 75) mapped = id - 58;
    else if (id >= 76 && id <= 78) mapped = id - 56;
    else if (id >= 79 && id <= 81) mapped = id - 34;
    if (mapped !== undefined) return BUILTIN_FORMATS?.[mapped];

    switch (id) {
        case 41: return '_(* #,##0_);_(* \\(#,##0\\);_(* "-"_);_(@_)';
        case 42: return '_("$"* #,##0_);_("$"* \\(#,##0\\);_("$"* "-"_);_(@_)';
        case 43: return '_(* #,##0.00_);_(* \\(#,##0.00\\);_(* "-"??_);_(@_)';
        case 44: return '_("$"* #,##0.00_);_("$"* \\(#,##0.00\\);_("$"* "-"??_);_(@_)';
        case 63: return '"$"#,##0_);\\("$"#,##0\\)';
        case 64: return '"$"#,##0_);[Red]\\("$"#,##0\\)';
        case 65: return '"$"#,##0.00_);\\("$"#,##0.00\\)';
        case 66: return '"$"#,##0.00_);[Red]\\("$"#,##0.00\\)';
        default: return undefined;
    }
}

/** Resolve an XF to the format code needed by an unsaved-value preview. */
export function resolve_number_format(
    xf_index: number,
    xfs: XfEntry[],
    format_map: Map<number, string>,
    datemode: DateMode,
): XlsxNumberFormat | undefined {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return undefined;
    const fmt_index = xfs[xf_index].format_index;
    // General carries no visible formatting recipe worth previewing.
    if (fmt_index === 0) return undefined;
    const code = format_map.get(fmt_index) ?? builtin_format_code(fmt_index);
    if (!code) return undefined;
    return { code, ...(datemode === 1 ? { date1904: true as const } : {}) };
}

/** Resolve each XF recipe at most once for parser and writer hot paths. */
export function create_number_format_resolver(
    xfs: XfEntry[],
    format_map: Map<number, string>,
    datemode: DateMode,
): (xf_index: number) => XlsxNumberFormat | undefined {
    const cache = new Map<number, XlsxNumberFormat | null>();
    return (xf_index) => {
        const cached = cache.get(xf_index);
        if (cached !== undefined) return cached ?? undefined;
        const resolved = resolve_number_format(xf_index, xfs, format_map, datemode);
        cache.set(xf_index, resolved ?? null);
        return resolved;
    };
}

/** Split a number format without treating quoted/escaped/bracketed semicolons as separators. */
function format_sections(code: string): string[] {
    const out: string[] = [];
    let quoted = false;
    let bracket = 0;
    let start = 0;
    for (let i = 0; i < code.length; i += 1) {
        const ch = code[i];
        if (ch === '\\') { i += 1; continue; }
        if (ch === '"') { quoted = !quoted; continue; }
        if (quoted) continue;
        // `_` consumes the following padding character. In particular, `_;`
        // does not introduce a new format section.
        if (ch === '_') { i += 1; continue; }
        if (ch === '[') bracket += 1;
        else if (ch === ']') bracket = Math.max(0, bracket - 1);
        else if (ch === ';' && bracket === 0) {
            out.push(code.slice(start, i));
            start = i + 1;
        }
    }
    out.push(code.slice(start));
    return out;
}

// Keep these in sync with SSF's choose_fmt grammar and precedence. Date
// classification must select the same section that SSF.format will render.
const CONDITION_MARKER_RE = /\[[=<>]/;
const CONDITION_RE = /\[(=|>[=]?|<[>=]?)(-?\d+(?:\.\d*)?)\]/;

type NumberFormatCondition = readonly [operator: string, bound: number];

interface CompiledNumberFormatSection {
    readonly code: string;
    readonly condition?: NumberFormatCondition;
    readonly hasConditionMarker: boolean;
    readonly isDate: boolean;
}

interface CompiledNumberFormatSections {
    readonly sections: readonly CompiledNumberFormatSection[];
    readonly normalized?: readonly [
        positive: CompiledNumberFormatSection,
        negative: CompiledNumberFormatSection,
        zero: CompiledNumberFormatSection,
    ];
}

function parse_number_format_condition(section: string): NumberFormatCondition | undefined {
    const match = CONDITION_RE.exec(section);
    return match ? [match[1], Number(match[2])] : undefined;
}

function condition_holds(condition: NumberFormatCondition | undefined, value: number): boolean {
    if (!condition) return false;
    const [operator, bound] = condition;
    switch (operator) {
        case '<': return value < bound;
        case '>': return value > bound;
        case '<=': return value <= bound;
        case '>=': return value >= bound;
        case '=': return value === bound;
        default: return value !== bound;
    }
}

function normalize_numeric_sections(
    sections: readonly CompiledNumberFormatSection[],
): CompiledNumberFormatSections['normalized'] {
    const last = sections[sections.length - 1];
    const has_text_section = sections.length < 4 && last?.code.includes('@');
    switch (sections.length) {
        case 1:
            return has_text_section ? undefined : [sections[0], sections[0], sections[0]];
        case 2:
            return has_text_section
                ? [sections[0], sections[0], sections[0]]
                : [sections[0], sections[1], sections[0]];
        case 3:
            return has_text_section
                ? [sections[0], sections[1], sections[0]]
                : [sections[0], sections[1], sections[2]];
        case 4:
            return [sections[0], sections[1], sections[2]];
        default:
            return undefined;
    }
}

function compile_number_format_sections(code: string): CompiledNumberFormatSections {
    const sections = format_sections(code).map((section) => ({
        code: section,
        condition: parse_number_format_condition(section),
        hasConditionMarker: CONDITION_MARKER_RE.test(section),
        isDate: SSF.is_date(section) && !ELAPSED_TIME_RE.test(section),
    }));
    return {
        sections,
        normalized: normalize_numeric_sections(sections),
    };
}

function number_format_section_from(
    compiled: CompiledNumberFormatSections,
    value: number,
): CompiledNumberFormatSection {
    const normalized = compiled.normalized;
    if (!normalized) return compiled.sections[0];
    const [positive, negative, zero] = normalized;
    if (!positive.hasConditionMarker && !negative.hasConditionMarker) {
        return value > 0 ? positive : value < 0 ? negative : zero;
    }
    if (condition_holds(positive.condition, value)) return positive;
    if (condition_holds(negative.condition, value)) return negative;
    return positive.condition && negative.condition ? zero : negative;
}

/** The numeric section Excel will use for a candidate value. */
export function number_format_section_for_value(code: string, value: number): string {
    return number_format_section_from(compile_number_format_sections(code), value).code;
}

const NUMBER_FORMAT_SECTIONS = new WeakMap<XlsxNumberFormat, CompiledNumberFormatSections>();

export function number_format_is_date(format: XlsxNumberFormat, value?: number): boolean {
    if (value === undefined) {
        return SSF.is_date(format.code) && !ELAPSED_TIME_RE.test(format.code);
    }
    let compiled = NUMBER_FORMAT_SECTIONS.get(format);
    if (!compiled) {
        compiled = compile_number_format_sections(format.code);
        NUMBER_FORMAT_SECTIONS.set(format, compiled);
    }
    return number_format_section_from(compiled, value).isDate;
}

/** Check whether an XF format index refers to a date/time format. */
export function is_date_format(xf_index: number, xfs: XfEntry[], format_map: Map<number, string>): boolean {
    const format = resolve_number_format(xf_index, xfs, format_map, 0);
    return format !== undefined && number_format_is_date(format);
}

export function format_number_value(raw: number, format: XlsxNumberFormat): string {
    try {
        return SSF.format(format.code, raw, { date1904: format.date1904 === true });
    } catch {
        return String(raw);
    }
}

export function format_value(
    raw: number,
    xf_index: number,
    xfs: XfEntry[],
    format_map: Map<number, string>,
    datemode: DateMode
): string {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return String(raw);
    const format = resolve_number_format(xf_index, xfs, format_map, datemode);
    if (!format) {
        try {
            return SSF.format(xfs[xf_index]?.format_index ?? 0, raw);
        } catch {
            return String(raw);
        }
    }
    return format_number_value(raw, format);
}

type DatePart = 'y' | 'm' | 'd';

interface DisplayDatePattern {
    readonly re: RegExp;
    readonly order: readonly DatePart[];
}

const MONTH_NAMES = [
    'january', 'february', 'march', 'april', 'may', 'june',
    'july', 'august', 'september', 'october', 'november', 'december',
];

const display_date_patterns = new Map<string, DisplayDatePattern | null>();

/**
 * The text one format section shows for a date, as a pattern: day, month, and
 * year in the section's order with its separators between them. A time before
 * or after them is left off, so the date alone is accepted. Anything else
 * (weekday names, literal text, a missing part) gives null.
 */
function display_date_pattern(section: string): DisplayDatePattern | null {
    const cached = display_date_patterns.get(section);
    if (cached !== undefined) return cached;
    // `kind` is a lowercased format letter, 'ampm', 'lit' for literal text,
    // or 'other' for anything that cannot be part of a plain date.
    type Token = { kind: string; len: number; text: string };
    const tokens: Token[] = [];
    const literal = (text: string) => {
        const last = tokens[tokens.length - 1];
        if (last?.kind === 'lit') last.text += text;
        else tokens.push({ kind: 'lit', len: 0, text });
    };
    let i = 0;
    while (i < section.length) {
        const ch = section[i];
        const lower = ch.toLowerCase();
        const ampm = /^(am\/pm|a\/p)/i.exec(section.slice(i));
        if (ch === '"') {
            const end = section.indexOf('"', i + 1);
            if (end < 0) break;
            literal(section.slice(i + 1, end));
            i = end + 1;
        } else if (ch === '\\') {
            literal(section[i + 1] ?? '');
            i += 2;
        } else if (ch === '[') {
            const end = section.indexOf(']', i);
            if (end < 0) break;
            i = end + 1;
        } else if (ampm) {
            tokens.push({ kind: 'ampm', len: ampm[0].length, text: '' });
            i += ampm[0].length;
        } else if ('ymdhs'.includes(lower)) {
            let len = 1;
            while (section[i + len]?.toLowerCase() === lower) len += 1;
            tokens.push({ kind: lower, len, text: '' });
            i += len;
        } else if (/[A-Za-z0-9#?@_*]/.test(ch)) {
            tokens.push({ kind: 'other', len: 1, text: '' });
            i += 1;
        } else {
            literal(ch);
            i += 1;
        }
    }
    // `m` beside an hour or second is minutes; fractional-second digits follow `s`.
    const fields = tokens.filter((token) => token.kind !== 'lit');
    const time = new Set<Token>();
    fields.forEach((token, at) => {
        const before = fields[at - 1];
        if (
            token.kind === 'h' || token.kind === 's' || token.kind === 'ampm'
            || (token.kind === 'm' && (before?.kind === 'h' || fields[at + 1]?.kind === 's'))
            || (token.kind === 'other' && (before?.kind === 's' || (before?.kind === 'other' && time.has(before))))
        ) time.add(token);
    });
    const is_time = (token: Token) => time.has(token);
    const is_date_field = (token: Token) => 'ymd'.includes(token.kind) && !is_time(token);
    const first = tokens.findIndex(is_date_field);
    let last = -1;
    tokens.forEach((token, index) => { if (is_date_field(token)) last = index; });
    const date = first < 0 ? [] : tokens.slice(first, last + 1);
    const outside = [...tokens.slice(0, Math.max(first, 0)), ...tokens.slice(last + 1)];
    // A time beside the date must be set apart from it by a space.
    const apart = (token: Token | undefined) => token === undefined || /\s/.test(token.text);
    let valid = date.length === 5
        && outside.every((token) => token.kind === 'lit' || is_time(token))
        && apart(first > 0 ? tokens[first - 1] : undefined)
        && apart(tokens[last + 1]);

    const order: DatePart[] = [];
    let source = '';
    date.forEach((token, index) => {
        if (!valid) return;
        const { kind, len, text } = token;
        if (index % 2 === 1) {
            if (kind !== 'lit' || /[A-Za-z0-9]/.test(text)) valid = false;
            else source += text.replace(/[.*+?^${}()|[\]\\/-]/g, '\\$&');
            return;
        }
        if ((kind !== 'y' && kind !== 'm' && kind !== 'd') || order.includes(kind)) {
            valid = false;
            return;
        }
        if (kind === 'y') source += '(\\d{2}|\\d{4})';
        else if (len <= 2) source += '(\\d{1,2})';
        else if (kind === 'm' && len <= 4) source += '([A-Za-z]{3,9})';
        else valid = false;
        order.push(kind);
    });
    const pattern = valid ? { re: new RegExp(`^${source}$`, 'i'), order } : null;
    display_date_patterns.set(section, pattern);
    return pattern;
}

function display_date_match_to_serial(
    pattern: DisplayDatePattern,
    match: RegExpExecArray,
    datemode: DateMode,
): number | null {
    let year = 0, month = 0, day = 0;
    for (const [index, part] of pattern.order.entries()) {
        const field = match[index + 1];
        if (part === 'y') {
            year = Number(field);
            if (field.length === 2) year += year < 30 ? 2000 : 1900;
        } else if (part === 'd') {
            day = Number(field);
        } else if (/^\d+$/.test(field)) {
            month = Number(field);
        } else {
            const name = field.toLowerCase();
            month = MONTH_NAMES.findIndex((full) => full === name || full.slice(0, 3) === name) + 1;
        }
    }
    const pad = (n: number, width: number) => String(n).padStart(width, '0');
    return iso_to_serial(`${pad(year, 4)}-${pad(month, 2)}-${pad(day, 2)}`, datemode);
}

/**
 * Convert text written the way a date format shows dates (`6/1/23` under
 * `m/d/yy`) to an Excel serial, or null. Each section is tried, and a date read
 * by one counts only if that section is the one that shows it. Two-digit years
 * follow Excel: 00–29 are 2000–2029, 30–99 are 1930–1999.
 */
export function display_date_to_serial(
    text: string,
    code: string,
    datemode: DateMode,
): number | null {
    const trimmed = text.trim();
    for (const section of format_sections(code)) {
        const pattern = display_date_pattern(section);
        const match = pattern?.re.exec(trimmed);
        if (!pattern || !match) continue;
        const serial = display_date_match_to_serial(pattern, match, datemode);
        if (serial !== null && serial >= 0 && number_format_section_for_value(code, serial) === section) {
            return serial;
        }
    }
    return null;
}

export interface XlsxEditPreviewOptions {
    readonly was_boolean?: boolean;
    readonly was_iso_date?: boolean;
    /** Rich/styled edits are saved as text and must not receive numeric formatting. */
    readonly force_text?: boolean;
}

/** Format a dirty XLSX value exactly as its scalar save result will be displayed. */
export function format_xlsx_edit_preview(
    value: string,
    format: XlsxNumberFormat,
    options: XlsxEditPreviewOptions = {},
): string {
    if (options.force_text) return value;
    const classified = classify_xlsx_cell_value(value, {
        datemode: format.date1904 ? 1 : 0,
        is_date_style: (serial) => number_format_is_date(format, serial),
        display_date_serial: (text) => display_date_to_serial(text, format.code, format.date1904 ? 1 : 0),
        was_boolean: options.was_boolean,
        was_iso_date: options.was_iso_date,
    });
    switch (classified.kind) {
        case 'empty': return '';
        case 'string': return classified.text;
        case 'boolean': return classified.text === '1' ? 'TRUE' : 'FALSE';
        case 'iso-date': return classified.text;
        case 'number': return format_number_value(Number(classified.text), format);
    }
}

export function get_style(xf_index: number, xfs: XfEntry[], fonts: FontEntry[]): FontEntry {
    if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return { bold: false, italic: false };
    const xf = xfs[xf_index];
    const font_idx = xf.font_index;
    if (!Number.isInteger(font_idx) || font_idx < 0 || font_idx >= fonts.length) return { bold: false, italic: false };
    return fonts[font_idx];
}

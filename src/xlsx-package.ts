import CFB from 'cfb';
import {
    apply_cell_edits,
    element_close,
    element_content,
    formula_count,
    live_tags_in,
    widen_dimension,
    type XlsxCellEdit,
} from './xlsx-cell-write';
import { get_style, is_date_format } from './spreadsheet-format';
import { decode_xml, get_text, iter_elements } from './ooxml-xml';
import { font_to_style } from './xlsx-rich-text';
import type { CellTextStyle } from './cell-content';
import {
    parse_styles,
    parse_workbook_xml,
    resolve_part_path,
    worksheet_part_paths_from_package,
} from './parse-xlsx';
import type { XfEntry, DateMode } from './spreadsheet-format';
import { rels_path_for_part } from './ooxml-relationships';
import { apply_hyperlink_edits, type XlsxHyperlinkEdit } from './xlsx-hyperlink-write';

/**
 * Package-level (.xlsx container) side of `putexcel`-style saving.
 *
 * We reuse the `cfb` dependency already present for reading rather than adding a
 * writer library. That choice was made empirically, not by reputation: round-
 * tripping our fixtures and `docs/examples/garden-cafe-sample.xlsx` through
 * `CFB.read` → `CFB.write` reproduced every part byte-identically, and a mutation
 * test (rewrite one `<c>`, leave everything else) produced a zip that `unzip -t`
 * accepts with `xl/styles.xml` untouched. Every deserialize/re-serialize library
 * we looked at (ExcelJS, xlsx-populate, SheetJS write) instead rebuilds parts it
 * models and drops those it doesn't. Here the parts we never touch are never even
 * parsed, so charts, pivot tables, conditional formatting and macros survive by
 * construction — the strongest preservation guarantee available, and the one the
 * `putexcel` requirement actually asks for.
 */

function read_part_text(cfb_file: ReturnType<typeof CFB.read>, path: string): string | null {
    const entry = CFB.find(cfb_file, path);
    if (!entry?.content) return null;
    return Buffer.from(entry.content as Uint8Array).toString('utf8');
}

function write_part_text(cfb_file: ReturnType<typeof CFB.read>, path: string, text: string): boolean {
    const entry = CFB.find(cfb_file, path);
    if (!entry) return false;
    const bytes = Buffer.from(text, 'utf8');
    entry.content = bytes;
    // `size` is not derived from `content` on write, so both must be set or the
    // emitted zip declares a stale length and readers truncate the part.
    entry.size = bytes.length;
    return true;
}

/**
 * Split a number format into its sections.
 *
 * A `;` inside a quoted literal, an escape, or a bracketed condition/colour is not
 * a section break, so this cannot be a `split(';')`: `"a;b";0` is one section, and
 * cutting it in half would leave a fragment that classifies as anything at all.
 */
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

/**
 * A `[>=100]`-style condition, if the section carries one.
 *
 * Not anchored to the very start: a section may carry a colour or a locale
 * bracket ahead of its condition (`[Red][>50000]yyyy-mm-dd`), and requiring the
 * condition to come first made those read as unconditional — which then took the
 * positive/negative/zero path and picked the wrong section entirely.
 *
 * The bound's sign may be written explicitly: `[>+50000]` is the same condition as
 * `[>50000]`. Accepting only a leading `-` made the format read as unconditional
 * for the same reason and with the same consequence — the date section was picked
 * for a value the cell will not display as a date, so a typed date went in as a
 * serial the user then sees as `45306`.
 */
const CONDITION_RE = /^\s*(?:\[(?![<>=])[^\]]*\]\s*)*\[\s*(<=|>=|<>|<|>|=)\s*([+-]?[\d.]+(?:[eE][+-]?\d+)?)\s*\]/;

function condition_holds(section: string, value: number): boolean | null {
    const m = CONDITION_RE.exec(section);
    if (!m) return null;
    const bound = Number(m[2]);
    if (!Number.isFinite(bound)) return null;
    switch (m[1]) {
        case '<': return value < bound;
        case '>': return value > bound;
        case '<=': return value <= bound;
        case '>=': return value >= bound;
        case '=': return value === bound;
        default: return value !== bound;
    }
}

/**
 * The section of `code` that `value` will actually be displayed by.
 *
 * Sections are ordinarily `positive;negative;zero;text`, so a positive serial
 * takes the first — but a section may instead carry its own condition
 * (`[>50000]yyyy-mm-dd;0`), and then Excel uses the first condition that holds and
 * the last section as the fallback. Getting this wrong is not cosmetic: the writer
 * asks whether a typed date will *render* as a date, and both directions corrupt.
 * Assuming section one, `[>50000]0;yyyy-mm-dd` stored an inline string where the
 * cell would have shown a date, and `[>50000]yyyy-mm-dd;0` stored a serial the
 * cell then displayed as `45306`.
 */
function section_for_value(code: string, value: number): string {
    const sections = format_sections(code);
    if (sections.length === 1) return sections[0];
    const conditional = sections.some((section) => CONDITION_RE.test(section));
    if (!conditional) {
        if (value > 0) return sections[0];
        if (value < 0) return sections[1] ?? sections[0];
        return sections[2] ?? sections[0];
    }
    // The text section never applies to a number, and a trailing one would
    // otherwise be picked up as the fallback below.
    const numeric = sections.length === 4 ? sections.slice(0, 3) : sections;
    for (const section of numeric) {
        const holds = condition_holds(section, value);
        if (holds === true) return section;
        if (holds === null) return section;
    }
    return numeric[numeric.length - 1];
}

/**
 * Everything the writer needs from `/xl/styles.xml`, read and parsed once per
 * save: the date predicate for serial classification, plus the per-xf run-font
 * context for rich inline strings — the cell font's four style flags (for the
 * writer's uniform-style reduction) and its non-flag properties as
 * `<rPr>`-ready inner XML (so a styled run on a Cambria-14 cell stays
 * Cambria-14 — a present `<rPr>` REPLACES the cell font, never merges).
 *
 * The parse is the *reader's* — `parse_styles`, imported, not a second scan
 * written to match it. This module had its own, quote-aware and comment-aware
 * where the reader's is neither, and every difference between them was a cell
 * stored under a format only one side agreed about: a commented-out `<numFmt>`
 * shadowing the live entry, or a legally single-quoted `numFmtId='164'`, made a
 * style a date to the writer and General to the reader, so a typed `2024-01-15`
 * went in as the serial `45306` and that is what the user then saw. Being more
 * nearly correct about XML is not the requirement here; agreeing with the side
 * that renders the result is.
 *
 * `applyNumberFormat="0"` is deliberately not consulted, and now cannot be: Excel
 * reads it as "inherit the format from `cellStyleXfs`", so honouring it would be
 * more faithful to the format — and `is_date_format`, which the reader uses,
 * ignores it. Teaching only this side about it would recreate exactly the
 * disagreement above. Both sides have to change together, and that is a reader
 * change this branch does not make.
 *
 * The run-font base transformation: drop the four flag tags (`<b>`, `<i>`,
 * `<strike>`, `<u>` in any spelling — the writer re-emits per-run flags
 * itself, and a leftover `<u val="none"/>` says nothing absence doesn't), and
 * rename `<name …/>` to `<rFont …/>` — the one child whose tag differs between
 * a styles-part `<font>` and a string-part `<rPr>`. `<rPr>`'s children are an
 * unbounded xsd:choice, so the surviving order is legal as-is. The flags come
 * from the reader's own `get_style`/`font_to_style`, and the base walk uses
 * the reader's `iter_elements` over the same `<fonts>` section, so writer and
 * reader see the same font list in the same order.
 */
/**
 * A `<font>` element's inner XML with every style element removed, leaving the
 * face/size/color properties that make a run's `<rPr>` base.
 *
 * Looped to a fixed point rather than replaced once. A single pass can put back
 * what it removes: `<<b/>b/>` has the inner `<b/>` deleted and the outer halves
 * close up into a live `<b/>`, so a crafted styles.xml could re-introduce a
 * style into a base the model believes is unstyled — the run would come back
 * bold from a workbook we never agreed was bold. Untrusted input, so the loop
 * is also bounded; a part that will not converge is treated as having no usable
 * base rather than being trusted.
 */
function strip_style_elements(inner: string): string {
    const style_tags = /<(?:b|i|u|strike)\b[^>]*\/?>|<\/(?:b|i|u|strike)>/g;
    let out = inner;
    for (let pass = 0; pass < 8; pass++) {
        const next = out.replace(style_tags, '');
        if (next === out) return out;
        out = next;
    }
    return '';
}

interface StyleWriteContext {
    readonly is_date_style: (xf_index: number, serial: number) => boolean;
    readonly cell_font_style: (xf_index: number) => CellTextStyle | undefined;
    readonly run_font_base: (xf_index: number) => string;
}

function read_style_write_context(cfb_file: ReturnType<typeof CFB.read>): StyleWriteContext {
    const xml = read_part_text(cfb_file, '/xl/styles.xml');
    if (!xml) {
        return {
            is_date_style: () => false,
            cell_font_style: () => undefined,
            run_font_base: () => '',
        };
    }
    const { xfs, fonts, format_map } = parse_styles(xml);

    // Narrowed to the section the serial about to be written will be *displayed*
    // by. `SSF.is_date` says true if any section of a format is a date, so
    // `0;0;yyyy-mm-dd` counted and a typed date was stored as a serial the cell
    // then showed as `45306`. Which section applies depends on the value — plain
    // formats split positive/negative/zero, and a conditional one
    // (`[>50000]yyyy-mm-dd;0`) picks by its own test — so the predicate takes the
    // candidate serial rather than answering for the format as a whole. Only the
    // reading side wants that whole-format answer.
    const is_date_style = (xf_index: number, serial: number) => {
        const scoped = new Map<number, string>();
        for (const [id, code] of format_map) scoped.set(id, section_for_value(code, serial));
        return is_date_format(xf_index, xfs, scoped);
    };

    // The <rPr> bases are only wanted when some edit actually carries runs, so
    // the <fonts> walk is deferred to the first call — a plain-text save never
    // pays for it.
    let bases: string[] | undefined;
    const font_bases = (): string[] => {
        if (bases === undefined) {
            bases = [];
            const fonts_section = get_text(xml, 'fonts');
            if (fonts_section) {
                iter_elements(fonts_section, 'font', (_open, inner) => {
                    bases!.push(
                        strip_style_elements(inner).replace(/<name\b/g, '<rFont'),
                    );
                });
            }
        }
        return bases;
    };
    const font_index = (xf_index: number): number | undefined => {
        if (!Number.isInteger(xf_index) || xf_index < 0 || xf_index >= xfs.length) return undefined;
        const idx = xfs[xf_index].font_index;
        return Number.isInteger(idx) && idx >= 0 && idx < fonts.length ? idx : undefined;
    };

    return {
        is_date_style,
        cell_font_style: (xf_index) => font_to_style(get_style(xf_index, xfs, fonts)),
        run_font_base: (xf_index) => {
            const idx = font_index(xf_index);
            return idx === undefined ? '' : font_bases()[idx] ?? '';
        },
    };
}

/**
 * The decoded value of `tag`'s `name` attribute, or null if it has none.
 *
 * Both quote styles, because XML allows either and calling one of them malformed
 * is this module's own invention: `formatCode='yyyy-mm-dd'` is an ordinary date
 * format, and reading only `"…"` left it unseen, so the style did not look like a
 * date and a typed date was written as text. The worksheet parts get away with a
 * double-quote-only scan because `assert_writable_sheet_data` refuses anything it
 * cannot read that way; these parts are read, never spliced, and have no such
 * guard — so they have to actually handle it.
 *
 * Decoded on the way out for the same reason every other value here is.
 *
 * `name` is spliced into the pattern, so a caller may pass a fragment — `r:[iI]d`
 * for the relationship reference, which is spelled both ways in the wild. Every
 * caller here is a literal in this file; none is user input.
 */
function attr(tag: string, name: string): string | null {
    const m = new RegExp(`\\b${name}=(?:"([^"]*)"|'([^']*)')`).exec(tag);
    if (!m) return null;
    return decode_xml(m[1] ?? m[2]);
}

/**
 * A non-negative integer attribute of `tag`, or null if absent or not one.
 *
 * The pattern cannot be `"(\d+)"` directly: an encoded digit is still a digit,
 * so `numFmtId="16&#52;"` is `164` — a custom date format — and matching the raw
 * text failed, left the index at its `0` default, and stored a typed date as an
 * inline string under a format that renders dates. Decoding first and validating
 * after also rejects the encoded spelling of a genuinely malformed value rather
 * than reading it as `NaN`.
 */
function numeric_attr(tag: string, name: string): number | null {
    const text = attr(tag, name);
    return text !== null && /^\d+$/.test(text) ? Number(text) : null;
}

/**
 * The workbook's date epoch, read exactly as `parse_xlsx` reads it.
 *
 * Shared for the same reason as {@link read_style_write_context}. This module's
 * own `workbookPr` scan skipped comments, so a commented-out
 * `<workbookPr date1904="1"/>` left the writer on the 1900 epoch while the reader
 * used 1904 — and the two are 1462 days apart, so a saved `2024-01-15` read back
 * as `2028-01-16`. Not a rounding error: a date four years off.
 */
function read_datemode(cfb_file: ReturnType<typeof CFB.read>): DateMode {
    const wb = read_part_text(cfb_file, '/xl/workbook.xml');
    if (!wb) return 0;
    return parse_workbook_xml(wb).datemode;
}

export interface XlsxWorksheetCellEdits {
    readonly sheetIndex: number;
    readonly edits: readonly XlsxCellEdit[];
    /** Whole-cell hyperlink edits, applied to the worksheet's `<hyperlinks>`
     *  section and its `.rels` part alongside the value edits. */
    readonly link_edits?: readonly XlsxHyperlinkEdit[];
}

/**
 * Rewrite several worksheets inside one .xlsx package and serialize it once.
 *
 * Every worksheet replacement is computed before the package is mutated. A bad
 * edit on any sheet therefore rejects the whole operation without producing a
 * partially updated workbook.
 */
export function write_xlsx_workbook_cell_edits(
    raw: Uint8Array,
    worksheets: readonly XlsxWorksheetCellEdits[],
): Uint8Array {
    const active = worksheets.filter(
        ({ edits, link_edits }) => edits.length > 0 || (link_edits?.length ?? 0) > 0,
    );
    if (active.length === 0) return raw;

    const indices = new Set<number>();
    for (const { sheetIndex } of active) {
        if (!Number.isSafeInteger(sheetIndex) || sheetIndex < 0 || indices.has(sheetIndex)) {
            throw new Error('Invalid or duplicate worksheet to save');
        }
        indices.add(sheetIndex);
    }

    let cfb_file: ReturnType<typeof CFB.read>;
    try {
        cfb_file = CFB.read(raw, { type: 'buffer' });
    } catch {
        throw new Error('Not a valid .xlsx file');
    }

    const parts = worksheet_part_paths_from_package(cfb_file);
    const { is_date_style, cell_font_style, run_font_base } = read_style_write_context(cfb_file);
    const datemode = read_datemode(cfb_file);
    let removed_formula = false;
    const replacements: Array<{ path: string; xml: string; created?: boolean }> = [];

    for (const { sheetIndex, edits, link_edits } of active) {
        const part = parts[sheetIndex];
        if (!part) throw new Error('Could not locate a worksheet to save');
        const path = `/${part}`;
        const sheet_xml = read_part_text(cfb_file, path);
        if (sheet_xml === null) throw new Error('Could not read a worksheet to save');

        let updated = edits.length > 0
            ? apply_cell_edits(sheet_xml, edits, {
                datemode,
                is_date_style,
                cell_font_style,
                run_font_base,
            })
            : sheet_xml;
        if (edits.length > 0) {
            let min_row = Infinity, min_col = Infinity, max_row = 0, max_col = 0;
            for (const edit of edits) {
                if (edit.row < min_row) min_row = edit.row;
                if (edit.col < min_col) min_col = edit.col;
                if (edit.row > max_row) max_row = edit.row;
                if (edit.col > max_col) max_col = edit.col;
            }
            updated = widen_dimension(updated, min_row, min_col, max_row, max_col);
        }
        if (link_edits && link_edits.length > 0) {
            // The `.rels` splice is planned here with everything else so a bad
            // link edit rejects the whole save before any part is mutated.
            const rels_path = `/${rels_path_for_part(part)}`;
            const rels_xml = read_part_text(cfb_file, rels_path);
            const link_result = apply_hyperlink_edits(updated, rels_xml, link_edits);
            updated = link_result.sheet_xml;
            if (link_result.rels_xml !== null) {
                replacements.push({
                    path: rels_path,
                    xml: link_result.rels_xml,
                    // A sheet that had no `.rels` part gets one created.
                    created: rels_xml === null,
                });
            }
        }
        // Only a cell write can drop a formula; a hyperlink splice touches the
        // `<hyperlinks>` section and the rels, never a `<c>`. Skipping the two
        // whole-sheet scans keeps a link-only save off the worksheet body.
        if (edits.length > 0) {
            removed_formula ||= formula_count(updated) < formula_count(sheet_xml);
        }
        replacements.push({ path, xml: updated });
    }

    for (const { path, xml, created } of replacements) {
        if (created) {
            // A sheet that never had relationships has no `.rels` part to
            // replace; adding one needs no [Content_Types] change because the
            // standard `Default Extension="rels"` already types it.
            CFB.utils.cfb_add(cfb_file, path, Buffer.from(xml, 'utf8'));
            continue;
        }
        if (!write_part_text(cfb_file, path, xml)) {
            throw new Error('Could not update a worksheet to save');
        }
    }
    if (removed_formula) remove_part(cfb_file, '/xl/calcChain.xml');

    // `xl/sharedStrings.xml` is deliberately not touched, including its `count`.
    // Values are written inline, so no shared-string table entry changes.
    const out = CFB.write(cfb_file, { type: 'buffer', fileType: 'zip', compression: true });
    return out instanceof Uint8Array ? out : new Uint8Array(out as ArrayBufferLike);
}

/** Backward-compatible one-worksheet entry point. */
export function write_xlsx_cell_edits(
    raw: Uint8Array,
    sheet_index: number,
    edits: readonly XlsxCellEdit[],
): Uint8Array {
    return write_xlsx_workbook_cell_edits(raw, [{ sheetIndex: sheet_index, edits }]);
}

/**
 * Remove a part and every reference to it: the container entry, the content-type
 * override, and the workbook relationship.
 *
 * All three, because a package that still points at a part it no longer contains
 * is exactly the corruption the removal was meant to avoid — `cfb_del` is a
 * container operation and knows nothing about OOXML's reference graph.
 *
 * All three or none, for the same reason: every partial removal is its own broken
 * package, so the reference edits are computed before any is applied and a failure
 * to compute them abandons the removal entirely.
 */
function remove_part(cfb_file: ReturnType<typeof CFB.read>, part_path: string): void {
    if (!CFB.find(cfb_file, part_path)) return;
    // Planned in full before anything is mutated, then committed in one go.
    //
    // Ordering alone cannot make this safe, because every order leaves *some*
    // half-done package: delete first and the part is gone but still referenced;
    // strip the override first and the part is still there, typed by the
    // `<Default Extension="xml">` fallback rather than as a calc chain; strip the
    // relationship first and it is an unreferenced orphan. Each of those is a
    // package that says one thing and contains another, and the `catch` below would
    // hide whichever one happened.
    //
    // Planning is what removes the middle: computing the two replacement texts
    // touches nothing, so a throw there leaves the package exactly as it was, and
    // the three writes that follow are assignments and a container delete with no
    // parsing left to fail between them.
    let planned: Array<() => void>;
    try {
        planned = plan_reference_removals(cfb_file, part_path);
    } catch {
        // calcChain is a pure recalculation cache. Leaving it in place costs a
        // stale chain Excel rebuilds on the next calculation; failing the save
        // would cost the user the edit they asked to keep. So the plan is
        // abandoned whole, and the package goes out untouched and consistent.
        return;
    }
    for (const commit of planned) commit();
    CFB.utils.cfb_del(cfb_file, part_path);
}

/**
 * Work out how to drop every reference to `part_path`, without changing anything.
 *
 * Returns one thunk per part that needs rewriting; each captures its already-built
 * replacement text, so applying them cannot fail partway on a parse. A part with no
 * reference to remove contributes no thunk.
 */
function plan_reference_removals(
    cfb_file: ReturnType<typeof CFB.read>,
    part_path: string,
): Array<() => void> {
    const commits: Array<() => void> = [];
    const plan = (path: string, stripped: string | null): void => {
        if (stripped === null) return;
        commits.push(() => { write_part_text(cfb_file, path, stripped); });
    };
    plan('/[Content_Types].xml', content_type_override_removed(cfb_file, part_path));
    plan('/xl/_rels/workbook.xml.rels', workbook_relationship_removed(cfb_file, part_path));
    return commits;
}

/**
 * Delete every live empty `<name …>` element that `wanted` selects.
 *
 * Both spellings: XML lets an empty element be written `<X .../>` or
 * `<X ...></X>` — pretty-printed, with whitespace between the halves — and
 * writers in the wild use both. Spans are removed back to front so the earlier
 * offsets stay valid. An element that actually has content is left alone rather
 * than half-deleted; both parts this serves are attribute-only by schema.
 */
function remove_elements(xml: string, name: string, wanted: (tag: string) => boolean): string {
    const spans: Array<[number, number]> = [];
    for (const [at, tag] of live_tags_in(xml, name)) {
        if (!wanted(tag)) continue;
        const inner_start = at + tag.length;
        if (tag.endsWith('/>')) {
            spans.push([at, inner_start]);
            continue;
        }
        // Located comment-aware, not by `indexOf`: `</Override>` written inside a
        // comment is text, and mistaking it for the real end tag made the element
        // look like it had content, so the removal declined and the package kept a
        // reference to a part it no longer contains.
        const closed = element_close(xml, name, inner_start);
        if (closed === null || /\S/.test(closed.inner)) continue;
        spans.push([at, closed.end]);
    }
    let out = xml;
    for (const [start, end] of spans.reverse()) out = out.slice(0, start) + out.slice(end);
    return out;
}

/**
 * The text of `[Content_Types].xml` with a part's `<Override>` gone, or null when
 * there is nothing to change (no such part file, or no override naming it).
 *
 * Computes only -- see `remove_part`, which needs every reference edit to be known
 * good before any of them is applied.
 *
 * Located quote-aware, then removed by span. A `[^>]*` match cut the tag at a
 * legal `>` inside an earlier attribute value, so an `<Override>` carrying one
 * never matched at all and the package kept a content type naming a part it no
 * longer contains — exactly the inconsistency Excel offers to repair, and the one
 * this removal exists to prevent.
 */
function content_type_override_removed(
    cfb_file: ReturnType<typeof CFB.read>,
    part_name: string,
): string | null {
    const xml = read_part_text(cfb_file, '/[Content_Types].xml');
    if (!xml) return null;
    const stripped = remove_elements(
        xml,
        'Override',
        // `attr` decodes, as in `worksheet_part_path`: an encoded spelling of the
        // same part name is the same part, and missing it leaves an override for a
        // part that is no longer in the package.
        (tag) => attr(tag, 'PartName') === part_name,
    );
    return stripped === xml ? null : stripped;
}

/**
 * The text of `xl/_rels/workbook.xml.rels` with the relationship targeting a part
 * gone, or null when there is nothing to change. Computes only, as above.
 *
 * Targets are matched after resolution, since the same part is spelled both
 * `calcChain.xml` (relative to `xl/`) and `/xl/calcChain.xml` in the wild.
 */
function workbook_relationship_removed(
    cfb_file: ReturnType<typeof CFB.read>,
    part_path: string,
): string | null {
    const xml = read_part_text(cfb_file, '/xl/_rels/workbook.xml.rels');
    if (!xml) return null;
    const wanted = part_path.replace(/^\//, '');
    // See `content_type_override_removed`: same quote-aware location, and a
    // relationship left pointing at a deleted part is the other half of the same
    // broken package.
    const stripped = remove_elements(xml, 'Relationship', (tag) => {
        const path = attr(tag, 'Target');
        if (path === null) return false;
        const resolved = resolve_part_path(path);
        return resolved === wanted;
    });
    return stripped === xml ? null : stripped;
}

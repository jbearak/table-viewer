import {
    element_close,
    remove_formula_cached_values,
    worksheet_formula_dependencies,
    type XlsxCellEdit,
} from './xlsx-cell-write';
import { compile_workbook_formula_graph } from './formula-dependencies';
import type { PackedFormulaDependencies } from './data-source/interface';
import { worksheet_scan_input } from './ooxml-worksheet-scan';
import {
    create_number_format_resolver,
    get_style,
    number_format_is_date,
} from './spreadsheet-format';
import {
    decode_xml,
    find_tag_end,
    get_text,
    ignorable_end,
    ignorable_ranges,
    is_tag_boundary,
    iter_elements,
} from './ooxml-xml';
import { font_to_style } from './xlsx-rich-text';
import type { CellTextStyle } from './cell-content';
import {
    parse_styles,
    parse_workbook_xml,
    resolve_part_path,
    worksheet_part_entries_from_package,
} from './parse-xlsx';
import type { DateMode } from './spreadsheet-format';
import { rels_path_for_part } from './ooxml-relationships';
import type { XlsxHyperlinkEdit } from './xlsx-hyperlink-write';
import { apply_worksheet_edits } from './ooxml-surgery';
import { ZipPackage, ZipPackageError } from './zip-package';

/**
 * Package-level (.xlsx container) side of `putexcel`-style saving.
 *
 * The ZIP package is indexed lazily. With verified formula topology, only
 * explicitly edited worksheets and worksheets containing invalidated formula
 * caches are inflated. Standalone callers without that hint scan worksheet
 * formulas one part at a time for correctness. Every unchanged local ZIP record
 * is copied verbatim, including opaque charts, images, pivots, and custom XML.
 */

function read_part_bytes(zip: ZipPackage, path: string): Uint8Array | null {
    try {
        return zip.read(path);
    } catch (error) {
        if (error instanceof ZipPackageError) throw new Error('Not a valid .xlsx file');
        throw error;
    }
}

function read_part_text(zip: ZipPackage, path: string): string | null {
    try {
        return zip.read_text(path);
    } catch (error) {
        if (error instanceof ZipPackageError) throw new Error('Not a valid .xlsx file');
        throw error;
    }
}

function write_part_bytes(
    zip: ZipPackage,
    path: string,
    bytes: Uint8Array,
): boolean {
    return zip.replace(path, bytes);
}

function write_part_text(zip: ZipPackage, path: string, text: string): boolean {
    return write_part_bytes(zip, path, Buffer.from(text, 'utf8'));
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

function read_style_write_context(zip: ZipPackage): StyleWriteContext {
    const xml = read_part_text(zip, '/xl/styles.xml');
    if (!xml) {
        return {
            is_date_style: () => false,
            cell_font_style: () => undefined,
            run_font_base: () => '',
        };
    }
    const { xfs, fonts, format_map } = parse_styles(xml);

    const number_format_for = create_number_format_resolver(xfs, format_map, 0);

    // Narrowed to the section the serial about to be written will be *displayed*
    // by. `SSF.is_date` says true if any section of a format is a date, so
    // `0;0;yyyy-mm-dd` counted and a typed date was stored as a serial the cell
    // then showed as `45306`. Which section applies depends on the value — plain
    // formats split positive/negative/zero, and a conditional one
    // (`[>50000]yyyy-mm-dd;0`) picks by its own test — so the predicate takes the
    // candidate serial rather than answering for the format as a whole. Only the
    // reading side wants that whole-format answer.
    const is_date_style = (xf_index: number, serial: number) => {
        const format = number_format_for(xf_index);
        return format !== undefined && number_format_is_date(format, serial);
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
 * The workbook's date epoch, read exactly as `parse_xlsx` reads it.
 *
 * Shared for the same reason as {@link read_style_write_context}. This module's
 * own `workbookPr` scan skipped comments, so a commented-out
 * `<workbookPr date1904="1"/>` left the writer on the 1900 epoch while the reader
 * used 1904 — and the two are 1462 days apart, so a saved `2024-01-15` read back
 * as `2028-01-16`. Not a rounding error: a date four years off.
 */
function read_datemode(zip: ZipPackage): DateMode {
    const wb = read_part_text(zip, '/xl/workbook.xml');
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

export interface XlsxWorkbookWriteOptions {
    /** Topology parsed from the verified source, in current worksheet order. */
    readonly formulaDependencies?: readonly {
        readonly formulaDependencies?: PackedFormulaDependencies;
    }[];
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
    options?: XlsxWorkbookWriteOptions,
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

    let zip: ZipPackage;
    try {
        zip = ZipPackage.open(raw);
    } catch {
        throw new Error('Not a valid .xlsx file');
    }

    const parts = worksheet_part_entries_from_package(zip);
    const sheet_names = parts.map((part) => part.name);
    const has_value_edits = active.some(({ edits }) => edits.length > 0);
    const dependency_sheets = !has_value_edits
        ? parts.map(() => ({}))
        : options?.formulaDependencies?.length === parts.length
        ? options.formulaDependencies
        : parts.map((part, sheet_index) => {
            const content = read_part_bytes(zip, `/${part.path}`);
            if (content === null) throw new Error('Could not read a worksheet to save');
            return {
                formulaDependencies: worksheet_formula_dependencies(
                    worksheet_scan_input(content),
                    sheet_index,
                    sheet_names,
                ),
            };
        });
    const formula_impact = compile_workbook_formula_graph(dependency_sheets).invalidatedBy(
        active.flatMap(({ sheetIndex, edits }) => edits.map((edit) => ({
            sheetIndex,
            row: edit.row,
            column: edit.col,
        }))),
    );
    const { is_date_style, cell_font_style, run_font_base } = read_style_write_context(zip);
    const datemode = read_datemode(zip);
    let calculation_chain_stale = false;
    const replacements: Array<
        | { path: string; bytes: Uint8Array }
        | { path: string; text: string; created?: boolean }
    > = [];

    const active_by_sheet = new Map(active.map((entry) => [entry.sheetIndex, entry]));
    const touched_sheets = new Set(active_by_sheet.keys());
    for (let sheet_index = 0; sheet_index < parts.length; sheet_index += 1) {
        if (formula_impact.forSheet(sheet_index).size > 0) touched_sheets.add(sheet_index);
    }

    for (const sheetIndex of [...touched_sheets].sort((left, right) => left - right)) {
        const active_entry = active_by_sheet.get(sheetIndex);
        const edits = active_entry?.edits ?? [];
        const link_edits = active_entry?.link_edits;
        const part = parts[sheetIndex];
        if (!part) throw new Error('Could not locate a worksheet to save');
        const path = `/${part.path}`;
        const sheet_content = read_part_bytes(zip, path);
        if (sheet_content === null) throw new Error('Could not read a worksheet to save');
        const sheet_xml = worksheet_scan_input(sheet_content);

        const rels_path = `/${rels_path_for_part(part.path)}`;
        const rels_xml = link_edits && link_edits.length > 0
            ? read_part_text(zip, rels_path)
            : null;
        const invalidations = [...formula_impact.forSheet(sheetIndex).cells()];
        const result = active_entry === undefined
            ? {
                worksheet_xml: remove_formula_cached_values(sheet_xml, invalidations),
                relationships_xml: null,
                calculation_chain_stale: false,
            }
            : apply_worksheet_edits({
                worksheet_xml: sheet_xml,
                relationships_xml: rels_xml,
                cell_edits: edits,
                hyperlink_edits: link_edits,
                write_options: {
                    datemode,
                    is_date_style,
                    cell_font_style,
                    run_font_base,
                    sheet_name: part.name,
                    formula_result_invalidations: invalidations,
                },
            });
        if (result.relationships_xml !== null) {
            replacements.push({
                path: rels_path,
                text: result.relationships_xml,
                // A sheet that had no `.rels` part gets one created.
                created: rels_xml === null,
            });
        }
        calculation_chain_stale ||= result.calculation_chain_stale;
        if (active_entry !== undefined || result.worksheet_xml !== sheet_xml) {
            replacements.push({ path, bytes: result.worksheet_xml });
        }
    }

    for (const replacement of replacements) {
        if ('text' in replacement && replacement.created) {
            // A sheet that never had relationships has no `.rels` part to
            // replace; adding one needs no [Content_Types] change because the
            // standard `Default Extension="rels"` already types it.
            zip.add(replacement.path, Buffer.from(replacement.text, 'utf8'));
            continue;
        }
        const written = 'bytes' in replacement
            ? write_part_bytes(zip, replacement.path, replacement.bytes)
            : write_part_text(zip, replacement.path, replacement.text);
        if (!written) throw new Error('Could not update a worksheet to save');
    }
    if (calculation_chain_stale) remove_part(zip, '/xl/calcChain.xml');

    // `xl/sharedStrings.xml` is deliberately not touched, including its `count`.
    // Values are written inline, so no shared-string table entry changes.
    return zip.write();
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
function remove_part(zip: ZipPackage, part_path: string): void {
    if (!zip.has(part_path)) return;
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
        planned = plan_reference_removals(zip, part_path);
    } catch {
        // calcChain is a pure recalculation cache. Leaving it in place costs a
        // stale chain Excel rebuilds on the next calculation; failing the save
        // would cost the user the edit they asked to keep. So the plan is
        // abandoned whole, and the package goes out untouched and consistent.
        return;
    }
    for (const commit of planned) commit();
    zip.remove(part_path);
}

/**
 * Work out how to drop every reference to `part_path`, without changing anything.
 *
 * Returns one thunk per part that needs rewriting; each captures its already-built
 * replacement text, so applying them cannot fail partway on a parse. A part with no
 * reference to remove contributes no thunk.
 */
function plan_reference_removals(
    zip: ZipPackage,
    part_path: string,
): Array<() => void> {
    const commits: Array<() => void> = [];
    const plan = (path: string, stripped: string | null): void => {
        if (stripped === null) return;
        commits.push(() => { write_part_text(zip, path, stripped); });
    };
    plan('/[Content_Types].xml', content_type_override_removed(zip, part_path));
    plan('/xl/_rels/workbook.xml.rels', workbook_relationship_removed(zip, part_path));
    return commits;
}

function* string_live_tags_in(xml: string, name: string): Generator<[number, string]> {
    const ranges = ignorable_ranges(xml, 0, xml.length);
    let pos = 0;
    while (pos < xml.length) {
        const at = xml.indexOf(`<${name}`, pos);
        if (at === -1) return;
        const skip_to = ignorable_end(ranges, at);
        if (skip_to !== undefined) { pos = skip_to; continue; }
        if (!is_tag_boundary(xml[at + name.length + 1])) { pos = at + 1; continue; }
        const tag_end = find_tag_end(xml, at);
        if (tag_end === -1) return;
        yield [at, xml.slice(at, tag_end + 1)];
        pos = tag_end + 1;
    }
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
    for (const [at, tag] of string_live_tags_in(xml, name)) {
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
    zip: ZipPackage,
    part_name: string,
): string | null {
    const xml = read_part_text(zip, '/[Content_Types].xml');
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
    zip: ZipPackage,
    part_path: string,
): string | null {
    const xml = read_part_text(zip, '/xl/_rels/workbook.xml.rels');
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

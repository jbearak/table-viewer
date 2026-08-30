import { createHash } from 'node:crypto';
import {
    apply_utf8_splices,
    update_formula_cached_values,
    worksheet_formula_dependencies,
    worksheet_formula_move_edits,
    worksheet_structured_formula_rename_edits,
    is_xlsx_formula_edit,
    worksheet_content_cells,
    writable_worksheet_sheet_data,
    type XlsxCellEdit,
} from './xlsx-cell-write';
import {
    compile_workbook_formula_graph,
    type WorkbookFormulaPlan,
} from './formula-dependencies';
import type { FormulaCalculationResult } from './formula-calculation';
import {
    compile_a1_formula_move_retargeter,
    retarget_renamed_structured_formula,
    type StructuredFormulaColumnRename,
    type XlsxFormulaCellMove,
} from './xlsx-formula';
import type { PackedFormulaDependencies } from './data-source/interface';
import {
    direct_child_elements,
    find_first_element_by_local_name,
    get_tag_attr,
    opening_tag_text,
    scan_rows,
    utf8_text,
    worksheet_scan_input,
} from './ooxml-worksheet-scan';
import {
    create_number_format_resolver,
    get_style,
    number_format_is_date,
} from './spreadsheet-format';
import {
    decode_xml,
    find_tag_end,
    get_attr as get_xml_attr,
    get_text,
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
import { rels_path_for_part, scan_relationships_document } from './ooxml-relationships';
import type { XlsxHyperlinkEdit } from './xlsx-hyperlink-write';
import {
    apply_worksheet_edits,
    type XlsxWorksheetRowChanges,
} from './ooxml-surgery';
import { ZipPackage, ZipPackageError } from './zip-package';
import { create_workbook_budget } from './spreadsheet-safety';
import type { XlsxPendingRowFormat } from './pending-changes';

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

interface StyleElement {
    readonly open: string;
    readonly inner: string;
}

function style_elements(styles: string, section_name: string, element_name: string): StyleElement[] {
    const section = get_text(styles, section_name);
    if (section === null) return [];
    const elements: StyleElement[] = [];
    iter_elements(section, element_name, (open, inner) => elements.push({ open, inner }));
    return elements;
}

/**
 * Canonicalize the subset of XML syntax used by style definitions. Attribute
 * order, quoting, insignificant inter-tag whitespace, comments and processing
 * instructions do not identify a style; element/attribute names and decoded
 * values do. This is deliberately narrower than a general XML canonicalizer.
 */
function canonical_style_markup(
    markup: string,
    used_prefixes?: Set<string>,
): readonly unknown[] {
    const tokens: unknown[] = [];
    let position = 0;
    while (position < markup.length) {
        const open = markup.indexOf('<', position);
        const text = (open === -1 ? markup.slice(position) : markup.slice(position, open)).trim();
        if (text.length > 0) tokens.push(['text', decode_xml(text)]);
        if (open === -1) break;
        if (markup.startsWith('<!--', open)) {
            const end = markup.indexOf('-->', open + 4);
            position = end === -1 ? markup.length : end + 3;
            continue;
        }
        if (markup.startsWith('<?', open)) {
            const end = markup.indexOf('?>', open + 2);
            position = end === -1 ? markup.length : end + 2;
            continue;
        }
        if (markup.startsWith('<![CDATA[', open)) {
            const end = markup.indexOf(']]>', open + 9);
            const value_end = end === -1 ? markup.length : end;
            tokens.push(['text', markup.slice(open + 9, value_end)]);
            position = end === -1 ? markup.length : end + 3;
            continue;
        }
        const end = find_tag_end(markup, open);
        if (end === -1) {
            tokens.push(['malformed', markup.slice(open)]);
            break;
        }
        const tag = markup.slice(open, end + 1);
        const closing = tag.startsWith('</');
        const self_closing = /\/\s*>$/.test(tag);
        let cursor = closing ? 2 : 1;
        while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
        const name_start = cursor;
        while (cursor < tag.length && !/[\s/>]/.test(tag[cursor])) cursor += 1;
        const name = tag.slice(name_start, cursor);
        const name_colon = name.indexOf(':');
        used_prefixes?.add(name_colon === -1 ? '' : name.slice(0, name_colon));
        if (closing) {
            tokens.push(['close', name]);
            position = end + 1;
            continue;
        }
        const attributes: Array<readonly [string, string]> = [];
        while (cursor < tag.length) {
            while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
            if (cursor >= tag.length || tag[cursor] === '/' || tag[cursor] === '>') break;
            const attr_start = cursor;
            while (cursor < tag.length && !/[\s=/>]/.test(tag[cursor])) cursor += 1;
            const attr_name = tag.slice(attr_start, cursor);
            const attr_colon = attr_name.indexOf(':');
            if (attr_colon > 0 && !attr_name.startsWith('xmlns:')) {
                used_prefixes?.add(attr_name.slice(0, attr_colon));
            }
            while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
            if (tag[cursor] !== '=') break;
            cursor += 1;
            while (cursor < tag.length && /\s/.test(tag[cursor])) cursor += 1;
            const quote = tag[cursor];
            if (quote !== '"' && quote !== "'") break;
            const value_start = ++cursor;
            const value_end = tag.indexOf(quote, value_start);
            if (value_end === -1) break;
            attributes.push([attr_name, decode_xml(tag.slice(value_start, value_end))]);
            cursor = value_end + 1;
        }
        attributes.sort(([left], [right]) => left.localeCompare(right));
        tokens.push(['open', name, attributes, self_closing]);
        position = end + 1;
    }
    return tokens;
}

function append_style_dependency_fingerprint(
    styles: string | null,
    cell_style_indexes: readonly (number | null)[],
    row_style_index?: number,
): string {
    const selected = [...new Set([
        ...cell_style_indexes.map((style) => style ?? row_style_index ?? 0),
        ...(row_style_index === undefined ? [] : [row_style_index]),
    ])]
        .sort((left, right) => left - right);
    if (styles === null) {
        return `sha256:${createHash('sha256').update(JSON.stringify({ selected })).digest('hex')}`;
    }
    const xfs = style_elements(styles, 'cellXfs', 'xf');
    const fonts = style_elements(styles, 'fonts', 'font');
    const fills = style_elements(styles, 'fills', 'fill');
    const borders = style_elements(styles, 'borders', 'border');
    const base_xfs = style_elements(styles, 'cellStyleXfs', 'xf');
    const number_formats = new Map<number, StyleElement>();
    for (const element of style_elements(styles, 'numFmts', 'numFmt')) {
        const id = Number(get_xml_attr(element.open, 'numFmtId'));
        if (Number.isSafeInteger(id) && id >= 0) number_formats.set(id, element);
    }
    const used_prefixes = new Set<string>();
    const canonical = (element: StyleElement | undefined): readonly unknown[] | null =>
        element === undefined
            ? null
            : canonical_style_markup(`${element.open}${element.inner}`, used_prefixes);
    const referenced = (xf: StyleElement, attribute: string): number => {
        const value = Number(get_xml_attr(xf.open, attribute) ?? 0);
        return Number.isSafeInteger(value) && value >= 0 ? value : -1;
    };
    const xf_dependencies = (xf: StyleElement | undefined): unknown => {
        if (xf === undefined) return null;
        const reference = (attribute: string): number => referenced(xf, attribute);
        const font = reference('fontId');
        const fill = reference('fillId');
        const border = reference('borderId');
        const number_format = reference('numFmtId');
        return {
            xf: canonical(xf),
            font: [font, canonical(fonts[font])],
            fill: [fill, canonical(fills[fill])],
            border: [border, canonical(borders[border])],
            numberFormat: number_format < 164
                ? ['builtin', number_format]
                : [number_format, canonical(number_formats.get(number_format))],
        };
    };
    const dependency = selected.map((index) => {
        const xf = xfs[index];
        if (xf === undefined) return { index, missing: true };
        const direct = xf_dependencies(xf) as Record<string, unknown>;
        const base = referenced(xf, 'xfId');
        return {
            index,
            ...direct,
            // A cell XF inherits from cellStyleXfs. Fingerprinting the base tag
            // alone misses its own font/fill/border/custom-format references, so
            // include the same transitive dependency closure used for the cell XF.
            base: [base, xf_dependencies(base_xfs[base])],
        };
    });
    const root_start = styles.search(/<(?:[A-Za-z_][\w.-]*:)?styleSheet(?:\s|\/?>)/);
    const root_end = root_start === -1 ? -1 : find_tag_end(styles, root_start);
    let root: unknown = null;
    if (root_start !== -1 && root_end !== -1) {
        const root_tokens = canonical_style_markup(styles.slice(root_start, root_end + 1));
        const token = root_tokens.find((entry) => Array.isArray(entry) && entry[0] === 'open') as
            | readonly ['open', string, readonly (readonly [string, string])[], boolean]
            | undefined;
        if (token !== undefined) {
            const colon = token[1].indexOf(':');
            used_prefixes.add(colon === -1 ? '' : token[1].slice(0, colon));
            const namespaces = token[2].filter(([name]) => name === 'xmlns'
                ? used_prefixes.has('')
                : name.startsWith('xmlns:')
                    && used_prefixes.has(name.slice('xmlns:'.length)));
            root = [token[1], namespaces];
        }
    }
    return `sha256:${createHash('sha256').update(JSON.stringify({ root, dependency })).digest('hex')}`;
}

function assert_valid_append_style_request(
    cell_style_indexes: readonly (number | null)[],
    row_style_index?: number,
): void {
    if (
        cell_style_indexes.length > 256
        || cell_style_indexes.some((style) => style !== null && (
            !Number.isSafeInteger(style) || style < 0
        ))
        || (row_style_index !== undefined && (
            !Number.isSafeInteger(row_style_index) || row_style_index < 0
        ))
    ) throw new Error('Invalid worksheet append style dependency request');
}

/** Recompute the style dependency fingerprint for an already captured template. */
export function xlsx_append_style_dependency_fingerprint(
    raw: Uint8Array,
    cell_style_indexes: readonly (number | null)[],
    row_style_index?: number,
): string {
    assert_valid_append_style_request(cell_style_indexes, row_style_index);
    let zip: ZipPackage;
    try {
        zip = ZipPackage.open(raw);
    } catch {
        throw new Error('Not a valid .xlsx file');
    }
    const styles = read_part_bytes(zip, '/xl/styles.xml');
    return append_style_dependency_fingerprint(
        styles === null ? null : Buffer.from(styles).toString('utf8'),
        cell_style_indexes,
        row_style_index,
    );
}

/** Retain only the styles part needed to re-key a reconciled append template. */
export function create_xlsx_append_style_dependency_fingerprinter(
    raw: Uint8Array,
): (
    cell_style_indexes: readonly (number | null)[],
    row_style_index?: number,
) => string {
    let zip: ZipPackage;
    try {
        zip = ZipPackage.open(raw);
    } catch {
        throw new Error('Not a valid .xlsx file');
    }
    const styles = read_part_bytes(zip, '/xl/styles.xml');
    const styles_text = styles === null ? null : Buffer.from(styles).toString('utf8');
    return (cell_style_indexes, row_style_index) => {
        assert_valid_append_style_request(cell_style_indexes, row_style_index);
        return append_style_dependency_fingerprint(
            styles_text,
            cell_style_indexes,
            row_style_index,
        );
    };
}

function parse_append_style_index(raw: string, message: string): number {
    const normalized = raw.replace(/^[\t\n\r ]+|[\t\n\r ]+$/g, '');
    if (!/^[+-]?[0-9]+$/.test(normalized)) throw new Error(message);
    const parsed = Number(normalized);
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new Error(message);
    return parsed;
}

/**
 * Capture the exact presentation dependency for rows admitted at the physical
 * worksheet tail. This reads the verified package, never the paged DataSource,
 * so a sparse or unloaded final row cannot silently lose its formatting.
 */
export function capture_xlsx_append_row_format(
    raw: Uint8Array,
    sheet_index: number,
    source_row_count: number,
    column_count: number,
    header_source_row?: number,
    viewer_row_height?: number,
): XlsxPendingRowFormat {
    if (
        !Number.isSafeInteger(sheet_index)
        || sheet_index < 0
        || !Number.isSafeInteger(source_row_count)
        || source_row_count < 0
        || source_row_count > 1_048_576
        || !Number.isSafeInteger(column_count)
        || column_count <= 0
        || column_count > 256
    ) throw new Error('Invalid worksheet append format request');

    let zip: ZipPackage;
    try {
        zip = ZipPackage.open(raw);
    } catch {
        throw new Error('Not a valid .xlsx file');
    }
    const part = worksheet_part_entries_from_package(zip)[sheet_index];
    if (!part) throw new Error('Could not locate a worksheet to append');
    const content = read_part_bytes(zip, `/${part.path}`);
    if (!content) throw new Error('Could not read a worksheet to append');
    const xml = worksheet_scan_input(content);
    const sheet_data = writable_worksheet_sheet_data(xml).element;

    const styles = read_part_bytes(zip, '/xl/styles.xml') ?? new Uint8Array();
    let templateSourceRow: number | null = source_row_count === 0
        ? null
        : source_row_count - 1;
    if (templateSourceRow === header_source_row) {
        templateSourceRow = templateSourceRow === 0 ? null : templateSourceRow - 1;
    }
    const cellStyleIndexes: Array<number | null> = Array(column_count).fill(null);
    let nativeRowHeight: number | undefined;
    let rowStyleIndex: number | undefined;
    let thickTop: true | undefined;
    let thickBottom: true | undefined;
    let phonetic: true | undefined;

    if (templateSourceRow !== null) {
        const seen_columns = new Set<number>();
        const rows = scan_rows(xml, sheet_data.inner_start, sheet_data.inner_end, {
            capture_cell: (row) => row === templateSourceRow,
            on_cell: (row, col, cell) => {
                if (row !== templateSourceRow || col >= column_count) return;
                if (seen_columns.has(col)) {
                    throw new Error('The append format row contains duplicate cells');
                }
                seen_columns.add(col);
                const raw_style = get_tag_attr(xml, cell.start, cell.inner_start, 's');
                if (raw_style === null) return;
                const style = parse_append_style_index(
                    raw_style,
                    'The append format row contains an invalid style',
                );
                cellStyleIndexes[col] = style;
            },
        });
        const owners = rows.get(templateSourceRow);
        if (owners && owners.length > 1) {
            throw new Error('The append format row is ambiguous');
        }
        const owner = owners?.[0];
        if (owner) {
            const boolean_attribute = (name: string): boolean => {
                const raw = get_tag_attr(xml, owner.start, owner.inner_start, name);
                if (raw === null || raw === '0' || raw === 'false') return false;
                if (raw === '1' || raw === 'true') return true;
                throw new Error(`The append format row has an invalid ${name} flag`);
            };
            const raw_height = get_tag_attr(xml, owner.start, owner.inner_start, 'ht');
            if (raw_height !== null) {
                const parsed = Number(raw_height);
                if (!Number.isFinite(parsed) || parsed <= 0) {
                    throw new Error('The append format row has an invalid height');
                }
                nativeRowHeight = parsed;
            }
            const custom_format = boolean_attribute('customFormat');
            const raw_row_style = get_tag_attr(xml, owner.start, owner.inner_start, 's');
            if (raw_row_style !== null) {
                const parsed = parse_append_style_index(
                    raw_row_style,
                    'The append format row contains an invalid row style',
                );
                if (custom_format) rowStyleIndex = parsed;
            } else if (custom_format) {
                rowStyleIndex = 0;
            }
            if (boolean_attribute('thickTop')) thickTop = true;
            if (boolean_attribute('thickBot')) thickBottom = true;
            if (boolean_attribute('ph')) phonetic = true;
        }
    }

    const styles_text = styles.length === 0 ? null : Buffer.from(styles).toString('utf8');
    const { cellNumberFormats, cellFontStyles, rowNumberFormat, rowFontStyle } = styles_text === null
        ? (() => {
            if (
                cellStyleIndexes.some((style) => style !== null && style !== 0)
                || (rowStyleIndex !== undefined && rowStyleIndex !== 0)
            ) {
                throw new Error('The append format row references a missing cell style');
            }
            return {
                cellNumberFormats: cellStyleIndexes.map(() => null),
                cellFontStyles: cellStyleIndexes.map(() => ({
                    bold: false,
                    italic: false,
                })),
                rowNumberFormat: rowStyleIndex === undefined ? undefined : null,
                rowFontStyle: rowStyleIndex === undefined ? undefined : {
                    bold: false,
                    italic: false,
                },
            };
        })()
        : (() => {
            const { fonts, xfs, format_map } = parse_styles(styles_text);
            if (
                cellStyleIndexes.some((style) => style !== null && style >= xfs.length)
                || (rowStyleIndex !== undefined && rowStyleIndex >= xfs.length)
            ) {
                throw new Error('The append format row references a missing cell style');
            }
            const resolve = create_number_format_resolver(xfs, format_map, read_datemode(zip));
            const row_font = rowStyleIndex === undefined
                ? undefined
                : get_style(rowStyleIndex, xfs, fonts);
            return {
                cellNumberFormats: cellStyleIndexes.map(
                    (style) => resolve(style ?? rowStyleIndex ?? 0) ?? null,
                ),
                cellFontStyles: cellStyleIndexes.map((style) => {
                    const font = get_style(style ?? rowStyleIndex ?? 0, xfs, fonts);
                    return { bold: font.bold, italic: font.italic };
                }),
                rowNumberFormat: rowStyleIndex === undefined
                    ? undefined
                    : resolve(rowStyleIndex) ?? null,
                rowFontStyle: row_font === undefined ? undefined : {
                    bold: row_font.bold,
                    italic: row_font.italic,
                },
            };
        })();
    const styleFingerprint = append_style_dependency_fingerprint(
        styles_text,
        cellStyleIndexes,
        rowStyleIndex,
    );
    const cellStyleFingerprints = cellStyleIndexes.map((style) =>
        append_style_dependency_fingerprint(styles_text, [style], rowStyleIndex));
    return Object.freeze({
        kind: 'xlsx',
        templateSourceRow,
        styleFingerprint,
        cellStyleIndexes: Object.freeze(cellStyleIndexes),
        cellStyleFingerprints: Object.freeze(cellStyleFingerprints),
        cellNumberFormats: Object.freeze(cellNumberFormats),
        cellFontStyles: Object.freeze(cellFontStyles.map((entry) => Object.freeze(entry))),
        ...(rowStyleIndex === undefined ? {} : { rowStyleIndex }),
        ...(rowNumberFormat === undefined ? {} : {
            rowNumberFormat: rowNumberFormat === null
                ? null
                : Object.freeze(rowNumberFormat),
        }),
        ...(rowFontStyle === undefined ? {} : {
            rowFontStyle: Object.freeze(rowFontStyle),
        }),
        ...(thickTop === undefined ? {} : { thickTop }),
        ...(thickBottom === undefined ? {} : { thickBottom }),
        ...(phonetic === undefined ? {} : { phonetic }),
        ...(nativeRowHeight === undefined ? {} : { nativeRowHeight }),
        ...(viewer_row_height === undefined ? {} : { viewerRowHeight: viewer_row_height }),
    });
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
    readonly row_changes?: XlsxWorksheetRowChanges;
}

export interface XlsxFormulaCacheAddress {
    readonly sheetIndex: number;
    readonly row: number;
    readonly column: number;
}

export interface XlsxFormulaCacheResult extends XlsxFormulaCacheAddress {
    readonly value: string;
}

const XLSX_FORMULA_WRITE_PLAN = Symbol('xlsx-formula-write-plan');

export interface XlsxFormulaWritePlan {
    readonly [XLSX_FORMULA_WRITE_PLAN]: {
        readonly sheetCount: number;
        readonly invalidations: readonly XlsxFormulaCacheAddress[];
        readonly results: readonly XlsxFormulaCacheResult[];
    };
}

/**
 * Derive one immutable, complete cache-write capability from a calculation plan.
 * Successful results supersede invalidation; every other impacted/target formula
 * has its stale cache removed.
 */
export function create_xlsx_formula_write_plan(
    plan: WorkbookFormulaPlan,
    calculation_results: readonly FormulaCalculationResult[],
): XlsxFormulaWritePlan {
    if (
        !Number.isSafeInteger(plan.sheetCount)
        || plan.sheetCount < 0
        || plan.formulaLimitExceeded
    ) throw new Error('Invalid formula calculation plan');

    const addresses = new Map<string, XlsxFormulaCacheAddress>();
    const add_address = (address: XlsxFormulaCacheAddress): string => {
        if (
            !Number.isSafeInteger(address.sheetIndex)
            || address.sheetIndex < 0
            || address.sheetIndex >= plan.sheetCount
            || !Number.isSafeInteger(address.row)
            || address.row < 0
            || address.row >= 1_048_576
            || !Number.isSafeInteger(address.column)
            || address.column < 0
            || address.column >= 16_384
        ) throw new Error('Invalid formula cache address');
        const key = `${address.sheetIndex}:${address.row}:${address.column}`;
        if (!addresses.has(key)) addresses.set(key, Object.freeze({ ...address }));
        return key;
    };
    for (let sheetIndex = 0; sheetIndex < plan.sheetCount; sheetIndex += 1) {
        for (const cell of plan.impact.forSheet(sheetIndex).cells()) {
            add_address({ sheetIndex, row: cell.row, column: cell.column });
        }
    }
    const target_keys = new Set(plan.targets.map(add_address));

    const results_by_key = new Map<string, XlsxFormulaCacheResult>();
    for (const result of calculation_results) {
        if (result.value === undefined) continue;
        const key = `${result.sheetIndex}:${result.row}:${result.column}`;
        if (!target_keys.has(key) || results_by_key.has(key)) {
            throw new Error('Formula result does not match the calculation plan');
        }
        if (!Number.isFinite(Number(result.value))) {
            throw new Error('Invalid formula cache result');
        }
        results_by_key.set(key, Object.freeze({
            sheetIndex: result.sheetIndex,
            row: result.row,
            column: result.column,
            value: result.value,
        }));
    }
    const invalidations = Object.freeze(
        [...addresses].flatMap(([key, address]) => results_by_key.has(key) ? [] : [address]),
    );
    const results = Object.freeze([...results_by_key.values()]);
    return Object.freeze({
        [XLSX_FORMULA_WRITE_PLAN]: Object.freeze({
            sheetCount: plan.sheetCount,
            invalidations,
            results,
        }),
    });
}

export interface XlsxWorkbookWriteOptions {
    /** Topology parsed from the verified source, in current worksheet order. */
    readonly formulaDependencies?: readonly {
        readonly formulaDependencies?: PackedFormulaDependencies;
    }[];
    /** Opaque cache plan precomputed for this exact edit set. */
    readonly formulaWritePlan?: XlsxFormulaWritePlan;
    readonly structuredColumnRenames?: readonly StructuredFormulaColumnRename[];
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
    let active = worksheets.filter(
        ({ edits, link_edits, row_changes }) => edits.length > 0
            || (link_edits?.length ?? 0) > 0
            || (row_changes?.removeRows.length ?? 0) > 0
            || (row_changes?.appendRows.length ?? 0) > 0,
    );
    if (active.length === 0) return raw;
    if (options?.formulaWritePlan && options.formulaDependencies) {
        throw new Error('Formula write plan and dependency fallback are mutually exclusive');
    }

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
    const worksheet_bytes = new Map<number, Uint8Array>();
    const read_worksheet_bytes = (sheet_index: number, error: string): Uint8Array => {
        const cached = worksheet_bytes.get(sheet_index);
        if (cached !== undefined) return cached;
        const content = read_part_bytes(zip, `/${parts[sheet_index].path}`);
        if (content === null) throw new Error(error);
        worksheet_bytes.set(sheet_index, content);
        return content;
    };
    const sheet_names = parts.map((part) => part.name);
    const moves: XlsxFormulaCellMove[] = [];
    const moved_sources = new Map<string, string>();
    const moved_destinations = new Set<string>();
    for (const worksheet of active) {
        for (const edit of worksheet.edits) {
            if (edit.movedFrom === undefined) continue;
            const source = edit.movedFrom;
            for (const previous of source.previous ?? []) {
                moves.push({
                    order: previous.order,
                    sheetIndex: worksheet.sheetIndex,
                    sourceRow: previous.sourceRow,
                    sourceColumn: previous.sourceCol,
                    destinationRow: previous.destinationRow,
                    destinationColumn: previous.destinationCol,
                });
            }
            if (
                !Number.isSafeInteger(source.row)
                || source.row < 0
                || source.row >= 1_048_576
                || !Number.isSafeInteger(source.col)
                || source.col < 0
                || source.col >= 16_384
                || !Number.isSafeInteger(source.order ?? 0)
                || (source.order ?? 0) < 0
                || !Number.isSafeInteger(edit.row)
                || edit.row < 0
                || edit.row >= 1_048_576
                || !Number.isSafeInteger(edit.col)
                || edit.col < 0
                || edit.col >= 16_384
            ) throw new Error('Invalid formula move coordinates');
            const source_key = `${worksheet.sheetIndex}:${source.row}:${source.col}`;
            const destination_key = `${worksheet.sheetIndex}:${edit.row}:${edit.col}`;
            const ordered_source_key = `${source.order ?? 0}:${source_key}`;
            const ordered_destination_key = `${source.order ?? 0}:${destination_key}`;
            const previous = moved_sources.get(ordered_source_key);
            if (previous !== undefined && previous !== destination_key) {
                throw new Error('One source cell cannot move to several destinations');
            }
            if (moved_destinations.has(ordered_destination_key)) {
                throw new Error('Several source cells cannot move to one destination');
            }
            moved_sources.set(ordered_source_key, destination_key);
            moved_destinations.add(ordered_destination_key);
            moves.push({
                order: source.order ?? 0,
                sheetIndex: worksheet.sheetIndex,
                sourceRow: source.row,
                sourceColumn: source.col,
                destinationRow: edit.row,
                destinationColumn: edit.col,
            });
        }
    }
    const validated_sources = new Set<string>();
    const validated_destinations = new Set<string>();
    for (const move of moves) {
        if (!Number.isSafeInteger(move.sheetIndex) || move.sheetIndex < 0
            || !Number.isSafeInteger(move.sourceRow) || move.sourceRow < 0 || move.sourceRow >= 1_048_576
            || !Number.isSafeInteger(move.destinationRow) || move.destinationRow < 0 || move.destinationRow >= 1_048_576
            || !Number.isSafeInteger(move.sourceColumn) || move.sourceColumn < 0 || move.sourceColumn >= 16_384
            || !Number.isSafeInteger(move.destinationColumn) || move.destinationColumn < 0 || move.destinationColumn >= 16_384
            || !Number.isSafeInteger(move.order ?? 0) || (move.order ?? 0) < 0) {
            throw new Error('Invalid formula move coordinates');
        }
        const source_key = `${move.order ?? 0}:${move.sheetIndex}:${move.sourceRow}:${move.sourceColumn}`;
        const destination_key = `${move.order ?? 0}:${move.sheetIndex}:${move.destinationRow}:${move.destinationColumn}`;
        if (validated_sources.has(source_key) || validated_destinations.has(destination_key)) {
            throw new Error('A move operation contains duplicate cells');
        }
        validated_sources.add(source_key);
        validated_destinations.add(destination_key);
    }
    if (moves.length > 0) {
        const edits_by_address = new Map<string, XlsxCellEdit>();
        for (const worksheet of active) {
            for (const edit of worksheet.edits) {
                edits_by_address.set(`${worksheet.sheetIndex}:${edit.row}:${edit.col}`, edit);
            }
        }
        const content_sources = new Set<string>();
        const moves_by_sheet = new Map<number, XlsxFormulaCellMove[]>();
        for (const move of moves) {
            const sheet_moves = moves_by_sheet.get(move.sheetIndex) ?? [];
            sheet_moves.push(move);
            moves_by_sheet.set(move.sheetIndex, sheet_moves);
        }
        for (let sheet_index = 0; sheet_index < parts.length; sheet_index += 1) {
            const sheet_moves = moves_by_sheet.get(sheet_index) ?? [];
            if (sheet_moves.length === 0) continue;
            const content = read_worksheet_bytes(
                sheet_index,
                'Could not read a worksheet to validate a move',
            );
            for (const key of worksheet_content_cells(
                worksheet_scan_input(content),
                sheet_moves.map((move) => ({ row: move.sourceRow, col: move.sourceColumn })),
            )) content_sources.add(`${sheet_index}:${key}`);
        }
        const destinations_by_operation = new Set(moves.map((move) =>
            `${move.order ?? 0}:${move.sheetIndex}:${move.destinationRow}:${move.destinationColumn}`));
        for (const move of moves) {
            const source_key = `${move.sheetIndex}:${move.sourceRow}:${move.sourceColumn}`;
            const destination_key = `${move.sheetIndex}:${move.destinationRow}:${move.destinationColumn}`;
            if (!edits_by_address.has(destination_key)) {
                throw new Error('A move destination has no matching cell edit');
            }
            const destination_in_operation = destinations_by_operation.has(
                `${move.order ?? 0}:${move.sheetIndex}:${move.sourceRow}:${move.sourceColumn}`,
            );
            const source_edit = edits_by_address.get(source_key);
            const source_rewritten_after_move = source_edit?.valueEditOrder !== undefined
                && source_edit.valueEditOrder > (move.order ?? 0);
            if (!destination_in_operation && !source_rewritten_after_move && (
                source_edit === undefined ? content_sources.has(source_key) : source_edit.value !== ''
            )) {
                throw new Error('A move source was not cleared');
            }
        }
        const retarget_formula = compile_a1_formula_move_retargeter(sheet_names, moves);
        active = active.map((worksheet) => ({
            ...worksheet,
            edits: worksheet.edits.map((edit) => {
                if (!is_xlsx_formula_edit(edit)) return edit;
                return {
                    ...edit,
                    value: retarget_formula(
                        edit.value,
                        worksheet.sheetIndex,
                        edit.valueEditOrder ?? 0,
                    ),
                };
            }),
        }));
        const formula_budget = create_workbook_budget();
        const active_by_index = new Map(active.map((entry) => [entry.sheetIndex, entry]));
        for (let sheet_index = 0; sheet_index < parts.length; sheet_index += 1) {
            const content = read_worksheet_bytes(sheet_index, 'Could not read a worksheet to save');
            const current = active_by_index.get(sheet_index);
            const excluded = new Set((current?.edits ?? []).map(
                (edit) => `${edit.row}:${edit.col}`,
            ));
            const derived = worksheet_formula_move_edits(
                worksheet_scan_input(content),
                sheet_index,
                sheet_names,
                moves,
                excluded,
                formula_budget,
            );
            if (derived.length === 0) continue;
            active_by_index.set(sheet_index, {
                sheetIndex: sheet_index,
                edits: [...(current?.edits ?? []), ...derived],
                ...(current?.link_edits === undefined ? {} : { link_edits: current.link_edits }),
                ...(current?.row_changes === undefined
                    ? {}
                    : { row_changes: current.row_changes }),
            });
        }
        active = [...active_by_index.values()].sort(
            (left, right) => left.sheetIndex - right.sheetIndex,
        );
    }
    const structured_renames = options?.structuredColumnRenames ?? [];
    if (structured_renames.length > 0) {
        active = active.map((worksheet) => ({
            ...worksheet,
            edits: worksheet.edits.map((edit) => !is_xlsx_formula_edit(edit) ? edit : ({
                ...edit,
                value: retarget_renamed_structured_formula(
                    edit.value,
                    worksheet.sheetIndex,
                    sheet_names,
                    structured_renames,
                ),
            })),
        }));
        const formula_budget = create_workbook_budget();
        const active_by_index = new Map(active.map((entry) => [entry.sheetIndex, entry]));
        for (let sheet_index = 0; sheet_index < parts.length; sheet_index += 1) {
            const content = read_worksheet_bytes(
                sheet_index,
                'Could not read a worksheet to rename a column',
            );
            const current = active_by_index.get(sheet_index);
            const excluded = new Set((current?.edits ?? []).map(
                (edit) => `${edit.row}:${edit.col}`,
            ));
            const derived = worksheet_structured_formula_rename_edits(
                worksheet_scan_input(content),
                sheet_index,
                sheet_names,
                structured_renames,
                excluded,
                formula_budget,
            );
            if (derived.length === 0) continue;
            active_by_index.set(sheet_index, {
                sheetIndex: sheet_index,
                edits: [...(current?.edits ?? []), ...derived],
                ...(current?.link_edits === undefined ? {} : { link_edits: current.link_edits }),
                ...(current?.row_changes === undefined
                    ? {}
                    : { row_changes: current.row_changes }),
            });
        }
        active = [...active_by_index.values()].sort(
            (left, right) => left.sheetIndex - right.sheetIndex,
        );
    }
    const formula_invalidations_by_sheet = new Map<number, Array<{
        readonly row: number;
        readonly column: number;
    }>>();
    if (options?.formulaWritePlan !== undefined) {
        const formula_write_plan = options.formulaWritePlan[XLSX_FORMULA_WRITE_PLAN];
        if (!formula_write_plan) {
            throw new Error('Invalid formula write plan');
        }
        if (formula_write_plan.sheetCount !== parts.length) {
            throw new Error('Formula write plan does not match the workbook');
        }
        const add_formula_invalidation = (invalidation: XlsxFormulaCacheAddress): void => {
            if (
                !Number.isSafeInteger(invalidation.sheetIndex)
                || invalidation.sheetIndex < 0
                || invalidation.sheetIndex >= parts.length
                || !Number.isSafeInteger(invalidation.row)
                || invalidation.row < 0
                || invalidation.row >= 1_048_576
                || !Number.isSafeInteger(invalidation.column)
                || invalidation.column < 0
                || invalidation.column >= 16_384
            ) throw new Error('Invalid formula cache invalidation');
            const sheet = formula_invalidations_by_sheet.get(invalidation.sheetIndex) ?? [];
            sheet.push(invalidation);
            formula_invalidations_by_sheet.set(invalidation.sheetIndex, sheet);
        };
        for (const invalidation of formula_write_plan.invalidations) {
            add_formula_invalidation(invalidation);
        }
        for (const result of formula_write_plan.results) {
            if (!Number.isFinite(Number(result.value))) {
                throw new Error('Invalid formula cache result');
            }
            add_formula_invalidation(result);
        }
    } else {
        const has_value_edits = active.some(({ edits }) => edits.length > 0);
        const formula_budget = create_workbook_budget();
        const dependency_sheets = !has_value_edits
            ? parts.map(() => ({}))
            : options?.formulaDependencies?.length === parts.length
            ? options.formulaDependencies
            : parts.map((part, sheet_index) => {
                const content = read_worksheet_bytes(
                    sheet_index,
                    'Could not read a worksheet to save',
                );
                return {
                    formulaDependencies: worksheet_formula_dependencies(
                        worksheet_scan_input(content),
                        sheet_index,
                        sheet_names,
                        formula_budget,
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
        for (let sheet_index = 0; sheet_index < parts.length; sheet_index += 1) {
            const cells = [...formula_impact.forSheet(sheet_index).cells()];
            if (cells.length > 0) formula_invalidations_by_sheet.set(sheet_index, cells);
        }
    }
    const { is_date_style, cell_font_style, run_font_base } = read_style_write_context(zip);
    const datemode = read_datemode(zip);
    let calculation_chain_stale = false;
    const replacements: Array<
        | { path: string; bytes: Uint8Array }
        | { path: string; text: string; created?: boolean }
    > = [];

    const active_by_sheet = new Map(active.map((entry) => [entry.sheetIndex, entry]));
    const formula_results_by_sheet = new Map<number, Array<{
        readonly row: number;
        readonly column: number;
        readonly value: string;
    }>>();
    const formula_write_plan = options?.formulaWritePlan?.[XLSX_FORMULA_WRITE_PLAN];
    // A move changes formula source text after the renderer's calculation plan
    // was made. Its numeric results describe the old formulas, so retain none;
    // every result address was already added to invalidations above.
    for (const result of moves.length > 0 ? [] : formula_write_plan?.results ?? []) {
        const sheet = formula_results_by_sheet.get(result.sheetIndex) ?? [];
        sheet.push(result);
        formula_results_by_sheet.set(result.sheetIndex, sheet);
    }
    const touched_sheets = new Set(active_by_sheet.keys());
    for (const sheet_index of formula_invalidations_by_sheet.keys()) {
        touched_sheets.add(sheet_index);
    }

    for (const sheetIndex of [...touched_sheets].sort((left, right) => left - right)) {
        const active_entry = active_by_sheet.get(sheetIndex);
        const edits = active_entry?.edits ?? [];
        const link_edits = active_entry?.link_edits;
        const part = parts[sheetIndex];
        if (!part) throw new Error('Could not locate a worksheet to save');
        const path = `/${part.path}`;
        const sheet_content = read_worksheet_bytes(
            sheetIndex,
            'Could not read a worksheet to save',
        );
        const sheet_xml = worksheet_scan_input(sheet_content);

        const rels_path = `/${rels_path_for_part(part.path)}`;
        const rels_xml = link_edits && link_edits.length > 0
            ? read_part_text(zip, rels_path)
            : null;
        const invalidations = formula_invalidations_by_sheet.get(sheetIndex) ?? [];
        const formula_result_updates = formula_results_by_sheet.get(sheetIndex) ?? [];
        const result = active_entry === undefined
            ? {
                worksheet_xml: update_formula_cached_values(
                    sheet_xml,
                    invalidations,
                    formula_result_updates,
                ),
                relationships_xml: null,
                calculation_chain_stale: false,
            }
            : apply_worksheet_edits({
                worksheet_xml: sheet_xml,
                relationships_xml: rels_xml,
                cell_edits: edits,
                hyperlink_edits: link_edits,
                row_changes: active_entry.row_changes,
                write_options: {
                    datemode,
                    is_date_style,
                    cell_font_style,
                    run_font_base,
                    sheet_name: part.name,
                    formula_result_invalidations: invalidations,
                    formula_result_updates,
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

function local_name(name: string): string {
    return name.slice(name.lastIndexOf(':') + 1);
}

function qname_prefix(name: string): string {
    const colon = name.indexOf(':');
    return colon === -1 ? '' : name.slice(0, colon);
}

function namespace_attribute(prefix: string): string {
    return prefix === '' ? 'xmlns' : `xmlns:${prefix}`;
}

/** Remove selected direct children in the same namespace as a qualified root. */
function remove_namespaced_children(
    xml: string,
    root_local_name: string,
    child_local_name: string,
    supported_namespaces: ReadonlySet<string>,
    wanted: (tag: string) => boolean,
): string {
    const bytes = Buffer.from(xml, 'utf8');
    const root = find_first_element_by_local_name(bytes, root_local_name);
    if (root === null) throw new Error(`Malformed ${root_local_name} part`);
    const root_open = opening_tag_text(bytes, root.element);
    const root_namespace = get_xml_attr(
        root_open,
        namespace_attribute(qname_prefix(root.name)),
    );
    if (root_namespace === null || !supported_namespaces.has(root_namespace)) {
        throw new Error(`Unsupported ${root_local_name} namespace`);
    }
    const splices = direct_child_elements(bytes, root.element).flatMap((child) => {
        if (local_name(child.name) !== child_local_name) return [];
        const open = opening_tag_text(bytes, child.element);
        const declaration = namespace_attribute(qname_prefix(child.name));
        const child_namespace = get_xml_attr(open, declaration)
            ?? get_xml_attr(root_open, declaration);
        if (child_namespace !== root_namespace || !wanted(open)) return [];
        return [{ start: child.element.start, end: child.element.end, text: '' }];
    });
    return utf8_text(apply_utf8_splices(bytes, splices));
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
    const stripped = remove_namespaced_children(
        xml,
        'Types',
        'Override',
        new Set([
            'http://schemas.openxmlformats.org/package/2006/content-types',
            'http://purl.oclc.org/ooxml/package/content-types',
        ]),
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
    const document = scan_relationships_document(xml);
    if (document === undefined) throw new Error('Malformed workbook relationships part');
    const bytes = Buffer.from(xml, 'utf8');
    const stripped = utf8_text(apply_utf8_splices(bytes, document.relationships.flatMap(
        (relationship) => {
            const path = attr(relationship.openTag, 'Target');
            if (path === null || resolve_part_path(path) !== wanted) return [];
            return [{
                start: relationship.element.start,
                end: relationship.element.end,
                text: '',
            }];
        },
    )));
    return stripped === xml ? null : stripped;
}

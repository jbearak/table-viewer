// Hand-built `.xlsx` packages for the structural save tests: a real ZIP with
// content types, relationships, styles, and shared strings, so the reader,
// the support scan, the writer, and independent readers all see a complete
// workbook.
import CFB from 'cfb';

export const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
export const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PKG_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const OD = REL_NS;

export interface FixtureRelationship {
    readonly id: string;
    readonly type: 'hyperlink' | 'printerSettings';
    readonly target: string;
    readonly external?: boolean;
}

export interface FixtureSheet {
    readonly name: string;
    /** Children of `<worksheet>`, `sheetData` included. */
    readonly body: string;
    readonly relationships?: readonly FixtureRelationship[];
}

export interface FixtureWorkbook {
    readonly sheets: readonly FixtureSheet[];
    readonly definedNames?: string;
    /** Shared strings, referenced by index from `t="s"` cells. */
    readonly sharedStrings?: readonly string[];
    /** Include `xl/calcChain.xml` listing these cells (`Sheet index`, `A1` ref). */
    readonly calcChain?: readonly { readonly sheet: number; readonly ref: string }[];
}

/** Four cell formats: 0 default, 1 bold, 2 percent, 3 fill. */
export const FIXTURE_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="${MAIN_NS}"><numFmts count="0"/>`
    + '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="11"/><name val="Calibri"/></font></fonts>'
    + '<fills count="3"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill>'
    + '<fill><patternFill patternType="solid"><fgColor rgb="FFFFFF00"/><bgColor indexed="64"/></patternFill></fill></fills>'
    + '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>'
    + '<cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>'
    + '<cellXfs count="4"><xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>'
    + '<xf numFmtId="0" fontId="1" fillId="0" borderId="0" xfId="0" applyFont="1"/>'
    + '<xf numFmtId="9" fontId="0" fillId="0" borderId="0" xfId="0" applyNumberFormat="1"/>'
    + '<xf numFmtId="0" fontId="0" fillId="2" borderId="0" xfId="0" applyFill="1"/></cellXfs>'
    + '<cellStyles count="1"><cellStyle name="Normal" xfId="0" builtinId="0"/></cellStyles>'
    + '<dxfs count="1"><dxf><font><b/></font></dxf></dxfs></styleSheet>';

function rels(relationships: readonly { id: string; type: string; target: string; external?: boolean }[]): string {
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n<Relationships xmlns="${PKG_REL_NS}">${
        relationships.map((relationship) => `<Relationship Id="${relationship.id}" Type="${relationship.type}" Target="${relationship.target}"${
            relationship.external ? ' TargetMode="External"' : ''}/>`).join('')
    }</Relationships>`;
}

function xml_text(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

export function build_fixture_xlsx(spec: FixtureWorkbook): Uint8Array {
    const file = CFB.utils.cfb_new();
    const add = (name: string, text: string): void => {
        CFB.utils.cfb_add(file, `/${name}`, Buffer.from(text, 'utf8'));
    };
    const overrides = [
        '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>',
        '<Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>',
        ...spec.sheets.map((_, index) => `<Override PartName="/xl/worksheets/sheet${index + 1}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`),
        ...(spec.sharedStrings === undefined ? [] : ['<Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>']),
        ...(spec.calcChain === undefined ? [] : ['<Override PartName="/xl/calcChain.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.calcChain+xml"/>']),
    ];
    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Default Extension="bin" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.printerSettings"/>${overrides.join('')}</Types>`);
    add('_rels/.rels', rels([{ id: 'rId1', type: `${OD}/officeDocument`, target: 'xl/workbook.xml' }]));
    const workbook_relationships = [
        ...spec.sheets.map((_, index) => ({ id: `rId${index + 1}`, type: `${OD}/worksheet`, target: `worksheets/sheet${index + 1}.xml` })),
        { id: `rId${spec.sheets.length + 1}`, type: `${OD}/styles`, target: 'styles.xml' },
        ...(spec.sharedStrings === undefined ? [] : [{ id: `rId${spec.sheets.length + 2}`, type: `${OD}/sharedStrings`, target: 'sharedStrings.xml' }]),
        ...(spec.calcChain === undefined ? [] : [{ id: `rId${spec.sheets.length + 3}`, type: `${OD}/calcChain`, target: 'calcChain.xml' }]),
    ];
    add('xl/_rels/workbook.xml.rels', rels(workbook_relationships));
    add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><bookViews><workbookView/></bookViews><sheets>${
    spec.sheets.map((sheet, index) => `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`).join('')
}</sheets>${spec.definedNames === undefined ? '' : `<definedNames>${spec.definedNames}</definedNames>`}<calcPr calcId="191029"/></workbook>`);
    add('xl/styles.xml', FIXTURE_STYLES);
    if (spec.sharedStrings !== undefined) {
        add('xl/sharedStrings.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="${MAIN_NS}" count="${spec.sharedStrings.length}" uniqueCount="${spec.sharedStrings.length}">${
    spec.sharedStrings.map((text) => `<si><t>${xml_text(text)}</t></si>`).join('')
}</sst>`);
    }
    if (spec.calcChain !== undefined) {
        add('xl/calcChain.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<calcChain xmlns="${MAIN_NS}">${spec.calcChain.map((cell) => `<c r="${cell.ref}" i="${cell.sheet + 1}"/>`).join('')}</calcChain>`);
    }
    spec.sheets.forEach((sheet, index) => {
        add(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}">${sheet.body}</worksheet>`);
        if (sheet.relationships !== undefined) {
            add(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, rels(sheet.relationships.map((relationship) => ({
                id: relationship.id,
                type: `${OD}/${relationship.type}`,
                target: relationship.target,
                ...(relationship.external ? { external: true } : {}),
            }))));
            for (const relationship of sheet.relationships) {
                if (relationship.type === 'printerSettings') {
                    CFB.utils.cfb_add(file, `/xl/printerSettings/${relationship.target.split('/').pop()}`, Buffer.from([1, 2, 3, 4]));
                }
            }
        }
    });
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? new Uint8Array(written) : new Uint8Array(written as ArrayBufferLike);
}

/** A cell element: number, inline string, shared string index, or formula (with an optional cached value). */
export function cell(ref: string, value: number | string | { f: string; v?: number; shared?: { si: number; ref?: string } } | { s: number }, style?: number): string {
    const s = style === undefined ? '' : ` s="${style}"`;
    if (typeof value === 'number') return `<c r="${ref}"${s}><v>${value}</v></c>`;
    if (typeof value === 'string') return `<c r="${ref}"${s} t="inlineStr"><is><t>${xml_text(value)}</t></is></c>`;
    if ('s' in value) return `<c r="${ref}"${s} t="s"><v>${value.s}</v></c>`;
    const shared = value.shared === undefined
        ? ''
        : ` t="shared" si="${value.shared.si}"${value.shared.ref === undefined ? '' : ` ref="${value.shared.ref}"`}`;
    return `<c r="${ref}"${s}><f${shared}>${xml_text(value.f)}</f>${value.v === undefined ? '' : `<v>${value.v}</v>`}</c>`;
}

export function row(number: number, cells: readonly string[], attributes = ''): string {
    return `<row r="${number}"${attributes}>${cells.join('')}</row>`;
}

/**
 * The representative two-sheet workbook the structural save tests and the
 * independent-reader proof share.
 *
 * Data (Header Row 1, body rows 2-7): Item / Qty / Price / Total, with
 * `Total` a shared formula `B*C`, bold header, percent styles on column C,
 * a fill on row 5, a merge `E2:F3`, conditional formatting on `B2:B7`
 * (`B2>C2`, same-row relative), validation on `B2:B7` (`>=0`), an
 * AutoFilter over `A1:D7`, an external hyperlink on `A3` (with its
 * relationship), an internal hyperlink on `A4` to `Summary!A1`, and a
 * page setup relationship.
 *
 * Summary: totals over Data's body (`SUM(Data!D2:D7)`), a single-cell
 * reference to Data row 5, and a defined name `Quantities` over
 * `Data!$B$2:$B$7`, used in `SUM(Quantities)`.
 */
export function representative_workbook(options: { readonly calcChain?: boolean } = {}): Uint8Array {
    const body_rows = [
        ['Apple', 3, 0.5],
        ['Banana', 5, 0.25],
        ['Cherry', 7, 2],
        ['Date', 9, 1.5],
        ['Elder', 11, 3],
        ['Fig', 13, 0.75],
    ] as const;
    const data_rows = [
        row(1, [
            cell('A1', { s: 0 }, 1), cell('B1', { s: 1 }, 1), cell('C1', { s: 2 }, 1), cell('D1', { s: 3 }, 1),
        ]),
        ...body_rows.map(([item, qty, price], index) => {
            const number = index + 2;
            const fill = number === 5 ? 3 : undefined;
            return row(number, [
                cell(`A${number}`, item, fill),
                cell(`B${number}`, qty, fill),
                cell(`C${number}`, price, 2),
                cell(`D${number}`, index === 0
                    ? { f: 'B2*C2', v: qty * price, shared: { si: 0, ref: 'D2:D7' } }
                    : { f: '', v: qty * price, shared: { si: 0 } }),
                ...(number === 2 ? [cell('E2', 'merged note')] : []),
            ], number === 5 ? ' s="3" customFormat="1"' : '');
        }),
    ];
    const data = '<dimension ref="A1:F7"/>'
        + '<sheetViews><sheetView workbookViewId="0"><selection activeCell="B4" sqref="B4"/></sheetView></sheetViews>'
        + '<sheetFormatPr defaultRowHeight="15"/>'
        + '<cols><col min="1" max="1" width="14" customWidth="1"/><col min="3" max="3" width="10" style="2" customWidth="1"/></cols>'
        + `<sheetData>${data_rows.join('')}</sheetData>`
        + '<autoFilter ref="A1:D7"/>'
        + '<mergeCells count="1"><mergeCell ref="E2:F3"/></mergeCells>'
        + '<conditionalFormatting sqref="B2:B7"><cfRule type="expression" dxfId="0" priority="1"><formula>B2&gt;C2</formula></cfRule></conditionalFormatting>'
        + '<dataValidations count="1"><dataValidation type="whole" operator="greaterThanOrEqual" allowBlank="1" sqref="B2:B7"><formula1>0</formula1></dataValidation></dataValidations>'
        + '<hyperlinks><hyperlink ref="A3" r:id="rId1"/><hyperlink ref="A4" location="Summary!A1" display="Summary"/></hyperlinks>'
        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
        + '<pageSetup orientation="portrait" r:id="rId2"/>';
    const summary = '<dimension ref="A1:B4"/>'
        + `<sheetData>${[
            row(1, [cell('A1', 'Total'), cell('B1', { f: 'SUM(Data!D2:D7)', v: 46.75 })]),
            row(2, [cell('A2', 'Row 5 qty'), cell('B2', { f: 'Data!B5', v: 9 })]),
            row(3, [cell('A3', 'All qty'), cell('B3', { f: 'SUM(Quantities)', v: 48 })]),
            row(4, [cell('A4', 'Last price'), cell('B4', { f: 'Data!$C$7', v: 0.75 })]),
        ].join('')}</sheetData>`
        + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>';
    return build_fixture_xlsx({
        sheets: [
            {
                name: 'Data',
                body: data,
                relationships: [
                    { id: 'rId1', type: 'hyperlink', target: 'https://example.com/banana', external: true },
                    { id: 'rId2', type: 'printerSettings', target: '../printerSettings/printerSettings1.bin' },
                ],
            },
            { name: 'Summary', body: summary },
        ],
        sharedStrings: ['Item', 'Qty', 'Price', 'Total'],
        definedNames: '<definedName name="Quantities">Data!$B$2:$B$7</definedName>'
            + '<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">Data!$A$1:$D$7</definedName>',
        ...(options.calcChain ? {
            calcChain: [
                ...[2, 3, 4, 5, 6, 7].map((number) => ({ sheet: 0, ref: `D${number}` })),
                { sheet: 1, ref: 'B1' }, { sheet: 1, ref: 'B2' }, { sheet: 1, ref: 'B3' }, { sheet: 1, ref: 'B4' },
            ],
        } : {}),
    });
}

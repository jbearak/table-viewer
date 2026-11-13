import { describe, expect, it, vi } from 'vitest';
import { readFileSync, readdirSync } from 'fs';
import path from 'path';
import CFB from 'cfb';
import {
    REVIEWED_COORDINATE_FREE_EXTENSION_URIS,
    WORKSHEET_CHILD_INVENTORY,
    scan_xlsx_structural_support,
    structural_refusal_message,
    unanchorable_formula_refusal,
    type StructuralAxisSupport,
    type StructuralRefusal,
    type WorksheetStructuralSupport,
    type XlsxStructuralSupportOptions,
} from '../xlsx-structural-support';

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MC_NS = 'http://schemas.openxmlformats.org/markup-compatibility/2006';
const OD = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const MS = 'http://schemas.microsoft.com/office';

interface Relationship {
    readonly type: string;
    readonly target: string;
    readonly external?: boolean;
}

interface SheetSpec {
    readonly name: string;
    /** Children of `<worksheet>`; must include `sheetData`. */
    readonly body: string;
    readonly relationships?: readonly Relationship[];
    /** Extra namespace declarations on the root. */
    readonly namespaces?: string;
}

interface WorkbookSpec {
    readonly sheets: readonly SheetSpec[];
    readonly definedNames?: string;
    readonly workbookRelationships?: readonly Relationship[];
    readonly chartsheets?: readonly { readonly name: string; readonly relationships: readonly Relationship[] }[];
    readonly parts?: Readonly<Record<string, string>>;
}

function rels_xml(relationships: readonly Relationship[]): string {
    return `<?xml version="1.0" encoding="UTF-8"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${
    relationships.map((relationship, index) => `<Relationship Id="rId${index + 1}" Type="${relationship.type}" Target="${relationship.target}"${relationship.external ? ' TargetMode="External"' : ''}/>`).join('')
}</Relationships>`;
}

function build_xlsx(spec: WorkbookSpec): Uint8Array {
    const file = CFB.utils.cfb_new();
    const add = (name: string, text: string): void => {
        CFB.utils.cfb_add(file, `/${name}`, Buffer.from(text, 'utf8'));
    };
    add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
<Default Extension="xml" ContentType="application/xml"/>
<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
</Types>`);
    add('_rels/.rels', rels_xml([{ type: `${OD}/officeDocument`, target: 'xl/workbook.xml' }]));
    const sheet_relationships: Relationship[] = spec.sheets.map((_, index) => ({
        type: `${OD}/worksheet`,
        target: `worksheets/sheet${index + 1}.xml`,
    }));
    const chartsheets = spec.chartsheets ?? [];
    const chartsheet_relationships: Relationship[] = chartsheets.map((_, index) => ({
        type: `${OD}/chartsheet`,
        target: `chartsheets/sheet${index + 1}.xml`,
    }));
    const all_relationships = [
        ...sheet_relationships,
        ...chartsheet_relationships,
        ...(spec.workbookRelationships ?? []),
    ];
    const sheets_xml = [
        ...spec.sheets.map((sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${index + 1}" r:id="rId${index + 1}"/>`),
        ...chartsheets.map((sheet, index) =>
            `<sheet name="${sheet.name}" sheetId="${spec.sheets.length + index + 1}" r:id="rId${spec.sheets.length + index + 1}"/>`),
    ].join('');
    add('xl/workbook.xml', `<?xml version="1.0" encoding="UTF-8"?>
<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheets_xml}</sheets>${
    spec.definedNames === undefined ? '' : `<definedNames>${spec.definedNames}</definedNames>`
}</workbook>`);
    add('xl/_rels/workbook.xml.rels', rels_xml(all_relationships));
    spec.sheets.forEach((sheet, index) => {
        add(`xl/worksheets/sheet${index + 1}.xml`, `<?xml version="1.0" encoding="UTF-8"?>
<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"${sheet.namespaces ?? ''}>${sheet.body}</worksheet>`);
        if (sheet.relationships !== undefined) {
            add(`xl/worksheets/_rels/sheet${index + 1}.xml.rels`, rels_xml(sheet.relationships));
        }
    });
    chartsheets.forEach((sheet, index) => {
        add(`xl/chartsheets/sheet${index + 1}.xml`, `<chartsheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><drawing r:id="rId1"/></chartsheet>`);
        add(`xl/chartsheets/_rels/sheet${index + 1}.xml.rels`, rels_xml(sheet.relationships));
    });
    for (const [name, text] of Object.entries(spec.parts ?? {})) add(name, text);
    const written = CFB.write(file, { type: 'buffer', fileType: 'zip', compression: true });
    return written instanceof Uint8Array ? written : new Uint8Array(written as ArrayBufferLike);
}

const PLAIN_DATA = '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row>'
    + '<row r="2"><c r="A2"><v>1</v></c><c r="B2"><f>A2*2</f><v>2</v></c></row></sheetData>';

function sheet(name: string, body = PLAIN_DATA, extra: Partial<SheetSpec> = {}): SheetSpec {
    return { name, body, ...extra };
}

function scan(spec: WorkbookSpec, options?: XlsxStructuralSupportOptions): WorksheetStructuralSupport[] {
    return scan_xlsx_structural_support(build_xlsx(spec), options);
}

function refusal(support: StructuralAxisSupport): StructuralRefusal {
    if (support.supported) throw new Error('expected the axis to be refused');
    return support.reason;
}

/** Both axes refuse with the same reason; return the rows refusal. */
function refused(support: WorksheetStructuralSupport): StructuralRefusal {
    const rows = refusal(support.rows);
    const columns = refusal(support.columns);
    const { message: rows_message, ...rows_reason } = rows;
    const { message: columns_message, ...columns_reason } = columns;
    expect(columns_reason).toEqual(rows_reason);
    expect(rows_message).toMatch(/^Can't insert, delete, or move rows on this sheet: /);
    expect(columns_message).toMatch(/^Can't insert, delete, or move columns on this sheet: /);
    return rows;
}

function expect_supported(support: WorksheetStructuralSupport): void {
    expect(support.rows).toEqual({ supported: true });
    expect(support.columns).toEqual({ supported: true });
}

describe('scan_xlsx_structural_support', () => {
    it('supports a plain sheet and ships its merges and rules', () => {
        const [support] = scan({
            sheets: [sheet('Sales', '<dimension ref="A1:B3"/><sheetViews><sheetView workbookViewId="0"/></sheetViews>'
                + '<sheetFormatPr defaultRowHeight="15"/><cols><col min="1" max="2" width="12"/></cols>'
                + PLAIN_DATA
                + '<autoFilter ref="A1:B2"/>'
                + '<mergeCells count="2"><mergeCell ref="A3:B3"/><mergeCell ref="C1:D2"/></mergeCells>'
                + '<conditionalFormatting sqref="B2:B5 D1"><cfRule type="expression" priority="1"><formula>B2&gt;A2</formula></cfRule>'
                + '<cfRule type="dataBar" priority="2"><dataBar><cfvo type="min"/><cfvo type="max"/><color rgb="FF638EC6"/></dataBar></cfRule></conditionalFormatting>'
                + '<dataValidations count="1"><dataValidation type="whole" sqref="A2:A9"><formula1>0</formula1><formula2>$C$1</formula2></dataValidation></dataValidations>'
                + '<hyperlinks><hyperlink ref="A1" location="Sales!B2"/></hyperlinks>'
                + '<pageMargins left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>'
                + '<pageSetup orientation="portrait" r:id="rId1"/>'
                + '<rowBreaks count="1"><brk id="2" max="16383" man="1"/></rowBreaks>'
                + '<ignoredErrors><ignoredError sqref="A2" numberStoredAsText="1"/></ignoredErrors>',
            { relationships: [{ type: `${OD}/printerSettings`, target: '../printerSettings/printerSettings1.bin' }] })],
            workbookRelationships: [
                { type: `${OD}/styles`, target: 'styles.xml' },
                { type: `${OD}/theme`, target: 'theme/theme1.xml' },
                { type: `${OD}/sharedStrings`, target: 'sharedStrings.xml' },
                { type: `${OD}/calcChain`, target: 'calcChain.xml' },
            ],
        });
        expect_supported(support);
        expect(support.merges).toEqual(['A3:B3', 'C1:D2']);
        expect(support.autoFilter).toEqual({ ref: 'A1:B2', filteredColumns: [] });
        expect(support.relativeRules).toEqual([
            { sqref: 'B2:B5 D1', formulas: ['B2>A2'] },
            { sqref: 'B2:B5 D1', formulas: [] },
            { sqref: 'A2:A9', formulas: ['0', '$C$1'] },
        ]);
    });

    it('ships the AutoFilter range and its filtered columns as worksheet columns', () => {
        const [filtered, plain] = scan({
            sheets: [
                sheet('F', `${PLAIN_DATA}<autoFilter ref="B1:D9"><filterColumn colId="2"><filters><filter val="x"/></filters></filterColumn><filterColumn colId="0"/></autoFilter>`),
                sheet('P'),
            ],
        });
        expect_supported(filtered);
        expect(filtered.autoFilter).toEqual({ ref: 'B1:D9', filteredColumns: [1, 3] });
        expect(plain).not.toHaveProperty('autoFilter');
    });

    it('refuses an AutoFilter it cannot read', () => {
        const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<autoFilter ref="A1:B2"><filterColumn colId="x"/></autoFilter>`)] });
        expect(refused(support)).toMatchObject({ code: 'invalid-range', element: 'filterColumn', value: 'x' });
    });

    it('numbers worksheets in reader order and skips chartsheets', () => {
        const supports = scan({
            sheets: [sheet('One'), sheet('Two')],
            chartsheets: [{ name: 'Chart', relationships: [] }],
        });
        expect(supports).toHaveLength(2);
        supports.forEach(expect_supported);
    });

    describe('worksheet children', () => {
        const refused_children = WORKSHEET_CHILD_INVENTORY.filter((row) => row.disposition === 'refused');

        it.each(refused_children.map((row) => [row.element, row]))('refuses <%s>', (element, row) => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<${element}/>`)] });
            const reason = refused(support);
            expect(reason).toMatchObject({ code: 'unsupported-worksheet-child', element });
            expect(reason.message).toBe(`Can't insert, delete, or move rows on this sheet: ${'refusal' in row ? row.refusal : ''}.`);
        });

        it('words an Excel table refusal the way the spec does', () => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<tableParts count="1"><tablePart r:id="rId1"/></tableParts>`)] });
            const reason = refused(support);
            expect(structural_refusal_message('rows', reason, 'insert-or-delete'))
                .toBe("Can't insert or delete rows on this sheet: it contains an Excel table.");
            expect(structural_refusal_message('columns', reason, 'move'))
                .toBe("Can't move columns on this sheet: it contains an Excel table.");
        });

        it('refuses an unknown child element', () => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<futureThing/>`)] });
            expect(refused(support)).toMatchObject({ code: 'unknown-worksheet-child', element: 'futureThing' });
        });

        it('refuses an inventoried name in a foreign namespace', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<x14ac:mergeCells/>`, {
                    namespaces: ' xmlns:x14ac="http://schemas.microsoft.com/office/spreadsheetml/2009/9/ac"',
                })],
            });
            expect(refused(support)).toMatchObject({ code: 'unknown-worksheet-child', element: 'x14ac:mergeCells' });
        });

        it('accepts a SpreadsheetML child spelled with a bound prefix', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<x:pageMargins xmlns:x="${MAIN_NS}" left="0.7" right="0.7" top="0.75" bottom="0.75" header="0.3" footer="0.3"/>`)],
            });
            expect_supported(support);
        });

        it('ignores a commented-out refused child', () => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<!-- <tableParts/> -->`)] });
            expect_supported(support);
        });

        it('refuses an extLst whose ext URI is not reviewed', () => {
            expect(REVIEWED_COORDINATE_FREE_EXTENSION_URIS.size).toBe(0);
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<extLst><ext uri="{11111111-2222-3333-4444-555555555555}"><x:thing xmlns:x="urn:x"/></ext></extLst>`)],
            });
            expect(refused(support)).toMatchObject({
                code: 'unsupported-extension',
                uri: '{11111111-2222-3333-4444-555555555555}',
                element: 'extLst',
            });
        });

        it('names x14 conditional formatting', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<extLst><ext uri="{78C0D931-6437-407d-A8EE-F0AAD7539E65}"/></extLst>`)],
            });
            expect(refused(support).message)
                .toBe("Can't insert, delete, or move rows on this sheet: it contains conditional formatting from Excel 2010 or later.");
        });

        it('accepts an empty extLst', () => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}<extLst/>`)] });
            expect_supported(support);
        });

        it('refuses an extension nested inside a covered child', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<conditionalFormatting sqref="A1"><cfRule type="expression" priority="1"><formula>TRUE</formula>`
                    + '<extLst><ext uri="{B025F937-C7B1-47D3-B67F-A62EFF666E3E}"><x14:id xmlns:x14="urn:x14">{1}</x14:id></ext></extLst></cfRule></conditionalFormatting>')],
            });
            expect(refused(support)).toMatchObject({ code: 'unsupported-extension', element: 'conditionalFormatting' });
        });

        it('refuses an extension inside a row or cell', () => {
            const [row, cell] = scan({
                sheets: [
                    sheet('R', '<sheetData><row r="1"><c r="A1"><v>1</v></c><extLst><ext uri="urn:unreviewed"/></extLst></row></sheetData>'),
                    sheet('C', '<sheetData><row r="1"><c r="A1"><v>1</v><extLst><ext uri="urn:unreviewed"/></extLst></c></row></sheetData>'),
                ],
            });
            expect(refused(row)).toMatchObject({ code: 'unsupported-extension', uri: 'urn:unreviewed', element: 'sheetData' });
            expect(refused(cell)).toMatchObject({ code: 'unsupported-extension', uri: 'urn:unreviewed', element: 'sheetData' });
        });

        it('refuses a conditional-formatting threshold given as a formula', () => {
            const scale = (cfvo: string) => `${PLAIN_DATA}<conditionalFormatting sqref="A1:A5"><cfRule type="colorScale" priority="1"><colorScale>`
                + `<cfvo type="min"/>${cfvo}<color rgb="FFF8696B"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>`;
            const [formula, cell_value, number] = scan({
                sheets: [
                    sheet('F', scale('<cfvo type="formula" val="INDEX(A:A,1)"/>')),
                    sheet('V', scale('<cfvo type="num" val="$B$1"/>')),
                    sheet('N', scale('<cfvo type="percentile" val="50"/>')),
                ],
            });
            const reason = refused(formula);
            expect(reason).toMatchObject({ code: 'conditional-formatting-threshold', sqref: 'A1:A5', value: 'INDEX(A:A,1)' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: the conditional formatting on A1:A5 has a threshold formula Table Viewer can't adjust (INDEX(A:A,1)).");
            expect(refused(cell_value)).toMatchObject({ code: 'conditional-formatting-threshold', value: '$B$1' });
            expect_supported(number);
        });

        it('refuses mc:AlternateContent wrapping a worksheet child', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<mc:AlternateContent><mc:Choice Requires="x14"><pageMargins left="1" right="1" top="1" bottom="1" header="0" footer="0"/></mc:Choice></mc:AlternateContent>`, {
                    namespaces: ` xmlns:mc="${MC_NS}"`,
                })],
            });
            expect(refused(support)).toMatchObject({ code: 'alternate-content', element: 'mc:AlternateContent' });
        });

        it('refuses a sheet that another sheet\'s formula threshold reads', () => {
            const [data, report, other] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', `${PLAIN_DATA}<conditionalFormatting sqref="A1:A5"><cfRule type="colorScale" priority="1"><colorScale>`
                        + '<cfvo type="min"/><cfvo type="formula" val="Data!$A$1"/><color rgb="FFF8696B"/><color rgb="FF63BE7B"/></colorScale></cfRule></conditionalFormatting>'),
                    sheet('Other'),
                ],
            });
            const reason = refused(data);
            expect(reason).toMatchObject({ code: 'conditional-formatting-threshold', value: 'Data!$A$1', worksheet: 'Report' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: the conditional formatting on Report!A1:A5 has a threshold formula that uses this sheet (Data!$A$1).");
            expect(refused(report)).toMatchObject({ code: 'conditional-formatting-threshold' });
            expect(refused(report)).not.toHaveProperty('worksheet');
            expect_supported(other);
        });

        it('refuses a sheet that a data consolidation on another sheet reads', () => {
            const [data, , other] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', `${PLAIN_DATA}<dataConsolidate><dataRefs count="1"><dataRef ref="A1:B5" sheet="Data"/></dataRefs></dataConsolidate>`),
                    sheet('Other'),
                ],
            });
            const reason = refused(data);
            expect(reason).toMatchObject({ code: 'unsupported-worksheet-child', element: 'dataConsolidate', worksheet: 'Report' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: a data consolidation on Report uses data from this sheet.");
            expect_supported(other);
        });

        it.each([
            ['hyperlink', '<hyperlinks><hyperlink ref="A0" location="S!A1"/></hyperlinks>', 'A0'],
            ['hyperlink', '<hyperlinks><hyperlink r:id="rId1"/></hyperlinks>', ''],
            ['sortState', '<sortState ref="A1:B"/>', 'A1:B'],
            ['sortCondition', '<autoFilter ref="A1:B5"><sortState ref="A2:B5"><sortCondition ref="Q"/></sortState></autoFilter>', 'Q'],
            ['selection', '<sheetViews><sheetView workbookViewId="0"><selection activeCell="A1" sqref="A1 ZZZZ9"/></sheetView></sheetViews>', 'A1 ZZZZ9'],
            ['pane', '<sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A0" state="frozen"/></sheetView></sheetViews>', 'A0'],
            ['ignoredError', '<ignoredErrors><ignoredError sqref="" numberStoredAsText="1"/></ignoredErrors>', ''],
        ])('refuses an unreadable <%s> range', (element, child, value) => {
            const [support] = scan({ sheets: [sheet('S', `${PLAIN_DATA}${child}`)] });
            expect(refused(support)).toMatchObject({ code: 'invalid-range', element, value });
        });

        it('refuses a merged range it cannot read', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<mergeCells><mergeCell ref="A1:ZZZZ2"/></mergeCells>`)],
            });
            expect(refused(support)).toMatchObject({ code: 'invalid-range', element: 'mergeCell', value: 'A1:ZZZZ2' });
        });

        it('refuses a worksheet the cell writer refuses', () => {
            const [support] = scan({ sheets: [sheet('S', '<sheetData><row r="1"><c><v>1</v></c></row></sheetData>')] });
            expect(refused(support)).toMatchObject({ code: 'unwritable-worksheet', ooxmlCode: 'missing-cell-reference' });
        });
    });

    describe('related parts', () => {
        const worksheet_parts: [string, string, string][] = [
            [`${OD}/table`, '../tables/table1.xml', 'it contains an Excel table'],
            [`${OD}/drawing`, '../drawings/drawing1.xml', 'it contains pictures, charts, or shapes'],
            [`${OD}/vmlDrawing`, '../drawings/vmlDrawing1.vml', 'it contains notes or legacy drawings'],
            [`${OD}/comments`, '../comments1.xml', 'it contains notes'],
            [`${MS}/2017/10/relationships/threadedComment`, '../threadedComments/threadedComment1.xml', 'it contains threaded comments'],
            [`${OD}/pivotTable`, '../pivotTables/pivotTable1.xml', 'it contains a PivotTable'],
            [`${OD}/queryTable`, '../queryTables/queryTable1.xml', 'it contains a query table'],
            [`${MS}/2007/relationships/slicer`, '../slicers/slicer1.xml', 'it contains slicers'],
            [`${MS}/2011/relationships/timeline`, '../timelines/timeline1.xml', 'it contains timelines'],
            [`${OD}/oleObject`, '../embeddings/oleObject1.bin', 'it contains embedded objects'],
            [`${OD}/ctrlProp`, '../ctrlProps/ctrlProp1.xml', 'it contains form controls'],
            [`${OD}/customProperty`, '../customProperty1.bin', 'it contains custom properties'],
        ];

        it.each(worksheet_parts)('refuses a worksheet related to %s', (type, target, clause) => {
            const [support] = scan({ sheets: [sheet('S', PLAIN_DATA, { relationships: [{ type, target }] })] });
            const reason = refused(support);
            expect(reason).toMatchObject({
                code: 'unsupported-part',
                part: path.posix.normalize(`xl/worksheets/${target}`),
                relationshipType: type,
                scope: 'worksheet',
            });
            expect(reason.message).toBe(`Can't insert, delete, or move rows on this sheet: ${clause}.`);
        });

        it('allows external hyperlinks and printer settings', () => {
            const [support] = scan({
                sheets: [sheet('S', `${PLAIN_DATA}<hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks>`, {
                    relationships: [
                        { type: `${OD}/hyperlink`, target: 'https://example.com', external: true },
                        { type: `${OD}/printerSettings`, target: '../printerSettings/printerSettings1.bin' },
                    ],
                })],
            });
            expect_supported(support);
        });

        it('refuses an unrecognized worksheet relationship', () => {
            const [support] = scan({
                sheets: [sheet('S', PLAIN_DATA, { relationships: [{ type: 'urn:example:thing', target: '../thing.xml' }] })],
            });
            expect(refused(support)).toMatchObject({ code: 'unsupported-part', partKind: 'unknown', scope: 'worksheet' });
        });

        it.each([
            [`${OD}/connections`, 'connections.xml', 'the workbook has data connections'],
            [`${MS}/2007/relationships/slicerCache`, 'slicerCaches/slicerCache1.xml', 'the workbook has slicers'],
            [`${MS}/2011/relationships/timelineCache`, 'timelineCaches/timelineCache1.xml', 'the workbook has timelines'],
            ['urn:example:workbook-thing', 'thing.xml', "the workbook has content Table Viewer doesn't recognize (urn:example:workbook-thing)"],
        ])('refuses every worksheet for workbook relationship %s', (type, target, clause) => {
            const supports = scan({
                sheets: [sheet('One'), sheet('Two')],
                workbookRelationships: [{ type, target }],
            });
            for (const support of supports) {
                expect(refused(support)).toMatchObject({ code: 'unsupported-part', part: `xl/${target}`, scope: 'workbook' });
                expect(refusal(support.rows).message).toBe(`Can't insert, delete, or move rows on this sheet: ${clause}.`);
            }
        });

        it('refuses only the worksheet a pivot cache reads', () => {
            const [one, two] = scan({
                sheets: [sheet('One'), sheet('Two')],
                workbookRelationships: [{ type: `${OD}/pivotCacheDefinition`, target: 'pivotCache/pivotCacheDefinition1.xml' }],
                parts: {
                    'xl/pivotCache/pivotCacheDefinition1.xml': `<pivotCacheDefinition xmlns="${MAIN_NS}"><cacheSource type="worksheet"><worksheetSource ref="A1:B2" sheet="One"/></cacheSource></pivotCacheDefinition>`,
                },
            });
            expect(refused(one)).toMatchObject({ code: 'unsupported-part', partKind: 'pivot-cache' });
            expect(refusal(one.rows).message).toBe("Can't insert, delete, or move rows on this sheet: a PivotTable uses data from this sheet.");
            expect_supported(two);
        });

        it('refuses a worksheet that a chart on another sheet reads', () => {
            const chart = `<c:chartSpace xmlns:c="http://schemas.openxmlformats.org/drawingml/2006/chart"><c:chart><c:plotArea><c:barChart><c:ser><c:val><c:numRef><c:f>'Data One'!$B$2:$B$5</c:f></c:numRef></c:val></c:ser></c:barChart></c:plotArea></c:chart></c:chartSpace>`;
            const [data, report, other] = scan({
                sheets: [
                    sheet('Data One'),
                    sheet('Report', `${PLAIN_DATA}<drawing r:id="rId1"/>`, {
                        relationships: [{ type: `${OD}/drawing`, target: '../drawings/drawing1.xml' }],
                    }),
                    sheet('Other'),
                ],
                parts: {
                    'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([{ type: `${OD}/chart`, target: '../charts/chart1.xml' }]),
                    'xl/charts/chart1.xml': chart,
                },
            });
            expect(refused(data)).toMatchObject({ code: 'unsupported-part', partKind: 'chart', part: 'xl/charts/chart1.xml', host: 'Report' });
            expect(refusal(data.rows).message).toBe("Can't insert, delete, or move rows on this sheet: a chart on Report uses data from this sheet.");
            expect(refused(report)).toMatchObject({ code: 'unsupported-part', partKind: 'drawing' });
            expect_supported(other);
        });

        it('refuses a worksheet that a chartsheet reads', () => {
            const [data, other] = scan({
                sheets: [sheet('Data'), sheet('Other')],
                chartsheets: [{ name: 'Chart1', relationships: [{ type: `${OD}/drawing`, target: '../drawings/drawing1.xml' }] }],
                parts: {
                    'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"/>',
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([{ type: `${OD}/chart`, target: '../charts/chart1.xml' }]),
                    'xl/charts/chart1.xml': '<c:chartSpace xmlns:c="urn:c"><c:f>Data!$A$1:$A$3</c:f></c:chartSpace>',
                },
            });
            expect(refused(data)).toMatchObject({ code: 'unsupported-part', partKind: 'chart' });
            expect(refusal(data.rows).message).toBe("Can't insert, delete, or move rows on this sheet: a chart uses data from this sheet.");
            expect_supported(other);
        });
    });

    describe('parts on another sheet that read this one', () => {
        const DRAWING_REL = (target = '../drawings/drawing1.xml') => ({ type: `${OD}/drawing`, target });
        const WS_DR = 'xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing"';
        const report = (relationships: readonly Relationship[], body = PLAIN_DATA) => sheet('Report', body, { relationships });

        it('refuses a sheet that a shape\'s text link reads', () => {
            const [data, , other] = scan({
                sheets: [sheet('Data'), report([DRAWING_REL()], `${PLAIN_DATA}<drawing r:id="rId1"/>`), sheet('Other')],
                parts: {
                    'xl/drawings/drawing1.xml': `<xdr:wsDr ${WS_DR}><xdr:twoCellAnchor><xdr:sp macro="" textlink="Data!$A$1"/></xdr:twoCellAnchor>`
                        + `<xdr:twoCellAnchor><xdr:sp macro="" textlink=""/></xdr:twoCellAnchor></xdr:wsDr>`,
                },
            });
            const reason = refused(data);
            expect(reason).toMatchObject({ code: 'unsupported-part', partKind: 'drawing', part: 'xl/drawings/drawing1.xml', host: 'Report' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: a shape on Report uses data from this sheet.");
            expect_supported(other);
        });

        it('refuses a sheet that a drawing hyperlink points into', () => {
            const [data, , other] = scan({
                sheets: [sheet('Data'), report([DRAWING_REL()]), sheet('Other')],
                parts: {
                    'xl/drawings/drawing1.xml': `<xdr:wsDr ${WS_DR}/>`,
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([
                        { type: `${OD}/hyperlink`, target: "#'Data'!A1", external: true },
                        { type: `${OD}/hyperlink`, target: 'https://example.com', external: true },
                        { type: `${OD}/image`, target: '../media/image1.png' },
                    ]),
                },
            });
            expect(refused(data)).toMatchObject({ code: 'unsupported-part', partKind: 'drawing', host: 'Report' });
            expect_supported(other);
        });

        it('refuses every sheet when a drawing has a relationship it cannot classify', () => {
            const supports = scan({
                sheets: [sheet('Data'), report([DRAWING_REL()])],
                parts: {
                    'xl/drawings/drawing1.xml': `<xdr:wsDr ${WS_DR}/>`,
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([{ type: 'urn:example:drawing-thing', target: 'thing.xml' }]),
                },
            });
            expect(refused(supports[0])).toMatchObject({ code: 'unsupported-part', partKind: 'unknown', relationshipType: 'urn:example:drawing-thing' });
        });

        it('refuses a sheet that a chart\'s user shape reads', () => {
            const [data, , other] = scan({
                sheets: [sheet('Data'), report([DRAWING_REL()]), sheet('Other')],
                parts: {
                    'xl/drawings/drawing1.xml': `<xdr:wsDr ${WS_DR}/>`,
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([{ type: `${OD}/chart`, target: '../charts/chart1.xml' }]),
                    'xl/charts/chart1.xml': '<c:chartSpace xmlns:c="urn:c"><c:f>Report!$A$1</c:f></c:chartSpace>',
                    'xl/charts/_rels/chart1.xml.rels': rels_xml([{ type: `${OD}/chartUserShapes`, target: '../drawings/drawing2.xml' }]),
                    'xl/drawings/drawing2.xml': '<c:userShapes xmlns:c="urn:c" xmlns:cdr="urn:cdr"><cdr:relSizeAnchor><cdr:sp textlink="Data!$B$2"/></cdr:relSizeAnchor></c:userShapes>',
                },
            });
            expect(refused(data)).toMatchObject({ code: 'unsupported-part', partKind: 'drawing', part: 'xl/drawings/drawing2.xml', host: 'Report' });
            expect_supported(other);
        });

        it('refuses a sheet that a form control links to', () => {
            const [vml_data, ctrl_data, , other] = scan({
                sheets: [
                    sheet('VmlData'),
                    sheet('CtrlData'),
                    report([
                        { type: `${OD}/vmlDrawing`, target: '../drawings/vmlDrawing1.vml' },
                        { type: `${OD}/ctrlProp`, target: '../ctrlProps/ctrlProp1.xml' },
                    ]),
                    sheet('Other'),
                ],
                parts: {
                    'xl/drawings/vmlDrawing1.vml': '<xml xmlns:x="urn:schemas-microsoft-com:office:excel"><v:shape><x:ClientData ObjectType="Checkbox"><x:FmlaLink>VmlData!$A$1</x:FmlaLink></x:ClientData></v:shape></xml>',
                    'xl/ctrlProps/ctrlProp1.xml': '<formControlPr xmlns="http://schemas.microsoft.com/office/spreadsheetml/2009/9/main" objectType="Drop" fmlaRange="CtrlData!$A$1:$A$5"/>',
                },
            });
            expect(refused(vml_data)).toMatchObject({ code: 'unsupported-part', partKind: 'legacy-drawing', host: 'Report' });
            expect(refusal(vml_data.rows).message).toBe("Can't insert, delete, or move rows on this sheet: a form control on Report uses data from this sheet.");
            expect(refused(ctrl_data)).toMatchObject({ code: 'unsupported-part', partKind: 'control', host: 'Report' });
            expect_supported(other);
        });

        it('refuses a sheet that an Excel table\'s column formula reads', () => {
            const [data, , other] = scan({
                sheets: [sheet('Data'), report([{ type: `${OD}/table`, target: '../tables/table1.xml' }]), sheet('Other')],
                parts: {
                    'xl/tables/table1.xml': `<table xmlns="${MAIN_NS}" id="1" name="T" ref="A1:B3"><tableColumns count="2"><tableColumn id="1" name="A"/>`
                        + '<tableColumn id="2" name="B"><calculatedColumnFormula>Data!A2*2</calculatedColumnFormula></tableColumn></tableColumns></table>',
                },
            });
            const reason = refused(data);
            expect(reason).toMatchObject({ code: 'unsupported-part', partKind: 'table', host: 'Report' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: an Excel table on Report uses data from this sheet.");
            expect_supported(other);
        });
    });

    describe('array formulas and data tables', () => {
        it('refuses an array formula on the sheet, naming the cell', () => {
            const [support] = scan({
                sheets: [sheet('S', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2:D4">A2:A4*2</f><v>2</v></c></row></sheetData>')],
            });
            const reason = refused(support);
            expect(reason).toMatchObject({ code: 'array-formula', cell: 'D2' });
            expect(structural_refusal_message('rows', reason, 'move'))
                .toBe("Can't move rows on this sheet: cell D2 has an array formula.");
        });

        it('refuses a single-cell dynamic array', () => {
            const [support] = scan({
                sheets: [sheet('S', '<sheetData><row r="2"><c r="E2" cm="1"><f t="array" ref="E2" aca="false">_xlfn._xlws.FILTER(A2:A9,B2:B9&gt;0)</f><v>1</v></c></row></sheetData>')],
            });
            expect(refused(support)).toMatchObject({ code: 'array-formula', cell: 'E2' });
        });

        it('refuses a data table', () => {
            const [support] = scan({
                sheets: [sheet('S', '<sheetData><row r="3"><c r="B3"><f t="dataTable" ref="B3:C5" dt2D="0" dtr="0" r1="A1"/><v>1</v></c></row></sheetData>')],
            });
            const reason = refused(support);
            expect(reason).toMatchObject({ code: 'data-table', cell: 'B3' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: cell B3 has a data table.");
        });

        it('refuses a sheet that an array formula on another sheet references', () => {
            const [data, report, other] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2:D3">Data!A2:A3*2</f><v>2</v></c></row></sheetData>'),
                    sheet('Other'),
                ],
            });
            const reason = refused(data);
            expect(reason).toMatchObject({ code: 'array-formula', cell: 'D2', worksheet: 'Report' });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: cell Report!D2 has an array formula that uses this sheet.");
            expect(refused(report)).toMatchObject({ code: 'array-formula', cell: 'D2' });
            expect(refused(report)).not.toHaveProperty('worksheet');
            expect_supported(other);
        });

        it('follows quoted names and defined names to the referenced sheet', () => {
            const [data, report, quoted] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2">SUM(Inputs)</f><v>2</v></c></row>'
                        + '<row r="3"><c r="D3"><f t="array" ref="D3">\'My Sheet\'!A1*2</f></c></row></sheetData>'),
                    sheet('My Sheet'),
                ],
                definedNames: '<definedName name="Inputs">Base</definedName><definedName name="Base">Data!$A$2:$A$9</definedName>',
            });
            expect(refused(data)).toMatchObject({ code: 'array-formula', cell: 'D2', worksheet: 'Report' });
            expect(refused(report)).toMatchObject({ code: 'array-formula' });
            expect(refused(quoted)).toMatchObject({ code: 'array-formula', cell: 'D3', worksheet: 'Report' });
        });

        it('leaves a sheet alone when another sheet\'s array formula does not reference it', () => {
            const [data] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2:D3">A2:A3*2&amp;"Data!A1"</f></c></row></sheetData>'),
                ],
            });
            expect_supported(data);
        });

        it('treats a 3D reference as possibly spanning any sheet', () => {
            const [first, , third] = scan({
                sheets: [
                    sheet('First'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2">SUM(Jan:Mar!A1)</f></c></row></sheetData>'),
                    sheet('Third'),
                ],
            });
            expect(refused(first)).toMatchObject({ code: 'array-formula', worksheet: 'Report' });
            expect(refused(third)).toMatchObject({ code: 'array-formula', worksheet: 'Report' });
        });

        it('reads numeric sheet names and numeric 3D endpoints as sheet qualifiers', () => {
            const [year, , other] = scan({
                sheets: [
                    sheet('2024'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2">2024!A1:A3*2</f></c></row></sheetData>'),
                    sheet('Other'),
                ],
            });
            expect(refused(year)).toMatchObject({ code: 'array-formula', cell: 'D2', worksheet: 'Report' });
            expect_supported(other);

            const [first] = scan({
                sheets: [
                    sheet('First'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2">SUM(2023:2025!A1)</f></c></row></sheetData>'),
                ],
            });
            expect(refused(first)).toMatchObject({ code: 'array-formula', worksheet: 'Report' });
        });

        it('reads formula text in CDATA and ignores comments', () => {
            const [data, , other] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2"><![CDATA[Data!A1:A3*2]]></f></c>'
                        + '<c r="E2"><f t="array" ref="E2">A1<!-- Other!A1 --></f></c></row></sheetData>'),
                    sheet('Other'),
                ],
            });
            expect(refused(data)).toMatchObject({ code: 'array-formula', cell: 'D2', worksheet: 'Report' });
            expect_supported(other);
        });

        it('reads chart and defined-name formulas in CDATA', () => {
            const [data, chart_data] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('ChartData'),
                    sheet('Report', `${PLAIN_DATA}<drawing r:id="rId1"/>`, { relationships: [{ type: `${OD}/drawing`, target: '../drawings/drawing1.xml' }] }),
                ],
                definedNames: '<definedName name="Window"><![CDATA[INDEX(Data!$A:$A,1):Data!$B$5]]></definedName>',
                parts: {
                    'xl/drawings/drawing1.xml': '<xdr:wsDr xmlns:xdr="urn:xdr"/>',
                    'xl/drawings/_rels/drawing1.xml.rels': rels_xml([{ type: `${OD}/chart`, target: '../charts/chart1.xml' }]),
                    'xl/charts/chart1.xml': '<c:chartSpace xmlns:c="urn:c"><c:f><![CDATA[ChartData!$A$1:$A$3]]></c:f></c:chartSpace>',
                },
            }, {
                formula_is_anchorable: (formula) => formula.startsWith('INDEX(') ? unanchorable_formula_refusal(formula) : undefined,
            });
            expect(refused(data)).toMatchObject({ code: 'unanchorable-formula', formula: 'INDEX(Data!$A:$A,1):Data!$B$5', location: { kind: 'defined-name', name: 'Window' } });
            expect(refused(chart_data)).toMatchObject({ code: 'unsupported-part', partKind: 'chart', host: 'Report' });
        });

        it('ignores references into another workbook', () => {
            const [data] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="2"><c r="D2"><f t="array" ref="D2">[1]Data!A1:A3*2</f></c></row></sheetData>'),
                ],
            });
            expect_supported(data);
        });
    });

    describe('formula anchorability', () => {
        const refuse_index: XlsxStructuralSupportOptions = {
            formula_is_anchorable: (formula) => formula.includes('INDEX(')
                ? unanchorable_formula_refusal(formula, 'INDEX(A:A,1):B5')
                : undefined,
        };

        it('treats every formula as anchorable by default', () => {
            const [support] = scan({
                sheets: [sheet('S', '<sheetData><row r="1"><c r="A1"><f>SUM(INDEX(A:A,1):B5)</f></c></row></sheetData>')],
            });
            expect_supported(support);
        });

        it('refuses a cell formula on the sheet', () => {
            const [support] = scan({
                sheets: [sheet('S', '<sheetData><row r="1"><c r="C4"><f>SUM(INDEX(A:A,1):B5)</f></c></row></sheetData>')],
            }, refuse_index);
            const reason = refused(support);
            expect(reason).toMatchObject({
                code: 'unanchorable-formula',
                formula: 'SUM(INDEX(A:A,1):B5)',
                construct: 'INDEX(A:A,1):B5',
                location: { kind: 'cell', cell: 'C4' },
            });
            expect(reason.message).toBe("Can't insert, delete, or move rows on this sheet: Table Viewer can't adjust the formula in cell C4 (INDEX(A:A,1):B5).");
        });

        it('refuses through a formula on another sheet that references it', () => {
            const [data, report, other] = scan({
                sheets: [
                    sheet('Data'),
                    sheet('Report', '<sheetData><row r="1"><c r="B7"><f>SUM(INDEX(Data!A:A,1):Data!B5)</f></c></row></sheetData>'),
                    sheet('Other'),
                ],
            }, refuse_index);
            expect(refused(data)).toMatchObject({
                code: 'unanchorable-formula',
                location: { kind: 'cell', worksheet: 'Report', cell: 'B7' },
            });
            expect(refusal(data.rows).message).toContain('the formula in cell Report!B7');
            expect(refused(report)).toMatchObject({ location: { kind: 'cell', cell: 'B7' } });
            expect_supported(other);
        });

        it('refuses through a defined name', () => {
            const [data, other] = scan({
                sheets: [sheet('Data'), sheet('Other')],
                definedNames: '<definedName name="Window">INDEX(Data!$A:$A,1):Data!$B$5</definedName>',
            }, refuse_index);
            expect(refused(data)).toMatchObject({ location: { kind: 'defined-name', name: 'Window' } });
            expect(refusal(data.rows).message).toContain('the name Window');
            expect_supported(other);
        });

        it('refuses through conditional formatting, data validation, and internal links', () => {
            const [cf, dv, link] = scan({
                sheets: [
                    sheet('CF', `${PLAIN_DATA}<conditionalFormatting sqref="A1:A5"><cfRule type="expression" priority="1"><formula>INDEX(A:A,1)&gt;0</formula></cfRule></conditionalFormatting>`),
                    sheet('DV', `${PLAIN_DATA}<dataValidations><dataValidation type="list" sqref="B2"><formula1>INDEX(A:A,1):A3</formula1></dataValidation></dataValidations>`),
                    sheet('Link', `${PLAIN_DATA}<hyperlinks><hyperlink ref="C3" location="INDEX(A:A,1)"/></hyperlinks>`),
                ],
            }, refuse_index);
            expect(refused(cf)).toMatchObject({ location: { kind: 'conditional-formatting', sqref: 'A1:A5' } });
            expect(refused(dv)).toMatchObject({ location: { kind: 'data-validation', sqref: 'B2' } });
            expect(refused(link)).toMatchObject({ location: { kind: 'hyperlink', cell: 'C3' } });
            expect(refusal(link.columns).message).toBe("Can't insert, delete, or move columns on this sheet: Table Viewer can't adjust the link in cell C3 (INDEX(A:A,1):B5).");
        });

        it('checks only formulas that may reference the sheet', () => {
            const check = vi.fn<NonNullable<XlsxStructuralSupportOptions['formula_is_anchorable']>>(() => undefined);
            scan({
                sheets: [
                    sheet('Data', '<sheetData><row r="1"><c r="A1"><f>1+1</f></c></row></sheetData>'),
                    sheet('Report', '<sheetData><row r="1"><c r="A1"><f>B1*2</f></c><c r="B1"><f>Data!A1</f></c></row></sheetData>'),
                ],
            }, { formula_is_anchorable: check });
            // Each distinct text is checked once; `B1*2` only for Report.
            expect(check.mock.calls.map(([text]) => text).sort()).toEqual(['1+1', 'B1*2', 'Data!A1']);
        });
    });
});

describe('worksheet child inventory', () => {
    /** ECMA-376 Part 1, §18.3.1.99 CT_Worksheet, in schema order. */
    const CT_WORKSHEET_CHILDREN = [
        'sheetPr', 'dimension', 'sheetViews', 'sheetFormatPr', 'cols', 'sheetData', 'sheetCalcPr',
        'sheetProtection', 'protectedRanges', 'scenarios', 'autoFilter', 'sortState', 'dataConsolidate',
        'customSheetViews', 'mergeCells', 'phoneticPr', 'conditionalFormatting', 'dataValidations',
        'hyperlinks', 'printOptions', 'pageMargins', 'pageSetup', 'headerFooter', 'rowBreaks', 'colBreaks',
        'customProperties', 'cellWatches', 'ignoredErrors', 'smartTags', 'drawing', 'legacyDrawing',
        'legacyDrawingHF', 'drawingHF', 'picture', 'oleObjects', 'controls', 'webPublishItems',
        'tableParts', 'extLst',
    ];

    it('has exactly one row per CT_Worksheet child, in schema order', () => {
        expect(WORKSHEET_CHILD_INVENTORY.map((row) => row.element)).toEqual(CT_WORKSHEET_CHILDREN);
    });

    it('marks the spec\'s coordinate-free children and refuses what the spec refuses', () => {
        const by = (disposition: string) => WORKSHEET_CHILD_INVENTORY
            .filter((row) => row.disposition === disposition)
            .map((row) => row.element);
        expect(by('coordinate-free')).toEqual([
            'sheetPr', 'sheetFormatPr', 'sheetCalcPr', 'sheetProtection', 'phoneticPr',
            'printOptions', 'pageMargins', 'pageSetup', 'headerFooter',
        ]);
        expect(by('covered')).toEqual([
            'dimension', 'sheetViews', 'cols', 'sheetData', 'autoFilter', 'sortState', 'mergeCells',
            'conditionalFormatting', 'dataValidations', 'hyperlinks', 'rowBreaks', 'colBreaks', 'ignoredErrors',
        ]);
        for (const element of ['protectedRanges', 'webPublishItems', 'customSheetViews', 'scenarios', 'dataConsolidate', 'tableParts', 'drawing', 'oleObjects', 'controls']) {
            expect(by('refused')).toContain(element);
        }
        expect(by('extension-list')).toEqual(['extLst']);
    });

    it('accepts a worksheet holding every covered and coordinate-free child', () => {
        const body = WORKSHEET_CHILD_INVENTORY
            .filter((row) => row.disposition === 'covered' || row.disposition === 'coordinate-free')
            .map((row) => row.element === 'sheetData'
                ? PLAIN_DATA
                : row.element === 'conditionalFormatting'
                    ? '<conditionalFormatting sqref="A1"/>'
                    : row.element === 'autoFilter' || row.element === 'sortState'
                        ? `<${row.element} ref="A1"/>`
                        : `<${row.element}/>`)
            .join('');
        const [support] = scan({ sheets: [sheet('S', body)] });
        expect_supported(support);
    });

    it('meets no uninventoried worksheet child in any committed workbook', () => {
        const files = [
            ...readdirSync('src/test/fixtures').filter((name) => name.endsWith('.xlsx')).map((name) => `src/test/fixtures/${name}`),
            ...readdirSync('docs/examples').filter((name) => name.endsWith('.xlsx')).map((name) => `docs/examples/${name}`),
        ];
        expect(files.length).toBeGreaterThan(0);
        const unknown: string[] = [];
        for (const file of files) {
            const supports = scan_xlsx_structural_support(readFileSync(file));
            supports.forEach((support, index) => {
                if (!support.rows.supported && support.rows.reason.code === 'unknown-worksheet-child') {
                    unknown.push(`${file} sheet ${index}: <${support.rows.reason.element}>`);
                }
            });
        }
        expect(unknown).toEqual([]);
    });
});

/* eslint-disable sonarjs/no-duplicate-string */
import { GridCellKind, type GridCell, BooleanIndeterminate } from "../index.js";
import {
    cutSourceGridLocations,
    copyBufferContainsCut,
    decodeHTML,
    getCopyBufferContents,
    resolveCopyBufferValue,
    type CellBuffer,
} from "../data-editor/copy-paste.js";
import { expect, describe, test } from "vitest";

function makeCellBuffer(
    rawValue: string | string[],
    formatted = rawValue,
    format: CellBuffer["format"] = "string"
): CellBuffer {
    return {
        rawValue,
        formatted,
        format,
    } as CellBuffer;
}

describe("copy-paste", () => {
    const operationId = "01234567-89ab-cdef";
    test("keeps displayed values generic while round-tripping formula copy metadata", () => {
        const cells = [[{
            kind: GridCellKind.Text,
            data: "2",
            displayData: "2",
            copyData: "2",
            allowOverlay: true,
            clipboardData: {
                source: "workbook-1/sheet-1",
                location: [1, 0],
                gridLocation: [1, 0],
                formula: "=A1+B1",
            },
        }]] as unknown as GridCell[][];

        const encoded = getCopyBufferContents(cells, [1], "copy", operationId);
        const decoded = decodeHTML(encoded.textHtml);

        expect(encoded.textPlain).toBe("2");
        expect(encoded.textHtml).toContain(">2</td>");
        expect(decoded?.[0][0].clipboardData).toEqual({
            source: "workbook-1/sheet-1",
            location: [1, 0],
            gridLocation: [1, 0],
            formula: "=A1+B1",
            action: "copy",
            operationId,
        });
        expect(resolveCopyBufferValue(decoded![0][0], {
            source: "workbook-1/sheet-1",
            location: [1, 1],
        }, operationId)).toBe("=A2+B2");
    });

    test("translates each copied formula from its own origin and preserves absolute axes", () => {
        const formula = (text: string, location: readonly [number, number]): CellBuffer => ({
            rawValue: "cached",
            formatted: "cached",
            format: "string",
            clipboardData: {
                source: "workbook-1/sheet-1",
                location,
                gridLocation: location,
                formula: text,
                action: "copy",
                operationId,
            },
        } as CellBuffer);

        expect(resolveCopyBufferValue(formula("=$A$1+A$1+$A1+A1", [0, 0]), {
            source: "workbook-1/sheet-1",
            location: [1, 1],
        }, operationId)).toBe("=$A$1+B$1+$A2+B2");
        expect(resolveCopyBufferValue(formula("=A1+B1", [2, 3]), {
            source: "workbook-1/sheet-1",
            location: [5, 7],
        }, operationId)).toBe("=D5+E5");
    });

    test("cut formulas stay verbatim and hostile metadata falls back to the value", () => {
        const cut = {
            rawValue: "cached",
            formatted: "cached",
            format: "string",
            clipboardData: {
                source: "workbook-1/sheet-1",
                location: [0, 0],
                gridLocation: [0, 0],
                formula: "=A1+B1",
                action: "cut",
                operationId,
            },
        } as CellBuffer;
        expect(resolveCopyBufferValue(cut, {
            source: "workbook-1/sheet-1",
            location: [0, 10],
        }, operationId)).toBe("=A1+B1");

        const oversized = `<table><tr><td gdg-raw-value="cached" data-tv-clipboard="1" `
            + `data-tv-source="sheet" data-tv-column="0" data-tv-row="0" `
            + `data-tv-grid-column="0" data-tv-grid-row="0" data-tv-action="copy" `
            + `data-tv-formula="=${"x".repeat(8_193)}">cached</td></tr></table>`;
        expect(decodeHTML(oversized)?.[0][0]).toEqual(makeCellBuffer("cached"));

        const missingCoordinates = `<table><tr><td gdg-raw-value="cached" data-tv-clipboard="1" `
            + `data-tv-source="sheet" data-tv-action="copy" data-tv-formula="=A1">cached</td></tr></table>`;
        expect(decodeHTML(missingCoordinates)?.[0][0]).toEqual(makeCellBuffer("cached"));
    });

    test("only returns cut sources for one matching sheet and projection", () => {
        const cutCell = (gridLocation: readonly [number, number]): CellBuffer => ({
            rawValue: "value",
            formatted: "value",
            format: "string",
            clipboardData: {
                source: "workbook-1/sheet-1/projection-4",
                location: gridLocation,
                gridLocation,
                action: "cut",
                operationId,
            },
        });
        const buffer = [[cutCell([2, 3]), cutCell([3, 3])]];
        const expected = buffer;

        expect(cutSourceGridLocations(buffer, "workbook-1/sheet-1/projection-4", operationId, expected))
            .toEqual([[2, 3], [3, 3]]);
        expect(cutSourceGridLocations(buffer, "workbook-1/sheet-2/projection-4", operationId, expected))
            .toBeUndefined();
        expect(copyBufferContainsCut(buffer)).toBe(true);
        expect(cutSourceGridLocations(
            [[buffer[0][0]], [buffer[0][1]]],
            "workbook-1/sheet-1/projection-4",
            operationId,
            expected,
        )).toBeUndefined();
        expect(cutSourceGridLocations([[{
            ...cutCell([2, 3]),
            clipboardData: { ...cutCell([2, 3]).clipboardData!, action: "copy" },
        }]], "workbook-1/sheet-1/projection-4", operationId, expected)).toBeUndefined();
    });

    test("decode html", () => {
        const html = `
            <table>
            <tbody>
                <tr>
                    <td>1</td>
                    <td>2</td>
                </tr>
                <tr>
                    <td>3</td>
                    <td>4</td>
                </tr>
            </tbody>
            </table>
        `;

        const decoded = decodeHTML(html);

        expect(decoded).toEqual([
            [makeCellBuffer("1"), makeCellBuffer("2")],
            [makeCellBuffer("3"), makeCellBuffer("4")],
        ]);
    });

    test("Excel for Mac public HTML exposes a cached value, not its formula", () => {
        // Captured from Excel 15 after copying a cell whose formula bar showed
        // =A2+B2. Formula identity remained in Microsoft-only pasteboard types.
        const html = `<html xmlns:x="urn:schemas-microsoft-com:office:excel">
            <meta name="Generator" content="Microsoft Excel 15">
            <table><tr><td align="right">0</td></tr></table>
        </html>`;

        expect(decodeHTML(html)).toEqual([[makeCellBuffer("0")]]);
    });

    test("decode html line breaks", () => {
        const html = `
            <table>
            <tbody>
                <tr>
                    <td>1<br>1.1</td>
                    <td>2<br/>2.1</td>
                </tr>
                <tr>
                    <td>3</td>
                    <td>4</td>
                </tr>
            </tbody>
            </table>
        `;

        const decoded = decodeHTML(html);

        expect(decoded).toEqual([
            [makeCellBuffer("1\n1.1"), makeCellBuffer("2\n2.1")],
            [makeCellBuffer("3"), makeCellBuffer("4")],
        ]);
    });

    test("Simple text cell", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Text,
                    data: "Hello",
                    allowOverlay: true,
                    displayData: "Display Hello",
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe("Display Hello");
        expect(result.textHtml).toContain('<td gdg-raw-value="Hello" gdg-format="string">Display Hello</td>');
    });

    test("Simple text cell with multiple spaces", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Text,
                    data: "Hello",
                    allowOverlay: true,
                    displayData: "Display  Hello",
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe("Display  Hello");
        expect(result.textHtml).toContain(
            '<td gdg-raw-value="Hello" gdg-format="string">Display<span> </span><span> </span>Hello</td>'
        );
    });

    test("Simple text cell with special chars", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Text,
                    data: '"Hello"',
                    allowOverlay: true,
                    displayData: 'Display "Hello"',
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe('"Display ""Hello"""');
        expect(result.textHtml).toContain(
            '<td gdg-raw-value="&quot;Hello&quot;" gdg-format="string">Display "Hello"</td>'
        );
    });

    test("Bubble cell encoding", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Bubble,
                    data: ["Bubble1", "Bubble2"],
                    allowOverlay: true,
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe("Bubble1,Bubble2");
        expect(result.textHtml).toContain(
            '<td gdg-format="string-array"><ol><li gdg-raw-value="Bubble1">Bubble1</li><li gdg-raw-value="Bubble2">Bubble2</li></ol></td>'
        );
    });

    test("format empty bubble cell", () => {
        expect(
            getCopyBufferContents(
                [
                    [
                        {
                            kind: GridCellKind.Bubble,
                            allowOverlay: true,
                            data: [],
                        },
                    ],
                ],
                [0]
            ).textPlain
        ).toEqual("");
    });

    test("format url cell", () => {
        expect(
            getCopyBufferContents(
                [
                    [
                        {
                            kind: GridCellKind.Uri,
                            allowOverlay: true,
                            data: "https://www.google.com",
                        },
                    ],
                ],
                [0]
            ).textPlain
        ).toEqual("https://www.google.com");
    });

    test("format url cell with display value", () => {
        expect(
            getCopyBufferContents(
                [
                    [
                        {
                            kind: GridCellKind.Uri,
                            allowOverlay: true,
                            data: "https://www.google.com",
                            displayData: "Google",
                        },
                    ],
                ],
                [0]
            ).textPlain
        ).toEqual("https://www.google.com");
    });

    test("format empty bubble cell with comma", () => {
        expect(
            getCopyBufferContents(
                [
                    [
                        {
                            kind: GridCellKind.Bubble,
                            allowOverlay: true,
                            data: ["foo, bar", "baz"],
                        },
                    ],
                ],
                [0]
            ).textPlain
        ).toEqual('"foo, bar",baz');
    });

    test("format respects copyData", () => {
        expect(
            getCopyBufferContents(
                [
                    [
                        {
                            kind: GridCellKind.Bubble,
                            allowOverlay: true,
                            data: ["foo, bar", "baz"],
                            copyData: "override",
                        },
                    ],
                ],
                [0]
            ).textPlain
        ).toEqual("override");
    });

    test("Custom cell type", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Custom,
                    copyData: "CustomData",
                    allowOverlay: true,
                    data: "data",
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe("CustomData");
        expect(result.textHtml).toContain('<td gdg-raw-value="CustomData" gdg-format="string">CustomData</td>');
    });

    test.each([
        [true, "TRUE"],
        [false, "FALSE"],
        [BooleanIndeterminate, "INDETERMINATE"],
        [null, ""],
    ])("Boolean cell type %p", (data, expectedFormatted) => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Boolean,
                    data,
                    allowOverlay: false,
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe(expectedFormatted);
        expect(result.textHtml).toContain(
            `<td gdg-raw-value="${data ?? ""}" gdg-format="boolean">${expectedFormatted}</td>`
        );
    });

    test("Image cell type", () => {
        const cells: GridCell[][] = [
            [
                {
                    kind: GridCellKind.Image,
                    data: ["image1.jpg", "image2.jpg"],
                    allowOverlay: true,
                    readonly: false,
                },
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe("image1.jpg,image2.jpg");
        expect(result.textHtml).toContain(
            '<td gdg-format="string-array"><ol><li gdg-raw-value="image1.jpg">image1.jpg</li><li gdg-raw-value="image2.jpg">image2.jpg</li></ol></td>'
        );
    });

    test.each([
        [GridCellKind.Markdown, "markdownContent", "markdownContent", "string"],
        [GridCellKind.RowID, "row123", "row123", "string"],
        [GridCellKind.Number, 1234, "1234", "number"],
        [GridCellKind.Loading, undefined, "#LOADING", "string"],
        [GridCellKind.Protected, undefined, "************", "string"],
    ])("Special cell type %p", (kind, data, expectedFormatted, format) => {
        const cells: GridCell[][] = [
            [
                {
                    kind,
                    data,
                    displayData: data?.toString(),
                    allowOverlay: true,
                } as GridCell,
            ],
        ];
        const columnIndexes = [0];

        const result = getCopyBufferContents(cells, columnIndexes);

        expect(result.textPlain).toBe(expectedFormatted);
        expect(result.textHtml).toContain(
            `<td gdg-raw-value="${data ?? ""}" gdg-format="${format}">${expectedFormatted}</td>`
        );
    });

    test("decode html with URLs", () => {
        const html = `
            <table>
            <tbody>
                <tr>
                    <td gdg-format="url"><a href="https://example.com">Example Link</a></td>
                    <td><ol><li gdg-raw-value="item1">Item1</li><li gdg-raw-value="item2">Item2</li></ol></td>
                </tr>
            </tbody>
            </table>
        `;

        const decoded = decodeHTML(html);

        expect(decoded).toEqual([
            [
                makeCellBuffer("https://example.com", "Example Link", "url"),
                makeCellBuffer(["item1", "item2"], ["Item1", "Item2"], "string-array"),
            ],
        ]);
    });
});

test("Drilldown cell conversion", () => {
    const cells: GridCell[][] = [
        [
            {
                kind: GridCellKind.Drilldown,
                data: [{ text: "Drill1" }, { text: "Drill2" }],
                allowOverlay: true,
            },
        ],
    ];
    const columnIndexes = [0];
    const result = getCopyBufferContents(cells, columnIndexes);
    expect(result.textPlain).toBe("Drill1,Drill2");
    expect(result.textHtml).toContain(
        '<td gdg-format="string-array"><ol><li gdg-raw-value="Drill1">Drill1</li><li gdg-raw-value="Drill2">Drill2</li></ol></td>'
    );
});

test("decode non-table HTML", () => {
    const html = `<div>Non-table content</div>`;
    const decoded = decodeHTML(html);
    expect(decoded).toBeUndefined();
});

test("handle cell span", () => {
    const cells: GridCell[][] = [
        [
            {
                kind: GridCellKind.Text,
                data: "Hello",
                displayData: "Display Hello",
                span: [0, 1],
                allowOverlay: true,
            },
        ],
    ];
    const columnIndexes = [1];
    const result = getCopyBufferContents(cells, columnIndexes);
    expect(result.textPlain).toBe(""); // It should be empty since span doesn't match
});

test("escape string with tab character", () => {
    const cells: GridCell[][] = [
        [
            {
                kind: GridCellKind.Text,
                data: "Hello\tWorld",
                displayData: "Hello\tWorld",
                allowOverlay: true,
            },
        ],
    ];
    const columnIndexes = [0];
    const result = getCopyBufferContents(cells, columnIndexes);
    expect(result.textPlain).toBe('"Hello\tWorld"');
});

test("decode ordered list", () => {
    const html = `
        <table>
        <tbody>
            <tr>
                <td gdg-format="string-array">
                    <ol>
                        <li gdg-raw-value="test1">Test1</li>
                        <li gdg-raw-value="test2">Test2</li>
                    </ol
                </td>
            </tr>
        </tbody>
        </table>
    `;
    const decoded = decodeHTML(html);
    expect(decoded).toEqual([
        [
            {
                rawValue: ["test1", "test2"],
                formatted: ["Test1", "Test2"],
                format: "string-array",
            },
        ],
    ]);
});

test("decode apple numbers", () => {
    const html = `
<table cellspacing="0" cellpadding="0" style="border-collapse: collapse">
<tbody>
<tr>
<td valign="top" style="width: 89.0px; height: 11.0px; border-style: solid; border-width: 1.0px 1.0px 1.0px 1.0px; border-color: #000000 #000000 #000000 #000000; padding: 4.0px 4.0px 4.0px 4.0px">
<p style="margin: 0.0px 0.0px 0.0px 0.0px"><font face="Helvetica Neue" size="2" color="#000000" style="font: 10.0px 'Helvetica Neue'; font-variant-ligatures: common-ligatures; color: #000000">Test</font></p>
</td>
<td valign="top" style="width: 89.0px; height: 11.0px; border-style: solid; border-width: 1.0px 1.0px 1.0px 1.0px; border-color: #000000 #000000 #000000 #000000; padding: 4.0px 4.0px 4.0px 4.0px">
<p style="margin: 0.0px 0.0px 0.0px 0.0px"><font face="Helvetica Neue" size="2" color="#000000" style="font: 10.0px 'Helvetica Neue'; font-variant-ligatures: common-ligatures; color: #000000">This</font></p>
</td>
</tr>
<tr>
<td valign="top" style="width: 89.0px; height: 23.0px; border-style: solid; border-width: 1.0px 1.0px 1.0px 1.0px; border-color: #000000 #000000 #000000 #000000; padding: 4.0px 4.0px 4.0px 4.0px">
<p style="margin: 0.0px 0.0px 0.0px 0.0px"><font face="Helvetica Neue" size="2" color="#000000" style="font: 10.0px 'Helvetica Neue'; font-variant-ligatures: common-ligatures; color: #000000">Out</font></p>
</td>
<td valign="top" style="width: 89.0px; height: 23.0px; border-style: solid; border-width: 1.0px 1.0px 1.0px 1.0px; border-color: #000000 #000000 #000000 #000000; padding: 4.0px 4.0px 4.0px 4.0px">
<p style="margin: 0.0px 0.0px 0.0px 0.0px"><font face="Helvetica Neue" size="2" color="#000000" style="font: 10.0px 'Helvetica Neue'; font-variant-ligatures: common-ligatures; color: #000000">With a<br>
newline and such</font></p>
</td>
</tr>
</tbody>
</table>    
    `;
    const decoded = decodeHTML(html);
    expect(decoded).toEqual([
        [makeCellBuffer("Test"), makeCellBuffer("This")],
        [makeCellBuffer("Out"), makeCellBuffer("With a\nnewline and such")],
    ]);
});

test("decode html attributes", () => {
    const html = `
        <table>
        <tbody>
            <tr>
                <td gdg-raw-value="&quot;Hello&quot;">Hello</td>
            </tr>
        </tbody>
        </table>
    `;
    const decoded = decodeHTML(html);
    expect(decoded).toEqual([
        [
            {
                rawValue: '"Hello"',
                formatted: "Hello",
                format: "string",
            },
        ],
    ]);
});

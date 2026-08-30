/* eslint-disable sonarjs/no-duplicate-string */
import { assertNever } from "../common/support.js";
import {
    GridCellKind,
    type GridCell,
    BooleanEmpty,
    BooleanIndeterminate,
} from "../internal/data-grid/data-grid-types.js";
import { translate_a1_formula } from "../../../xlsx-formula.js";

export type ClipboardAction = "copy" | "cut";

export interface ClipboardCellData {
    readonly source: string;
    readonly location: readonly [number, number];
    readonly gridLocation: readonly [number, number];
    readonly projectionGeneration?: number;
    readonly rowIdentity?:
        | { readonly kind: "source"; readonly sourceRow: number }
        | { readonly kind: "pending"; readonly pendingRowId: string };
    readonly formula?: string;
    readonly action: ClipboardAction;
    readonly operationId?: string;
}

type StringArrayCellBuffer = {
    formatted: string[];
    rawValue: string[];
    format: "string-array";
};

type BasicCellBuffer = {
    formatted: string;
    rawValue: string | number | boolean | BooleanEmpty | BooleanIndeterminate | undefined;
    format: "string" | "number" | "boolean" | "url";
    clipboardData?: ClipboardCellData;
};
export type CellBuffer = (StringArrayCellBuffer | BasicCellBuffer) & {
    clipboardData?: ClipboardCellData;
};
export type CopyBuffer = CellBuffer[][];
export type CutSourceIdentity = CopyBuffer;

const MAX_CLIPBOARD_SOURCE_LENGTH = 512;
// Excel's 8,192-character limit excludes the normalized leading equals sign.
const MAX_XLSX_FORMULA_LENGTH = 8_193;
const MAX_XLSX_COLUMN = 16_383;
const MAX_XLSX_ROW = 1_048_575;

function validLocation(value: readonly [number, number]): boolean {
    return Number.isInteger(value[0])
        && Number.isInteger(value[1])
        && value[0] >= 0
        && value[0] <= MAX_XLSX_COLUMN
        && value[1] >= 0
        && value[1] <= MAX_XLSX_ROW;
}

function validClipboardData(value: ClipboardCellData): boolean {
    return value.source.length > 0
        && value.source.length <= MAX_CLIPBOARD_SOURCE_LENGTH
        && validLocation(value.location)
        && validLocation(value.gridLocation)
        && (value.projectionGeneration === undefined
            || (Number.isSafeInteger(value.projectionGeneration)
                && value.projectionGeneration >= 0))
        && (value.rowIdentity === undefined
            || (value.rowIdentity.kind === "source"
                ? Number.isSafeInteger(value.rowIdentity.sourceRow)
                    && value.rowIdentity.sourceRow >= 0
                    && value.rowIdentity.sourceRow <= MAX_XLSX_ROW
                : typeof value.rowIdentity.pendingRowId === "string"
                    && value.rowIdentity.pendingRowId.length > 0
                    && value.rowIdentity.pendingRowId.length <= 128))
        && (value.action === "copy" || value.action === "cut")
        && typeof value.operationId === "string"
        && /^[A-Za-z0-9-]{16,128}$/.test(value.operationId)
        && (value.formula === undefined || (
            value.formula.startsWith("=")
            && value.formula.length > 1
            && value.formula.length <= MAX_XLSX_FORMULA_LENGTH
        ));
}

function convertCellToBuffer(
    cell: GridCell,
    action: ClipboardAction,
    operationId?: string,
): CellBuffer {
    const withClipboardData = <T extends CellBuffer>(buffer: T): T => {
        const clipboardData = cell.clipboardData === undefined
            ? undefined
            : { ...cell.clipboardData, action, ...(operationId === undefined ? {} : { operationId }) };
        return clipboardData !== undefined && validClipboardData(clipboardData)
            ? { ...buffer, clipboardData }
            : buffer;
    };
    if (cell.copyData !== undefined) {
        return withClipboardData({
            formatted: cell.copyData,
            rawValue: cell.copyData,
            format: "string",
        });
    }
    switch (cell.kind) {
        case GridCellKind.Boolean:
            return withClipboardData({
                formatted:
                    cell.data === true
                        ? "TRUE"
                        : cell.data === false
                        ? "FALSE"
                        : cell.data === BooleanIndeterminate
                        ? "INDETERMINATE"
                        : "",
                rawValue: cell.data,
                format: "boolean",
            });
        case GridCellKind.Custom:
            return withClipboardData({
                formatted: cell.copyData,
                rawValue: cell.copyData,
                format: "string",
            });
        case GridCellKind.Image:
        case GridCellKind.Bubble:
            return withClipboardData({
                formatted: cell.data,
                rawValue: cell.data,
                format: "string-array",
            });
        case GridCellKind.Drilldown:
            return withClipboardData({
                formatted: cell.data.map(x => x.text),
                rawValue: cell.data.map(x => x.text),
                format: "string-array",
            });
        case GridCellKind.Text:
            return withClipboardData({
                formatted: cell.displayData ?? cell.data,
                rawValue: cell.data,
                format: "string",
            });
        case GridCellKind.Uri:
            return withClipboardData({
                formatted: cell.displayData ?? cell.data,
                rawValue: cell.data,
                format: "url",
            });
        case GridCellKind.Markdown:
        case GridCellKind.RowID:
            return withClipboardData({
                formatted: cell.data,
                rawValue: cell.data,
                format: "string",
            });
        case GridCellKind.Number:
            return withClipboardData({
                formatted: cell.displayData,
                rawValue: cell.data,
                format: "number",
            });
        case GridCellKind.Loading:
            return withClipboardData({
                formatted: "#LOADING",
                rawValue: "",
                format: "string",
            });
        case GridCellKind.Protected:
            return withClipboardData({
                formatted: "************",
                rawValue: "",
                format: "string",
            });
        default:
            assertNever(cell);
    }
}

function createBufferFromGridCells(
    cells: readonly (readonly GridCell[])[],
    columnIndexes: readonly number[],
    action: ClipboardAction,
    operationId?: string,
): CopyBuffer {
    // Fork fix (upstream bug): columnIndexes maps each CELL in a row to its
    // grid column, but upstream indexed it with the ROW index, so the
    // span-blanking comparison targeted the wrong column on all but the
    // coincidentally-aligned rows.
    const copyBuffer: CopyBuffer = cells.map(row => {
        return row.map((cell, cellIndex) => {
            if (cell.span !== undefined && cell.span[0] !== columnIndexes[cellIndex]) {
                const clipboardData = cell.clipboardData === undefined
                    ? undefined
                    : {
                        ...cell.clipboardData,
                        action,
                        ...(operationId === undefined ? {} : { operationId }),
                    };
                return {
                    formatted: "",
                    rawValue: "",
                    format: "string",
                    ...(clipboardData !== undefined && validClipboardData(clipboardData)
                        ? { clipboardData }
                        : {}),
                };
            }
            return convertCellToBuffer(cell, action, operationId);
        });
    });
    return copyBuffer;
}

function escapeIfNeeded(str: string, withComma: boolean): string {
    if ((withComma ? /[\t\n",]/ : /[\t\n"]/).test(str)) {
        str = `"${str.replace(/"/g, '""')}"`;
    }
    return str;
}

function createTextBuffer(copyBuffer: CopyBuffer): string {
    const lines: string[] = [];
    for (const row of copyBuffer) {
        const line: string[] = [];
        for (const cell of row) {
            if (cell.format === "url") {
                line.push(cell.rawValue?.toString() ?? "");
            } else if (cell.format === "string-array") {
                line.push(cell.formatted.map(x => escapeIfNeeded(x, true)).join(","));
            } else {
                line.push(escapeIfNeeded(cell.formatted, false));
            }
        }
        lines.push(line.join("\t"));
    }
    return lines.join("\n");
}

function formatHtmlTextContent(text: string): string {
    // The following formatting for the `html` variable ensures that when pasting,
    // spaces are preserved in both Google Sheets and Excel. This is done by:
    // 1. Replacing tabs with four spaces for consistency. Also google sheets disallows any tabs.
    // 2. Wrapping each space with a span element to prevent them from being collapsed or ignored during the
    //    paste operation
    return text.replace(/\t/g, "    ").replace(/ {2,}/g, match => "<span> </span>".repeat(match.length));
}

function formatHtmlAttributeContent(attrText: string): string {
    // Escape all quotes, lt, gt, and other special characters
    return (
        '"' + attrText.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;") + '"'
    );
}

function clipboardHtmlAttributes(cell: CellBuffer): string {
    const data = cell.clipboardData;
    if (data === undefined) return "";
    const fields = [
        `data-tv-clipboard="1"`,
        `data-tv-source=${formatHtmlAttributeContent(data.source)}`,
        `data-tv-column="${data.location[0]}"`,
        `data-tv-row="${data.location[1]}"`,
        `data-tv-grid-column="${data.gridLocation[0]}"`,
        `data-tv-grid-row="${data.gridLocation[1]}"`,
        `data-tv-action="${data.action}"`,
    ];
    if (data.projectionGeneration !== undefined) {
        fields.push(`data-tv-projection="${data.projectionGeneration}"`);
    }
    if (data.formula !== undefined) {
        fields.push(`data-tv-formula=${formatHtmlAttributeContent(data.formula)}`);
    }
    if (data.operationId !== undefined) {
        fields.push(`data-tv-operation=${formatHtmlAttributeContent(data.operationId)}`);
    }
    if (data.rowIdentity?.kind === "source") {
        fields.push(`data-tv-row-kind="source"`);
        fields.push(`data-tv-source-row="${data.rowIdentity.sourceRow}"`);
    } else if (data.rowIdentity?.kind === "pending") {
        fields.push(`data-tv-row-kind="pending"`);
        fields.push(`data-tv-pending-row=${formatHtmlAttributeContent(data.rowIdentity.pendingRowId)}`);
    }
    return ` ${fields.join(" ")}`;
}

function restoreHtmlEntities(str: string): string {
    // Unescape all quotes, lt, gt, and other special characters
    return str
        .replace(/&quot;/g, '"')
        .replace(/&lt;/g, "<")
        .replace(/&gt;/g, ">")
        .replace(/&amp;/g, "&");
}

function createHtmlBuffer(copyBuffer: CopyBuffer): string {
    const lines: string[] = [];
    lines.push(`<style type="text/css"><!--br {mso-data-placement:same-cell;}--></style>`, "<table><tbody>");
    for (const row of copyBuffer) {
        lines.push("<tr>");
        for (const cell of row) {
            const formatStr = `gdg-format="${cell.format}"`;
            const clipboardAttributes = clipboardHtmlAttributes(cell);
            if (cell.format === "url") {
                lines.push(
                    `<td ${formatStr}${clipboardAttributes}><a href="${cell.rawValue}">${formatHtmlTextContent(cell.formatted)}</a></td>`
                );
            } else {
                if (cell.format === "string-array") {
                    lines.push(
                        `<td ${formatStr}${clipboardAttributes}><ol>${cell.formatted
                            .map(
                                (x, ind) =>
                                    `<li gdg-raw-value=${formatHtmlAttributeContent(cell.rawValue[ind])}>` +
                                    formatHtmlTextContent(x) +
                                    "</li>"
                            )
                            .join("")}</ol></td>`
                    );
                } else {
                    lines.push(
                        `<td gdg-raw-value=${formatHtmlAttributeContent(
                            cell.rawValue?.toString() ?? ""
                        )} ${formatStr}${clipboardAttributes}>${formatHtmlTextContent(cell.formatted)}</td>`
                    );
                }
            }
        }
        lines.push("</tr>");
    }
    lines.push("</tbody></table>");
    return lines.join("");
}

// This function encodes grid cells to a table object.
// Each td in the table contains one of 3 things
// - A string directly and the td has a `gdg-raw-value` attribute with the raw value
// - An anchor tag with a href and the text is the formatted value
// - An ordered list with each item containing a `gdg-raw-value` attribute with the raw value
export function getCopyBufferContents(
    cells: readonly (readonly GridCell[])[],
    columnIndexes: readonly number[],
    action: ClipboardAction = "copy",
    operationId?: string,
): {
    readonly textPlain: string;
    readonly textHtml: string;
} {
    const copyBuffer = createBufferFromGridCells(cells, columnIndexes, action, operationId);
    const textPlain = createTextBuffer(copyBuffer);
    const textHtml = createHtmlBuffer(copyBuffer);
    return {
        textPlain,
        textHtml,
    };
}

function decodedClipboardData(cell: HTMLTableCellElement): ClipboardCellData | undefined {
    if (cell.getAttribute("data-tv-clipboard") !== "1") return undefined;
    const source = cell.getAttribute("data-tv-source") ?? "";
    const coordinate = (name: string): number | undefined => {
        const encoded = cell.getAttribute(name);
        if (encoded === null || !/^\d{1,7}$/.test(encoded)) return undefined;
        return Number(encoded);
    };
    const column = coordinate("data-tv-column");
    const row = coordinate("data-tv-row");
    const gridColumn = coordinate("data-tv-grid-column");
    const gridRow = coordinate("data-tv-grid-row");
    const projectionGeneration = coordinate("data-tv-projection");
    if (column === undefined || row === undefined || gridColumn === undefined || gridRow === undefined) {
        return undefined;
    }
    const action = cell.getAttribute("data-tv-action");
    const formula = cell.getAttribute("data-tv-formula") ?? undefined;
    const operationId = cell.getAttribute("data-tv-operation") ?? undefined;
    const rowKind = cell.getAttribute("data-tv-row-kind");
    const sourceRow = coordinate("data-tv-source-row");
    const pendingRow = cell.getAttribute("data-tv-pending-row");
    const rowIdentity = rowKind === "source" && sourceRow !== undefined
        ? { kind: "source" as const, sourceRow }
        : rowKind === "pending" && pendingRow !== null
            ? { kind: "pending" as const, pendingRowId: pendingRow }
            : undefined;
    const result: ClipboardCellData = {
        source,
        location: [column, row],
        gridLocation: [gridColumn, gridRow],
        ...(projectionGeneration === undefined ? {} : { projectionGeneration }),
        ...(rowIdentity === undefined ? {} : { rowIdentity }),
        ...(formula === undefined ? {} : { formula }),
        action: action as ClipboardAction,
        ...(operationId === undefined ? {} : { operationId }),
    };
    return validClipboardData(result) ? result : undefined;
}

export function resolveCopyBufferValue(
    cell: CellBuffer,
    destination?: Pick<ClipboardCellData, "source" | "location">,
    expectedOperationId?: string,
): CellBuffer["rawValue"] {
    const metadata = cell.clipboardData;
    if (
        metadata?.formula === undefined
        || destination === undefined
        || metadata.source !== destination.source
        || metadata.operationId !== expectedOperationId
    ) return cell.rawValue;
    if (metadata.action === "cut") return metadata.formula;
    return translate_a1_formula(
        metadata.formula,
        destination.location[1] - metadata.location[1],
        destination.location[0] - metadata.location[0],
    );
}

/**
 * Return projected source cells only when the entire payload is one valid cut
 * from the destination's current projection. A copied or cross-sheet payload
 * must never clear cells in this grid.
 */
export interface CutSourceCell {
    readonly gridLocation: readonly [number, number];
    readonly sourceColumn: number;
    readonly rowIdentity:
        | { readonly kind: "source"; readonly sourceRow: number }
        | { readonly kind: "pending"; readonly pendingRowId: string };
}

export function cutSourceCells(
    buffer: CopyBuffer,
    destinationSource: string | undefined,
    expectedOperationId?: string,
    expectedCells?: CutSourceIdentity,
    destinationProjectionGeneration?: number,
): readonly CutSourceCell[] | undefined {
    if (destinationSource === undefined || expectedOperationId === undefined
        || expectedCells === undefined || buffer.length === 0) return undefined;
    if (buffer.length !== expectedCells.length
        || buffer.some((row, index) => row.length !== expectedCells[index]?.length)) return undefined;
    const locations: CutSourceCell[] = [];
    const seen = new Set<string>();
    for (const [row_index, row] of buffer.entries()) {
        for (const [column_index, cell] of row.entries()) {
            const metadata = cell.clipboardData;
            if (
                metadata === undefined
                || metadata.action !== "cut"
                || metadata.source !== destinationSource
                || metadata.operationId !== expectedOperationId
                || (metadata.rowIdentity === undefined
                    && metadata.projectionGeneration !== destinationProjectionGeneration)
            ) return undefined;
            const key = `${metadata.gridLocation[0]}:${metadata.gridLocation[1]}`;
            if (seen.has(key)) return undefined;
            const expected = expectedCells[row_index]?.[column_index];
            const expected_metadata = expected?.clipboardData;
            if (expected === undefined || expected_metadata === undefined
                || expected.format !== cell.format
                || JSON.stringify(expected.rawValue) !== JSON.stringify(cell.rawValue)
                || JSON.stringify(expected.formatted) !== JSON.stringify(cell.formatted)
                || expected_metadata.source !== metadata.source
                || expected_metadata.formula !== metadata.formula
                || expected_metadata.location[0] !== metadata.location[0]
                || expected_metadata.location[1] !== metadata.location[1]
                || expected_metadata.gridLocation[0] !== metadata.gridLocation[0]
                || expected_metadata.gridLocation[1] !== metadata.gridLocation[1]
                || expected_metadata.projectionGeneration !== metadata.projectionGeneration
                || JSON.stringify(expected_metadata.rowIdentity)
                    !== JSON.stringify(metadata.rowIdentity)) return undefined;
            seen.add(key);
            locations.push({
                gridLocation: metadata.gridLocation,
                sourceColumn: metadata.location[0],
                rowIdentity: metadata.rowIdentity ?? {
                    kind: "source",
                    sourceRow: metadata.location[1],
                },
            });
        }
    }
    return locations.length === 0 ? undefined : locations;
}

export function cutSourceGridLocations(
    buffer: CopyBuffer,
    destinationSource: string | undefined,
    expectedOperationId?: string,
    expectedCells?: CutSourceIdentity,
    destinationProjectionGeneration?: number,
): readonly (readonly [number, number])[] | undefined {
    return cutSourceCells(
        buffer,
        destinationSource,
        expectedOperationId,
        expectedCells,
        destinationProjectionGeneration,
    )
        ?.map((cell) => cell.gridLocation);
}

export function copyBufferContainsCut(buffer: CopyBuffer): boolean {
    return buffer.some(row => row.some(cell => cell.clipboardData?.action === "cut"));
}

export function decodeHTML(html: string): CopyBuffer | undefined {
    // Fork change: parse into an inert document via DOMParser instead of
    // assigning clipboard HTML to a live element's innerHTML. The parsed
    // document never executes scripts or loads subresources, so hostile
    // clipboard content cannot run in the webview (CodeQL js/xss).
    // We don't want to retain the pasted non-breaking spaces.
    const doc = new DOMParser().parseFromString(html.replace(/&nbsp;/g, " "), "text/html");
    const tableEl = doc.querySelector("table");
    if (tableEl === null) return undefined;
    const walkEl: Element[] = [tableEl];
    const result: CellBuffer[][] = [];
    let current: CellBuffer[] | undefined;

    while (walkEl.length > 0) {
        const el = walkEl.pop();

        if (el === undefined) break;

        if (el instanceof HTMLTableElement || el.nodeName === "TBODY") {
            walkEl.push(...[...el.children].reverse());
        } else if (el instanceof HTMLTableRowElement) {
            if (current !== undefined) {
                result.push(current);
            }
            current = [];
            walkEl.push(...[...el.children].reverse());
        } else if (el instanceof HTMLTableCellElement) {
            // be careful not to use innerText here as its behavior is not well defined for non DOM attached nodes
            const clone: HTMLTableCellElement = el.cloneNode(true) as HTMLTableCellElement;

            // Apple numbers seems to always wrap the cell in a p tag and a font tag. It also puts both <br> and \n
            // linebreak markers in the code. This is both unneeded and causes issues with the paste code.
            const firstTagIsPara = clone.children.length === 1 && clone.children[0].nodeName === "P";
            const para = firstTagIsPara ? clone.children[0] : null;
            const isAppleNumbers = para?.children.length === 1 && para.children[0].nodeName === "FONT";

            const brs = clone.querySelectorAll("br");
            for (const br of brs) {
                br.replaceWith("\n");
            }

            const attributeValue = clone.getAttribute("gdg-raw-value");
            const formatValue = (clone.getAttribute("gdg-format") ?? "string") as any; // fix me at some point
            const clipboardData = decodedClipboardData(clone);
            if (clone.querySelector("a") !== null) {
                current?.push({
                    // raw value is the href
                    rawValue: clone.querySelector("a")?.getAttribute("href") ?? "",
                    formatted: clone.textContent ?? "",
                    format: formatValue,
                    ...(clipboardData === undefined ? {} : { clipboardData }),
                });
            } else if (clone.querySelector("ol") !== null) {
                const rawValues = clone.querySelectorAll("li");
                current?.push({
                    rawValue: [...rawValues].map(x => x.getAttribute("gdg-raw-value") ?? ""),
                    formatted: [...rawValues].map(x => x.textContent ?? ""),
                    format: "string-array",
                    ...(clipboardData === undefined ? {} : { clipboardData }),
                });
            } else if (attributeValue !== null) {
                current?.push({
                    rawValue: restoreHtmlEntities(attributeValue),
                    formatted: clone.textContent ?? "",
                    format: formatValue,
                    ...(clipboardData === undefined ? {} : { clipboardData }),
                });
            } else {
                let textContent = clone.textContent ?? "";
                if (isAppleNumbers) {
                    // replace any newline not preceded by a newline
                    textContent = textContent.replace(/\n(?!\n)/g, "");
                }

                current?.push({
                    rawValue: textContent ?? "",
                    formatted: textContent ?? "",
                    format: formatValue,
                    ...(clipboardData === undefined ? {} : { clipboardData }),
                });
            }
        }
    }

    if (current !== undefined) {
        result.push(current);
    }

    return result;
}

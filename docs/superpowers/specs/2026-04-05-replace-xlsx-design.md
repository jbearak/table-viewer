# Replace vulnerable xlsx (SheetJS) with minimal BIFF8 parser

## Problem

The `xlsx` (SheetJS) package has two unpatched high-severity vulnerabilities:

- **Prototype Pollution** — GHSA-4r6h-8v6p-xvw6
- **ReDoS** — GHSA-5pgg-2g8v-p4x9

No fix is available from the maintainer. SheetJS is the only maintained JS implementation of `.xls` (BIFF8) parsing, so there is no drop-in replacement.

## Solution

Replace `xlsx` with two small, focused dependencies and a custom minimal BIFF8 parser:

- **`cfb`** — parses the Compound File Binary container that wraps `.xls` files
- **`ssf`** — standalone number formatting library (the same code SheetJS bundles internally), replaces `XLSX.SSF.format()` usage in `.xlsx` parsing
- **Custom BIFF8 record parser** — ~300-500 lines of TypeScript that reads only the record types needed for a read-only table viewer

## Dependency changes

| Action | Package | Purpose |
|--------|---------|---------|
| Remove | `xlsx` (^0.18.5) | Vulnerable, fully replaced |
| Add | `cfb` | CFB container parsing for `.xls` |
| Add | `ssf` | Number format strings for `.xlsx` cell display |
| Add (dev) | `vitest` | Test framework |

## Architecture

### Parser layers

**Layer 1 — Record scanner:** Reads the raw Workbook stream (extracted by `cfb`) as a sequence of BIFF8 records. Each record has a 4-byte header (2-byte type + 2-byte length) followed by payload. Handles Continue records — when a record's data exceeds 8224 bytes, the remainder spills into Continue records that must be stitched together.

**Layer 2 — Record interpreter:** Single pass through the records, building up `WorkbookData`. Two phases:

1. **Globals phase:** Collect BoundSheet8 entries (sheet names + offsets), SST (Shared String Table), Font table, XF table, Format table
2. **Sheet phase:** For each sheet substream (seeked by BoundSheet8 offset), read Dimension, cell records, MergeCells

### BIFF8 records handled

| Record | Type ID | Purpose |
|--------|---------|---------|
| BOF | 0x0809 | Start of workbook/sheet substream |
| EOF | 0x000A | End of substream |
| BoundSheet8 | 0x0085 | Sheet name + offset to sheet substream |
| SST | 0x00FC | Shared String Table — all string values |
| Font | 0x0031 | Font records (bold/italic) |
| XF | 0x00E0 | Cell format — maps to Font index |
| Format | 0x041E | Number format strings |
| Dimension | 0x0200 | Row/column bounds for a sheet |
| LabelSST | 0x00FD | String cell (index into SST) |
| Number | 0x0203 | Float cell |
| RK | 0x027E | Compact number cell |
| MulRK | 0x00BD | Multiple compact numbers in a row |
| BoolErr | 0x0205 | Boolean or error cell |
| Blank | 0x0201 | Empty formatted cell |
| MergeCells | 0x00E5 | Merge ranges |
| Formula | 0x0006 | Formula cell — cached result only |
| String | 0x0207 | Cached string result for Formula |
| Label | 0x0204 | Inline string cell (older files) |

### Data flow

1. `cfb.read(buffer)` extracts the Workbook stream
2. Globals pass: collect BoundSheet8, SST, Font, XF, Format tables
3. Per-sheet pass: read Dimension, cell records, MergeCells
4. Cell XF index -> Font index -> bold/italic; XF index -> Format string -> `ssf.format()` for display value
5. Return `{ data: WorkbookData, warnings: string[] }`

### String handling

SST entries use UTF-16LE or compressed Latin-1, indicated by a flag byte. Rich text run data (formatting within a string) is skipped — plain text only. Continue record boundaries can split mid-string; the stitcher handles this.

### RK number encoding

A 4-byte value where bit 0 means "divide by 100" and bit 1 means "integer, not IEEE 754". Four combinations decoded into a regular JS number.

## Return type change

Both `parse_xls` and `parse_xlsx` return `{ data: WorkbookData, warnings: string[] }` instead of `WorkbookData` directly. This lets the caller in `custom-editor.ts` surface warnings to the user.

## Error handling

**Malformed files:** Throw specific errors like "Not a valid .xls file" or "No workbook data found in .xls file". These surface directly in the VS Code error notification (not wrapped in a generic "Failed to open file" message).

**Unsupported BIFF versions:** BIFF2-BIFF5 use different record structures. The parser checks the BOF version field and throws "Unsupported Excel format: BIFF5" (or similar) rather than producing garbage.

**Password-protected files:** If a FilePass record (0x002F) is encountered, throw "Password-protected .xls files are not supported".

**Truncated/corrupt records:** If a record's stated length extends past the end of the stream, stop parsing that substream. Return whatever was successfully parsed and add a warning. The caller shows a `vscode.window.showWarningMessage()` (yellow transient notification) like "Some data in this file could not be read. The file may be damaged."

## Intentionally unsupported

Formulas are supported only via cached results parsed from `FORMULA`/`STRING` records (including numeric, boolean, error, and string results). Formula expressions are not parsed or recalculated; charts, images, comments, conditional formatting, hyperlinks, VBA, print settings, protection, and macros remain unsupported. None of these are relevant for a read-only table viewer.

## File changes

### New files

- `src/test/fixtures/*.xls` — 5 test fixture files
- `src/test/parse-xls.test.ts` — unit + integration tests
- `vitest.config.ts` — minimal vitest config

### Modified files

- `package.json` — remove `xlsx`, add `cfb`, `ssf`, `vitest`
- `src/parse-xls.ts` — full rewrite: replace SheetJS with CFB + custom BIFF8 parser (~300-500 lines); return type changes to `{ data: WorkbookData, warnings: string[] }`
- `src/parse-xlsx.ts` — replace `import XLSX from 'xlsx'` with `import SSF from 'ssf'`, change `XLSX.SSF.format()` to `SSF.format()`; update return type to `{ data: WorkbookData, warnings: string[] }`
- `src/custom-editor.ts` — handle `{ data, warnings }` return type, show warning notification when `warnings.length > 0`, show parser error messages directly instead of generic "Failed to open file"

### Unchanged

- `src/types.ts`
- `src/webview/*`
- `src/state.ts`, `src/extension.ts`, `src/webview-html.ts`

## Testing

### Framework

Vitest — fast, good TypeScript support, no VS Code dependency needed since all tests are pure data transformation.

### Test fixtures

Small real `.xls` files (created in LibreOffice or Excel):

- `basic.xls` — strings, numbers, booleans, dates across multiple sheets
- `merged.xls` — cells with merge ranges
- `styled.xls` — bold and italic cells
- `empty-sheet.xls` — workbook with an empty sheet
- `large-range.xls` — data spread across a wide range

### Unit tests

- RK decoding — all four combinations (int, int/100, float, float/100)
- SST string extraction — Latin-1 compressed, UTF-16LE, rich text stripping
- Continue record stitching — synthetic buffer spanning a Continue boundary

### Integration tests

- Parse each fixture and assert `WorkbookData` matches expected output
- Compare output against current `xlsx`-based parser on the same files to verify parity before removing `xlsx`

### Edge case tests

- Invalid buffer -> specific error message
- BIFF5 file -> version error
- Truncated record -> partial data + warning

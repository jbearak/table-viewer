# Replace vulnerable xlsx with minimal BIFF8 parser — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Remove the vulnerable `xlsx` (SheetJS) dependency by replacing it with `cfb` + `ssf` + a custom minimal BIFF8 parser.

**Architecture:** Two layers — a record scanner that extracts BIFF8 records from the CFB Workbook stream (handling Continue records), and a record interpreter that builds `WorkbookData` from ~16 record types. The `.xlsx` path keeps ExcelJS but swaps `XLSX.SSF.format()` for standalone `ssf`. Both parsers return `{ data: WorkbookData, warnings: string[] }`.

**Tech Stack:** TypeScript, cfb, ssf, vitest, esbuild (existing), VS Code extension API (existing)

---

## Task 1: Add vitest and configure test infrastructure

**Files:**
- Create: `vitest.config.ts`
- Modify: `package.json`
- Modify: `tsconfig.json`

- [ ] **Step 1: Install vitest**

Run:
```bash
npm install --save-dev vitest
```

- [ ] **Step 2: Create vitest config**

Create `vitest.config.ts`:

```ts
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
  },
});
```

- [ ] **Step 3: Add test script to package.json**

In `package.json`, add to the `"scripts"` object:

```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 4: Run vitest to verify config**

Run: `npm test`
Expected: "No test files found" (not a config error)

- [ ] **Step 5: Commit**

```bash
git add vitest.config.ts package.json package-lock.json
git commit -m "chore: add vitest test infrastructure"
```

---

## Task 2: Generate test fixture .xls files

Use the currently-installed `xlsx` library to generate fixture files before we remove it. This ensures the fixtures are valid BIFF8 files.

**Files:**
- Create: `src/test/generate-fixtures.ts` (temporary script, removed after use)
- Create: `src/test/fixtures/basic.xls`
- Create: `src/test/fixtures/merged.xls`
- Create: `src/test/fixtures/styled.xls`
- Create: `src/test/fixtures/empty-sheet.xls`
- Create: `src/test/fixtures/large-range.xls`

- [ ] **Step 1: Write the fixture generator script**

Create `src/test/generate-fixtures.ts`:

```ts
import XLSX from 'xlsx';
import * as fs from 'fs';
import * as path from 'path';

const FIXTURES_DIR = path.join(__dirname, 'fixtures');
fs.mkdirSync(FIXTURES_DIR, { recursive: true });

function write(name: string, wb: XLSX.WorkBook): void {
    XLSX.writeFile(wb, path.join(FIXTURES_DIR, name), { bookType: 'biff8' });
}

// basic.xls — strings, numbers, booleans, dates across two sheets
function generate_basic(): void {
    const wb = XLSX.utils.book_new();

    const ws1_data = [
        ['Name', 'Age', 'Active', 'Joined'],
        ['Alice', 30, true, new Date('2024-01-15')],
        ['Bob', 25, false, new Date('2023-06-01')],
    ];
    const ws1 = XLSX.utils.aoa_to_sheet(ws1_data, { cellDates: true });
    XLSX.utils.book_append_sheet(wb, ws1, 'People');

    const ws2_data = [
        ['Product', 'Price', 'Quantity'],
        ['Widget', 9.99, 100],
        ['Gadget', 24.5, 50],
    ];
    const ws2 = XLSX.utils.aoa_to_sheet(ws2_data);
    XLSX.utils.book_append_sheet(wb, ws2, 'Inventory');

    write('basic.xls', wb);
}

// merged.xls — cells with merge ranges
function generate_merged(): void {
    const wb = XLSX.utils.book_new();
    const ws_data = [
        ['Merged Header', null, null],
        ['A', 'B', 'C'],
        ['Tall', 'D', 'E'],
        [null, 'F', 'G'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(ws_data);
    ws['!merges'] = [
        { s: { r: 0, c: 0 }, e: { r: 0, c: 2 } }, // A1:C1 horizontal merge
        { s: { r: 2, c: 0 }, e: { r: 3, c: 0 } }, // A3:A4 vertical merge
    ];
    XLSX.utils.book_append_sheet(wb, ws, 'Merges');
    write('merged.xls', wb);
}

// styled.xls — bold and italic cells
function generate_styled(): void {
    const wb = XLSX.utils.book_new();
    const ws_data = [
        ['Normal', 'Bold', 'Italic', 'Bold+Italic'],
        ['plain', 'strong', 'emphasis', 'both'],
    ];
    const ws = XLSX.utils.aoa_to_sheet(ws_data);

    // SheetJS community edition has limited style support for BIFF8 writes,
    // but we set what we can. The cell styles may or may not survive the
    // round-trip depending on the SheetJS version.
    const bold_font = { bold: true };
    const italic_font = { italic: true };
    const both_font = { bold: true, italic: true };

    if (ws['B1']) ws['B1'].s = { font: bold_font };
    if (ws['B2']) ws['B2'].s = { font: bold_font };
    if (ws['C1']) ws['C1'].s = { font: italic_font };
    if (ws['C2']) ws['C2'].s = { font: italic_font };
    if (ws['D1']) ws['D1'].s = { font: both_font };
    if (ws['D2']) ws['D2'].s = { font: both_font };

    XLSX.utils.book_append_sheet(wb, ws, 'Styles');
    write('styled.xls', wb);
}

// empty-sheet.xls — workbook with an empty sheet
function generate_empty_sheet(): void {
    const wb = XLSX.utils.book_new();
    const ws_with_data = XLSX.utils.aoa_to_sheet([['Has data']]);
    XLSX.utils.book_append_sheet(wb, ws_with_data, 'FilledSheet');

    const ws_empty = XLSX.utils.aoa_to_sheet([]);
    XLSX.utils.book_append_sheet(wb, ws_empty, 'EmptySheet');

    write('empty-sheet.xls', wb);
}

// large-range.xls — data spread across a wide range
function generate_large_range(): void {
    const wb = XLSX.utils.book_new();
    const ws: XLSX.WorkSheet = {};
    // Place data at A1 and at a distant cell (Z50)
    ws['A1'] = { t: 's', v: 'Top-left' };
    ws['Z50'] = { t: 'n', v: 12345 };
    ws['!ref'] = 'A1:Z50';
    XLSX.utils.book_append_sheet(wb, ws, 'Wide');
    write('large-range.xls', wb);
}

generate_basic();
generate_merged();
generate_styled();
generate_empty_sheet();
generate_large_range();

console.log('Fixtures generated in', FIXTURES_DIR);
```

- [ ] **Step 2: Run the generator**

Run:
```bash
npx tsx src/test/generate-fixtures.ts
```
Expected: "Fixtures generated in ..." and 5 `.xls` files created in `src/test/fixtures/`.

- [ ] **Step 3: Verify fixtures exist**

Run:
```bash
ls -la src/test/fixtures/
```
Expected: `basic.xls`, `merged.xls`, `styled.xls`, `empty-sheet.xls`, `large-range.xls`

- [ ] **Step 4: Delete the generator script**

```bash
rm src/test/generate-fixtures.ts
```

The fixtures are committed as binary files; the generator is disposable.

- [ ] **Step 5: Commit**

```bash
git add src/test/fixtures/
git commit -m "test: add .xls fixture files for BIFF8 parser tests"
```

---

## Task 3: Write parity baseline tests using current xlsx parser

Before rewriting `parse_xls`, capture its current output as the expected baseline. These tests will later verify the new parser produces identical results.

**Files:**
- Create: `src/test/parse-xls.test.ts`

- [ ] **Step 1: Write integration tests against current parser**

Create `src/test/parse-xls.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_xls } from '../parse-xls';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): Buffer {
    return fs.readFileSync(path.join(FIXTURES, name));
}

describe('parse_xls', () => {
    describe('basic.xls', () => {
        it('parses two sheets with correct names', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = 'data' in result ? result.data : result;
            expect(data.sheets).toHaveLength(2);
            expect(data.sheets[0].name).toBe('People');
            expect(data.sheets[1].name).toBe('Inventory');
        });

        it('parses string, number, and boolean cell values', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = 'data' in result ? result.data : result;
            const people = data.sheets[0];

            // Header row
            expect(people.rows[0][0]?.raw).toBe('Name');
            expect(people.rows[0][1]?.raw).toBe('Age');

            // Data row — string
            expect(people.rows[1][0]?.raw).toBe('Alice');
            // Data row — number
            expect(people.rows[1][1]?.raw).toBe(30);
            // Data row — boolean
            expect(people.rows[1][2]?.raw).toBe(true);
        });

        it('returns correct row and column counts', () => {
            const result = parse_xls(read_fixture('basic.xls'));
            const data = 'data' in result ? result.data : result;
            const people = data.sheets[0];
            expect(people.rowCount).toBe(3);
            expect(people.columnCount).toBe(4);
        });
    });

    describe('merged.xls', () => {
        it('detects merge ranges', () => {
            const result = parse_xls(read_fixture('merged.xls'));
            const data = 'data' in result ? result.data : result;
            const sheet = data.sheets[0];
            expect(sheet.merges).toHaveLength(2);

            // Horizontal merge: A1:C1
            expect(sheet.merges).toContainEqual({
                startRow: 0, startCol: 0, endRow: 0, endCol: 2,
            });
            // Vertical merge: A3:A4
            expect(sheet.merges).toContainEqual({
                startRow: 2, startCol: 0, endRow: 3, endCol: 0,
            });
        });

        it('returns null for non-anchor merged cells', () => {
            const result = parse_xls(read_fixture('merged.xls'));
            const data = 'data' in result ? result.data : result;
            const sheet = data.sheets[0];

            // A1 is the anchor — should have content
            expect(sheet.rows[0][0]?.raw).toBe('Merged Header');
            // B1, C1 are merged into A1 — should be null
            expect(sheet.rows[0][1]).toBeNull();
            expect(sheet.rows[0][2]).toBeNull();
        });
    });

    describe('empty-sheet.xls', () => {
        it('handles empty sheets', () => {
            const result = parse_xls(read_fixture('empty-sheet.xls'));
            const data = 'data' in result ? result.data : result;
            expect(data.sheets).toHaveLength(2);

            const empty = data.sheets.find(s => s.name === 'EmptySheet');
            expect(empty).toBeDefined();
            expect(empty!.rows).toHaveLength(0);
            expect(empty!.rowCount).toBe(0);
            expect(empty!.columnCount).toBe(0);
        });
    });

    describe('large-range.xls', () => {
        it('handles sparse data across a wide range', () => {
            const result = parse_xls(read_fixture('large-range.xls'));
            const data = 'data' in result ? result.data : result;
            const sheet = data.sheets[0];
            expect(sheet.rowCount).toBe(50);
            expect(sheet.columnCount).toBe(26); // A through Z

            expect(sheet.rows[0][0]?.raw).toBe('Top-left');
            expect(sheet.rows[49][25]?.raw).toBe(12345);
        });
    });
});
```

- [ ] **Step 2: Run the tests to verify they pass with current xlsx parser**

Run: `npm test`
Expected: All tests PASS. This confirms the baseline expectations match the current parser output.

Note: If any assertions are wrong (e.g., the fixture generator produced slightly different data than expected), fix the assertions to match the actual current output. The goal is to capture what the current parser produces, then verify the new parser matches.

- [ ] **Step 3: Commit**

```bash
git add src/test/parse-xls.test.ts
git commit -m "test: add parity baseline tests for .xls parser"
```

---

## Task 4: Replace XLSX.SSF with standalone ssf in parse-xlsx.ts

The quick win — swap one import and one call site.

**Files:**
- Modify: `package.json`
- Modify: `src/parse-xlsx.ts`

- [ ] **Step 1: Install ssf**

Run:
```bash
npm install ssf
```

- [ ] **Step 2: Replace the import and call in parse-xlsx.ts**

In `src/parse-xlsx.ts`, replace:

```ts
import XLSX from 'xlsx';
```

with:

```ts
import SSF from 'ssf';
```

And in the `format_cell_value` function, replace:

```ts
            return XLSX.SSF.format(num_fmt, raw);
```

with:

```ts
            return SSF.format(num_fmt, raw);
```

- [ ] **Step 3: Update parse_xlsx return type**

In `src/parse-xlsx.ts`, change the function signature from:

```ts
export async function parse_xlsx(buffer: Uint8Array): Promise<WorkbookData> {
```

to:

```ts
export async function parse_xlsx(buffer: Uint8Array): Promise<{ data: WorkbookData; warnings: string[] }> {
```

And change the return statement at the end of the function from:

```ts
    return { sheets };
```

to:

```ts
    return { data: { sheets }, warnings: [] };
```

- [ ] **Step 4: Verify the bundle still compiles**

Run:
```bash
npm run bundle
```
Expected: Build succeeds (will have type errors in `custom-editor.ts` due to new return type — that's expected and fixed in Task 8).

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json src/parse-xlsx.ts
git commit -m "refactor: replace XLSX.SSF with standalone ssf package"
```

---

## Task 5: Build the BIFF8 record scanner (Layer 1)

The low-level layer: extract BIFF8 records from a byte buffer, handling Continue record stitching.

**Files:**
- Modify: `src/parse-xls.ts`
- Create: `src/test/biff8-scanner.test.ts`

- [ ] **Step 1: Write failing tests for the record scanner**

Create `src/test/biff8-scanner.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { scan_records, type BiffRecord } from '../parse-xls';

describe('scan_records', () => {
    it('reads a single record', () => {
        // BOF record: type=0x0809, length=4, payload=[0x01, 0x02, 0x03, 0x04]
        const buf = Buffer.alloc(8);
        buf.writeUInt16LE(0x0809, 0); // type
        buf.writeUInt16LE(4, 2);      // length
        buf[4] = 0x01; buf[5] = 0x02; buf[6] = 0x03; buf[7] = 0x04;

        const records = scan_records(buf);
        expect(records).toHaveLength(1);
        expect(records[0].type).toBe(0x0809);
        expect(records[0].data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04]));
    });

    it('reads multiple records sequentially', () => {
        const buf = Buffer.alloc(12);
        // Record 1: type=0x0085, length=2
        buf.writeUInt16LE(0x0085, 0);
        buf.writeUInt16LE(2, 2);
        buf[4] = 0xAA; buf[5] = 0xBB;
        // Record 2: type=0x000A, length=0 (EOF)
        buf.writeUInt16LE(0x000A, 6);
        buf.writeUInt16LE(0, 8);
        // (2 bytes padding at end — buf is 12 but only 10 used)

        const records = scan_records(buf.subarray(0, 10));
        expect(records).toHaveLength(2);
        expect(records[0].type).toBe(0x0085);
        expect(records[1].type).toBe(0x000A);
    });

    it('stitches Continue records into preceding record', () => {
        // Record: type=0x00FC (SST), length=3, data=[0x01, 0x02, 0x03]
        // Continue: type=0x003C, length=2, data=[0x04, 0x05]
        const buf = Buffer.alloc(14);
        buf.writeUInt16LE(0x00FC, 0);
        buf.writeUInt16LE(3, 2);
        buf[4] = 0x01; buf[5] = 0x02; buf[6] = 0x03;
        buf.writeUInt16LE(0x003C, 7); // Continue
        buf.writeUInt16LE(2, 9);
        buf[11] = 0x04; buf[12] = 0x05;

        const records = scan_records(buf.subarray(0, 13));
        expect(records).toHaveLength(1);
        expect(records[0].type).toBe(0x00FC);
        expect(records[0].data).toEqual(Buffer.from([0x01, 0x02, 0x03, 0x04, 0x05]));
    });

    it('returns empty array for empty buffer', () => {
        expect(scan_records(Buffer.alloc(0))).toEqual([]);
    });

    it('stops gracefully on truncated record header', () => {
        // Only 2 bytes — not enough for a full 4-byte header
        const buf = Buffer.alloc(2);
        buf.writeUInt16LE(0x0809, 0);

        const records = scan_records(buf);
        expect(records).toEqual([]);
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/test/biff8-scanner.test.ts`
Expected: FAIL — `scan_records` is not exported from `parse-xls`.

- [ ] **Step 3: Implement the record scanner**

Replace the entire contents of `src/parse-xls.ts` with:

```ts
import CFB from 'cfb';
import SSF from 'ssf';
import type { WorkbookData, SheetData, CellData, MergeRange } from './types';

// --- Constants ---

const RECORD_CONTINUE = 0x003C;

// --- Types ---

export interface BiffRecord {
    type: number;
    data: Buffer;
    offset: number; // byte offset in the stream where this record started
}

export interface ParseResult {
    data: WorkbookData;
    warnings: string[];
}

// --- Layer 1: Record Scanner ---

export function scan_records(buf: Buffer): BiffRecord[] {
    const records: BiffRecord[] = [];
    let pos = 0;

    while (pos + 4 <= buf.length) {
        const type = buf.readUInt16LE(pos);
        const len = buf.readUInt16LE(pos + 2);

        if (pos + 4 + len > buf.length) {
            break; // truncated record
        }

        const data = Buffer.from(buf.subarray(pos + 4, pos + 4 + len));
        const offset = pos;
        pos += 4 + len;

        if (type === RECORD_CONTINUE && records.length > 0) {
            // Stitch into the preceding record
            const prev = records[records.length - 1];
            prev.data = Buffer.concat([prev.data, data]);
        } else {
            records.push({ type, data, offset });
        }
    }

    return records;
}
```

This is a partial file — the rest of the parser will be added in subsequent tasks. The file won't compile fully yet because `parse_xls` is not defined, but the exported `scan_records` function and types are testable.

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/test/biff8-scanner.test.ts`
Expected: All 5 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parse-xls.ts src/test/biff8-scanner.test.ts
git commit -m "feat: implement BIFF8 record scanner with Continue stitching"
```

---

## Task 6: Build BIFF8 string decoder and RK number decoder

The two trickiest encoding details, tested in isolation.

**Files:**
- Modify: `src/parse-xls.ts`
- Create: `src/test/biff8-decoders.test.ts`

- [ ] **Step 1: Write failing tests for string decoding and RK numbers**

Create `src/test/biff8-decoders.test.ts`:

```ts
import { describe, it, expect } from 'vitest';
import { decode_rk, read_biff8_string } from '../parse-xls';

describe('decode_rk', () => {
    it('decodes IEEE 754 float (flags=0x00)', () => {
        // RK value with bits 0,1 clear: upper 30 bits of an IEEE 754 double
        // Encode 1.5: as double = 0x3FF8000000000000, upper 32 bits = 0x3FF80000
        // RK = upper 30 bits << 2 shifted back = 0x3FF80000 with low 2 bits = 00
        const rk = 0x3FF80000;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });

    it('decodes IEEE 754 float / 100 (flags=0x01)', () => {
        // bit 0 set: divide by 100
        // Encode 150.0 so that /100 = 1.5
        // 150.0 as double: 0x4062C00000000000, upper 32 = 0x4062C000
        // RK = 0x4062C000 | 0x01 = 0x4062C001
        const rk = 0x4062C001;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });

    it('decodes integer (flags=0x02)', () => {
        // bit 1 set: value is a signed 30-bit integer in bits 2-31
        // Encode 42: 42 << 2 | 0x02 = 170
        const rk = (42 << 2) | 0x02;
        expect(decode_rk(rk)).toBe(42);
    });

    it('decodes integer / 100 (flags=0x03)', () => {
        // bits 0 and 1 set: signed integer / 100
        // Encode 150 so that /100 = 1.5: 150 << 2 | 0x03 = 603
        const rk = (150 << 2) | 0x03;
        expect(decode_rk(rk)).toBeCloseTo(1.5);
    });
});

describe('read_biff8_string', () => {
    it('reads a compressed (Latin-1) string', () => {
        // String: "Hi"
        // Byte layout: [charCount_lo, charCount_hi, flags=0x00, 'H', 'i']
        // But read_biff8_string takes (buf, offset) where offset points past
        // the char count — the caller reads char count separately.
        // We test the helper: read_biff8_string(buf, offset, charCount)
        const buf = Buffer.from([0x00, 0x48, 0x69]); // flags=0 (compressed), then "Hi"
        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('Hi');
        expect(result.bytesRead).toBe(3); // 1 flag byte + 2 chars
    });

    it('reads a UTF-16LE string', () => {
        // String: "Hi"
        // flags=0x01 (uncompressed), then UTF-16LE "Hi"
        const buf = Buffer.from([0x01, 0x48, 0x00, 0x69, 0x00]);
        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('Hi');
        expect(result.bytesRead).toBe(5); // 1 flag byte + 2*2 chars
    });

    it('skips rich text run data', () => {
        // flags=0x08 means rich text runs present
        // After flags: 2-byte run count, then compressed chars, then run data
        // "AB" with 1 rich text run (4 bytes per run)
        const buf = Buffer.alloc(10);
        buf[0] = 0x08;           // flags: rich text
        buf.writeUInt16LE(1, 1); // 1 rich text run
        buf[3] = 0x41;           // 'A'
        buf[4] = 0x42;           // 'B'
        // 4 bytes of rich text run data (skipped)
        buf[5] = 0x00; buf[6] = 0x00; buf[7] = 0x02; buf[8] = 0x00;

        const result = read_biff8_string(buf, 0, 2);
        expect(result.value).toBe('AB');
        expect(result.bytesRead).toBe(9); // 1 flag + 2 run count + 2 chars + 4 run data
    });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- src/test/biff8-decoders.test.ts`
Expected: FAIL — `decode_rk` and `read_biff8_string` not exported.

- [ ] **Step 3: Implement decoders**

Add the following to `src/parse-xls.ts` after the `scan_records` function:

```ts
// --- Layer 2 Helpers: Decoders ---

const f64_buf = new Float64Array(1);
const u8_view = new Uint8Array(f64_buf.buffer);

export function decode_rk(rk: number): number {
    const is_integer = (rk & 0x02) !== 0;
    const div_100 = (rk & 0x01) !== 0;

    let value: number;
    if (is_integer) {
        value = rk >> 2; // signed 30-bit integer
    } else {
        // Upper 30 bits of an IEEE 754 double (lower 32 bits are zero)
        u8_view[0] = 0; u8_view[1] = 0; u8_view[2] = 0; u8_view[3] = 0;
        u8_view[4] = (rk & 0xFC); // zero out the 2 flag bits
        u8_view[5] = (rk >> 8) & 0xFF;
        u8_view[6] = (rk >> 16) & 0xFF;
        u8_view[7] = (rk >> 24) & 0xFF;
        value = f64_buf[0];
    }

    return div_100 ? value / 100 : value;
}

export interface StringReadResult {
    value: string;
    bytesRead: number;
}

export function read_biff8_string(buf: Buffer, offset: number, char_count: number): StringReadResult {
    let pos = offset;
    if (pos >= buf.length) {
        return { value: '', bytesRead: 0 };
    }
    const flags = buf[pos];
    pos += 1;

    const is_utf16 = (flags & 0x01) !== 0;
    const has_rich_text = (flags & 0x08) !== 0;
    const has_ext_string = (flags & 0x04) !== 0;

    let rich_text_runs = 0;
    let ext_string_size = 0;

    if (has_rich_text) {
        if (pos + 2 > buf.length) {
            return { value: '', bytesRead: Math.max(0, buf.length - offset) };
        }
        rich_text_runs = buf.readUInt16LE(pos);
        pos += 2;
    }
    if (has_ext_string) {
        if (pos + 4 > buf.length) {
            return { value: '', bytesRead: Math.max(0, buf.length - offset) };
        }
        ext_string_size = buf.readUInt32LE(pos);
        pos += 4;
    }

    let value: string;
    if (is_utf16) {
        const bytes_available = Math.max(0, buf.length - pos);
        const chars_available = Math.floor(bytes_available / 2);
        const chars_to_read = Math.min(char_count, chars_available);
        value = buf.toString('utf16le', pos, pos + chars_to_read * 2);
        pos += chars_to_read * 2;
    } else {
        // Compressed Latin-1: each byte is a code point
        value = '';
        const chars_to_read = Math.min(char_count, Math.max(0, buf.length - pos));
        for (let i = 0; i < chars_to_read; i++) {
            value += String.fromCharCode(buf[pos + i]);
        }
        pos += chars_to_read;
    }

    // Skip rich text run data (4 bytes per run)
    pos = Math.min(buf.length, pos + rich_text_runs * 4);
    // Skip extended string data
    pos = Math.min(buf.length, pos + ext_string_size);

    return { value, bytesRead: pos - offset };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- src/test/biff8-decoders.test.ts`
Expected: All 7 tests PASS.

- [ ] **Step 5: Commit**

```bash
git add src/parse-xls.ts src/test/biff8-decoders.test.ts
git commit -m "feat: implement BIFF8 RK number and string decoders"
```

---

## Task 7: Build the BIFF8 record interpreter (Layer 2) and parse_xls function

The main parser that walks records and builds `WorkbookData`.

**Files:**
- Modify: `src/parse-xls.ts`

- [ ] **Step 1: Install cfb**

Run:
```bash
npm install cfb
```

- [ ] **Step 2: Implement the full record interpreter and parse_xls**

Add the following to the end of `src/parse-xls.ts`:

```ts
// --- Record Type Constants ---

const RT_BOF = 0x0809;
const RT_EOF = 0x000A;
const RT_BOUNDSHEET8 = 0x0085;
const RT_SST = 0x00FC;
const RT_FONT = 0x0031;
const RT_XF = 0x00E0;
const RT_FORMAT = 0x041E;
const RT_DIMENSION = 0x0200;
const RT_LABELSST = 0x00FD;
const RT_NUMBER = 0x0203;
const RT_RK = 0x027E;
const RT_MULRK = 0x00BD;
const RT_BOOLERR = 0x0205;
const RT_BLANK = 0x0201;
const RT_MERGECELLS = 0x00E5;
const RT_LABEL = 0x0204;
const RT_FILEPASS = 0x002F;

const BIFF8_VERSION = 0x0600;

// --- Internal Types ---

interface SheetEntry {
    name: string;
    offset: number;
}

interface FontEntry {
    bold: boolean;
    italic: boolean;
}

interface XfEntry {
    font_index: number;
    format_index: number;
}

// --- Layer 2: Record Interpreter ---

function read_sst(records: BiffRecord[]): string[] {
    const strings: string[] = [];

    for (const rec of records) {
        if (rec.type !== RT_SST) continue;

        const buf = rec.data;
        // First 8 bytes: total string count (4 bytes), unique string count (4 bytes)
        const unique_count = buf.readUInt32LE(4);
        let pos = 8;

        for (let i = 0; i < unique_count && pos < buf.length; i++) {
            const char_count = buf.readUInt16LE(pos);
            pos += 2;
            const result = read_biff8_string(buf, pos, char_count);
            strings.push(result.value);
            pos += result.bytesRead;
        }
        break; // Only one SST record per workbook
    }

    return strings;
}

function read_fonts(records: BiffRecord[]): FontEntry[] {
    const fonts: FontEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_FONT) continue;
        const buf = rec.data;
        // Bytes 4-5: font weight (bold if >= 700)
        const weight = buf.readUInt16LE(4);
        // Byte 2: bit fields — no, italic is separate
        // Actually BIFF8 Font record: offset 2 = grbit (2 bytes)
        // Bit 1 of grbit = italic
        const grbit = buf.readUInt16LE(2);
        const italic = (grbit & 0x02) !== 0;
        const bold = weight >= 700;
        fonts.push({ bold, italic });
    }

    return fonts;
}

function read_xfs(records: BiffRecord[]): XfEntry[] {
    const xfs: XfEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_XF) continue;
        const buf = rec.data;
        const font_index = buf.readUInt16LE(0);
        const format_index = buf.readUInt16LE(2);
        xfs.push({ font_index, format_index });
    }

    return xfs;
}

function read_formats(records: BiffRecord[]): Map<number, string> {
    const formats = new Map<number, string>();

    for (const rec of records) {
        if (rec.type !== RT_FORMAT) continue;
        const buf = rec.data;
        const index = buf.readUInt16LE(0);
        const char_count = buf.readUInt16LE(2);
        const result = read_biff8_string(buf, 4, char_count);
        formats.set(index, result.value);
    }

    return formats;
}

function read_bound_sheets(records: BiffRecord[]): SheetEntry[] {
    const sheets: SheetEntry[] = [];

    for (const rec of records) {
        if (rec.type !== RT_BOUNDSHEET8) continue;
        const buf = rec.data;
        const offset = buf.readUInt32LE(0);
        // Byte 4: sheet state (0=visible), Byte 5: sheet type (0=worksheet)
        const char_count = buf[6];
        const result = read_biff8_string(buf, 7, char_count);
        sheets.push({ name: result.value, offset });
    }

    return sheets;
}

function format_value(raw: number, xf_index: number, xfs: XfEntry[], format_map: Map<number, string>): string {
    if (xf_index >= xfs.length) return String(raw);
    const xf = xfs[xf_index];
    const fmt = format_map.get(xf.format_index);
    if (!fmt) return String(raw);
    try {
        return SSF.format(fmt, raw);
    } catch {
        return String(raw);
    }
}

function get_style(xf_index: number, xfs: XfEntry[], fonts: FontEntry[]): { bold: boolean; italic: boolean } {
    if (xf_index >= xfs.length) return { bold: false, italic: false };
    const xf = xfs[xf_index];
    // Font index 4 is skipped in BIFF8 (reserved), so index >= 4 means actual index is font_index
    // but the font array doesn't have a gap — Excel skips font index 4 in the file,
    // so we just look up directly.
    const font_idx = xf.font_index;
    if (font_idx >= fonts.length) return { bold: false, italic: false };
    return fonts[font_idx];
}

function parse_sheet_records(
    records: BiffRecord[],
    sst: string[],
    xfs: XfEntry[],
    fonts: FontEntry[],
    format_map: Map<number, string>,
    warnings: string[],
): SheetData {
    let row_count = 0;
    let col_count = 0;
    const cells = new Map<string, CellData>();
    const merges: MergeRange[] = [];

    for (const rec of records) {
        switch (rec.type) {
            case RT_DIMENSION: {
                const buf = rec.data;
                // BIFF8 Dimension: first_row (4), last_row+1 (4), first_col (2), last_col+1 (2)
                row_count = buf.readUInt32LE(4);
                col_count = buf.readUInt16LE(10);
                break;
            }

            case RT_LABELSST: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const sst_index = buf.readUInt32LE(6);
                const value = sst_index < sst.length ? sst[sst_index] : '';
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: value,
                    formatted: value,
                    bold: style.bold,
                    italic: style.italic,
                });
                break;
            }

            case RT_NUMBER: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const value = buf.readDoubleLE(6);
                const style = get_style(xf_index, xfs, fonts);
                const formatted = format_value(value, xf_index, xfs, format_map);
                cells.set(`${row}:${col}`, {
                    raw: value,
                    formatted,
                    bold: style.bold,
                    italic: style.italic,
                });
                break;
            }

            case RT_RK: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const value = decode_rk(buf.readInt32LE(6));
                const style = get_style(xf_index, xfs, fonts);
                const formatted = format_value(value, xf_index, xfs, format_map);
                cells.set(`${row}:${col}`, {
                    raw: value,
                    formatted,
                    bold: style.bold,
                    italic: style.italic,
                });
                break;
            }

            case RT_MULRK: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const first_col = buf.readUInt16LE(2);
                // Last 2 bytes = last column
                const last_col = buf.readUInt16LE(buf.length - 2);
                let pos = 4;
                for (let c = first_col; c <= last_col; c++) {
                    const xf_index = buf.readUInt16LE(pos);
                    const rk_val = buf.readInt32LE(pos + 2);
                    const value = decode_rk(rk_val);
                    const style = get_style(xf_index, xfs, fonts);
                    const formatted = format_value(value, xf_index, xfs, format_map);
                    cells.set(`${row}:${c}`, {
                        raw: value,
                        formatted,
                        bold: style.bold,
                        italic: style.italic,
                    });
                    pos += 6; // 2 bytes XF + 4 bytes RK
                }
                break;
            }

            case RT_BOOLERR: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const val = buf[6];
                const is_error = buf[7] === 1;
                const style = get_style(xf_index, xfs, fonts);
                if (is_error) {
                    const error_codes: Record<number, string> = {
                        0x00: '#NULL!', 0x07: '#DIV/0!', 0x0F: '#VALUE!',
                        0x17: '#REF!', 0x1D: '#NAME?', 0x24: '#NUM!', 0x2A: '#N/A',
                    };
                    const formatted = error_codes[val] ?? `#ERR(${val})`;
                    cells.set(`${row}:${col}`, { raw: formatted, formatted, bold: style.bold, italic: style.italic });
                } else {
                    cells.set(`${row}:${col}`, {
                        raw: val === 1,
                        formatted: val === 1 ? 'TRUE' : 'FALSE',
                        bold: style.bold,
                        italic: style.italic,
                    });
                }
                break;
            }

            case RT_BLANK: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: null,
                    formatted: '',
                    bold: style.bold,
                    italic: style.italic,
                });
                break;
            }

            case RT_LABEL: {
                const buf = rec.data;
                const row = buf.readUInt16LE(0);
                const col = buf.readUInt16LE(2);
                const xf_index = buf.readUInt16LE(4);
                const char_count = buf.readUInt16LE(6);
                const result = read_biff8_string(buf, 8, char_count);
                const style = get_style(xf_index, xfs, fonts);
                cells.set(`${row}:${col}`, {
                    raw: result.value,
                    formatted: result.value,
                    bold: style.bold,
                    italic: style.italic,
                });
                break;
            }

            case RT_MERGECELLS: {
                const buf = rec.data;
                const count = buf.readUInt16LE(0);
                let pos = 2;
                for (let i = 0; i < count; i++) {
                    const startRow = buf.readUInt16LE(pos);
                    const endRow = buf.readUInt16LE(pos + 2);
                    const startCol = buf.readUInt16LE(pos + 4);
                    const endCol = buf.readUInt16LE(pos + 6);
                    merges.push({ startRow, startCol, endRow, endCol });
                    pos += 8;
                }
                break;
            }
        }
    }

    // Build the merged_cells set
    const merged_cells = new Set<string>();
    for (const m of merges) {
        for (let r = m.startRow; r <= m.endRow; r++) {
            for (let c = m.startCol; c <= m.endCol; c++) {
                if (r === m.startRow && c === m.startCol) continue;
                merged_cells.add(`${r}:${c}`);
            }
        }
    }

    // Build rows array
    const rows: (CellData | null)[][] = [];
    for (let r = 0; r < row_count; r++) {
        const row_data: (CellData | null)[] = [];
        for (let c = 0; c < col_count; c++) {
            if (merged_cells.has(`${r}:${c}`)) {
                row_data.push(null);
            } else {
                row_data.push(cells.get(`${r}:${c}`) ?? { raw: null, formatted: '', bold: false, italic: false });
            }
        }
        rows.push(row_data);
    }

    return {
        name: '', // Set by caller
        rows,
        merges,
        columnCount: col_count,
        rowCount: row_count,
    };
}

// --- Public API ---

export function parse_xls(buffer: Buffer): ParseResult {
    const warnings: string[] = [];

    let cfb_file: CFB.CFBContainer;
    try {
        cfb_file = CFB.read(buffer, { type: 'buffer' });
    } catch {
        throw new Error('Not a valid .xls file');
    }

    const workbook_entry = CFB.find(cfb_file, '/Workbook') ?? CFB.find(cfb_file, '/Book');
    if (!workbook_entry?.content) {
        throw new Error('No workbook data found in .xls file');
    }

    const wb_buf = Buffer.from(workbook_entry.content);
    const records = scan_records(wb_buf);

    if (records.length === 0) {
        throw new Error('No workbook data found in .xls file');
    }

    // Check BIFF version from first BOF
    const first_bof = records.find(r => r.type === RT_BOF);
    if (first_bof) {
        const version = first_bof.data.readUInt16LE(0);
        if (version !== BIFF8_VERSION) {
            const ver_names: Record<number, string> = {
                0x0200: 'BIFF2', 0x0300: 'BIFF3', 0x0400: 'BIFF4', 0x0500: 'BIFF5',
            };
            const name = ver_names[version] ?? `0x${version.toString(16)}`;
            throw new Error(`Unsupported Excel format: ${name}. Only BIFF8 (.xls from Excel 97+) is supported.`);
        }
    }

    // Check for password protection
    if (records.some(r => r.type === RT_FILEPASS)) {
        throw new Error('Password-protected .xls files are not supported');
    }

    // Read global tables
    const sst = read_sst(records);
    const fonts = read_fonts(records);
    const xfs = read_xfs(records);
    const format_map = read_formats(records);
    const sheet_entries = read_bound_sheets(records);

    // Parse each sheet substream
    const sheets: SheetData[] = [];
    for (const entry of sheet_entries) {
        // Find the sheet's records: scan from the entry's offset
        const sheet_start_pos = entry.offset;

        // Find the index of the BOF record at or near this offset
        let start_idx = records.findIndex(r => r.offset >= sheet_start_pos && r.type === RT_BOF);
        if (start_idx === -1) {
            warnings.push(`Could not find sheet data for "${entry.name}"`);
            sheets.push({
                name: entry.name,
                rows: [],
                merges: [],
                columnCount: 0,
                rowCount: 0,
            });
            continue;
        }

        // Collect records from after the BOF to the matching EOF
        start_idx += 1; // skip the BOF
        let end_idx = records.findIndex((r, i) => i >= start_idx && r.type === RT_EOF);
        if (end_idx === -1) {
            end_idx = records.length;
            warnings.push(`Some data in this file could not be read. The file may be damaged.`);
        }

        const sheet_records = records.slice(start_idx, end_idx);
        const sheet_data = parse_sheet_records(sheet_records, sst, xfs, fonts, format_map, warnings);
        sheet_data.name = entry.name;
        sheets.push(sheet_data);
    }

    return { data: { sheets }, warnings };
}
```

- [ ] **Step 3: Run the parity tests from Task 3**

Run: `npm test -- src/test/parse-xls.test.ts`
Expected: Tests should pass. The return type changed to `{ data, warnings }`, and the tests already handle both shapes via `'data' in result ? result.data : result`.

If any tests fail, debug by comparing the old parser output with the new parser output on the same fixture. Adjust the parser to match.

- [ ] **Step 4: Run all tests**

Run: `npm test`
Expected: All tests PASS (scanner, decoder, and parity tests).

- [ ] **Step 5: Commit**

```bash
git add src/parse-xls.ts package.json package-lock.json
git commit -m "feat: implement BIFF8 record interpreter and parse_xls function"
```

---

## Task 8: Update custom-editor.ts for new return type and error handling

**Files:**
- Modify: `src/custom-editor.ts`

- [ ] **Step 1: Update parse_file to handle new return type**

In `src/custom-editor.ts`, replace the `parse_file` method:

```ts
    private async parse_file(): Promise<WorkbookData> {
        const raw = await vscode.workspace.fs.readFile(this.uri);
        const ext = this.file_path.toLowerCase();
        if (ext.endsWith('.xlsx')) {
            return parse_xlsx(raw);
        }
        return parse_xls(Buffer.from(raw));
    }
```

with:

```ts
    private async parse_file(): Promise<{ data: WorkbookData; warnings: string[] }> {
        const raw = await vscode.workspace.fs.readFile(this.uri);
        const ext = this.file_path.toLowerCase();
        if (ext.endsWith('.xlsx')) {
            return parse_xlsx(raw);
        }
        return parse_xls(Buffer.from(raw));
    }
```

- [ ] **Step 2: Update send_initial_data to surface warnings**

In `src/custom-editor.ts`, replace the `send_initial_data` method:

```ts
    private async send_initial_data(): Promise<void> {
        try {
            const data = await this.parse_file();
            const state = this.state_store.get(this.file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation',
                'horizontal'
            );

            this.panel.webview.postMessage({
                type: 'workbookData',
                data,
                state,
                defaultTabOrientation: default_orientation,
            });
        } catch (err) {
            vscode.window.showErrorMessage(
                `Failed to open file: ${err}`
            );
        }
    }
```

with:

```ts
    private async send_initial_data(): Promise<void> {
        try {
            const { data, warnings } = await this.parse_file();
            const state = this.state_store.get(this.file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation',
                'horizontal'
            );

            this.panel.webview.postMessage({
                type: 'workbookData',
                data,
                state,
                defaultTabOrientation: default_orientation,
            });

            if (warnings.length > 0) {
                vscode.window.showWarningMessage(warnings[0]);
            }
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }
```

- [ ] **Step 3: Update send_reload similarly**

In `src/custom-editor.ts`, replace the `send_reload` method:

```ts
    private async send_reload(): Promise<void> {
        try {
            const data = await this.parse_file();
            this.panel.webview.postMessage({
                type: 'reload',
                data,
            });
        } catch {
            // File may be mid-write; ignore transient errors
        }
    }
```

with:

```ts
    private async send_reload(): Promise<void> {
        try {
            const { data, warnings } = await this.parse_file();
            this.panel.webview.postMessage({
                type: 'reload',
                data,
            });
            if (warnings.length > 0) {
                vscode.window.showWarningMessage(warnings[0]);
            }
        } catch {
            // File may be mid-write; ignore transient errors
        }
    }
```

- [ ] **Step 4: Verify the full bundle compiles**

Run:
```bash
npm run bundle && npm run bundle:webview
```
Expected: Both builds succeed with no errors.

- [ ] **Step 5: Commit**

```bash
git add src/custom-editor.ts
git commit -m "feat: surface parser warnings and specific error messages"
```

---

## Task 9: Remove xlsx dependency and final verification

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Remove xlsx**

Run:
```bash
npm uninstall xlsx
```

- [ ] **Step 2: Verify no remaining imports of xlsx**

Run:
```bash
grep -r "from 'xlsx'" src/ || echo "No xlsx imports found"
grep -r "require('xlsx')" src/ || echo "No xlsx requires found"
```
Expected: "No xlsx imports found" / "No xlsx requires found"

- [ ] **Step 3: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 4: Verify bundles compile**

Run:
```bash
npm run bundle && npm run bundle:webview
```
Expected: Both builds succeed.

- [ ] **Step 5: Verify no high severity vulnerabilities remain**

Run:
```bash
npm audit
```
Expected: No high severity vulnerabilities. The `xlsx` advisory should be gone.

- [ ] **Step 6: Commit**

```bash
git add package.json package-lock.json
git commit -m "fix: remove vulnerable xlsx dependency (GHSA-4r6h-8v6p-xvw6, GHSA-5pgg-2g8v-p4x9)"
```

---

## Task 10: Add edge case tests

**Files:**
- Modify: `src/test/parse-xls.test.ts`

- [ ] **Step 1: Add error handling tests**

Append to `src/test/parse-xls.test.ts`:

```ts
describe('parse_xls error handling', () => {
    it('throws for invalid buffer', () => {
        expect(() => parse_xls(Buffer.from('not an xls file'))).toThrow(
            'Not a valid .xls file'
        );
    });

    it('throws for empty buffer', () => {
        expect(() => parse_xls(Buffer.alloc(0))).toThrow();
    });
});

describe('parse_xls warnings', () => {
    it('returns empty warnings for valid files', () => {
        const result = parse_xls(read_fixture('basic.xls'));
        const warnings = 'warnings' in result ? result.warnings : [];
        expect(warnings).toHaveLength(0);
    });
});
```

- [ ] **Step 2: Run all tests**

Run: `npm test`
Expected: All tests PASS.

- [ ] **Step 3: Commit**

```bash
git add src/test/parse-xls.test.ts
git commit -m "test: add error handling edge case tests"
```

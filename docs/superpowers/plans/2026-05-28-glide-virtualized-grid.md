# Glide Virtualized Grid Rebuild — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace table-viewer's full-DOM `<table>` renderer with a canvas-based virtualized grid (`@glideapps/glide-data-grid` v6), served by a demand-paged columnar data layer, so the extension stays fast at up to ~1M rows for CSV/TSV/XLSX/XLS while preserving every existing feature.

**Architecture:** Clean rebuild ("Approach B"). A host-side `DataSource` abstraction serves arbitrary row windows for each format (CSV via a byte-offset line index + on-demand slice parse; XLSX/XLS via a parse-once columnar store). A paginated `postMessage` protocol (`sheetMeta` + `requestRows`/`rowData`, with a generation guard) replaces the single-blob `workbookData` message. The webview wraps Glide's `DataEditor`, with custom canvas drawing for **exact** merged-cell rendering (per-segment gridlines, span-aware selection, keyboard nav over merges), variable row heights + a row-resize overlay, per-cell bold/italic, and an overlay editor for CSV editing.

**Tech Stack:** TypeScript, React 18, esbuild (IIFE webview bundle + CJS extension bundle), `@glideapps/glide-data-grid` v6.0.3, PapaParse (CSV), custom CFB+XML (XLSX) / BIFF8 (XLS) parsers, Vitest + jsdom.

---

## Scope Check (read first)

This rebuild covers **five independent subsystems**. Per the writing-plans scope-check, each is its own plan that produces working, testable software:

| # | Subsystem | Produces | Status in this doc |
|---|-----------|----------|--------------------|
| **A** | Host data-source + columnar store | Tested `DataSource` impls for all 4 formats, no UI change | **Fully detailed below (Phase A)** |
| **B** | Paginated protocol + panel-core | Host serves row windows over the new protocol; old renderer still consumes a compatibility shim | Scoped (Phase B) |
| **C** | Webview Glide foundation | Glide renders rows, columns, scrolling, theme; basic cells only | Scoped (Phase C) |
| **D** | Exact merged cells + variable row heights + resize | Pixel-exact merges, row resize, rich text | Scoped (Phase D) |
| **E** | Editing + selection + copy + parity + cleanup | Full feature parity; old renderer deleted | Scoped (Phase E) |

**Execution rule:** Detail and execute **Phase A** first (below, at full TDD granularity). Phases B–E are scoped with file structure, interfaces, key code, and acceptance criteria; expand each into bite-sized TDD steps **at the start of that phase**, once the upstream types exist. Do not delete `src/webview/table.tsx` or any existing parser until Phase E's parity gate passes.

---

## Project-wide File Structure (target)

```
src/
  types.ts                      MODIFY: add paginated protocol + shared render types
  spreadsheet-safety.ts         MODIFY: per-format caps, raise to 1M rows
  cell-display.ts               KEEP
  spreadsheet-format.ts         KEEP
  serialize-csv.ts              KEEP (save path)
  state.ts                      KEEP

  data-source/                  NEW (Phase A)
    interface.ts                DataSource, RenderedCell, RowWindow, SheetMeta, WorkbookMeta
    columnar-store.ts           ColumnarStore (string pool + typed arrays) for XLSX/XLS
    csv-source.ts               CsvDataSource (line index + windowed parse)
    xlsx-source.ts              XlsxDataSource (parse-once -> ColumnarStore)
    xls-source.ts               XlsDataSource  (parse-once -> ColumnarStore)
    line-index.ts               build_line_index() byte-offset index w/ quote tracking

  panel-core.ts                 NEW (Phase B): generation, LRU page cache, requestRows handler
  custom-editor.ts              MODIFY (Phase B): thin shell over panel-core + XlsxDataSource/XlsDataSource
  csv-panel.ts                  MODIFY (Phase B): thin shell over panel-core + CsvDataSource
  csv-preview.ts                KEEP (preview pane, small)
  webview-html.ts               MODIFY (Phase C): CSP for Glide
  extension.ts                  KEEP

  webview/
    index.tsx                   KEEP
    app.tsx                     MODIFY (Phase C/E): sheetMeta handler, mount grid-shell
    grid-shell.tsx              NEW (Phase C): DataEditor wrapper
    use-row-loader.ts           NEW (Phase C): paged, sheet-aware, generation guard
    grid-model.ts               NEW (Phase C): PAGE_SIZE, column build, width estimate
    vscode-theme.ts             NEW (Phase C): build Glide Theme from --vscode-* vars
    merge-index.ts              NEW (Phase D): anchors/covered/get_anchor + span geometry
    cell-renderer.ts            NEW (Phase D): getCellContent + drawCell (merges, rich text)
    row-heights.ts              NEW (Phase D): sparse height map + rowHeight fn + span sums
    row-resize-overlay.tsx      NEW (Phase D): drag-resize handles over the canvas
    csv-cell-editor.tsx         NEW (Phase E): overlay editor for provideEditor
    use-editing.ts              MODIFY (Phase E): inject get_cell_raw instead of rows[][]
    use-selection.ts            MODIFY (Phase E): drive Glide GridSelection
    selection.ts                KEEP (pure range/merge math reused)
    sheet-tabs.tsx              KEEP
    toolbar.tsx                 KEEP
    context-menu.tsx            KEEP
    sheet-state.ts              KEEP
    use-state-sync.ts           KEEP
    styles.css                  MODIFY (Phase C/D)
    # DELETED in Phase E: table.tsx, cell-editor.tsx, boundary-groups.ts,
    #   measure-column.ts, auto-resize-row.ts
```

---

## Key cross-phase contracts

These types are introduced in Phase A and consumed everywhere. They are the spine of the rebuild.

```typescript
// src/data-source/interface.ts

/** Webview-facing cell. Identical shape to the old CellData so the renderer
 *  is format-agnostic. `raw` is the raw value rendered to string (numbers/bools
 *  become their string form — acceptable: copy + edit-base both String() it). */
export interface RenderedCell {
    raw: string | null;       // null = empty cell
    formatted: string;        // display text (== raw for CSV)
    bold: boolean;
    italic: boolean;
}

export interface RowWindow {
    startRow: number;                 // 0-based, absolute
    rows: (RenderedCell | null)[][];  // rows[i][col]; outer length <= requested count
}

export interface SheetMeta {
    name: string;
    rowCount: number;
    columnCount: number;
    merges: MergeRange[];             // from types.ts (rowSpan + colSpan)
    hasFormatting: boolean;
}

export interface WorkbookMeta {
    sheets: SheetMeta[];
    hasFormatting: boolean;
}

export interface DataSource {
    /** Workbook structure only — no cell data. Cheap; safe to call repeatedly. */
    meta(): WorkbookMeta;
    /** Materialize a window of rows for one sheet. count may overshoot rowCount. */
    read_rows(sheet_index: number, start_row: number, count: number): RowWindow;
    /** Full row-major view of a sheet (for CSV serialize-on-save). Throws for xlsx/xls. */
    read_all_rows(sheet_index: number): (RenderedCell | null)[][];
    /** Release buffers/handles. */
    close(): void;
}
```

---

# PHASE A — Host data-source + columnar store

**Outcome:** Four tested `DataSource` implementations that serve correct row windows for CSV, TSV, XLSX, XLS, plus a `ColumnarStore` that holds ≥1M xlsx rows without object-per-cell blowup. No webview or protocol changes yet. All existing tests stay green.

**Why first:** Everything downstream depends on these types and the windowing semantics. It is pure, unit-testable, and carries zero UI risk.

### Task A1: Shared data-source types

**Files:**
- Create: `src/data-source/interface.ts`
- Test: `src/test/data-source-interface.test.ts`

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/data-source-interface.test.ts
import { describe, it, expect } from 'vitest';
import type { RenderedCell, RowWindow, SheetMeta, WorkbookMeta, DataSource } from '../data-source/interface';

describe('data-source interface shapes', () => {
    it('RenderedCell allows null raw and string formatted', () => {
        const cell: RenderedCell = { raw: null, formatted: '', bold: false, italic: false };
        expect(cell.formatted).toBe('');
    });
    it('RowWindow carries absolute startRow', () => {
        const w: RowWindow = { startRow: 200, rows: [[{ raw: 'a', formatted: 'a', bold: false, italic: false }]] };
        expect(w.startRow).toBe(200);
        expect(w.rows[0][0]?.raw).toBe('a');
    });
    it('WorkbookMeta nests SheetMeta with merges', () => {
        const meta: WorkbookMeta = {
            hasFormatting: false,
            sheets: [{ name: 'Sheet1', rowCount: 3, columnCount: 2, merges: [], hasFormatting: false }],
        };
        const s: SheetMeta = meta.sheets[0];
        expect(s.rowCount).toBe(3);
    });
    it('DataSource is structurally implementable', () => {
        const ds: DataSource = {
            meta: () => ({ hasFormatting: false, sheets: [] }),
            read_rows: () => ({ startRow: 0, rows: [] }),
            read_all_rows: () => [],
            close: () => {},
        };
        expect(ds.meta().sheets).toEqual([]);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/data-source-interface.test.ts`
Expected: FAIL — `Cannot find module '../data-source/interface'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/data-source/interface.ts` with the exact contents from the "Key cross-phase contracts" section above. Import `MergeRange` from `../types`:

```typescript
import type { MergeRange } from '../types';
// ...the four interfaces from the contracts section...
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/data-source-interface.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data-source/interface.ts src/test/data-source-interface.test.ts
git commit -m "feat(data-source): add DataSource interface and shared render types"
```

---

### Task A2: Byte-offset line index for CSV random access

**Files:**
- Create: `src/data-source/line-index.ts`
- Test: `src/test/line-index.test.ts`

The index maps each logical CSV row to its starting byte offset in the UTF-8 source, tracking quote state so multiline quoted fields count as one row. This is the random-access primitive that lets `CsvDataSource` parse only a window instead of the whole file. It generalizes the quote logic already proven in `src/parse-csv.ts:153-172` (`reconstruct_row_text`).

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/line-index.test.ts
import { describe, it, expect } from 'vitest';
import { build_line_index } from '../data-source/line-index';

const enc = (s: string) => new TextEncoder().encode(s);

describe('build_line_index', () => {
    it('indexes simple LF rows', () => {
        const idx = build_line_index(enc('a,b\nc,d\ne,f\n'));
        expect(idx.rowCount).toBe(3);
        expect(idx.offsetOf(0)).toBe(0);
        expect(idx.offsetOf(1)).toBe(4);
        expect(idx.offsetOf(2)).toBe(8);
    });
    it('handles CRLF', () => {
        const idx = build_line_index(enc('a\r\nb\r\n'));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe(3);
    });
    it('treats a quoted multiline field as one row', () => {
        // row 0 = `"x\ny",z` spans two physical lines; row 1 = `p,q`
        const src = '"x\ny",z\np,q\n';
        const idx = build_line_index(enc(src));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe('"x\ny",z\n'.length);
    });
    it('handles no trailing newline', () => {
        const idx = build_line_index(enc('a\nb'));
        expect(idx.rowCount).toBe(2);
        expect(idx.offsetOf(1)).toBe(2);
    });
    it('endOffset of last row is buffer length', () => {
        const buf = enc('a\nb\n');
        const idx = build_line_index(buf);
        expect(idx.endOffsetOf(idx.rowCount - 1)).toBe(buf.length);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/line-index.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/data-source/line-index.ts

const QUOTE = 0x22;  // "
const LF = 0x0a;     // \n
const CR = 0x0d;     // \r

export interface LineIndex {
    rowCount: number;
    /** Byte offset where row r begins. */
    offsetOf(r: number): number;
    /** Byte offset where row r ends (start of next row, or buffer end). */
    endOffsetOf(r: number): number;
}

/**
 * Single O(n) pass over UTF-8 bytes. A row boundary is an unquoted CR, LF, or
 * CRLF. Quote parity is tracked so newlines inside "..." do not split a row.
 * Returns byte offsets, so a caller can slice + parse any contiguous row range.
 */
export function build_line_index(buf: Uint8Array): LineIndex {
    const offsets: number[] = [];
    if (buf.length > 0) offsets.push(0);

    let in_quotes = false;
    for (let i = 0; i < buf.length; i++) {
        const b = buf[i];
        if (b === QUOTE) {
            in_quotes = !in_quotes;
            continue;
        }
        if (in_quotes) continue;
        if (b === LF || b === CR) {
            let next = i + 1;
            if (b === CR && next < buf.length && buf[next] === LF) next++;
            // A boundary at end-of-buffer does not start a new (empty) row.
            if (next < buf.length) offsets.push(next);
            i = next - 1;
        }
    }

    // Use a typed array for memory; 1M rows -> 4 MB.
    const arr = Int32Array.from(offsets);
    return {
        rowCount: arr.length,
        offsetOf: (r) => arr[r],
        endOffsetOf: (r) => (r + 1 < arr.length ? arr[r + 1] : buf.length),
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/line-index.test.ts`
Expected: PASS (5 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data-source/line-index.ts src/test/line-index.test.ts
git commit -m "feat(data-source): byte-offset CSV line index with quote tracking"
```

---

### Task A3: CsvDataSource (windowed parse)

**Files:**
- Create: `src/data-source/csv-source.ts`
- Test: `src/test/csv-source.test.ts`

Holds the decoded source string + line index; `read_rows` slices the source for the requested row range and runs PapaParse on just that fragment. `read_all_rows` parses the whole file (used only by the save path). `columnCount` is determined by a one-time scan that PapaParses the full source once at construction (acceptable: this is O(n) but allocates only counts, not CellData). For very large files this full parse is the construction cost; document it.

> **Design note:** To get an accurate `columnCount` and `rowCount` without a second full parse, construction does ONE `Papa.parse` pass capturing only `row.length` per row (not building cells), reusing the trailing-empty-row logic from `parse_csv` (`src/parse-csv.ts:28-50`). Window parses thereafter touch only ~`count` rows.

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/csv-source.test.ts
import { describe, it, expect } from 'vitest';
import { CsvDataSource } from '../data-source/csv-source';

const enc = (s: string) => new TextEncoder().encode(s);

describe('CsvDataSource', () => {
    it('reports rowCount and columnCount in meta', () => {
        const ds = new CsvDataSource(enc('a,b,c\n1,2,3\n4,5,6\n'), ',', 10000);
        const m = ds.meta();
        expect(m.sheets[0].rowCount).toBe(3);
        expect(m.sheets[0].columnCount).toBe(3);
        expect(m.sheets[0].merges).toEqual([]);
    });
    it('read_rows returns an absolute-addressed window', () => {
        const ds = new CsvDataSource(enc('a,b\n1,2\n3,4\n5,6\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 2);
        expect(w.startRow).toBe(1);
        expect(w.rows[0][0]?.raw).toBe('1');
        expect(w.rows[1][1]?.raw).toBe('4');
    });
    it('pads short rows to columnCount with null', () => {
        const ds = new CsvDataSource(enc('a,b,c\n1\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0].length).toBe(3);
        expect(w.rows[0][1]).toBeNull();
        expect(w.rows[0][2]).toBeNull();
    });
    it('empty fields become null cells', () => {
        const ds = new CsvDataSource(enc('a,,c\n'), ',', 10000);
        const w = ds.read_rows(0, 0, 1);
        expect(w.rows[0][1]).toBeNull();
        expect(w.rows[0][0]?.raw).toBe('a');
    });
    it('handles a window crossing a quoted multiline field', () => {
        const ds = new CsvDataSource(enc('h1,h2\n"x\ny",z\np,q\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0][0]?.raw).toBe('x\ny');
        expect(w.rows[0][1]?.raw).toBe('z');
    });
    it('respects max_rows truncation in meta', () => {
        const ds = new CsvDataSource(enc('1\n2\n3\n4\n'), ',', 2);
        expect(ds.meta().sheets[0].rowCount).toBe(2);
        expect(ds.truncationMessage).toMatch(/2 of 4/);
    });
    it('read_all_rows returns the full sheet', () => {
        const ds = new CsvDataSource(enc('a\nb\nc\n'), ',', 10000);
        expect(ds.read_all_rows(0).length).toBe(3);
    });
    it('supports TSV delimiter', () => {
        const ds = new CsvDataSource(enc('a\tb\n1\t2\n'), '\t', 10000);
        expect(ds.read_rows(0, 1, 1).rows[0][1]?.raw).toBe('2');
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/csv-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/data-source/csv-source.ts
import Papa from 'papaparse';
import type { DataSource, RenderedCell, RowWindow, WorkbookMeta } from './interface';
import { build_line_index, type LineIndex } from './line-index';

export class CsvDataSource implements DataSource {
    readonly truncationMessage?: string;
    private readonly source: string;
    private readonly index: LineIndex;
    private readonly _rowCount: number;
    private readonly _colCount: number;

    constructor(
        private readonly buf: Uint8Array,
        private readonly delimiter: ',' | '\t',
        max_rows: number,
    ) {
        this.source = new TextDecoder('utf-8').decode(buf);
        this.index = build_line_index(buf);

        // One full pass for shape only (row lengths), reusing parse-csv's
        // trailing-empty-row rule.
        const parsed = Papa.parse(this.source, { delimiter, header: false, skipEmptyLines: false });
        let lengths = (parsed.data as string[][]).map((r) => r.length);
        const ends_nl = this.source.length > 0 &&
            (this.source.endsWith('\n') || this.source.endsWith('\r'));
        const last = (parsed.data as string[][])[lengths.length - 1];
        if (ends_nl && last && last.length === 1 && last[0] === '') {
            lengths = lengths.slice(0, -1);
        }

        const total = lengths.length;
        let kept = total;
        if (total > max_rows) {
            kept = max_rows;
            this.truncationMessage =
                `Showing ${max_rows.toLocaleString()} of ${total.toLocaleString()} rows`;
        }
        this._rowCount = kept;
        this._colCount = lengths.slice(0, kept).reduce((m, n) => Math.max(m, n), 0);
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this._rowCount,
                columnCount: this._colCount,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet: number, start_row: number, count: number): RowWindow {
        const start = Math.max(0, Math.min(start_row, this._rowCount));
        const end = Math.min(start + count, this._rowCount);
        if (start >= end) return { startRow: start, rows: [] };

        const byteStart = this.index.offsetOf(start);
        const byteEnd = this.index.endOffsetOf(end - 1);
        const fragment = this.source.slice(byteStart, byteEnd);
        const parsed = Papa.parse(fragment, {
            delimiter: this.delimiter, header: false, skipEmptyLines: false,
        }).data as string[][];

        const rows: (RenderedCell | null)[][] = [];
        for (let i = 0; i < end - start; i++) {
            rows.push(this.to_cells(parsed[i] ?? []));
        }
        return { startRow: start, rows };
    }

    read_all_rows(_sheet: number): (RenderedCell | null)[][] {
        return this.read_rows(0, 0, this._rowCount).rows;
    }

    close(): void { /* nothing to release */ }

    private to_cells(row: string[]): (RenderedCell | null)[] {
        const cells: (RenderedCell | null)[] = [];
        for (let c = 0; c < this._colCount; c++) {
            const v = c < row.length ? row[c] : '';
            cells.push(v === '' ? null : { raw: v, formatted: v, bold: false, italic: false });
        }
        return cells;
    }
}
```

> **Byte-vs-char caveat to verify in Step 4:** `index` offsets are UTF-8 byte offsets, but `source.slice` uses UTF-16 char indices. For ASCII they coincide; for multibyte content they diverge. The test `handles a window crossing a quoted multiline field` uses ASCII and will pass, but **before closing this task add a test with a multibyte char** (e.g. `café`) in an early row and a window after it. If it fails, change `read_rows` to slice the `Uint8Array` (`this.buf.subarray(byteStart, byteEnd)`) and `TextDecoder().decode` the fragment instead of slicing the string. Prefer the byte-slice version — it is correct for all encodings.

- [ ] **Step 4: Add the multibyte test, then run all csv-source tests**

```typescript
    it('correctly windows after multibyte characters', () => {
        const ds = new CsvDataSource(enc('café,x\n1,2\n3,4\n'), ',', 10000);
        const w = ds.read_rows(0, 1, 1);
        expect(w.rows[0][0]?.raw).toBe('1');
    });
```

Run: `npx vitest run src/test/csv-source.test.ts`
Expected: PASS. If the multibyte test fails, switch to the byte-slice variant described above, then re-run to PASS.

- [ ] **Step 5: Commit**

```bash
git add src/data-source/csv-source.ts src/test/csv-source.test.ts
git commit -m "feat(data-source): CsvDataSource with windowed slice parsing"
```

---

### Task A4: ColumnarStore (string pool + typed arrays)

**Files:**
- Create: `src/data-source/columnar-store.ts`
- Test: `src/test/columnar-store.test.ts`

Backs XLSX/XLS, which cannot be seeked from disk and so are parsed once into a compact in-memory form. Per-cell layout: a deduplicated `string[]` pool + `Int32Array` raw-index and formatted-index grids + a `Uint8Array` flags grid (bit0 bold, bit1 italic). `-1` index = null cell. At 1M×50: raw idx 200 MB + fmt idx 200 MB (or aliased when equal) + flags 50 MB; pool size depends on duplication (xlsx repeats heavily).

- [ ] **Step 1: Write the failing test**

```typescript
// src/test/columnar-store.test.ts
import { describe, it, expect } from 'vitest';
import { ColumnarStore } from '../data-source/columnar-store';

describe('ColumnarStore', () => {
    it('builds via builder and reads a window', () => {
        const b = new ColumnarStore.Builder(2, 2);  // rows, cols
        b.set(0, 0, { raw: 'a', formatted: 'A', bold: true, italic: false });
        b.set(0, 1, { raw: '1', formatted: '1', bold: false, italic: false });
        b.set(1, 0, null);
        b.set(1, 1, { raw: 'b', formatted: 'b', bold: false, italic: true });
        const store = b.build();

        const w = store.read_window(0, 2);
        expect(w[0][0]).toEqual({ raw: 'a', formatted: 'A', bold: true, italic: false });
        expect(w[0][1]?.raw).toBe('1');
        expect(w[1][0]).toBeNull();
        expect(w[1][1]?.italic).toBe(true);
    });
    it('deduplicates repeated strings in the pool', () => {
        const b = new ColumnarStore.Builder(3, 1);
        b.set(0, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        b.set(1, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        b.set(2, 0, { raw: 'x', formatted: 'x', bold: false, italic: false });
        const store = b.build();
        expect(store.poolSize).toBe(2); // "" sentinel + "x"
    });
    it('window past end returns only existing rows', () => {
        const b = new ColumnarStore.Builder(2, 1);
        b.set(0, 0, { raw: 'a', formatted: 'a', bold: false, italic: false });
        b.set(1, 0, { raw: 'b', formatted: 'b', bold: false, italic: false });
        const store = b.build();
        expect(store.read_window(1, 10).length).toBe(1);
    });
    it('distinguishes null cell from empty-string cell', () => {
        const b = new ColumnarStore.Builder(2, 1);
        b.set(0, 0, null);
        b.set(1, 0, { raw: '', formatted: '', bold: false, italic: false });
        const store = b.build();
        const w = store.read_window(0, 2);
        expect(w[0][0]).toBeNull();
        expect(w[1][0]).toEqual({ raw: '', formatted: '', bold: false, italic: false });
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/columnar-store.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

```typescript
// src/data-source/columnar-store.ts
import type { RenderedCell } from './interface';

const NULL_IDX = -1;
const BOLD = 1, ITALIC = 2;

export class ColumnarStore {
    private constructor(
        private readonly rows: number,
        private readonly cols: number,
        private readonly pool: string[],
        private readonly rawIdx: Int32Array,
        private readonly fmtIdx: Int32Array,
        private readonly flags: Uint8Array,
    ) {}

    get poolSize(): number { return this.pool.length; }
    get rowCount(): number { return this.rows; }
    get colCount(): number { return this.cols; }

    read_window(start_row: number, count: number): (RenderedCell | null)[][] {
        const start = Math.max(0, Math.min(start_row, this.rows));
        const end = Math.min(start + count, this.rows);
        const out: (RenderedCell | null)[][] = [];
        for (let r = start; r < end; r++) {
            const row: (RenderedCell | null)[] = [];
            for (let c = 0; c < this.cols; c++) {
                const i = r * this.cols + c;
                if (this.rawIdx[i] === NULL_IDX) { row.push(null); continue; }
                const f = this.flags[i];
                row.push({
                    raw: this.pool[this.rawIdx[i]],
                    formatted: this.pool[this.fmtIdx[i]],
                    bold: (f & BOLD) !== 0,
                    italic: (f & ITALIC) !== 0,
                });
            }
            out.push(row);
        }
        return out;
    }

    static Builder = class {
        private readonly pool: string[] = [''];           // index 0 = ""
        private readonly poolMap = new Map<string, number>([['', 0]]);
        private readonly rawIdx: Int32Array;
        private readonly fmtIdx: Int32Array;
        private readonly flags: Uint8Array;

        constructor(private readonly rows: number, private readonly cols: number) {
            const n = rows * cols;
            this.rawIdx = new Int32Array(n).fill(NULL_IDX);
            this.fmtIdx = new Int32Array(n).fill(NULL_IDX);
            this.flags = new Uint8Array(n);
        }

        private intern(s: string): number {
            let idx = this.poolMap.get(s);
            if (idx === undefined) { idx = this.pool.length; this.pool.push(s); this.poolMap.set(s, idx); }
            return idx;
        }

        set(r: number, c: number, cell: RenderedCell | null): void {
            const i = r * this.cols + c;
            if (cell === null) { this.rawIdx[i] = NULL_IDX; return; }
            this.rawIdx[i] = this.intern(cell.raw ?? '');
            this.fmtIdx[i] = this.intern(cell.formatted);
            this.flags[i] = (cell.bold ? BOLD : 0) | (cell.italic ? ITALIC : 0);
        }

        build(): ColumnarStore {
            return new ColumnarStore(this.rows, this.cols, this.pool, this.rawIdx, this.fmtIdx, this.flags);
        }
    };
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/columnar-store.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data-source/columnar-store.ts src/test/columnar-store.test.ts
git commit -m "feat(data-source): ColumnarStore with string pool + typed arrays"
```

---

### Task A5: XlsxDataSource (parse-once into ColumnarStore)

**Files:**
- Create: `src/data-source/xlsx-source.ts`
- Modify: `src/parse-xlsx.ts` (extract a cell-visitor seam; keep public `parse_xlsx` working)
- Test: `src/test/xlsx-source.test.ts`

`parse_xlsx` currently returns a fully-materialized `WorkbookData` (`src/parse-xlsx.ts`). Rather than rewrite the XML machinery, add an internal entry point that drives the existing parse but writes each cell into a `ColumnarStore.Builder` instead of a `(CellData|null)[][]`. `XlsxDataSource.read_rows` then delegates to `store.read_window`. Merges and per-sheet shape come straight from the existing parse output.

- [ ] **Step 1: Write the failing test** (uses the existing fixture)

```typescript
// src/test/xlsx-source.test.ts
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { XlsxDataSource } from '../data-source/xlsx-source';

const load = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

describe('XlsxDataSource', () => {
    it('reports sheet shape in meta', () => {
        const ds = new XlsxDataSource(load('basic.xlsx'));
        const m = ds.meta();
        expect(m.sheets.length).toBeGreaterThan(0);
        expect(m.sheets[0].rowCount).toBeGreaterThan(0);
        expect(m.sheets[0].columnCount).toBeGreaterThan(0);
    });
    it('read_rows matches parse_xlsx cell values for the same window', () => {
        const buf = load('basic.xlsx');
        const ds = new XlsxDataSource(buf);
        const w = ds.read_rows(0, 0, 5);
        // Compare against legacy parse for the same cells.
        const { parse_xlsx } = require('../parse-xlsx');
        const legacy = parse_xlsx(buf).data.sheets[0].rows;
        for (let r = 0; r < w.rows.length; r++) {
            for (let c = 0; c < w.rows[r].length; c++) {
                expect(w.rows[r][c]?.formatted ?? null).toEqual(legacy[r]?.[c]?.formatted ?? null);
            }
        }
    });
    it('preserves merges in meta', () => {
        const ds = new XlsxDataSource(load('merged.xlsx'));
        expect(ds.meta().sheets[0].merges.length).toBeGreaterThan(0);
    });
    it('preserves bold/italic flags', () => {
        const ds = new XlsxDataSource(load('styled.xlsx'));
        const w = ds.read_rows(0, 0, 50);
        const anyStyled = w.rows.flat().some((c) => c && (c.bold || c.italic));
        expect(anyStyled).toBe(true);
    });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/test/xlsx-source.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write minimal implementation**

The lowest-risk implementation re-uses the existing parser output and copies it into a `ColumnarStore` once. (A later optimization can stream cells directly into the builder to avoid the intermediate array; do that only if profiling at 1M rows demands it — note this in a code comment.)

```typescript
// src/data-source/xlsx-source.ts
import { parse_xlsx } from '../parse-xlsx';
import { ColumnarStore } from './columnar-store';
import type { DataSource, RowWindow, WorkbookMeta } from './interface';
import type { MergeRange } from '../types';

interface SheetEntry {
    name: string; rowCount: number; columnCount: number; merges: MergeRange[];
    hasFormatting: boolean; store: ColumnarStore;
}

export class XlsxDataSource implements DataSource {
    private readonly sheets: SheetEntry[];
    private readonly _hasFormatting: boolean;
    readonly warnings: string[];

    constructor(buf: Uint8Array) {
        const parsed = parse_xlsx(buf);
        this.warnings = parsed.warnings;
        this._hasFormatting = parsed.data.hasFormatting;
        this.sheets = parsed.data.sheets.map((s) => {
            const b = new ColumnarStore.Builder(s.rowCount, s.columnCount);
            for (let r = 0; r < s.rowCount; r++) {
                const row = s.rows[r] ?? [];
                for (let c = 0; c < s.columnCount; c++) {
                    const cell = row[c] ?? null;
                    b.set(r, c, cell === null ? null : {
                        raw: cell.raw === null ? '' : String(cell.raw),
                        formatted: cell.formatted,
                        bold: cell.bold,
                        italic: cell.italic,
                    });
                }
            }
            return {
                name: s.name, rowCount: s.rowCount, columnCount: s.columnCount,
                merges: s.merges, hasFormatting: parsed.data.hasFormatting, store: b.build(),
            };
        });
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: this._hasFormatting,
            sheets: this.sheets.map((s) => ({
                name: s.name, rowCount: s.rowCount, columnCount: s.columnCount,
                merges: s.merges, hasFormatting: s.hasFormatting,
            })),
        };
    }

    read_rows(sheet_index: number, start_row: number, count: number): RowWindow {
        const s = this.sheets[sheet_index];
        return { startRow: Math.max(0, start_row), rows: s.store.read_window(start_row, count) };
    }

    read_all_rows(): never { throw new Error('read_all_rows is unsupported for xlsx (read-only)'); }
    close(): void { /* GC */ }
}
```

> **Memory note for 1M-row goal:** This implementation builds the legacy `(CellData|null)[][]` first, then the columnar copy — transient 2× peak. For true 1M-row xlsx, follow up (Phase A optimization task, only if needed) by adding a `parse_xlsx_into(builder)` seam in `src/parse-xlsx.ts` that writes cells directly to the builder, eliminating the intermediate array. Tracked as Task A7.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/test/xlsx-source.test.ts`
Expected: PASS (4 tests).

- [ ] **Step 5: Commit**

```bash
git add src/data-source/xlsx-source.ts src/test/xlsx-source.test.ts
git commit -m "feat(data-source): XlsxDataSource backed by ColumnarStore"
```

---

### Task A6: XlsDataSource

**Files:**
- Create: `src/data-source/xls-source.ts`
- Test: `src/test/xls-source.test.ts`

Identical structure to A5 but wraps `parse_xls` (`src/parse-xls.ts`, which returns the same `{ data, warnings }` shape — verified by `custom-editor.ts:135`). Mirror Task A5's code, swapping `parse_xlsx`→`parse_xls` and the constructor input to `Buffer` (parse_xls takes a Buffer per `custom-editor.ts:135`). Tests mirror A5 using fixtures `basic.xls`, `merged.xls`, `styled.xls`.

- [ ] **Step 1:** Write `src/test/xls-source.test.ts` mirroring A5's tests with `.xls` fixtures and `XlsDataSource`.
- [ ] **Step 2:** Run `npx vitest run src/test/xls-source.test.ts` → FAIL (module not found).
- [ ] **Step 3:** Write `src/data-source/xls-source.ts` mirroring A5; constructor signature `constructor(buf: Buffer)`, call `parse_xls(buf)`.
- [ ] **Step 4:** Run `npx vitest run src/test/xls-source.test.ts` → PASS.
- [ ] **Step 5:** Commit:

```bash
git add src/data-source/xls-source.ts src/test/xls-source.test.ts
git commit -m "feat(data-source): XlsDataSource backed by ColumnarStore"
```

---

### Task A7 (conditional): direct-to-builder xlsx parse

Only do this if a 1M-row xlsx fixture shows unacceptable peak memory in A5. Add `export function parse_xlsx_into(buf, makeBuilder): {meta, builders}` to `src/parse-xlsx.ts` that writes cells into a `ColumnarStore.Builder` as they are decoded, then have `XlsxDataSource` use it. Keep `parse_xlsx` (legacy array form) for existing tests. Write a memory-guard test using `process.memoryUsage()`. Defer unless needed; record the decision in the commit message either way.

---

### Task A8: Per-format safety caps

**Files:**
- Modify: `src/spreadsheet-safety.ts`
- Modify: `src/test/spreadsheet-safety.test.ts`

Raise limits to support the 1M-row goal, differentiated so xlsx (held fully in memory) keeps a cell budget while CSV scales by rows. Add `MAX_CSV_ROWS = 1_000_000`. Raise `MAX_SHEET_ROWS` to `1_000_000`, `MAX_WORKBOOK_CELLS` to `50_000_000`, and bump `MAX_WORKBOOK_FILE_BYTES`/default `maxFileSizeMiB` (e.g. 256 MiB) — keep `assert_safe_*` signatures unchanged. Update existing assertions in the test file to the new numbers; add a test that 1M rows passes `assert_safe_sheet_shape` and 50M+1 cells fails. Commit:

```bash
git add src/spreadsheet-safety.ts src/test/spreadsheet-safety.test.ts
git commit -m "feat(safety): raise caps for 1M-row support, add MAX_CSV_ROWS"
```

### Phase A gate

- [ ] `npx vitest run` — entire suite green (new + existing).
- [ ] `npm run bundle` — extension host still bundles.
- [ ] Commit any final fixups. **No webview or protocol changes were made; the app behaves exactly as before.**

---

# PHASE B — Paginated protocol + panel-core (SCOPED)

> Expand into bite-sized TDD steps at the start of this phase. Upstream types (Phase A) now exist.

**Outcome:** The two host panels (`custom-editor.ts`, `csv-panel.ts`) construct a `DataSource`, send a `sheetMeta` message (structure only), and answer `requestRows` with `rowData`. A `generation` counter drops stale responses across reloads. CSV save/conflict flow is preserved by routing `serialize_csv` through `DataSource.read_all_rows`.

**Files & responsibilities:**
- `src/types.ts` — add to `HostMessage`: `{ type:'sheetMeta'; meta:WorkbookMeta; state; defaultTabOrientation; truncationMessage?; previewMode?; csvEditable?; csvEditingSupported?; generation:number }`, `{ type:'metaReload'; meta; csvEditable?; csvEditingSupported?; generation:number }`, `{ type:'rowData'; sheetIndex:number; startRow:number; rows:(RenderedCell|null)[][]; requestId:string; generation:number }`. Add to `WebviewMessage`: `{ type:'requestRows'; sheetIndex:number; startRow:number; count:number; requestId:string; generation:number }`. Keep all existing messages (save/dialog/pendingEdits/visibleRowChanged/stateChanged/ready) unchanged. Keep `workbookData`/`reload` types during B–D; remove in E.
- `src/panel-core.ts` — `class ViewerPanelCore` (model: sight `browser-panel.ts`, raven `panel.ts`): owns `generation`, an LRU `Map<string, RowWindow>` page cache (reuse the eviction pattern from sight `row-cache.ts:42-58`), `handle_message`, `send_meta`, `send_meta_reload`, `handle_row_request` (generation check → cache or `source.read_rows` → post `rowData`). Constructor takes `(panel, source: DataSource, state_store, uri, opts:{csvEditable; serialize?})`.
- `src/custom-editor.ts` — build `XlsxDataSource`/`XlsDataSource` from the file, hand to `ViewerPanelCore`; keep watcher/reload/error handling, route through `send_meta_reload` (bump generation).
- `src/csv-panel.ts` — build `CsvDataSource`; keep the entire save/conflict/`pendingEdits` block (`csv-panel.ts:132-211`), but source serialize input from `source.read_all_rows(0)` instead of `last_parsed.data.sheets[0].rows`. Keep `originalColumnCounts`/`lineEnding`: have `CsvDataSource` also expose these (add getters in a small A-follow-up if not already present).

**Acceptance:** Add `src/test/panel-core.test.ts` with a fake `vscode.WebviewPanel` (capturing `postMessage`) and a stub `DataSource`: asserts `ready`→`sheetMeta`; `requestRows`→`rowData` with matching `requestId`; stale-generation `requestRows` is dropped; cache hit avoids a second `read_rows`. Keep the existing `app.test.ts` green by leaving the old `workbookData` path available (the webview still consumes it until Phase C). 

**Phase B gate:** full suite green; `npm run bundle` green; manual: opening files still works through the *old* renderer (the webview hasn't switched yet — panels send `sheetMeta` AND, transitionally, the old `workbookData` so the current UI keeps working; remove the transitional `workbookData` send in Phase C step 1).

---

# PHASE C — Webview Glide foundation (SCOPED)

**Outcome:** The webview renders via Glide `DataEditor`: virtualized rows from the paged loader, columns from meta, VS Code theming, scroll-driven fetching, column resize persistence, and plain text + bold/italic cells. Merges render as plain cells for now (Phase D makes them exact). Old `table.tsx` still exists but is no longer mounted.

**Files & responsibilities:**
- `package.json` — add dependency `@glideapps/glide-data-grid@6.0.3` (+ its peer `lodash`/`marked` come transitively). 
- `src/webview-html.ts` — relax CSP for Glide: add `'unsafe-inline'` (or a second nonce) to `style-src`, and confirm `img-src`/`worker-src` needs. **Spike first** (Task C0): bundle a hello-world Glide grid, open it, read the devtools console for CSP violations, and set the minimal CSP that clears them. Document the final CSP in a comment.
- `src/webview/grid-model.ts` — port `PAGE_SIZE`, `get_needed_page_starts`, `clamp_column_width`, `estimate_text_width_px` from sight `grid-model.ts:8,328,47,351`; add `build_grid_columns(meta, widths)` returning `SizedGridColumn[]` keyed by column index (table-viewer columns have no names — title = column letter `A,B,…` or empty).
- `src/webview/vscode-theme.ts` — port the `--vscode-*`→Glide `Theme` builder and `MutationObserver` re-read from raven `App.tsx:192,234` / sight. 
- `src/webview/use-row-loader.ts` — adapt sight `use-row-loader.ts`: **strip all sort/filter/histogram code**; add `sheetIndex` arg threaded into every `requestRows`; add `generation` guard (ignore `rowData` whose generation ≠ current); LRU-evict pages beyond ~50; expose `ensure_rows`, `get_row`, `update_viewport`, `meta`. On sheet switch, clear pages (or rely on `key={sheetIndex}` remount).
- `src/webview/grid-shell.tsx` — `<DataEditor>` wrapper: `getCellContent([col,row])` → `get_row(row)` → `GridCellKind.Text` (placeholder `''` while a page is loading); `rowHeight={ROW_HEIGHT_PX}` (constant for now); `onVisibleRegionChanged` → `ensure_rows` + `update_viewport` (+ preview `visibleRowChanged`); `onColumnResize`/`onColumnResizeEnd` → persist widths; `drawCell` applies bold/italic font when the cell has flags (model: raven `App.tsx:1270`); `theme` from `vscode-theme.ts`; `rowMarkers="number"`.
- `src/webview/app.tsx` — replace the `workbookData`/`reload` handlers with `sheetMeta`/`metaReload`; mount `<GridShell key={active_sheet_index} …>` instead of `<TableWithSelection>`; remove `table_ref`; restore scroll via `gridRef.scrollTo`. Keep toolbar, sheet tabs, per-sheet column-width state, `use-state-sync`.

**Acceptance:** Manual smoke (use the `verify`/`run` skill): open `basic.xlsx`, `basic.csv`, `formatted.xlsx` — grid renders, scrolls, columns resize and persist across reopen, bold/italic show, theme matches light/dark. Add `src/test/use-row-loader.test.ts` (mock `acquireVsCodeApi`): requests first page on mount, caches, drops stale generation, clears on sheet switch. 

**Phase C gate:** new + existing suite green; `npm run bundle:webview` produces a single IIFE with Glide CSS inlined; smoke checklist passes. Remove the transitional `workbookData` send from Phase B now.

---

# PHASE D — Exact merged cells + variable row heights + resize (SCOPED)

> This is the highest-risk phase. Start with spikes that verify Glide's draw order against the **installed** v6.0.3 source before committing to a technique.

**Outcome:** Merged cells render pixel-exact (single content block, interior gridlines removed **only within the merged region**, surrounding border intact), selection treats a merge as one logical cell, keyboard nav steps over merges; rows have variable heights with a drag-resize handle and auto-grow after multiline edits.

**Spike D0 (no production code, write findings into the plan):** In `node_modules/@glideapps/glide-data-grid/dist/esm/internal/data-grid/render/`, confirm the cell-pass vs line-pass order (`data-grid-render.cells.js`, `data-grid-render.lines.js`) and whether `drawCell` runs before or after gridlines. Decide the exact-merge mechanism:
- **If** gridlines draw with a clip = complement of span rects (confirmed for horizontal in deep-dive): replicate for vertical by passing merged rects, OR
- **Else**: render merges on a **transparent overlay canvas** stacked above the Glide canvas, redrawn on every `onVisibleRegionChanged`, that paints the merged block (bg, content, 4-sided border) and is kept in sync with scroll. The overlay approach is the safe fallback that guarantees exactness without forking Glide. Pick one in D0 and record the rationale.

**Files & responsibilities:**
- `src/webview/merge-index.ts` — `MergeIndex` built from `SheetMeta.merges`: `is_anchor(r,c)→MergeEntry|null`, `covered_by(r,c)→anchorKey|null`, `anchor_of(r,c)→{row,col}|null`. Pure; unit-tested (mirror `selection.ts` test style, fixtures from `merged.xlsx`). Reuse `resolve_merge_anchor`/`expand_range_for_merges` already in `src/webview/selection.ts`.
- `src/webview/row-heights.ts` — sparse `Map<number,number>` overrides + `row_height_fn(i)=override ?? host_height ?? DEFAULT`; `span_height(startRow,endRow)` summing heights (used by merge draw). 
- `src/webview/cell-renderer.ts` — `getCellContent` returns: anchor → Text cell with native horizontal `span:[startCol,endCol]` when colSpan>1; covered → blank custom cell; `drawCell` draws the exact merged block per D0's chosen mechanism, plus bold/italic (moved from Phase C grid-shell). 
- `src/webview/row-resize-overlay.tsx` — transparent strip over row bottom borders; on hover near a boundary show resize cursor (`onItemHovered`/`onMouseMove` give `localEventY` + `bounds`); drag updates `row-heights` override + `gridRef.updateCells(row cells)`. Replaces `RowResizeHandle` from `table.tsx`. Persist via existing `on_row_resize` plumbing.
- Auto-grow after edit: replace `auto-resize-row.ts`'s DOM measurement with offscreen-canvas `measureText` wrapping math, called from `onFinishedEditing`.

**Acceptance:** Manual: open `merged.xlsx`/`merged.xls` — merged blocks show no interior lines, exact borders, content centered; clicking any covered cell selects the merge; arrow/Tab nav skips over merges (matches current `move_active_cell` behavior); resize a row by dragging; resize a merged row and the block re-sums height; edit a CSV cell to multiline and the row grows. Unit tests for `merge-index.ts` and `row-heights.ts` (`span_height`, override precedence).

**Phase D gate:** suite green; merge + resize manual checklist passes in light & dark themes; verify with a vertical merge, a horizontal merge, and a mixed rowSpan×colSpan merge.

---

# PHASE E — Editing + selection + copy + parity + cleanup (SCOPED)

**Outcome:** Full feature parity, old renderer removed.

**Files & responsibilities:**
- `src/webview/use-editing.ts` — replace the `rows:(CellData|null)[][]` param with a `get_cell_raw(row,col):string` callback (reads the paged cache). For CSV conflict detection, snapshot the base value at edit-start into the existing `DirtyEntry.base` (already the design — `use-editing.ts:97`), so conflict detection never depends on a possibly-evicted page. Update `get_active_editor_value` to read from the Glide overlay editor instead of `.cell-editor-input`.
- `src/webview/csv-cell-editor.tsx` — `provideEditor` overlay component matching `cell-editor.tsx` behavior (Enter/Tab advance, Shift+Alt+Enter multiline, Esc cancel); wire `onCellEdited`→`confirm_edit`; dirty/conflict tint drawn in `drawCell` (cell key in `dirty_cells`/`conflicted_keys`).
- `src/webview/use-selection.ts` — drive Glide `gridSelection`/`onGridSelectionChange`; reuse pure helpers in `selection.ts` (`normalize_range`, `expand_range_for_merges`, `move_active_cell`, `format_selection_for_clipboard`). Copy: implement `getCellsForSelection` so native Ctrl+C works; covered cells emit the anchor's content. Context menu via `onCellContextMenu` → existing `<ContextMenu>`. Keyboard (arrows/hjkl/Tab/Ctrl+A) via Glide `onKeyDown` or a wrapper, preserving current semantics. `copy_selection`/`copy_cell` reuse `format_selection_for_clipboard` but source rows from the paged cache (selections may exceed loaded pages — fetch on demand or cap with a logged warning).
- Preview-mode scroll sync: `scrollToRow`→`gridRef.scrollTo(0,row)`; `visibleRowChanged` from `onVisibleRegionChanged.y` (already in Phase C). Update/replace `src/preview-scroll-sync.ts` host side if needed.
- Auto-fit: replace `measure-column.ts` DOM measurement with canvas `measureText` over sampled loaded rows; toolbar button unchanged.
- **Remove** the transitional `workbookData`/`reload` message types from `types.ts` and the old send paths.
- **Delete** `src/webview/table.tsx`, `cell-editor.tsx`, `boundary-groups.ts`, `measure-column.ts`, `auto-resize-row.ts`. **Only after** the parity checklist passes.
- Update/replace affected tests: `app.test.ts` (rewrite around Glide/message wiring), `use-editing.test.ts` (callback form), `measure-column.test.ts`, `boundary-groups.test.ts`, `auto-resize-row.test.ts`, `cell-editor.test.ts` (move with `csv-cell-editor`). Keep parser/serialize/selection/sheet-state/format tests.

**Parity checklist (gate):** sort N/A (none); verify every item in the feature inventory: file formats; multi-sheet + tab orientation; merged cells; bold/italic + formatting toggle; column resize + batch + auto-fit + double-click auto-size; row resize + batch + min height; persisted layout (widths/heights/scroll/active sheet/orientation) across reopen + LRU eviction; selection (single/range/shift/keyboard/Ctrl+A/row/col); highlight; Ctrl+C + context-menu copy; full context menu; CSV edit mode (double-click/Enter/Tab/Shift+Alt+Enter/Esc/Cmd+S); dirty highlight; save + external-conflict banner (Keep/Discard Conflicted/Discard All); pending edits survive tab close; truncation banner; live reload; preview-mode bidirectional scroll sync. Plus performance: open a generated 500k-row and 1M-row CSV and confirm smooth scroll + bounded memory.

**Phase E gate:** full suite green; `npm run bundle && npm run bundle:webview` green; parity + performance checklists pass; bump version; update `README.md`/`CLAUDE.md` if present.

---

## Self-Review notes

- **Spec coverage:** Every feature in the explored inventory maps to a phase (rendering→C, merges/heights→D, editing/selection/copy/preview/auto-fit→E, scale→A/B). The two user-chosen ambitions are explicit: 1M rows (A columnar + B paging + Glide infinite-scroller verified) and exact merges (D, with a spike to lock the mechanism).
- **Type consistency:** `RenderedCell`/`RowWindow`/`SheetMeta`/`WorkbookMeta`/`DataSource` defined in A1 are used verbatim in A3–A6, B, C. Protocol field names (`sheetIndex`, `startRow`, `requestId`, `generation`) are consistent across B/C.
- **Known residual risks called out inline:** UTF-8 byte vs UTF-16 char slicing (A3 Step 4), transient 2× xlsx memory (A5 → A7), Glide draw-order/exact-merge mechanism (D0 spike), CSP for Glide (C0 spike), large-selection copy beyond loaded pages (E).
```

# CSV/TSV Viewer Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add CSV and TSV file viewing to the Table Viewer extension with two modes: a singleton Preview with bidirectional scroll sync, and a multi-instance standalone table tab.

**Architecture:** Both modes use `WebviewPanel` with the existing React webview. A new `parse-csv.ts` module wraps papaparse and produces `WorkbookData` plus a line-to-row map. The Preview panel (`csv-preview.ts`) manages singleton lifecycle and scroll sync via the extension host. The toolbar panel (`csv-panel.ts`) is a simpler multi-instance viewer with file watching.

**Tech Stack:** papaparse (CSV parsing), VS Code WebviewPanel API, existing React webview

---

## File Structure

| File | Responsibility |
|---|---|
| `src/parse-csv.ts` (create) | Parse CSV/TSV via papaparse, produce `WorkbookData` + line-to-row map, handle row truncation |
| `src/csv-preview.ts` (create) | Singleton Preview panel: create/reuse/reveal, scroll sync (bidirectional with lockout), file watcher, editor tracking |
| `src/csv-panel.ts` (create) | Multi-instance table panel: create, file watcher, state persistence |
| `src/types.ts` (modify) | Add `truncationMessage` and `previewMode` to `workbookData` message, add `scrollToRow` and `visibleRowChanged` message types |
| `src/spreadsheet-safety.ts` (modify) | Replace hardcoded 16 MiB with `maxFileSizeMiB` setting |
| `src/extension.ts` (modify) | Register CSV commands, language contributions handled by package.json |
| `src/webview/app.tsx` (modify) | Truncation banner, scroll sync message handling |
| `src/webview/styles.css` (modify) | Truncation banner styles |
| `package.json` (modify) | papaparse dep, commands, menus, languages, settings |

---

### Task 1: Add papaparse dependency and type declarations

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Install papaparse**

Run: `npm install papaparse`

- [ ] **Step 2: Install papaparse type declarations**

Run: `npm install --save-dev @types/papaparse`

- [ ] **Step 3: Verify installation**

Run: `node -e "require('papaparse').parse('a,b\n1,2'); console.log('ok')"`
Expected: `ok`

- [ ] **Step 4: Commit**

```bash
git add package.json package-lock.json
git commit -m "Add papaparse dependency for CSV/TSV parsing"
```

---

### Task 2: Update types for CSV/TSV support

**Files:**
- Modify: `src/types.ts`

- [ ] **Step 1: Add new message types and fields to `src/types.ts`**

Add `truncationMessage` and `previewMode` to the `workbookData` host message. Add `scrollToRow` host message. Add `visibleRowChanged` webview message.

Replace the `HostMessage` and `WebviewMessage` type definitions:

```typescript
/** Messages from extension host to webview */
export type HostMessage =
    | { type: 'workbookData'; data: WorkbookData; state: StoredPerFileState; defaultTabOrientation: 'horizontal' | 'vertical'; truncationMessage?: string; previewMode?: boolean }
    | { type: 'reload'; data: WorkbookData; truncationMessage?: string }
    | { type: 'scrollToRow'; row: number };

/** Messages from webview to extension host */
export type WebviewMessage =
    | { type: 'ready' }
    | { type: 'stateChanged'; state: PerFileState }
    | { type: 'visibleRowChanged'; row: number };
```

- [ ] **Step 2: Verify the project still compiles**

Run: `npx tsc --noEmit`
Expected: No errors (the new union members are additive)

- [ ] **Step 3: Commit**

```bash
git add src/types.ts
git commit -m "Add CSV/TSV message types: scrollToRow, visibleRowChanged, truncation"
```

---

### Task 3: CSV/TSV parser with line mapping

**Files:**
- Create: `src/parse-csv.ts`
- Create: `src/test/parse-csv.test.ts`
- Create: `src/test/fixtures/basic.csv`
- Create: `src/test/fixtures/basic.tsv`
- Create: `src/test/fixtures/quoted-multiline.csv`

- [ ] **Step 1: Create test fixtures**

Create `src/test/fixtures/basic.csv`:
```
Name,Age,City
Alice,30,New York
Bob,25,London
Charlie,35,Paris
```

Create `src/test/fixtures/basic.tsv`:
```
Name	Age	City
Alice	30	New York
Bob	25	London
Charlie	35	Paris
```

Create `src/test/fixtures/quoted-multiline.csv`:
```
Name,Bio,City
Alice,"Line 1
Line 2",New York
Bob,"Simple",London
```

- [ ] **Step 2: Write failing tests for `parse_csv`**

Create `src/test/parse-csv.test.ts`:

```typescript
import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { parse_csv } from '../parse-csv';

const FIXTURES = path.join(__dirname, 'fixtures');

function read_fixture(name: string): string {
    return fs.readFileSync(path.join(FIXTURES, name), 'utf-8');
}

describe('parse_csv', () => {
    it('parses a basic CSV file into WorkbookData', () => {
        const src = read_fixture('basic.csv');
        const result = parse_csv(src, ',', 10_000);

        expect(result.data.hasFormatting).toBe(false);
        expect(result.data.sheets).toHaveLength(1);

        const sheet = result.data.sheets[0];
        expect(sheet.name).toBe('Sheet1');
        expect(sheet.merges).toEqual([]);
        expect(sheet.rowCount).toBe(4);
        expect(sheet.columnCount).toBe(3);

        // First row is the header treated as data
        expect(sheet.rows[0][0]).toEqual({
            raw: 'Name', formatted: 'Name', bold: false, italic: false,
        });
        expect(sheet.rows[1][1]).toEqual({
            raw: '30', formatted: '30', bold: false, italic: false,
        });
    });

    it('parses a basic TSV file', () => {
        const src = read_fixture('basic.tsv');
        const result = parse_csv(src, '\t', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.rowCount).toBe(4);
        expect(sheet.columnCount).toBe(3);
        expect(sheet.rows[0][0]?.raw).toBe('Name');
        expect(sheet.rows[2][2]?.raw).toBe('London');
    });

    it('produces correct line_map for simple files', () => {
        const src = read_fixture('basic.csv');
        const result = parse_csv(src, ',', 10_000);

        // 4 rows: line 0 (header), line 1, line 2, line 3
        expect(result.line_map).toEqual([0, 1, 2, 3]);
    });

    it('produces correct line_map for multi-line quoted fields', () => {
        const src = read_fixture('quoted-multiline.csv');
        const result = parse_csv(src, ',', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.rowCount).toBe(3);
        // Row 0 starts at line 0 (header)
        // Row 1 starts at line 1 (Alice, spans lines 1-2)
        // Row 2 starts at line 3 (Bob)
        expect(result.line_map).toEqual([0, 1, 3]);
    });

    it('handles empty input', () => {
        const result = parse_csv('', ',', 10_000);
        expect(result.data.sheets[0].rowCount).toBe(0);
        expect(result.data.sheets[0].rows).toEqual([]);
        expect(result.line_map).toEqual([]);
        expect(result.truncationMessage).toBeUndefined();
    });

    it('truncates rows beyond max_rows and reports truncation', () => {
        const rows = ['a,b'];
        for (let i = 0; i < 20; i++) {
            rows.push(`${i},${i}`);
        }
        const src = rows.join('\n');
        const result = parse_csv(src, ',', 10);

        expect(result.data.sheets[0].rowCount).toBe(10);
        expect(result.data.sheets[0].rows).toHaveLength(10);
        expect(result.line_map).toHaveLength(10);
        expect(result.truncationMessage).toBe('Showing 10 of 21 rows');
    });

    it('does not truncate when rows exactly equal max_rows', () => {
        const rows = ['a,b', '1,2', '3,4'];
        const src = rows.join('\n');
        const result = parse_csv(src, ',', 3);

        expect(result.data.sheets[0].rowCount).toBe(3);
        expect(result.truncationMessage).toBeUndefined();
    });

    it('handles rows with varying column counts by padding with nulls', () => {
        const src = 'a,b,c\n1\n2,3';
        const result = parse_csv(src, ',', 10_000);

        const sheet = result.data.sheets[0];
        expect(sheet.columnCount).toBe(3);
        // Row 1 has only 1 value — remaining cells should be null
        expect(sheet.rows[1][0]?.raw).toBe('1');
        expect(sheet.rows[1][1]).toBeNull();
        expect(sheet.rows[1][2]).toBeNull();
    });
});
```

- [ ] **Step 3: Run the tests to verify they fail**

Run: `npx vitest run src/test/parse-csv.test.ts`
Expected: FAIL — `parse_csv` does not exist yet

- [ ] **Step 4: Implement `parse_csv` in `src/parse-csv.ts`**

```typescript
import Papa from 'papaparse';
import type { WorkbookData, CellData } from './types';

export interface CsvParseResult {
    data: WorkbookData;
    line_map: number[];
    truncationMessage?: string;
}

export function parse_csv(
    source: string,
    delimiter: ',' | '\t',
    max_rows: number
): CsvParseResult {
    const result = Papa.parse(source, {
        delimiter,
        header: false,
        skipEmptyLines: false,
    });

    let parsed_rows = result.data as string[][];

    // Remove trailing empty row if source ends with newline
    if (
        parsed_rows.length > 0 &&
        parsed_rows[parsed_rows.length - 1].length === 1 &&
        parsed_rows[parsed_rows.length - 1][0] === ''
    ) {
        parsed_rows = parsed_rows.slice(0, -1);
    }

    const total_rows = parsed_rows.length;

    // Compute line_map before truncation
    const full_line_map = build_line_map(source, parsed_rows);

    // Truncate if needed
    let truncationMessage: string | undefined;
    if (total_rows > max_rows) {
        parsed_rows = parsed_rows.slice(0, max_rows);
        truncationMessage = `Showing ${max_rows.toLocaleString()} of ${total_rows.toLocaleString()} rows`;
    }

    const line_map = full_line_map.slice(0, parsed_rows.length);

    // Determine max column count
    let column_count = 0;
    for (const row of parsed_rows) {
        if (row.length > column_count) column_count = row.length;
    }

    // Build rows as CellData arrays
    const rows: (CellData | null)[][] = parsed_rows.map((row) => {
        const cells: (CellData | null)[] = [];
        for (let c = 0; c < column_count; c++) {
            if (c < row.length && row[c] !== '') {
                cells.push({
                    raw: row[c],
                    formatted: row[c],
                    bold: false,
                    italic: false,
                });
            } else if (c < row.length) {
                // Empty string cell
                cells.push(null);
            } else {
                // Padding for short rows
                cells.push(null);
            }
        }
        return cells;
    });

    return {
        data: {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rows,
                merges: [],
                columnCount: column_count,
                rowCount: parsed_rows.length,
            }],
        },
        line_map,
        truncationMessage,
    };
}

/**
 * Build a mapping from row index to source line number.
 * Walk the source string tracking newlines and match each parsed row
 * to its starting line. Multi-line quoted fields span multiple source
 * lines; the map points to the first line of each row.
 */
function build_line_map(source: string, parsed_rows: string[][]): number[] {
    if (parsed_rows.length === 0) return [];

    const line_map: number[] = [];
    let current_line = 0;
    let pos = 0;

    for (const row of parsed_rows) {
        line_map.push(current_line);

        // Reconstruct what this row consumes in the source.
        // We advance pos past the characters for this row + its delimiter.
        // Rather than reconstructing, we count newlines consumed by this row.
        const row_text = reconstruct_row_text(row, source, pos);
        for (const ch of row_text) {
            if (ch === '\n') current_line++;
        }
        pos += row_text.length;

        // Skip the row delimiter (\n or \r\n)
        if (pos < source.length) {
            if (source[pos] === '\r' && pos + 1 < source.length && source[pos + 1] === '\n') {
                current_line++;
                pos += 2;
            } else if (source[pos] === '\n') {
                current_line++;
                pos += 1;
            }
        }
    }

    return line_map;
}

/**
 * Given a parsed row and the current position in source, extract the
 * source text that corresponds to this row (up to but not including
 * the row-terminating newline).
 */
function reconstruct_row_text(
    _row: string[],
    source: string,
    start_pos: number
): string {
    // Find the next unquoted newline or end of string
    let pos = start_pos;
    let in_quotes = false;

    while (pos < source.length) {
        const ch = source[pos];
        if (ch === '"') {
            in_quotes = !in_quotes;
        } else if (!in_quotes && (ch === '\n' || ch === '\r')) {
            break;
        }
        pos++;
    }

    return source.slice(start_pos, pos);
}
```

- [ ] **Step 5: Run the tests**

Run: `npx vitest run src/test/parse-csv.test.ts`
Expected: All tests pass

- [ ] **Step 6: Commit**

```bash
git add src/parse-csv.ts src/test/parse-csv.test.ts src/test/fixtures/basic.csv src/test/fixtures/basic.tsv src/test/fixtures/quoted-multiline.csv
git commit -m "Add CSV/TSV parser with line-to-row mapping and truncation"
```

---

### Task 4: Make file size limit configurable

**Files:**
- Modify: `src/spreadsheet-safety.ts`
- Modify: `src/test/spreadsheet-safety.test.ts`

- [ ] **Step 1: Write a failing test for configurable file size**

Add to `src/test/spreadsheet-safety.test.ts`, inside the existing `describe('spreadsheet safety limits', ...)` block:

```typescript
    it('assert_safe_file_size accepts a custom limit', () => {
        // 1 MiB custom limit
        expect(() =>
            assert_safe_file_size(2 * 1024 * 1024, 1)
        ).toThrow('File is too large to open safely');

        // Should not throw at 0.5 MiB with 1 MiB limit
        expect(() =>
            assert_safe_file_size(0.5 * 1024 * 1024, 1)
        ).not.toThrow();
    });

    it('assert_safe_file_size uses default when no custom limit given', () => {
        expect(() =>
            assert_safe_file_size(MAX_WORKBOOK_FILE_BYTES + 1)
        ).toThrow('File is too large to open safely');
    });
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/spreadsheet-safety.test.ts`
Expected: FAIL — `assert_safe_file_size` doesn't accept a second argument yet

- [ ] **Step 3: Update `assert_safe_file_size` to accept optional MiB limit**

In `src/spreadsheet-safety.ts`, replace the `assert_safe_file_size` function:

```typescript
export function assert_safe_file_size(size: number, max_mib?: number): void {
    const limit = max_mib !== undefined
        ? max_mib * MEBIBYTE
        : MAX_WORKBOOK_FILE_BYTES;
    if (size > limit) {
        throw new Error(
            `File is too large to open safely (max ${format_mebibytes(limit)} MiB)`
        );
    }
}
```

- [ ] **Step 4: Run the tests**

Run: `npx vitest run src/test/spreadsheet-safety.test.ts`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add src/spreadsheet-safety.ts src/test/spreadsheet-safety.test.ts
git commit -m "Make file size limit configurable via optional max_mib parameter"
```

---

### Task 5: Update package.json with commands, menus, languages, and settings

**Files:**
- Modify: `package.json`

- [ ] **Step 1: Add language contributions to `package.json`**

Add a `"languages"` array inside `"contributes"`:

```json
"languages": [
    {
        "id": "csv",
        "extensions": [".csv", ".CSV"],
        "aliases": ["CSV"]
    },
    {
        "id": "tsv",
        "extensions": [".tsv", ".TSV"],
        "aliases": ["TSV"]
    }
]
```

- [ ] **Step 2: Add commands to `package.json`**

Add a `"commands"` array inside `"contributes"`:

```json
"commands": [
    {
        "command": "tableViewer.showCsvPreviewToSide",
        "title": "Table Viewer: Open Preview to the Side",
        "icon": "$(open-preview)"
    },
    {
        "command": "tableViewer.showCsvPreview",
        "title": "Table Viewer: Open Preview"
    },
    {
        "command": "tableViewer.openCsvTable",
        "title": "Table Viewer: Open as Table",
        "icon": "$(table)"
    }
]
```

- [ ] **Step 3: Add menu contributions to `package.json`**

Add a `"menus"` object inside `"contributes"`:

```json
"menus": {
    "editor/title": [
        {
            "command": "tableViewer.showCsvPreviewToSide",
            "when": "resourceExtname =~ /\\.(csv|tsv|CSV|TSV)$/",
            "group": "navigation",
            "alt": "tableViewer.showCsvPreview"
        },
        {
            "command": "tableViewer.openCsvTable",
            "when": "resourceExtname =~ /\\.(csv|tsv|CSV|TSV)$/",
            "group": "navigation"
        }
    ]
}
```

- [ ] **Step 4: Add new settings to the `"configuration"` section**

Add these properties inside the existing `"properties"` object in `"configuration"`:

```json
"tableViewer.csvMaxRows": {
    "type": "integer",
    "default": 10000,
    "minimum": 1,
    "description": "Maximum rows to display for CSV/TSV files. Excess rows are truncated with a banner."
},
"tableViewer.maxFileSizeMiB": {
    "type": "number",
    "default": 16,
    "minimum": 1,
    "description": "Maximum file size in MiB for all file types (xlsx, xls, csv, tsv)."
}
```

- [ ] **Step 5: Update the extension description**

Change the `"description"` field in `package.json` to:

```json
"description": "Read-only viewer for Excel, CSV, and TSV files with merged cells, formatting, and persistent UI state"
```

- [ ] **Step 6: Verify package.json is valid**

Run: `node -e "JSON.parse(require('fs').readFileSync('package.json', 'utf8')); console.log('valid')"`
Expected: `valid`

- [ ] **Step 7: Commit**

```bash
git add package.json
git commit -m "Add CSV/TSV commands, menus, languages, and settings to package.json"
```

---

### Task 6: Webview truncation banner and scroll sync handling

**Files:**
- Modify: `src/webview/app.tsx`
- Modify: `src/webview/styles.css`
- Modify: `src/test/app.test.ts`

- [ ] **Step 1: Write failing test for truncation banner**

Add to `src/test/app.test.ts`. First, read the existing test file to find the pattern for `dispatch_host_message` and the `afterEach` block. Add a new `describe` block:

```typescript
describe('truncation banner', () => {
    afterEach(() => {
        if (root) {
            act(() => root!.unmount());
            root = null;
        }
        container?.remove();
        container = null;
        vi.restoreAllMocks();
    });

    it('renders truncation banner when truncationMessage is present', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
            truncationMessage: 'Showing 10,000 of 50,000 rows',
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).not.toBeNull();
        expect(banner!.textContent).toBe('Showing 10,000 of 50,000 rows');
    });

    it('does not render truncation banner when truncationMessage is absent', async () => {
        await render_app();

        await dispatch_host_message({
            type: 'workbookData',
            data: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rows: [[make_cell('a')]],
                    merges: [],
                    columnCount: 1,
                    rowCount: 1,
                }],
            },
            state: {},
            defaultTabOrientation: 'horizontal',
        });

        const banner = container!.querySelector('.truncation-banner');
        expect(banner).toBeNull();
    });
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `npx vitest run src/test/app.test.ts`
Expected: FAIL — no `.truncation-banner` element rendered

- [ ] **Step 3: Add truncation banner state and rendering to `app.tsx`**

In `src/webview/app.tsx`:

Add state for truncation message and preview mode near the top of the `App` function, after the existing state declarations:

```typescript
const [truncation_message, set_truncation_message] = useState<string | null>(null);
const [preview_mode, set_preview_mode] = useState(false);
```

In the `msg.type === 'workbookData'` handler, after setting existing state, add:

```typescript
set_truncation_message(msg.truncationMessage ?? null);
set_preview_mode(msg.previewMode ?? false);
```

In the `msg.type === 'reload'` handler, add:

```typescript
set_truncation_message(msg.truncationMessage ?? null);
```

In the JSX, add the truncation banner right after the `<Toolbar ... />` component:

```tsx
{truncation_message && (
    <div className="truncation-banner">{truncation_message}</div>
)}
```

- [ ] **Step 4: Add scroll sync handling to `app.tsx`**

Add a `useEffect` for `scrollToRow` messages. Place it after the existing message handler `useEffect`:

```typescript
useEffect(() => {
    if (!preview_mode) return;

    const handler = (event: MessageEvent) => {
        const msg = event.data;
        if (msg.type === 'scrollToRow' && typeof msg.row === 'number') {
            const table = table_ref.current;
            const scroller = scroll_ref.current;
            if (!table || !scroller) return;

            const rows = table.querySelectorAll('tbody tr');
            const target_row = rows[msg.row] as HTMLElement | undefined;
            if (target_row) {
                scroller.scrollTop = target_row.offsetTop;
            }
        }
    };

    window.addEventListener('message', handler);
    return () => window.removeEventListener('message', handler);
}, [preview_mode]);
```

Add a scroll handler that reports the visible row back to the host. Add this after the `scrollToRow` effect:

```typescript
useEffect(() => {
    if (!preview_mode) return;
    const scroller = scroll_ref.current;
    if (!scroller) return;

    const report_visible_row = () => {
        const table = table_ref.current;
        if (!table) return;

        const rows = table.querySelectorAll('tbody tr');
        const scroll_top = scroller.scrollTop;
        let visible_row = 0;

        for (let i = 0; i < rows.length; i++) {
            const row_el = rows[i] as HTMLElement;
            if (row_el.offsetTop + row_el.offsetHeight > scroll_top) {
                visible_row = i;
                break;
            }
        }

        vscode_api.postMessage({ type: 'visibleRowChanged', row: visible_row });
    };

    scroller.addEventListener('scroll', report_visible_row, { passive: true });
    return () => scroller.removeEventListener('scroll', report_visible_row);
}, [preview_mode]);
```

- [ ] **Step 5: Add truncation banner styles to `styles.css`**

Add to `src/webview/styles.css`:

```css
.truncation-banner {
    padding: 4px 8px;
    background: var(--vscode-editorInfo-background, rgba(0, 122, 204, 0.1));
    color: var(--vscode-editorInfo-foreground, var(--vscode-foreground, #ccc));
    border-bottom: 1px solid var(--vscode-panel-border, #444);
    font-size: 12px;
    flex-shrink: 0;
    text-align: center;
}
```

- [ ] **Step 6: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add src/webview/app.tsx src/webview/styles.css src/test/app.test.ts
git commit -m "Add truncation banner and scroll sync handling to webview"
```

---

### Task 7: Standalone CSV/TSV table panel (toolbar button)

**Files:**
- Create: `src/csv-panel.ts`

- [ ] **Step 1: Create `src/csv-panel.ts`**

```typescript
import * as path from 'path';
import * as vscode from 'vscode';
import { parse_csv, type CsvParseResult } from './parse-csv';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

export function open_csv_table(
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    active_panels: Set<vscode.Disposable>
): void {
    const file_path = uri.fsPath;
    const basename = path.basename(file_path);

    const panel = vscode.window.createWebviewPanel(
        'tableViewer.csvTable',
        basename,
        vscode.ViewColumn.Active,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extension_uri, 'dist', 'webview'),
            ],
        }
    );

    const nonce = generate_nonce();
    panel.webview.html = build_webview_html(panel.webview, extension_uri, nonce);

    const disposables: vscode.Disposable[] = [];
    let consecutive_reload_failures = 0;

    function get_delimiter(): ',' | '\t' {
        return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    }

    function get_max_file_size_mib(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxFileSizeMiB', 16)!;
    }

    function get_csv_max_rows(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('csvMaxRows', 10_000)!;
    }

    async function parse_file(): Promise<CsvParseResult> {
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, get_max_file_size_mib());
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(raw);
        return parse_csv(text, get_delimiter(), get_csv_max_rows());
    }

    async function send_initial_data(): Promise<void> {
        try {
            const result = await parse_file();
            const state = state_store.get(file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation', 'horizontal'
            );

            panel.webview.postMessage({
                type: 'workbookData',
                data: result.data,
                state,
                defaultTabOrientation: default_orientation,
                truncationMessage: result.truncationMessage,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        try {
            const result = await parse_file();
            const delivered = await panel.webview.postMessage({
                type: 'reload',
                data: result.data,
                truncationMessage: result.truncationMessage,
            });
            if (!delivered) return;
            consecutive_reload_failures = 0;
        } catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err
                && typeof err.code === 'string' ? err.code : null;
            if (code === 'EBUSY' || code === 'EPERM') return;

            consecutive_reload_failures++;
            if (consecutive_reload_failures >= 3) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('Failed to reload CSV viewer data', err);
                vscode.window.showErrorMessage(`Failed to reload CSV: ${message}`);
            }
        }
    }

    disposables.push(
        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    send_initial_data();
                    break;
                case 'stateChanged':
                    state_store.set(file_path, msg.state);
                    break;
            }
        })
    );

    // File watcher
    const dir = path.dirname(file_path);
    const file_basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), file_basename)
    );
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    const panel_disposable: vscode.Disposable = {
        dispose() {
            for (const d of disposables) d.dispose();
        },
    };

    active_panels.add(panel_disposable);

    panel.onDidDispose(() => {
        panel_disposable.dispose();
        active_panels.delete(panel_disposable);
    });
}
```

- [ ] **Step 2: Verify the project compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/csv-panel.ts
git commit -m "Add standalone CSV/TSV table panel (toolbar button mode)"
```

---

### Task 8: Preview panel with scroll sync

**Files:**
- Create: `src/csv-preview.ts`

- [ ] **Step 1: Create `src/csv-preview.ts`**

```typescript
import * as path from 'path';
import * as vscode from 'vscode';
import { parse_csv, type CsvParseResult } from './parse-csv';
import { assert_safe_file_size } from './spreadsheet-safety';
import type { FileStateStore } from './state';
import type { WebviewMessage } from './types';
import { build_webview_html, generate_nonce } from './webview-html';

const SCROLL_LOCKOUT_MS = 150;

interface ActivePreview {
    panel: vscode.WebviewPanel;
    uri: vscode.Uri;
    dispose: () => void;
}

let active_preview: ActivePreview | null = null;

export function show_csv_preview(
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    view_column: vscode.ViewColumn
): void {
    if (active_preview) {
        if (active_preview.uri.toString() === uri.toString()) {
            active_preview.panel.reveal(view_column);
            return;
        }
        // Reuse panel for different file: clean up old listeners, set up new ones
        active_preview.dispose();
        const new_cleanup = setup_preview(
            active_preview.panel, uri, extension_uri, state_store, true
        );
        active_preview.uri = uri;
        active_preview.dispose = new_cleanup;
        active_preview.panel.reveal(view_column);
        active_preview.panel.title = `Preview: ${path.basename(uri.fsPath)}`;
        return;
    }

    const panel = vscode.window.createWebviewPanel(
        'tableViewer.csvPreview',
        `Preview: ${path.basename(uri.fsPath)}`,
        view_column,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.joinPath(extension_uri, 'dist', 'webview'),
            ],
        }
    );

    const nonce = generate_nonce();
    panel.webview.html = build_webview_html(panel.webview, extension_uri, nonce);

    const cleanup = setup_preview(panel, uri, extension_uri, state_store, false);

    active_preview = { panel, uri, dispose: cleanup };

    panel.onDidDispose(() => {
        cleanup();
        active_preview = null;
    });
}

function setup_preview(
    panel: vscode.WebviewPanel,
    uri: vscode.Uri,
    extension_uri: vscode.Uri,
    state_store: FileStateStore,
    reusing: boolean
): () => void {
    const disposables: vscode.Disposable[] = [];
    const file_path = uri.fsPath;
    let line_map: number[] = [];
    let consecutive_reload_failures = 0;

    // Scroll sync lockout state
    let editor_lockout = false;
    let preview_lockout = false;
    let editor_lockout_timer: ReturnType<typeof setTimeout> | undefined;
    let preview_lockout_timer: ReturnType<typeof setTimeout> | undefined;

    function get_delimiter(): ',' | '\t' {
        return file_path.toLowerCase().endsWith('.tsv') ? '\t' : ',';
    }

    function get_max_file_size_mib(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxFileSizeMiB', 16)!;
    }

    function get_csv_max_rows(): number {
        return vscode.workspace.getConfiguration('tableViewer')
            .get<number>('csvMaxRows', 10_000)!;
    }

    async function parse_file(): Promise<CsvParseResult> {
        const stat = await vscode.workspace.fs.stat(uri);
        assert_safe_file_size(stat.size, get_max_file_size_mib());
        const raw = await vscode.workspace.fs.readFile(uri);
        const text = new TextDecoder('utf-8').decode(raw);
        return parse_csv(text, get_delimiter(), get_csv_max_rows());
    }

    async function send_initial_data(): Promise<void> {
        try {
            const result = await parse_file();
            line_map = result.line_map;
            const state = state_store.get(file_path);
            const config = vscode.workspace.getConfiguration('tableViewer');
            const default_orientation = config.get<'horizontal' | 'vertical'>(
                'tabOrientation', 'horizontal'
            );

            panel.webview.postMessage({
                type: 'workbookData',
                data: result.data,
                state,
                defaultTabOrientation: default_orientation,
                truncationMessage: result.truncationMessage,
                previewMode: true,
            });
        } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            vscode.window.showErrorMessage(message);
        }
    }

    async function send_reload(): Promise<void> {
        try {
            const result = await parse_file();
            line_map = result.line_map;
            const delivered = await panel.webview.postMessage({
                type: 'reload',
                data: result.data,
                truncationMessage: result.truncationMessage,
            });
            if (!delivered) return;
            consecutive_reload_failures = 0;
        } catch (err) {
            const code = typeof err === 'object' && err !== null && 'code' in err
                && typeof err.code === 'string' ? err.code : null;
            if (code === 'EBUSY' || code === 'EPERM') return;

            consecutive_reload_failures++;
            if (consecutive_reload_failures >= 3) {
                const message = err instanceof Error ? err.message : String(err);
                console.error('Failed to reload CSV preview', err);
                vscode.window.showErrorMessage(`Failed to reload CSV preview: ${message}`);
            }
        }
    }

    // --- Scroll sync: editor → preview ---

    function find_row_for_line(source_line: number): number {
        // Binary search for the last row whose source line ≤ source_line
        let lo = 0;
        let hi = line_map.length - 1;
        let result = 0;

        while (lo <= hi) {
            const mid = (lo + hi) >>> 1;
            if (line_map[mid] <= source_line) {
                result = mid;
                lo = mid + 1;
            } else {
                hi = mid - 1;
            }
        }

        return result;
    }

    function find_matching_editor(): vscode.TextEditor | undefined {
        return vscode.window.visibleTextEditors.find(
            (e) => e.document.uri.toString() === uri.toString()
        );
    }

    disposables.push(
        vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
            if (preview_lockout) return;
            if (e.textEditor.document.uri.toString() !== uri.toString()) return;
            if (e.visibleRanges.length === 0) return;

            const top_line = e.visibleRanges[0].start.line;
            const row = find_row_for_line(top_line);

            // Set lockout to prevent the webview's scroll response from bouncing back
            editor_lockout = true;
            if (editor_lockout_timer !== undefined) clearTimeout(editor_lockout_timer);
            editor_lockout_timer = setTimeout(() => { editor_lockout = false; }, SCROLL_LOCKOUT_MS);

            panel.webview.postMessage({ type: 'scrollToRow', row });
        })
    );

    // --- Scroll sync: preview → editor ---

    disposables.push(
        panel.webview.onDidReceiveMessage((msg: WebviewMessage) => {
            switch (msg.type) {
                case 'ready':
                    send_initial_data();
                    break;
                case 'stateChanged':
                    state_store.set(file_path, msg.state);
                    break;
                case 'visibleRowChanged': {
                    if (editor_lockout) return;
                    if (msg.row < 0 || msg.row >= line_map.length) return;

                    const source_line = line_map[msg.row];
                    const editor = find_matching_editor();
                    if (!editor) return;

                    // Set lockout to prevent editor scroll from bouncing back
                    preview_lockout = true;
                    if (preview_lockout_timer !== undefined) clearTimeout(preview_lockout_timer);
                    preview_lockout_timer = setTimeout(() => { preview_lockout = false; }, SCROLL_LOCKOUT_MS);

                    const range = new vscode.Range(source_line, 0, source_line, 0);
                    editor.revealRange(range, vscode.TextEditorRevealType.AtTop);
                    break;
                }
            }
        })
    );

    // File watcher
    const dir = path.dirname(file_path);
    const basename = path.basename(file_path);
    const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(vscode.Uri.file(dir), basename)
    );
    disposables.push(watcher.onDidChange(() => send_reload()));
    disposables.push(watcher.onDidCreate(() => send_reload()));
    disposables.push(watcher);

    // When reusing an existing panel, the webview is already loaded and won't
    // send 'ready' again. Trigger initial data send directly.
    if (reusing) {
        send_initial_data();
    }

    return () => {
        if (editor_lockout_timer !== undefined) clearTimeout(editor_lockout_timer);
        if (preview_lockout_timer !== undefined) clearTimeout(preview_lockout_timer);
        for (const d of disposables) d.dispose();
    };
}

/** Dispose the active preview (for extension deactivation). */
export function dispose_csv_preview(): void {
    if (active_preview) {
        active_preview.panel.dispose();
        // onDidDispose handler will clean up
    }
}
```

- [ ] **Step 2: Verify the project compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/csv-preview.ts
git commit -m "Add CSV/TSV preview panel with bidirectional scroll sync"
```

---

### Task 9: Wire commands into extension entry point

**Files:**
- Modify: `src/extension.ts`

- [ ] **Step 1: Update `src/extension.ts` to register CSV commands**

Replace the contents of `src/extension.ts`:

```typescript
import * as vscode from 'vscode';
import { register_table_viewer } from './custom-editor';
import { open_csv_table } from './csv-panel';
import { show_csv_preview, dispose_csv_preview } from './csv-preview';
import { create_file_state_store, DEFAULT_MAX_STORED_FILES } from './state';

export function activate(context: vscode.ExtensionContext): void {
    const get_max_stored = () =>
        Math.max(1, vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxStoredFiles', DEFAULT_MAX_STORED_FILES)!);

    const state_store = create_file_state_store(context, get_max_stored);
    register_table_viewer(context, state_store);

    const active_panels = new Set<vscode.Disposable>();

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.showCsvPreviewToSide',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                show_csv_preview(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    vscode.ViewColumn.Beside
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.showCsvPreview',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                show_csv_preview(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    vscode.ViewColumn.Active
                );
            }
        )
    );

    context.subscriptions.push(
        vscode.commands.registerCommand(
            'tableViewer.openCsvTable',
            (uri?: vscode.Uri) => {
                const target_uri = uri ?? vscode.window.activeTextEditor?.document.uri;
                if (!target_uri) return;
                open_csv_table(
                    target_uri,
                    context.extensionUri,
                    state_store,
                    active_panels
                );
            }
        )
    );

    context.subscriptions.push({
        dispose() {
            dispose_csv_preview();
            for (const p of active_panels) p.dispose();
            active_panels.clear();
        },
    });
}

export function deactivate(): void {}
```

- [ ] **Step 2: Verify the project compiles**

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3: Commit**

```bash
git add src/extension.ts
git commit -m "Register CSV/TSV commands in extension entry point"
```

---

### Task 10: Update xlsx custom editor to use configurable file size limit

**Files:**
- Modify: `src/custom-editor.ts`

- [ ] **Step 1: Update `parse_file` in `custom-editor.ts` to read the setting**

In `src/custom-editor.ts`, in the `ViewerPanel` class, update the `parse_file` method. Replace:

```typescript
    private async parse_file(): Promise<{ data: WorkbookData; warnings: string[] }> {
        const stat = await vscode.workspace.fs.stat(this.uri);
        assert_safe_file_size(stat.size);
```

With:

```typescript
    private async parse_file(): Promise<{ data: WorkbookData; warnings: string[] }> {
        const stat = await vscode.workspace.fs.stat(this.uri);
        const max_mib = vscode.workspace.getConfiguration('tableViewer')
            .get<number>('maxFileSizeMiB', 16)!;
        assert_safe_file_size(stat.size, max_mib);
```

- [ ] **Step 2: Run all tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 3: Commit**

```bash
git add src/custom-editor.ts
git commit -m "Use configurable file size limit in xlsx custom editor"
```

---

### Task 11: Build verification and bundle test

**Files:** (no new files)

- [ ] **Step 1: Run all unit tests**

Run: `npx vitest run`
Expected: All tests pass

- [ ] **Step 2: Build the extension bundle**

Run: `npm run bundle && npm run bundle:webview`
Expected: Builds succeed with no errors, `dist/extension.js` and `dist/webview/index.js` are produced

- [ ] **Step 3: Package the extension**

Run: `npm run package`
Expected: `.vsix` file is produced

- [ ] **Step 4: Commit any fixes if needed, then tag completion**

```bash
git log --oneline -10
```

Verify the commit history looks clean with all tasks committed.

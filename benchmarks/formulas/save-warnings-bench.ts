// Cost of the Save warnings' formula question (ADR 0006) on a large
// workbook: the host review that lists formulas Save will write #REF! into
// and ranges a move or delete changed. Bundle with esbuild inside the
// repository, then run with node:
//
//   esbuild benchmarks/formulas/save-warnings-bench.ts --bundle --platform=node \
//     --packages=external --outfile=test-results/save-warnings-bench.js
//   node test-results/save-warnings-bench.js [rows] [dependents]
//
// With `dependents`, every row also has `E = D*1.1` and the All row sums E,
// so deleting Price breaks a formula on every row and one that uses it.
//
// Prints one JSON line per gesture: the review's total CPU time, its longest
// uninterrupted slice when run cooperatively (8 ms slices, as the host runs
// it), and what it found.
import { performance } from 'node:perf_hooks';
import { build_source_from_buffer } from '../../src/data-source/from-buffer';
import { build_fixture_xlsx, cell, row } from '../../src/test/helpers/xlsx-structure-fixture';
import { EMPTY_PENDING_STRUCTURAL_CHANGES, type PendingStructuralChanges } from '../../src/pending-changes';
import {
    delete_columns,
    insert_rows,
    move_rows,
    type WorksheetStructureContext,
} from '../../src/webview/pending-row-store';
import type { FormulaCalculationLayout } from '../../src/formula-calculation';
import {
    review_formula_divergence,
    review_formula_divergence_cooperatively,
} from '../../src/formula-divergence-review';

async function main(): Promise<void> {
    const rows = Number(process.argv[2] ?? 50_000);
    const dependents = process.argv[3] === 'dependents';
    const body: string[] = [row(1, ['Item', 'Qty', 'Price', 'Total', 'Tax'].map((v, c) => cell(`${'ABCDE'[c]}1`, v)))];
    for (let n = 2; n <= rows + 1; n += 1) {
        body.push(row(n, [
            cell(`A${n}`, `item ${n}`),
            cell(`B${n}`, n % 17),
            cell(`C${n}`, (n % 13) / 4),
            cell(`D${n}`, { f: `B${n}*C${n}` }),
            ...(dependents ? [cell(`E${n}`, { f: `D${n}*1.1` })] : []),
        ]));
    }
    body.push(row(rows + 2, [
        cell(`B${rows + 2}`, { f: `SUM(B2:B${rows + 1})` }),
        cell(`D${rows + 2}`, { f: `SUM(D2:D${rows + 1})` }),
        ...(dependents ? [cell(`E${rows + 2}`, { f: `SUM(E2:E${rows + 1})` })] : []),
    ]));
    const bytes = build_fixture_xlsx({ sheets: [{ name: 'Data', body: `<sheetData>${body.join('')}</sheetData>` }] });
    const opened = performance.now();
    const source = await build_source_from_buffer(bytes, 'bench.xlsx');
    const open_ms = performance.now() - opened;
    const sheet = source.meta().sheets[0]!;
    const context: WorksheetStructureContext = {
        worksheet: { sheetIndex: 0, sheetName: 'Data' },
        bodyStart: 1,
        sourceRowCount: sheet.sourceRowCount,
        sourceColumnCount: sheet.columnCount,
        bodyViewTransformed: false,
    };
    const unwrap = (result: ReturnType<typeof insert_rows>): PendingStructuralChanges => {
        if (!result.ok) throw new Error(result.refusal.message);
        return result.outcome.next;
    };
    const gestures: Record<string, PendingStructuralChanges> = {
        'insert a row near the top': unwrap(insert_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context,
            { kind: 'source', sourceRow: 2 }, 'after', ['i1'], { id: 't1', format: { kind: 'none' } }, 1)),
        'delete column Price': unwrap(delete_columns(EMPTY_PENDING_STRUCTURAL_CHANGES, context,
            [{ kind: 'source', sourceColumn: 2 }])),
        'move the first body row down': unwrap(move_rows(EMPTY_PENDING_STRUCTURAL_CHANGES, context,
            [{ kind: 'source', sourceRow: 1 }], { kind: 'source', sourceRow: 3 })),
    };
    console.log(JSON.stringify({
        rows,
        formulas: dependents ? 2 * rows + 3 : rows + 2,
        open_ms: Math.round(open_ms),
    }));
    for (const [gesture, changes] of Object.entries(gestures)) {
        const layouts: FormulaCalculationLayout[] = [{
            bodyStart: 1,
            ...(changes.rowLayout === undefined ? {} : { rowLayout: changes.rowLayout }),
            ...(changes.columnLayout === undefined ? {} : { columnLayout: changes.columnLayout }),
            band: [],
        }];
        // Warm once, then time.
        review_formula_divergence(source, [], layouts);
        const began = performance.now();
        const review = review_formula_divergence(source, [], layouts);
        const total_ms = performance.now() - began;
        let longest = 0;
        let last = performance.now();
        let yields = 0;
        const wall_began = performance.now();
        await review_formula_divergence_cooperatively(source, [], layouts, {
            isCancelled: () => false,
            yieldControl: async () => {
                const now = performance.now();
                longest = Math.max(longest, now - last);
                yields += 1;
                await new Promise<void>((resolve) => setImmediate(resolve));
                last = performance.now();
            },
        });
        longest = Math.max(longest, performance.now() - last);
        console.log(JSON.stringify({
            gesture,
            total_ms: Math.round(total_ms),
            cooperative_wall_ms: Math.round(performance.now() - wall_began),
            longest_slice_ms: Math.round(longest * 10) / 10,
            yields,
            ref_formulas: review.deletedCounts.reduce((sum, entry) => sum + entry.formulas, 0),
            ref_dependents: review.totals.refDependents,
            unchecked_dependents: review.totals.uncheckedDependents,
            range_formulas: review.counts.reduce((sum, entry) => sum + entry.formulas, 0),
        }));
    }
}

void main();

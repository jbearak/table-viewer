#!/usr/bin/env node
// Compare a grid-perf results file against a recorded baseline.
//
// Usage: node benchmarks/grid/compare.mjs <baseline.json> <candidate.json>
//
// Gates (per scenario, lower is better for every metric):
//   - hard fail when a metric regresses more than its allowed percentage
//   - long-frame counts use an absolute allowance instead (counts are small
//     and noisy; a percentage of 3 is meaningless)
//
// Exit code 0 = within gates, 1 = regression, 2 = usage/shape error.
import * as fs from 'node:fs';

const PCT_ALLOWANCE = {
    // Electron launch + parse; noisier than in-page metrics.
    open_canvas_ms: 10,
    open_first_cell_ms: 10,
    // In-page rAF cadence; the authoritative gate.
    scroll_p50_ms: 5,
    scroll_p95_ms: 5,
    scroll_total_ms: 5,
};
const ABS_ALLOWANCE = {
    scroll_long_frames: 5,
};

const [, , baseline_path, candidate_path] = process.argv;
if (!baseline_path || !candidate_path) {
    console.error('usage: compare.mjs <baseline.json> <candidate.json>');
    process.exit(2);
}

const read = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
let baseline, candidate;
try {
    baseline = read(baseline_path);
    candidate = read(candidate_path);
} catch (error) {
    console.error(String(error));
    process.exit(2);
}

// Shape validation before any gate comparison. An empty baseline would make
// the gate loop run zero times and "pass"; a non-numeric baseline metric would
// yield NaN comparisons that never fail. These are input errors (exit 2), not
// performance regressions (exit 1).
const scenario_entries = Object.entries(baseline?.scenarios ?? {});
if (scenario_entries.length === 0) {
    console.error(`SHAPE ERROR: baseline has no scenarios: ${baseline_path}`);
    process.exit(2);
}
const is_plain_object = (v) => typeof v === 'object' && v !== null && !Array.isArray(v);
for (const [scenario, base_values] of scenario_entries) {
    if (!is_plain_object(base_values) || Object.keys(base_values).length === 0) {
        console.error(`SHAPE ERROR: baseline scenario ${scenario} has no metrics`);
        process.exit(2);
    }
    for (const [metric, base] of Object.entries(base_values)) {
        if (typeof base !== 'number' || !Number.isFinite(base)) {
            console.error(`SHAPE ERROR: baseline ${scenario}.${metric} is not a finite number`);
            process.exit(2);
        }
    }
    const cand_values = candidate?.scenarios?.[scenario];
    if (!is_plain_object(cand_values)) {
        console.error(`SHAPE ERROR: candidate is missing scenario: ${scenario}`);
        process.exit(2);
    }
    for (const metric of Object.keys(base_values)) {
        const cand = cand_values[metric];
        if (typeof cand !== 'number' || !Number.isFinite(cand)) {
            console.error(`SHAPE ERROR: candidate ${scenario}.${metric} is not a finite number`);
            process.exit(2);
        }
    }
}

let failed = false;
for (const [scenario, base_values] of scenario_entries) {
    const cand_values = candidate.scenarios[scenario];
    console.log(`\n${scenario}`);
    for (const [metric, base] of Object.entries(base_values)) {
        const cand = cand_values[metric];
        const delta = cand - base;
        const pct = base === 0 ? 0 : (delta / base) * 100;
        let verdict = 'ok';
        if (metric in ABS_ALLOWANCE) {
            if (delta > ABS_ALLOWANCE[metric]) {
                verdict = `FAIL (+${delta} > +${ABS_ALLOWANCE[metric]} allowed)`;
                failed = true;
            }
        } else {
            const allowance = PCT_ALLOWANCE[metric] ?? 5;
            if (base > 0 && pct > allowance) {
                verdict = `FAIL (+${pct.toFixed(1)}% > +${allowance}% allowed)`;
                failed = true;
            }
        }
        console.log(
            `  ${metric.padEnd(22)} ${String(base).padStart(10)} -> ${String(cand).padStart(10)}` +
            `  (${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)  ${verdict}`,
        );
    }
}

if (failed) {
    console.error('\nPerformance gate: FAILED');
    process.exit(1);
}
console.log('\nPerformance gate: passed');

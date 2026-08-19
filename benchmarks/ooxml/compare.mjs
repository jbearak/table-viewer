#!/usr/bin/env node
// Compare OOXML benchmark results against a committed baseline.
//
// Usage: node benchmarks/ooxml/compare.mjs <baseline.json> <candidate.json>
// Exit code 0 = within gates, 1 = regression, 2 = usage/shape error.
import * as fs from 'node:fs';

const SCENARIOS = [
    'real-cfb-read',
    'real-worksheet-decode',
    'real-coordinate-scan',
    'real-full-save',
    'non-ascii-cfb-read',
    'non-ascii-worksheet-decode',
    'non-ascii-coordinate-scan',
    'non-ascii-full-save',
];
const METRICS = [
    'time_ms',
    'peak_rss_mib',
    'live_external_delta_mib',
    'live_heap_used_delta_mib',
];
const PCT_ALLOWANCE = {
    time_ms: 15,
    peak_rss_mib: 8,
};
const PHASE_PCT_ALLOWANCE = {
    'real-cfb-read.time_ms': 20,
    'real-worksheet-decode.time_ms': 20,
    'non-ascii-cfb-read.time_ms': 20,
    'non-ascii-worksheet-decode.time_ms': 20,
};
const ABS_ALLOWANCE = {
    live_external_delta_mib: 4,
    live_heap_used_delta_mib: 8,
};
const COMPATIBLE_META_PATHS = [
    ['schema'],
    ['node_major'],
    ['platform'],
    ['arch'],
    ['sample_count'],
    ['aggregation'],
    ['fixtures', 'real', 'path'],
    ['fixtures', 'real', 'bytes'],
    ['fixtures', 'real', 'sha256'],
    ['fixtures', 'real', 'worksheet_path'],
    ['fixtures', 'real', 'worksheet_bytes'],
    ['fixtures', 'real', 'worksheet_rows'],
    ['fixtures', 'non_ascii', 'generator'],
    ['fixtures', 'non_ascii', 'package_bytes'],
    ['fixtures', 'non_ascii', 'worksheet_path'],
    ['fixtures', 'non_ascii', 'worksheet_bytes'],
    ['fixtures', 'non_ascii', 'worksheet_sha256'],
    ['fixtures', 'non_ascii', 'worksheet_rows'],
    ['fixtures', 'non_ascii', 'worksheet_columns'],
    ['fixtures', 'non_ascii', 'cell_text'],
];

const [, , baseline_path, candidate_path] = process.argv;
if (!baseline_path || !candidate_path) {
    console.error('usage: compare.mjs <baseline.json> <candidate.json>');
    process.exit(2);
}

function shape_error(message) {
    console.error(`SHAPE ERROR: ${message}`);
    process.exit(2);
}

function read_json(file_path) {
    return JSON.parse(fs.readFileSync(file_path, 'utf8'));
}

function is_plain_object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function value_at(value, keys) {
    let current = value;
    for (const key of keys) current = current?.[key];
    return current;
}

function display(value) {
    return Number.isInteger(value) ? String(value) : value.toFixed(3);
}

function require_exact_keys(value, expected, description) {
    if (!is_plain_object(value)) shape_error(`${description} is not an object`);
    const actual = Object.keys(value).sort();
    const wanted = [...expected].sort();
    if (actual.length !== wanted.length
        || actual.some((key, index) => key !== wanted[index])) {
        shape_error(
            `${description} keys are ${JSON.stringify(actual)}; expected ${JSON.stringify(wanted)}`,
        );
    }
}

function validate_result_shape(result, description) {
    require_exact_keys(result?.scenarios, SCENARIOS, `${description} scenarios`);
    for (const scenario of SCENARIOS) {
        const values = result.scenarios[scenario];
        require_exact_keys(values, METRICS, `${description} scenario ${scenario}`);
        for (const metric of METRICS) {
            const value = values[metric];
            if (typeof value !== 'number' || !Number.isFinite(value)) {
                shape_error(`${description} ${scenario}.${metric} is not a finite number`);
            }
            if (metric in PCT_ALLOWANCE && value <= 0) {
                shape_error(`${description} ${scenario}.${metric} must be positive`);
            }
        }
    }
}

let baseline;
let candidate;
try {
    baseline = read_json(baseline_path);
    candidate = read_json(candidate_path);
} catch (error) {
    shape_error(String(error));
}

for (const keys of COMPATIBLE_META_PATHS) {
    const meta_path = keys.join('.');
    const baseline_value = value_at(baseline?.meta, keys);
    const candidate_value = value_at(candidate?.meta, keys);
    if (baseline_value === undefined || candidate_value === undefined) {
        shape_error(`missing meta.${meta_path}`);
    }
    if (baseline_value !== candidate_value) {
        shape_error(
            `incompatible meta.${meta_path}: `
            + `${JSON.stringify(baseline_value)} != ${JSON.stringify(candidate_value)}`,
        );
    }
}
validate_result_shape(baseline, 'baseline');
validate_result_shape(candidate, 'candidate');

let failed = false;
for (const scenario of SCENARIOS) {
    const baseline_values = baseline.scenarios[scenario];
    const candidate_values = candidate.scenarios[scenario];
    console.log(`\n${scenario}`);
    for (const metric of METRICS) {
        const baseline_value = baseline_values[metric];
        const candidate_value = candidate_values[metric];
        const delta = candidate_value - baseline_value;
        const pct = (delta / Math.abs(baseline_value)) * 100;
        let verdict = 'ok';
        if (metric in ABS_ALLOWANCE) {
            const allowance = ABS_ALLOWANCE[metric];
            if (delta > allowance) {
                verdict = `FAIL (+${display(delta)} > +${allowance} allowed)`;
                failed = true;
            }
        } else {
            const allowance = PHASE_PCT_ALLOWANCE[`${scenario}.${metric}`] ?? PCT_ALLOWANCE[metric];
            if (pct > allowance) {
                verdict = `FAIL (+${pct.toFixed(1)}% > +${allowance}% allowed)`;
                failed = true;
            }
        }
        console.log(
            `  ${metric.padEnd(28)} ${display(baseline_value).padStart(10)} -> `
            + `${display(candidate_value).padStart(10)}  `
            + `(${pct >= 0 ? '+' : ''}${pct.toFixed(1)}%)  ${verdict}`,
        );
    }
}

if (failed) {
    console.error('\nPerformance gate: FAILED');
    process.exit(1);
}
console.log('\nPerformance gate: passed');

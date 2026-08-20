#!/usr/bin/env node
// Run every OOXML phase in fresh --expose-gc child processes and aggregate the
// samples by median. Exit 2 means the fixtures, arguments, worker output, or
// comparison inputs have the wrong shape.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import CFB from 'cfb';
import { build } from 'esbuild';

const BENCHMARK_DIR = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(BENCHMARK_DIR, '../..');
const WORKER_PATH = path.join(BENCHMARK_DIR, 'worker.mjs');
const COMPARE_PATH = path.join(BENCHMARK_DIR, 'compare.mjs');
const REAL_FIXTURE_PATH = path.join(
    REPO_ROOT,
    'src/test/fixtures/undesa_pd_2024_wcu_country_data_survey-based.xlsx',
);
const REAL_FIXTURE_RELATIVE_PATH = path.relative(REPO_ROOT, REAL_FIXTURE_PATH);
const REAL_FIXTURE_BYTES = 7_123_695;
const REAL_FIXTURE_SHA256 = 'd673a5e7f0a79e46f6df9d1a9e65382ca39f40004a4e4bf43696d0f7eff80e78';
const REAL_WORKSHEET_PATH = '/xl/worksheets/sheet4.xml';
const REAL_WORKSHEET_BYTES = 59_945_240;
const REAL_WORKSHEET_ROWS = 70_453;
const NON_ASCII_WORKSHEET_PATH = '/xl/worksheets/sheet1.xml';
const NON_ASCII_WORKSHEET_ROWS = 70_453;
const NON_ASCII_WORKSHEET_COLUMNS = 7;
const NON_ASCII_CELL_TEXT = 'café';
const PHASES = ['cfb-read', 'worksheet-decode', 'coordinate-scan', 'full-save'];
const METRICS = [
    'time_ms',
    'peak_rss_mib',
    'live_external_delta_mib',
    'live_heap_used_delta_mib',
];

function shape_error(message) {
    throw new Error(message);
}

function parse_args(args) {
    let output_path;
    let compare_path;
    let label = 'candidate';
    let sample_count = 3;

    for (let index = 0; index < args.length; index++) {
        const arg = args[index];
        const value = args[index + 1];
        switch (arg) {
            case '--output':
                if (!value) shape_error('--output requires a path');
                output_path = path.resolve(value);
                index++;
                break;
            case '--compare':
                if (!value) shape_error('--compare requires a baseline path');
                compare_path = path.resolve(value);
                index++;
                break;
            case '--label':
                if (!value) shape_error('--label requires a value');
                label = value;
                index++;
                break;
            case '--samples':
                if (!value || !/^\d+$/.test(value)) shape_error('--samples requires a positive integer');
                sample_count = Number(value);
                if (sample_count < 1 || sample_count > 9 || sample_count % 2 === 0) {
                    shape_error('--samples must be an odd integer from 1 through 9');
                }
                index++;
                break;
            case '--help':
                console.log(
                    'usage: run.mjs [--samples 3] [--label LABEL] [--output FILE] '
                    + '[--compare BASELINE]',
                );
                process.exit(0);
            default:
                shape_error(`unknown argument: ${arg}`);
        }
    }
    if (output_path && compare_path && output_path === compare_path) {
        shape_error('candidate output must not overwrite its comparison baseline');
    }
    return { output_path, compare_path, label, sample_count };
}

function validate_real_fixture() {
    let bytes;
    try {
        bytes = fs.readFileSync(REAL_FIXTURE_PATH);
    } catch (error) {
        shape_error(`cannot read fixture ${REAL_FIXTURE_RELATIVE_PATH}: ${String(error)}`);
    }
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    if (bytes.byteLength !== REAL_FIXTURE_BYTES || sha256 !== REAL_FIXTURE_SHA256) {
        shape_error(
            `fixture identity changed: got ${bytes.byteLength} bytes / ${sha256}, `
            + `expected ${REAL_FIXTURE_BYTES} bytes / ${REAL_FIXTURE_SHA256}`,
        );
    }
}

function column_name(index) {
    let value = index + 1;
    let name = '';
    while (value > 0) {
        const remainder = (value - 1) % 26;
        name = String.fromCharCode(65 + remainder) + name;
        value = Math.floor((value - 1) / 26);
    }
    return name;
}

function build_non_ascii_worksheet() {
    const rows = new Array(NON_ASCII_WORKSHEET_ROWS);
    for (let row = 1; row <= NON_ASCII_WORKSHEET_ROWS; row++) {
        let cells = '';
        for (let col = 0; col < NON_ASCII_WORKSHEET_COLUMNS; col++) {
            cells += `<c r="${column_name(col)}${row}" t="inlineStr"><is><t>${NON_ASCII_CELL_TEXT}</t></is></c>`;
        }
        rows[row - 1] = `<row r="${row}">${cells}</row>`;
    }
    return '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>'
        + '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">'
        + `<dimension ref="A1:${column_name(NON_ASCII_WORKSHEET_COLUMNS - 1)}${NON_ASCII_WORKSHEET_ROWS}"/>`
        + `<sheetData>${rows.join('')}</sheetData></worksheet>`;
}

function add_package_part(cfb_file, part_path, text) {
    CFB.utils.cfb_add(cfb_file, part_path, Buffer.from(text, 'utf8'));
}

function build_non_ascii_fixture(output_path) {
    const worksheet = build_non_ascii_worksheet();
    const worksheet_bytes = Buffer.byteLength(worksheet, 'utf8');
    const worksheet_sha256 = createHash('sha256').update(worksheet, 'utf8').digest('hex');
    const cfb_file = CFB.utils.cfb_new();
    add_package_part(cfb_file, '/[Content_Types].xml',
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">'
        + '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>'
        + '<Default Extension="xml" ContentType="application/xml"/>'
        + '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>'
        + '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>'
        + '</Types>');
    add_package_part(cfb_file, '/_rels/.rels',
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>'
        + '</Relationships>');
    add_package_part(cfb_file, '/xl/workbook.xml',
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" '
        + 'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">'
        + '<sheets><sheet name="Non-ASCII" sheetId="1" r:id="rId1"/></sheets></workbook>');
    add_package_part(cfb_file, '/xl/_rels/workbook.xml.rels',
        '<?xml version="1.0" encoding="UTF-8"?>'
        + '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">'
        + '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>'
        + '</Relationships>');
    add_package_part(cfb_file, NON_ASCII_WORKSHEET_PATH, worksheet);
    const package_buffer = Buffer.from(
        CFB.write(cfb_file, { type: 'buffer', fileType: 'zip', compression: true }),
    );
    fs.writeFileSync(output_path, package_buffer);
    return {
        package_bytes: package_buffer.byteLength,
        worksheet_bytes,
        worksheet_sha256,
    };
}

async function build_source_bundle() {
    const cache_root = path.join(REPO_ROOT, 'node_modules/.cache');
    fs.mkdirSync(cache_root, { recursive: true });
    const bundle_dir = fs.mkdtempSync(path.join(cache_root, 'ooxml-benchmark-'));
    const bundle_path = path.join(bundle_dir, 'source.mjs');
    try {
        await build({
            stdin: {
                contents: [
                    "export { cells_present } from './src/xlsx-cell-write.ts';",
                    "export { worksheet_scan_input } from './src/ooxml-worksheet-scan.ts';",
                    "export { write_xlsx_cell_edits } from './src/xlsx-package.ts';",
                ].join('\n'),
                resolveDir: REPO_ROOT,
                sourcefile: 'ooxml-benchmark-entry.ts',
                loader: 'ts',
            },
            bundle: true,
            platform: 'node',
            format: 'esm',
            target: 'node26',
            outfile: bundle_path,
            external: ['cfb'],
            logLevel: 'silent',
        });
    } catch (error) {
        fs.rmSync(bundle_dir, { recursive: true, force: true });
        shape_error(`could not bundle benchmark source: ${String(error)}`);
    }
    return { bundle_dir, bundle_path };
}

function median(values) {
    const sorted = [...values].sort((left, right) => left - right);
    return sorted[Math.floor(sorted.length / 2)];
}

function rounded(value) {
    const result = Math.round(value * 1000) / 1000;
    return Object.is(result, -0) ? 0 : result;
}

function run_sample(phase, profile, bundle_path) {
    const child = spawnSync(
        process.execPath,
        ['--expose-gc', WORKER_PATH, phase, JSON.stringify(profile), bundle_path],
        { encoding: 'utf8', maxBuffer: 1024 * 1024 },
    );
    if (child.status !== 0) {
        const detail = (child.stderr || child.stdout || `worker exited ${child.status}`).trim();
        shape_error(`${profile.name}-${phase} worker failed: ${detail}`);
    }
    let measurement;
    try {
        measurement = JSON.parse(child.stdout);
    } catch (error) {
        shape_error(`${profile.name}-${phase} worker emitted invalid JSON: ${String(error)}`);
    }
    for (const metric of METRICS) {
        if (typeof measurement?.[metric] !== 'number' || !Number.isFinite(measurement[metric])) {
            shape_error(`${profile.name}-${phase}.${metric} is not a finite number`);
        }
    }
    return measurement;
}

function aggregate_phase(samples) {
    const aggregate = {};
    for (const metric of METRICS) {
        aggregate[metric] = rounded(median(samples.map((sample) => sample[metric])));
    }
    return aggregate;
}

function serialize_result(result) {
    return `${JSON.stringify(result, null, 2)}\n`;
}

function write_result(result, output_path) {
    const json = serialize_result(result);
    if (output_path) {
        fs.mkdirSync(path.dirname(output_path), { recursive: true });
        fs.writeFileSync(output_path, json);
        console.error(`wrote ${output_path}`);
    } else {
        process.stdout.write(json);
    }
}

function compare_result(result, baseline_path) {
    const temp_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooxml-benchmark-result-'));
    const candidate_path = path.join(temp_dir, 'candidate.json');
    try {
        fs.writeFileSync(candidate_path, serialize_result(result));
        const compared = spawnSync(
            process.execPath,
            [COMPARE_PATH, baseline_path, candidate_path],
            { encoding: 'utf8', maxBuffer: 1024 * 1024 },
        );
        if (compared.stdout) process.stdout.write(compared.stdout);
        if (compared.stderr) process.stderr.write(compared.stderr);
        if (![0, 1, 2].includes(compared.status)) {
            shape_error(`comparison process exited ${compared.status}`);
        }
        return compared.status;
    } finally {
        fs.rmSync(temp_dir, { recursive: true, force: true });
    }
}

async function main() {
    const options = parse_args(process.argv.slice(2));
    validate_real_fixture();
    const temporary_dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ooxml-benchmark-fixture-'));
    let bundle_dir;
    let result;
    try {
        const non_ascii_path = path.join(temporary_dir, 'non-ascii.xlsx');
        const non_ascii_shape = build_non_ascii_fixture(non_ascii_path);
        const fixtures = [
            {
                name: 'real',
                fixture_path: REAL_FIXTURE_PATH,
                worksheet_path: REAL_WORKSHEET_PATH,
                worksheet_bytes: REAL_WORKSHEET_BYTES,
                worksheet_rows: REAL_WORKSHEET_ROWS,
                save_sheet_index: 3,
            },
            {
                name: 'non-ascii',
                fixture_path: non_ascii_path,
                worksheet_path: NON_ASCII_WORKSHEET_PATH,
                worksheet_bytes: non_ascii_shape.worksheet_bytes,
                worksheet_rows: NON_ASCII_WORKSHEET_ROWS,
                save_sheet_index: 0,
            },
        ];
        const bundle = await build_source_bundle();
        bundle_dir = bundle.bundle_dir;
        const scenarios = {};
        for (const fixture of fixtures) {
            for (const phase of PHASES) {
                const scenario = `${fixture.name}-${phase}`;
                const samples = [];
                for (let sample = 1; sample <= options.sample_count; sample++) {
                    console.error(`${scenario}: sample ${sample}/${options.sample_count}`);
                    samples.push(run_sample(phase, fixture, bundle.bundle_path));
                }
                scenarios[scenario] = aggregate_phase(samples);
            }
        }
        result = {
            meta: {
                schema: 1,
                date: new Date().toISOString(),
                node: process.version,
                node_major: Number(process.versions.node.split('.')[0]),
                platform: process.platform,
                arch: process.arch,
                label: options.label,
                sample_count: options.sample_count,
                aggregation: 'median of fresh child processes',
                fixtures: {
                    real: {
                        path: REAL_FIXTURE_RELATIVE_PATH,
                        bytes: REAL_FIXTURE_BYTES,
                        sha256: REAL_FIXTURE_SHA256,
                        worksheet_path: REAL_WORKSHEET_PATH,
                        worksheet_bytes: REAL_WORKSHEET_BYTES,
                        worksheet_rows: REAL_WORKSHEET_ROWS,
                    },
                    non_ascii: {
                        generator: 'inline-string-v1',
                        package_bytes: non_ascii_shape.package_bytes,
                        worksheet_path: NON_ASCII_WORKSHEET_PATH,
                        worksheet_bytes: non_ascii_shape.worksheet_bytes,
                        worksheet_sha256: non_ascii_shape.worksheet_sha256,
                        worksheet_rows: NON_ASCII_WORKSHEET_ROWS,
                        worksheet_columns: NON_ASCII_WORKSHEET_COLUMNS,
                        cell_text: NON_ASCII_CELL_TEXT,
                    },
                },
            },
            scenarios,
        };
    } finally {
        if (bundle_dir) fs.rmSync(bundle_dir, { recursive: true, force: true });
        fs.rmSync(temporary_dir, { recursive: true, force: true });
    }

    if (options.output_path || !options.compare_path) {
        write_result(result, options.output_path);
    }
    return options.compare_path ? compare_result(result, options.compare_path) : 0;
}

try {
    process.exitCode = await main();
} catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    console.error(`SHAPE ERROR: ${detail}`);
    process.exitCode = 2;
}

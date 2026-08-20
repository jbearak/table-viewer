#!/usr/bin/env node
// One benchmark measurement in one fresh process. The parent always launches
// this worker with --expose-gc so live deltas are taken after two forced GCs.
import { performance } from 'node:perf_hooks';
import { memoryUsage, resourceUsage } from 'node:process';
import { pathToFileURL } from 'node:url';
import * as fs from 'node:fs';
import CFB from 'cfb';

const [, , phase, profile_json, bundle_path] = process.argv;

function shape_error(message) {
    console.error(`SHAPE ERROR: ${message}`);
    process.exit(2);
}

function force_gc() {
    if (typeof global.gc !== 'function') {
        shape_error('worker must run with --expose-gc');
    }
    global.gc();
    global.gc();
}

function parse_profile(json) {
    let profile;
    try {
        profile = JSON.parse(json);
    } catch (error) {
        shape_error(`invalid fixture profile: ${String(error)}`);
    }
    for (const key of ['fixture_path', 'worksheet_path']) {
        if (typeof profile?.[key] !== 'string' || profile[key].length === 0) {
            shape_error(`fixture profile is missing ${key}`);
        }
    }
    for (const key of ['worksheet_bytes', 'worksheet_rows', 'save_sheet_index']) {
        if (!Number.isSafeInteger(profile?.[key]) || profile[key] < 0) {
            shape_error(`fixture profile has invalid ${key}`);
        }
    }
    return profile;
}

function worksheet_content(cfb_file, profile) {
    const entry = CFB.find(cfb_file, profile.worksheet_path);
    if (!entry || !Buffer.isBuffer(entry.content)) {
        shape_error(`fixture is missing Buffer entry ${profile.worksheet_path}`);
    }
    if (entry.content.byteLength !== profile.worksheet_bytes) {
        shape_error(
            `${profile.worksheet_path} is ${entry.content.byteLength} bytes; `
            + `expected ${profile.worksheet_bytes}`,
        );
    }
    return entry.content;
}

function verify_saved_output(output, profile) {
    let saved;
    try {
        saved = CFB.read(output, { type: 'buffer' });
    } catch {
        shape_error('full save output is not a readable workbook');
    }
    const entry = CFB.find(saved, profile.worksheet_path);
    if (!entry || !Buffer.isBuffer(entry.content)) {
        shape_error(`full save output is missing ${profile.worksheet_path}`);
    }
    const xml = entry.content.toString('utf8');
    const cell_start = xml.indexOf('<c r="A1"');
    if (cell_start === -1) {
        shape_error('full save output does not contain A1');
    }
    const cell_end = xml.indexOf('</c>', cell_start);
    if (cell_end === -1
        || !xml.slice(cell_start, cell_end).includes('>OOXML benchmark</t>')) {
        shape_error('full save output does not contain the benchmark edit at A1');
    }

    const before_members = raw_zip_members(fs.readFileSync(profile.fixture_path));
    const after_members = raw_zip_members(output);
    const before_names = [...before_members.keys()].sort();
    const after_names = [...after_members.keys()].sort();
    if (JSON.stringify(after_names) !== JSON.stringify(before_names)) {
        shape_error('full save changed the ZIP member inventory');
    }
    const changed = profile.worksheet_path.replace(/^\//, '');
    for (const [name, before] of before_members) {
        if (name === changed) continue;
        const after = after_members.get(name);
        if (!after || !after.local_record.equals(before.local_record)) {
            shape_error(`full save changed untouched local record ${name}`);
        }
    }
}

function raw_zip_members(raw) {
    let eocd = raw.length - 22;
    for (; eocd >= Math.max(0, raw.length - 0xffff - 22); eocd--) {
        if (raw.readUInt32LE(eocd) === 0x06054b50
            && eocd + 22 + raw.readUInt16LE(eocd + 20) === raw.length) break;
    }
    if (eocd < 0) shape_error('saved output has no ZIP end record');
    const count = raw.readUInt16LE(eocd + 10);
    const central_offset = raw.readUInt32LE(eocd + 16);
    const entries = [];
    let central = central_offset;
    for (let index = 0; index < count; index++) {
        if (raw.readUInt32LE(central) !== 0x02014b50) {
            shape_error('saved output has an invalid central directory');
        }
        const name_length = raw.readUInt16LE(central + 28);
        const extra_length = raw.readUInt16LE(central + 30);
        const comment_length = raw.readUInt16LE(central + 32);
        const name = raw.subarray(central + 46, central + 46 + name_length).toString('utf8');
        entries.push({ name, local_offset: raw.readUInt32LE(central + 42) });
        central += 46 + name_length + extra_length + comment_length;
    }
    const physical = [...entries].sort((left, right) => left.local_offset - right.local_offset);
    const local_end = new Map();
    for (let index = 0; index < physical.length; index++) {
        local_end.set(physical[index], physical[index + 1]?.local_offset ?? central_offset);
    }
    const members = new Map();
    for (const entry of entries) {
        if (members.has(entry.name)) shape_error(`duplicate ZIP member ${entry.name}`);
        members.set(entry.name, {
            local_record: raw.subarray(entry.local_offset, local_end.get(entry)),
        });
    }
    return members;
}

function worksheet_input_byte_length(input) {
    return typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
}

function* first_column_coordinates(row_count) {
    // One requested coordinate per fixture row makes cells_present walk every
    // row and every cell while retaining only a compact, checkable result.
    for (let row = 0; row < row_count; row++) {
        yield { row, col: 0 };
    }
}

async function measure_phase() {
    if (!phase || !profile_json) {
        shape_error('usage: worker.mjs <phase> <fixture-profile-json> <source-bundle.mjs>');
    }
    const profile = parse_profile(profile_json);
    const raw = fs.readFileSync(profile.fixture_path);
    let elapsed_ms;
    let result;

    // For decode and coordinate scan, CFB.read is setup rather than part of the
    // timed phase. The live baseline is package-ready but has no decoded sheet.
    // That deliberately keeps the decoded string in coordinate-scan's live
    // footprint: Stage 6 must be able to demonstrate that its byte scan removes
    // this retained allocation, while elapsed_ms still times only the scan.
    let cfb_file;
    let content;
    let source;
    if (phase === 'worksheet-decode' || phase === 'coordinate-scan') {
        cfb_file = CFB.read(raw, { type: 'buffer' });
        content = worksheet_content(cfb_file, profile);
    }
    if (phase === 'worksheet-decode' || phase === 'coordinate-scan' || phase === 'full-save') {
        if (!bundle_path) shape_error(`${phase} requires a source bundle`);
        source = await import(pathToFileURL(bundle_path).href);
    }

    // Keep every baseline object explicitly reachable through both snapshots.
    // Otherwise V8 may collect setup state during the post-measurement GCs and
    // make its teardown cancel the allocation this benchmark is measuring.
    const hold = { raw, cfb_file, content, source, result: undefined };
    globalThis.__ooxml_benchmark_hold = hold;
    force_gc();
    const before = memoryUsage();

    switch (phase) {
        case 'cfb-read': {
            const started = performance.now();
            cfb_file = CFB.read(raw, { type: 'buffer' });
            elapsed_ms = performance.now() - started;
            content = worksheet_content(cfb_file, profile);
            result = cfb_file;
            break;
        }
        case 'worksheet-decode': {
            const started = performance.now();
            const xml = source.worksheet_scan_input(content);
            elapsed_ms = performance.now() - started;
            if (worksheet_input_byte_length(xml) !== profile.worksheet_bytes) {
                shape_error('worksheet scan input byte length changed');
            }
            result = xml;
            break;
        }
        case 'coordinate-scan': {
            const xml = source.worksheet_scan_input(content);
            const started = performance.now();
            const found = source.cells_present(
                xml,
                first_column_coordinates(profile.worksheet_rows),
            );
            elapsed_ms = performance.now() - started;
            if (found.size !== profile.worksheet_rows) {
                shape_error(
                    `coordinate scan found ${found.size} first-column cells; `
                    + `expected ${profile.worksheet_rows}`,
                );
            }
            // Retain both input and result through the post-measurement GCs.
            result = { xml, found };
            break;
        }
        case 'full-save': {
            const started = performance.now();
            const output = source.write_xlsx_cell_edits(raw, profile.save_sheet_index, [
                { row: 0, col: 0, value: 'OOXML benchmark' },
            ]);
            elapsed_ms = performance.now() - started;
            if (!(output instanceof Uint8Array) || output.byteLength === 0) {
                shape_error('full save did not produce workbook bytes');
            }
            result = output;
            break;
        }
        default:
            shape_error(`unknown phase: ${phase}`);
    }

    hold.cfb_file = cfb_file;
    hold.content = content;
    hold.source = source;
    hold.result = result;
    force_gc();
    const after = memoryUsage();
    const max_rss_kib = resourceUsage().maxRSS;

    // Keep external and heapUsed separate. Adding them is invalid here: V8 can
    // re-account the source Buffer between the two, making real decode memory
    // appear to cancel to zero.
    const measurement = {
        time_ms: elapsed_ms,
        peak_rss_mib: max_rss_kib / 1024,
        live_external_delta_mib: (after.external - before.external) / (1024 * 1024),
        live_heap_used_delta_mib: (after.heapUsed - before.heapUsed) / (1024 * 1024),
    };
    // Verify after both snapshots so validation cannot inflate the reported peak
    // or live deltas.
    if (phase === 'full-save') verify_saved_output(result, profile);
    return measurement;
}

try {
    const measurement = await measure_phase();
    process.stdout.write(`${JSON.stringify(measurement)}\n`);
} catch (error) {
    shape_error(error instanceof Error ? error.stack ?? error.message : String(error));
}

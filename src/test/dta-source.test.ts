import { Buffer } from 'node:buffer';
import { createHash } from 'node:crypto';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { cells_exactly_equal } from '../cell-display';
import {
    DEFERRED_COMPARISON_IDENTITY,
    DEFERRED_FILTER_IDENTITY,
    type RawCell,
} from '../data-source/interface';
import { displayed_text } from '../webview/cell-renderer';
import { compute_column_histogram } from '../histograms';
import { compute_transform } from '../table-transform';
import { align_sheet } from '../diff-compare/row-alignment';

const decode_spy = vi.hoisted(() => vi.fn());
vi.mock('@jbearak/dta-parser', async (import_original) => {
    const actual = await import_original<typeof import('@jbearak/dta-parser')>();
    const read_columns = actual.DtaReader.prototype.readColumns;
    actual.DtaReader.prototype.readColumns = function (
        this: InstanceType<typeof actual.DtaReader>,
        ...args: Parameters<typeof read_columns>
    ) {
        decode_spy(...args);
        return read_columns.apply(this, args);
    };
    return actual;
});

import { DtaDataSource } from '../data-source/dta-source';
import { FileDtaDataSource } from '../data-source/file-dta-source';
import { build_source_from_buffer } from '../data-source/from-buffer';

class ByteWriter {
    private readonly bytes: number[] = [];

    get length(): number { return this.bytes.length; }

    text(value: string): void {
        this.bytes.push(...new TextEncoder().encode(value));
    }

    u8(value: number): void { this.bytes.push(value & 0xff); }

    i8(value: number): void { this.u8(value); }

    u16(value: number): void {
        this.bytes.push(value & 0xff, (value >>> 8) & 0xff);
    }

    i32(value: number): void {
        this.bytes.push(
            value & 0xff,
            (value >>> 8) & 0xff,
            (value >>> 16) & 0xff,
            (value >>> 24) & 0xff,
        );
    }

    u64(value: number): void {
        this.i32(value);
        this.i32(0);
    }

    f64(value: number): void {
        const bytes = new Uint8Array(8);
        new DataView(bytes.buffer).setFloat64(0, value, true);
        this.bytes.push(...bytes);
    }

    fixed(value: string, width: number): void {
        this.fixed_bytes(new TextEncoder().encode(value), width);
    }

    fixed_bytes(encoded: Uint8Array, width: number): void {
        if (encoded.length > width) throw new Error('fixture string exceeds field width');
        this.bytes.push(...encoded, ...new Array(width - encoded.length).fill(0));
    }

    patch_u64(offset: number, value: number): void {
        for (let index = 0; index < 8; index++) {
            this.bytes[offset + index] = index < 4 ? (value >>> (index * 8)) & 0xff : 0;
        }
    }

    finish(): Uint8Array { return Uint8Array.from(this.bytes); }
}

interface FixtureVariable {
    name: string;
    typeCode: number;
    format: string;
    valueLabel?: string;
}

interface FixtureValueLabelEntry {
    readonly value: number;
    readonly label: string;
    readonly textKey?: string;
}

interface FixtureValueLabelTable {
    readonly name: string;
    readonly entries: readonly FixtureValueLabelEntry[];
}

interface DtaFixtureOptions {
    readonly firstName?: string;
    readonly statusLabels?: readonly FixtureValueLabelEntry[];
    readonly statusValueLabelTableName?: string;
    readonly extraValueLabelTables?: readonly FixtureValueLabelTable[];
    readonly valueLabelNames?: Partial<Record<'status' | 'amount' | 'missing', string>>;
}

/** Build a tiny release-118 file in memory; no binary fixture is committed. */
function build_dta_fixture(
    observation_count = 4,
    second_strl = false,
    options: DtaFixtureOptions = {},
): Uint8Array {
    const writer = new ByteWriter();
    const variables: FixtureVariable[] = [
        {
            name: 'status', typeCode: 65530, format: '%8.0g',
            valueLabel: options.valueLabelNames?.status ?? 'status_lbl',
        },
        {
            name: 'amount', typeCode: 65526, format: '%9.2f',
            valueLabel: options.valueLabelNames?.amount,
        },
        { name: 'name', typeCode: 5, format: '%-5s' },
        {
            name: 'missing', typeCode: 65530, format: '%8.0g',
            valueLabel: options.valueLabelNames?.missing ?? 'missing_lbl',
        },
        { name: 'long_text', typeCode: 32768, format: '%9s' },
    ];
    if (second_strl) {
        variables.push({ name: 'long_text_2', typeCode: 32768, format: '%9s' });
    }
    const observations: Array<[number, number, string, number, string]> = [
        [1, 12.5, options.firstName ?? 'alpha', 101, 'a long first value'],
        [2, 2, 'beta', 102, 'second long value'],
        [1, 1000, 'gamma', 103, 'third long value'],
        [2, -3.25, 'delta', 127, 'fourth long value'],
    ];
    while (observations.length < observation_count) {
        const index = observations.length;
        observations.push([1, index, 'extra', 101, `long value ${index}`]);
    }
    const offsets = new Map<string, number>();
    const mark = (name: string) => offsets.set(name, writer.length);

    mark('stata_data');
    writer.text('<stata_dta><header><release>118</release><byteorder>LSF</byteorder><K>');
    writer.u16(variables.length);
    writer.text('</K><N>');
    writer.u64(observations.length);
    writer.text('</N><label>');
    writer.u16(0);
    writer.text('</label><timestamp>');
    writer.u8(0);
    writer.text('</timestamp></header>');

    mark('map');
    writer.text('<map>');
    const map_offset = writer.length;
    for (let index = 0; index < 14; index++) writer.u64(0);
    writer.text('</map>');

    mark('variable_types');
    writer.text('<variable_types>');
    for (const variable of variables) writer.u16(variable.typeCode);
    writer.text('</variable_types>');

    mark('varnames');
    writer.text('<varnames>');
    for (const variable of variables) writer.fixed(variable.name, 129);
    writer.text('</varnames>');

    mark('sortlist');
    writer.text('<sortlist>');
    for (let index = 0; index <= variables.length; index++) writer.u16(0);
    writer.text('</sortlist>');

    mark('formats');
    writer.text('<formats>');
    for (const variable of variables) writer.fixed(variable.format, 57);
    writer.text('</formats>');

    mark('value_label_names');
    writer.text('<value_label_names>');
    for (const variable of variables) writer.fixed(variable.valueLabel ?? '', 129);
    writer.text('</value_label_names>');

    mark('variable_labels');
    writer.text('<variable_labels>');
    for (const _variable of variables) writer.fixed('', 321);
    writer.text('</variable_labels>');

    mark('characteristics');
    writer.text('<characteristics></characteristics>');

    mark('data');
    writer.text('<data>');
    for (let row = 0; row < observations.length; row++) {
        const [status, amount, name, missing] = observations[row];
        writer.i8(status);
        writer.f64(amount);
        writer.fixed(name, 5);
        writer.i8(missing);
        writer.u16(5);
        writer.i32(row + 1);
        writer.u16(0);
        if (second_strl) {
            writer.u16(6);
            writer.i32(row + 1);
            writer.u16(0);
        }
    }
    writer.text('</data>');

    mark('strls');
    writer.text('<strls>');
    for (let row = 0; row < observations.length; row++) {
        const content = new TextEncoder().encode(`${observations[row][4]}\0`);
        writer.text('GSO');
        writer.i32(5);
        writer.u64(row + 1);
        writer.u8(130);
        writer.i32(content.length);
        for (const byte of content) writer.u8(byte);
        if (second_strl) {
            const second_content = new TextEncoder().encode(`second ${row}\0`);
            writer.text('GSO');
            writer.i32(6);
            writer.u64(row + 1);
            writer.u8(130);
            writer.i32(second_content.length);
            for (const byte of second_content) writer.u8(byte);
        }
    }
    writer.text('</strls>');

    mark('value_labels');
    writer.text('<value_labels>');
    const write_value_label_table = (
        name: string,
        entries: readonly FixtureValueLabelEntry[],
    ) => {
        writer.text('<lbl>');
        const text_by_key = new Map<string, { label: string; bytes: Uint8Array; offset: number }>();
        let next_text_offset = 0;
        const text_offsets = entries.map((entry, index) => {
            const key = entry.textKey ?? `entry:${index}`;
            const existing = text_by_key.get(key);
            if (existing !== undefined) {
                if (existing.label !== entry.label) {
                    throw new Error('shared fixture value-label text keys must use the same label');
                }
                return existing.offset;
            }
            const bytes = new TextEncoder().encode(`${entry.label}\0`);
            const offset = next_text_offset;
            next_text_offset += bytes.length;
            text_by_key.set(key, { label: entry.label, bytes, offset });
            return offset;
        });
        const texts = [...text_by_key.values()];
        const text_length = texts.reduce((total, text) => total + text.bytes.length, 0);
        const payload_length = 8 + entries.length * 8 + text_length;
        writer.i32(payload_length);
        writer.fixed(name, 129);
        writer.u8(0); writer.u8(0); writer.u8(0);
        writer.i32(entries.length);
        writer.i32(text_length);
        for (const offset of text_offsets) writer.i32(offset);
        for (const { value } of entries) writer.i32(value);
        for (const text of texts) for (const byte of text.bytes) writer.u8(byte);
        writer.text('</lbl>');
    };
    write_value_label_table(options.statusValueLabelTableName ?? 'status_lbl', options.statusLabels ?? [
        { value: 1, label: 'Zulu' },
        { value: 2, label: 'Alpha' },
        { value: 3, label: 'Zulu' },
    ]);
    write_value_label_table('missing_lbl', [
        { value: 2147483622, label: 'Refused' }, // .a's value-label key
    ]);
    for (const table of options.extraValueLabelTables ?? []) {
        write_value_label_table(table.name, table.entries);
    }
    writer.text('</value_labels>');

    mark('stata_data_close');
    writer.text('</stata_dta>');
    mark('end_of_file');

    const map_names = [
        'stata_data', 'map', 'variable_types', 'varnames', 'sortlist', 'formats',
        'value_label_names', 'variable_labels', 'characteristics', 'data', 'strls',
        'value_labels', 'stata_data_close', 'end_of_file',
    ];
    map_names.forEach((name, index) => writer.patch_u64(map_offset + index * 8, offsets.get(name)!));
    return writer.finish();
}

interface FixtureGsoRecord {
    readonly start: number;
    readonly end: number;
}

function release118_gso_records(fixture: Uint8Array): FixtureGsoRecord[] {
    const records: FixtureGsoRecord[] = [];
    const view = new DataView(fixture.buffer, fixture.byteOffset, fixture.byteLength);
    let position = find_tag_end(fixture, '<strls>');
    while (
        fixture[position] === 0x47
        && fixture[position + 1] === 0x53
        && fixture[position + 2] === 0x4f
    ) {
        const end = position + 20 + view.getUint32(position + 16, true);
        records.push({ start: position, end });
        position = end;
    }
    return records;
}

function reorder_release118_gso_prefix(
    fixture: Uint8Array,
    order: readonly number[],
): void {
    const records = release118_gso_records(fixture).slice(0, order.length);
    const snapshots = records.map(({ start, end }) => fixture.slice(start, end));
    if (new Set(order).size !== records.length || order.some((index) => snapshots[index] === undefined)) {
        throw new Error('fixture GSO order must be a complete prefix permutation');
    }
    let position = records[0].start;
    for (const index of order) {
        fixture.set(snapshots[index], position);
        position += snapshots[index].length;
    }
}

function keep_release118_gso_prefix(
    fixture: Uint8Array,
    count: number,
): Uint8Array {
    const records = release118_gso_records(fixture);
    const close_start = find_tag_end(fixture, '</strls>') - '</strls>'.length;
    const cut_start = records[count]?.start ?? close_start;
    if (cut_start >= close_start) return fixture.slice();
    const removed = close_start - cut_start;
    const result = new Uint8Array(fixture.length - removed);
    result.set(fixture.subarray(0, cut_start));
    result.set(fixture.subarray(close_start), cut_start);

    const map_start = find_tag_end(result, '<map>');
    const view = new DataView(result.buffer);
    for (let index = 0; index < 14; index++) {
        const offset = map_start + index * 8;
        const section = Number(view.getBigUint64(offset, true));
        if (section >= close_start) {
            view.setBigUint64(offset, BigInt(section - removed), true);
        }
    }
    return result;
}

function build_legacy_dta_fixture(
    expansion_length = 0,
    zero_length_fields = 0,
    text_byte = 0xe9,
    label_name_byte?: number,
): Uint8Array {
    const writer = new ByteWriter();
    const label_name = label_name_byte === undefined
        ? new TextEncoder().encode('legacy_lbl')
        : Uint8Array.of(...new TextEncoder().encode('legacy_'), label_name_byte);
    writer.u8(115);
    writer.u8(2); // LSF
    writer.u8(1); // file type
    writer.u8(0);
    writer.u16(2);
    writer.i32(3);
    writer.fixed('Legacy fixture', 81);
    writer.fixed('', 18);
    writer.u8(251); // byte
    writer.u8(5); // str5
    writer.fixed('legacy_value', 33);
    writer.fixed('legacy_text', 33);
    writer.u16(0); writer.u16(0); writer.u16(0);
    writer.fixed('%8.0g', 49);
    writer.fixed('%5s', 49);
    writer.fixed_bytes(label_name, 33); writer.fixed('', 33);
    writer.fixed('', 81); writer.fixed('', 81);
    for (let field = 0; field < zero_length_fields; field++) {
        writer.u8(1); writer.i32(0);
    }
    writer.u8(0); writer.i32(expansion_length); // expansion-fields terminator
    writer.i8(3); writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(text_byte); writer.u8(0);
    writer.i8(1); writer.fixed('plain', 5);
    writer.i8(2); writer.fixed('text', 5);
    const label = Uint8Array.of(0x43, 0x61, 0x66, text_byte, 0);
    writer.i32(8 + 8 + label.length);
    writer.fixed_bytes(label_name, 33);
    writer.u8(0); writer.u8(0); writer.u8(0);
    writer.i32(1);
    writer.i32(label.length);
    writer.i32(0);
    writer.i32(3);
    for (const byte of label) writer.u8(byte);
    return writer.finish();
}

function build_pre111_value_label_fixture(
    version: 105 | 108,
    table_name_width = 9,
    table_count = 1,
): Uint8Array {
    const writer = new ByteWriter();
    const dataset_label_width = version === 105 ? 32 : 81;
    const variable_label_width = version === 105 ? 32 : 81;
    writer.u8(version);
    writer.u8(2); // LSF
    writer.u8(1); // file type
    writer.u8(0);
    writer.u16(1);
    writer.i32(1);
    writer.fixed('Legacy labels', dataset_label_width);
    writer.fixed('', 18);
    writer.u8(98); // byte in releases before 111
    writer.fixed('status', 9);
    writer.u16(0); writer.u16(0);
    writer.fixed('%8.0g', 12);
    writer.fixed('statuslbl', 9);
    writer.fixed('', variable_label_width);
    writer.u8(0); writer.u16(0); // expansion-fields terminator
    writer.i8(3);

    for (let table = 0; table < table_count; table++) {
        if (version === 105) {
            writer.u16(2);
            writer.fixed('statuslbl', 9);
            writer.u8(0);
            writer.u16(1); writer.u16(3);
            writer.fixed('One', 8); writer.fixed('Third', 8);
        } else {
            const first = new TextEncoder().encode('One\0');
            const third = new TextEncoder().encode('Third\0');
            const text_length = first.length + third.length;
            writer.i32(8 + 2 * 8 + text_length);
            writer.fixed('statuslbl', table_name_width);
            writer.u8(0); writer.u8(0); writer.u8(0);
            writer.i32(2);
            writer.i32(text_length);
            writer.i32(0); writer.i32(first.length);
            writer.i32(1); writer.i32(3);
            for (const byte of first) writer.u8(byte);
            for (const byte of third) writer.u8(byte);
        }
    }
    return writer.finish();
}

async function with_temporary_dta<T>(
    bytes: Uint8Array,
    action: (file_path: string) => Promise<T>,
): Promise<T> {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-dta-preflight-'));
    const file_path = path.join(directory, 'fixture.dta');
    fs.writeFileSync(file_path, bytes);
    try {
        return await action(file_path);
    } finally {
        fs.rmSync(directory, { recursive: true, force: true });
    }
}

function build_release117_fixture(text_byte = 0xe9): Uint8Array {
    const writer = new ByteWriter();
    const offsets = new Map<string, number>();
    const mark = (name: string) => offsets.set(name, writer.length);
    mark('stata_data');
    writer.text('<stata_dta><header><release>117</release><byteorder>LSF</byteorder><K>');
    writer.u16(2);
    writer.text('</K><N>'); writer.i32(1);
    writer.text('</N><label>'); writer.u8(0);
    writer.text('</label><timestamp>'); writer.u8(0);
    writer.text('</timestamp></header>');
    mark('map'); writer.text('<map>');
    const map_offset = writer.length;
    for (let index = 0; index < 14; index++) writer.u64(0);
    writer.text('</map>');
    mark('variable_types'); writer.text('<variable_types>'); writer.u16(5); writer.u16(32768);
    writer.text('</variable_types>');
    mark('varnames'); writer.text('<varnames>');
    writer.fixed('text', 33); writer.fixed('long_text', 33); writer.text('</varnames>');
    mark('sortlist'); writer.text('<sortlist>');
    writer.u16(0); writer.u16(0); writer.u16(0); writer.text('</sortlist>');
    mark('formats'); writer.text('<formats>');
    writer.fixed('%5s', 49); writer.fixed('%9s', 49); writer.text('</formats>');
    mark('value_label_names'); writer.text('<value_label_names>');
    writer.fixed('', 33); writer.fixed('', 33); writer.text('</value_label_names>');
    mark('variable_labels'); writer.text('<variable_labels>');
    writer.fixed('', 81); writer.fixed('', 81); writer.text('</variable_labels>');
    mark('characteristics'); writer.text('<characteristics></characteristics>');
    mark('data'); writer.text('<data>');
    writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(text_byte); writer.u8(0);
    writer.i32(2); writer.i32(1);
    writer.text('</data>');
    mark('strls'); writer.text('<strls>GSO');
    writer.i32(2); writer.i32(1); writer.u8(130); writer.i32(5);
    writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(text_byte); writer.u8(0);
    writer.text('</strls>');
    mark('value_labels'); writer.text('<value_labels></value_labels>');
    mark('stata_data_close'); writer.text('</stata_dta>');
    mark('end_of_file');
    const names = [
        'stata_data', 'map', 'variable_types', 'varnames', 'sortlist', 'formats',
        'value_label_names', 'variable_labels', 'characteristics', 'data', 'strls',
        'value_labels', 'stata_data_close', 'end_of_file',
    ];
    names.forEach((name, index) => writer.patch_u64(map_offset + index * 8, offsets.get(name)!));
    return writer.finish();
}

function build_release119_strl_rows_fixture(
    contents: readonly Uint8Array[],
    type = 129,
    leading_numeric = false,
): Uint8Array {
    const writer = new ByteWriter();
    const offsets = new Map<string, number>();
    const mark = (name: string) => offsets.set(name, writer.length);
    mark('stata_data');
    writer.text('<stata_dta><header><release>119</release><byteorder>LSF</byteorder><K>');
    writer.i32(leading_numeric ? 2 : 1);
    writer.text('</K><N>'); writer.u64(contents.length);
    writer.text('</N><label>'); writer.u16(0);
    writer.text('</label><timestamp>'); writer.u8(0);
    writer.text('</timestamp></header>');
    mark('map'); writer.text('<map>');
    const map_offset = writer.length;
    for (let index = 0; index < 14; index++) writer.u64(0);
    writer.text('</map>');
    mark('variable_types'); writer.text('<variable_types>');
    if (leading_numeric) writer.u16(65530);
    writer.u16(32768);
    writer.text('</variable_types>');
    mark('varnames'); writer.text('<varnames>');
    if (leading_numeric) writer.fixed('number', 129);
    writer.fixed('long_text', 129);
    writer.text('</varnames>');
    mark('sortlist'); writer.text('<sortlist>');
    for (let index = 0; index < (leading_numeric ? 3 : 2); index++) writer.i32(0);
    writer.text('</sortlist>');
    mark('formats'); writer.text('<formats>');
    if (leading_numeric) writer.fixed('%8.0g', 57);
    writer.fixed('%9s', 57);
    writer.text('</formats>');
    mark('value_label_names'); writer.text('<value_label_names>');
    if (leading_numeric) writer.fixed('', 129);
    writer.fixed('', 129);
    writer.text('</value_label_names>');
    mark('variable_labels'); writer.text('<variable_labels>');
    if (leading_numeric) writer.fixed('', 321);
    writer.fixed('', 321);
    writer.text('</variable_labels>');
    mark('characteristics'); writer.text('<characteristics></characteristics>');
    mark('data'); writer.text('<data>');
    const strl_variable = leading_numeric ? 2 : 1;
    for (let row = 0; row < contents.length; row++) {
        if (leading_numeric) writer.i8(row);
        // Release 119 packs v into 3 bytes and o into 5 bytes.
        writer.u8(strl_variable); writer.u8(0); writer.u8(0);
        writer.i32(row + 1); writer.u8(0);
    }
    writer.text('</data>');
    mark('strls'); writer.text('<strls>');
    for (let row = 0; row < contents.length; row++) {
        const content = contents[row];
        writer.text('GSO');
        writer.i32(strl_variable); writer.u64(row + 1); writer.u8(type); writer.i32(content.length);
        for (const byte of content) writer.u8(byte);
    }
    writer.text('</strls>');
    mark('value_labels'); writer.text('<value_labels></value_labels>');
    mark('stata_data_close'); writer.text('</stata_dta>');
    mark('end_of_file');
    const names = [
        'stata_data', 'map', 'variable_types', 'varnames', 'sortlist', 'formats',
        'value_label_names', 'variable_labels', 'characteristics', 'data', 'strls',
        'value_labels', 'stata_data_close', 'end_of_file',
    ];
    names.forEach((name, index) => writer.patch_u64(map_offset + index * 8, offsets.get(name)!));
    return writer.finish();
}

function build_release119_strl_fixture(
    content = new TextEncoder().encode('hello\0'),
    type = 130,
): Uint8Array {
    return build_release119_strl_rows_fixture([content], type);
}

function build_large_release119_binary_fixture(content: Uint8Array): Uint8Array {
    const shell = build_release119_strl_fixture(new Uint8Array(0), 129);
    const strls = find_tag_end(shell, '<strls>');
    const content_start = strls + 3 + 4 + 8 + 1 + 4;
    const result = new Uint8Array(shell.length + content.length);
    result.set(shell.subarray(0, content_start));
    result.set(content, content_start);
    result.set(shell.subarray(content_start), content_start + content.length);
    const view = new DataView(result.buffer);
    view.setInt32(content_start - 4, content.length, true);
    const map_start = find_tag_end(result, '<map>');
    for (let index = 0; index < 14; index++) {
        const offset = map_start + index * 8;
        const section = Number(view.getBigUint64(offset, true));
        if (section >= content_start) {
            view.setBigUint64(offset, BigInt(section + content.length), true);
        }
    }
    return result;
}

/** The dta-parser error code behind `error`, following table-viewer's `cause` wrapping. */
function dta_error_code(error: unknown): string | undefined {
    for (let at = error; at instanceof Error; at = at.cause) {
        if ('code' in at && typeof at.code === 'string' && at.code.startsWith('DTA_')) return at.code;
    }
    return undefined;
}

function thrown_code(run: () => unknown): string | undefined {
    try {
        run();
    } catch (error) {
        return dta_error_code(error) ?? 'no dta-parser code';
    }
    return 'did not throw';
}

async function rejected_code(promise: Promise<unknown>): Promise<string | undefined> {
    try {
        await promise;
    } catch (error) {
        return dta_error_code(error) ?? 'no dta-parser code';
    }
    return 'did not reject';
}

function find_tag_end(bytes: Uint8Array, tag: string): number {
    const encoded = new TextEncoder().encode(tag);
    for (let offset = 0; offset <= bytes.length - encoded.length; offset++) {
        if (encoded.every((byte, index) => bytes[offset + index] === byte)) {
            return offset + encoded.length;
        }
    }
    throw new Error(`fixture is missing ${tag}`);
}

function first_release118_value_label_payload_start(bytes: Uint8Array): number {
    return find_tag_end(bytes, '<value_labels>')
        + '<lbl>'.length
        + 4
        + 129
        + 3;
}

function texts(rows: ReturnType<DtaDataSource['read_rows']>['rows']) {
    return rows.map((row) => row.map((cell) => ({ raw: cell?.raw, formatted: cell?.formatted })));
}

function binary_comparison_identity(cell: RawCell) {
    return cell[DEFERRED_COMPARISON_IDENTITY]!;
}

function binary_filter_identity(cell: RawCell) {
    return cell[DEFERRED_FILTER_IDENTITY]!;
}

describe('DtaDataSource', () => {
    it('reads metadata without eagerly decoding observations', async () => {
        decode_spy.mockClear();
        const source = await DtaDataSource.create(build_dta_fixture());
        expect(source.meta()).toEqual({
            hasFormatting: true,
            sheets: [{
                name: 'Sheet1',
                unnamedSingleSheet: true,
                rowCount: 4,
                sourceRowCount: 4,
                columnCount: 5,
                estimatedRowBytes: 23,
                merges: [],
                hasFormatting: true,
                columnNames: ['status', 'amount', 'name', 'missing', 'long_text'],
            }],
        });
        expect(decode_spy).not.toHaveBeenCalled();
    });

    it('keeps raw numbers while formatting labels and display formats', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const row = source.read_rows(0, 0, 1).rows[0];
        expect(row[0]).toMatchObject({ raw: '1', formatted: 'Zulu', rawType: 'number' });
        expect(row[1]).toMatchObject({ raw: '12.5', formatted: '12.50', rawType: 'number' });
        expect(row[2]).toMatchObject({ raw: 'alpha', formatted: 'alpha', rawType: 'string' });
        expect(row[4]).toMatchObject({
            raw: 'a long first value',
            formatted: 'a long first value',
            rawType: 'string',
        });
        expect(displayed_text(row[0], false, undefined)).toBe('1');
        expect(displayed_text(row[0], true, undefined)).toBe('Zulu');

        const sorted = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...sorted.indices!]).toEqual([0, 2, 1, 3]);
    });

    it('returns identical canonical raw values from fast and rendered paths', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const fast = source.read_raw_columns(0, 0, 4, [0, 1, 2, 3, 4]).rows;
        const rendered = source.read_rows(0, 0, 4).rows;
        expect(fast).toEqual(rendered.map((row) => row.map((cell) =>
            cell === null
                ? null
                : {
                    raw: cell.raw,
                    rawType: cell.rawType,
                    ...(cell.comparisonKey === undefined ? {} : { comparisonKey: cell.comparisonKey }),
                },
        )));
        expect(fast.map((row) => row[3])).toEqual([
            { raw: '.', rawType: 'number', comparisonKey: 'stata:missing:.' },
            { raw: '.a', rawType: 'number', comparisonKey: 'stata:missing:.a' },
            { raw: '.b', rawType: 'number', comparisonKey: 'stata:missing:.b' },
            { raw: '.z', rawType: 'number', comparisonKey: 'stata:missing:.z' },
        ]);
        expect(fast[0]).toEqual([
            { raw: '1', rawType: 'number' },
            { raw: '12.5', rawType: 'number' },
            { raw: 'alpha', rawType: 'string' },
            { raw: '.', rawType: 'number', comparisonKey: 'stata:missing:.' },
            { raw: 'a long first value', rawType: 'string' },
        ]);
        expect(rendered[0][0]?.formatted).toBe('Zulu');
    });

    it('renders arbitrary async rows in requested order with Stata formatting', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());

        const async_rows = await source.read_rows_indexed_async(
            0,
            [3, 0, 3],
            () => false,
        );

        expect(async_rows).toEqual(source.read_rows_indexed(0, [3, 0, 3]));
        expect(async_rows.rows[1][0]).toMatchObject({ raw: '1', formatted: 'Zulu' });
        expect(async_rows.rows[1][1]).toMatchObject({ raw: '12.5', formatted: '12.50' });
        expect(async_rows.rows[1][3]).toMatchObject({ raw: '.', formatted: '.' });
    });

    it('keeps Stata filter labels display-only and categorical by label semantics', async () => {
        const fixture = build_dta_fixture();
        const data_start = find_tag_end(fixture, '<data>');
        fixture[data_start + 3 * 23] = 3;
        const source = await DtaDataSource.create(fixture);

        const status = await compute_column_histogram(source, 0, 0, () => false);
        expect(status).toMatchObject({
            columnKind: 'numeric',
            defaultCategorical: true,
            distinctValues: [
                { value: '1', label: 'Zulu' },
                { value: '2', label: 'Alpha' },
                { value: '3', label: 'Zulu' },
            ],
        });
        const missing = await compute_column_histogram(source, 0, 3, () => false);
        expect(missing.defaultCategorical).toBe(false);
        expect(missing.distinctValues).toEqual([
            { value: '.' },
            { value: '.a', label: 'Refused' },
            { value: '.b' },
            { value: '.z' },
        ]);

        const selected_duplicate_label = await compute_transform(source, 0, {
            sort: [],
            filters: [{
                id: 'status-code-3',
                colIndex: 0,
                operator: 'isOneOf',
                excludedValues: ['1', '2'],
                caseSensitive: false,
                enabled: true,
            }],
        });
        expect([...selected_duplicate_label.indices!]).toEqual([3]);
        const sorted = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...sorted.indices!]).toEqual([0, 2, 1, 3]);
    });

    // dta-parser 1.0 keeps the last table of a repeated name, as pandas does.
    it('uses the last value-label table when a name repeats', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            valueLabelNames: { amount: 'absent_lbl' },
            extraValueLabelTables: [
                { name: 'unreferenced_lbl', entries: [{ value: 1, label: 'Unused' }] },
                { name: 'status_lbl', entries: [{ value: 1, label: 'Wrong duplicate' }] },
            ],
        }));
        expect(source.column_filter_metadata(0, 0)?.valueLabel?.('1')).toBe('Wrong duplicate');
        expect(source.column_filter_metadata(0, 3)?.valueLabel?.('.a')).toBe('Refused');
        expect(source.column_filter_metadata(0, 1)).toBeUndefined();
    });

    it('keeps binary strLs distinct from text and from other binary payloads', async () => {
        const binary = await DtaDataSource.create(
            build_release119_strl_fixture(Uint8Array.of(0x80), 129),
        );
        const other_binary = await DtaDataSource.create(
            build_release119_strl_fixture(Uint8Array.of(0x81), 129),
        );
        const text = await DtaDataSource.create(
            build_release119_strl_fixture(new TextEncoder().encode('binary (1 bytes): 80\0')),
        );
        const binary_cell = binary.read_rows(0, 0, 1).rows[0][0]!;
        const other_binary_cell = other_binary.read_rows(0, 0, 1).rows[0][0]!;
        const text_cell = text.read_rows(0, 0, 1).rows[0][0]!;

        expect(binary_cell.raw).toBe('binary (1 bytes): 80');
        expect(binary_cell.formatted).toBe(binary_cell.raw);
        expect(binary_cell.comparisonKey).toBeUndefined();
        expect(binary_cell.raw).toBe(text_cell.raw);
        const alignment = await align_sheet(binary, text, {
            status: 'matched', name: 'Sheet1', originalIndex: 0, modifiedIndex: 0,
        });
        expect(alignment.changedCells).toBe(1);
        const binary_key = await binary_comparison_identity(binary_cell).resolveKey(() => false);
        const other_key = await binary_comparison_identity(other_binary_cell)
            .resolveKey(() => false);
        expect(binary_key).toMatch(/^stata-binary:sha256:[0-9a-f]{64}:1$/);
        expect(binary_key).not.toBe(other_key);
    });

    it('keeps binary rendering and enumeration lazy with a bounded preview', async () => {
        const payload = new Uint8Array(2 * 1024 * 1024).fill(0xab);
        const source = await DtaDataSource.create(build_release119_strl_fixture(payload, 129));
        const rendered = source.read_rows(0, 0, 1).rows[0][0]!;
        const fast = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        expect(rendered.raw!.length).toBeLessThan(128);
        expect(rendered.formatted.length).toBeLessThan(128);
        expect(rendered.formatted).toContain('2097152 bytes');
        expect(displayed_text(rendered, false, undefined)).toBe(rendered.raw);
        expect(displayed_text(rendered, true, undefined)).toBe(rendered.formatted);
        expect(fast.raw).toBe(rendered.raw);
        expect(fast.comparisonKey).toBeUndefined();
        expect(fast.filterKey).toBeUndefined();
        expect(Object.keys(fast)).toEqual(['raw', 'rawType', 'rawByteLength']);
        expect(JSON.stringify(fast)).not.toContain('sha256');
        expect(binary_comparison_identity(fast)).toBe(binary_filter_identity(fast));
        const reread = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        expect(binary_comparison_identity(reread)).toBe(binary_comparison_identity(fast));

        const key = await binary_comparison_identity(fast).resolveKey(() => false);
        expect(key).toMatch(/^stata-binary:sha256:[0-9a-f]{64}:2097152$/);
    });

    it('resolves binary identities larger than 16 MiB asynchronously', async () => {
        const payload = new Uint8Array(17 * 1024 * 1024).fill(0x5a);
        const source = await DtaDataSource.create(
            build_large_release119_binary_fixture(payload),
        );
        const cell = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        let settled = false;
        const resolving = binary_comparison_identity(cell).resolveKey(() => false)
            .then((key) => {
                settled = true;
                return key;
            });
        expect(settled).toBe(false);
        await expect(resolving).resolves.toMatch(
            /^stata-binary:sha256:[0-9a-f]{64}:17825792$/,
        );
    });

    it('distinguishes equal binary previews by later backing bytes', async () => {
        const left_payload = new Uint8Array(64).fill(0x2a);
        const right_payload = left_payload.slice();
        right_payload[63] = 0x2b;
        const left = await DtaDataSource.create(
            build_release119_strl_fixture(left_payload, 129),
        );
        const right = await DtaDataSource.create(
            build_release119_strl_fixture(right_payload, 129),
        );
        const left_cell = left.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        const right_cell = right.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        expect(left_cell.raw).toBe(right_cell.raw);
        const equal = cells_exactly_equal(left_cell, right_cell, () => false);
        await expect(typeof equal === 'boolean' ? Promise.resolve(equal) : equal)
            .resolves.toBe(false);
        const left_key = await binary_comparison_identity(left_cell).resolveKey(() => false);
        const right_key = await binary_comparison_identity(right_cell).resolveKey(() => false);
        expect(left_key).not.toBe(right_key);
    });

    // dta-parser 1.0 reads these leniently: each gives what its own payload holds.
    it.each([
        ['empty', new Uint8Array(), ''],
        ['non-NUL-terminated', Uint8Array.of(0x41), 'A'],
    ])('reads %s non-UTF-8 type-130 strLs as their own bytes', async (_case, payload, expected) => {
        const source = await DtaDataSource.create(
            build_release119_strl_fixture(payload, 130),
            { encoding: 'windows-1252' },
        );

        expect(source.read_raw_columns(0, 0, 1, [0]).rows[0][0]?.raw).toBe(expected);
    });

    it('keeps tagged missings distinct, labeled, nonempty, and numerically sortable', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const rows = source.read_columns(0, 0, 4, [3]).rows;
        expect(rows.map((row) => row[0])).toEqual([
            expect.objectContaining({ raw: '.', formatted: '.', rawType: 'number' }),
            expect.objectContaining({ raw: '.a', formatted: 'Refused', rawType: 'number' }),
            expect.objectContaining({ raw: '.b', formatted: '.b', rawType: 'number' }),
            expect.objectContaining({ raw: '.z', formatted: '.z', rawType: 'number' }),
        ]);
        expect(displayed_text(rows[1][0], false, undefined)).toBe('.a');
        expect(displayed_text(rows[1][0], true, undefined)).toBe('Refused');
        expect(new Set(rows.map((row) => row[0]?.raw)).size).toBe(4);

        const modified_fixture = build_dta_fixture();
        const data_start = find_tag_end(modified_fixture, '<data>');
        // Row 1's missing byte follows byte + double + str5 within a 23-byte row.
        modified_fixture[data_start + 23 + 14] = 103; // .a -> .b
        const modified = await DtaDataSource.create(modified_fixture);
        const alignment = await align_sheet(source, modified, {
            status: 'matched', name: 'Sheet1', originalIndex: 0, modifiedIndex: 0,
        });
        expect(alignment.changedCells).toBe(1);

        const empty = await compute_transform(source, 0, {
            sort: [],
            filters: [{
                id: 'empty', colIndex: 3, operator: 'isEmpty',
                caseSensitive: false, enabled: true,
            }],
        });
        expect(empty.rowCount).toBe(0);
        const sorted = await compute_transform(source, 0, {
            sort: [{ colIndex: 3, direction: 'asc' }],
            filters: [],
        });
        expect([...sorted.indices!]).toEqual([0, 1, 2, 3]);
    });

    it('clamps row windows that overshoot the end', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const window = source.read_rows(0, 3, 10);
        expect(window.startRow).toBe(3);
        expect(window.rows).toHaveLength(1);
        expect(texts(window.rows)[0][0]).toEqual({ raw: '2', formatted: 'Alpha' });
        expect(source.read_rows(0, 99, 2)).toEqual({ startRow: 4, rows: [] });
    });

    it('projects requested columns in requested order with duplicates', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const window = source.read_columns(0, 1, 2, [2, 0, 2]);
        expect(window.startRow).toBe(1);
        expect(texts(window.rows)).toEqual([
            [
                { raw: 'beta', formatted: 'beta' },
                { raw: '2', formatted: 'Alpha' },
                { raw: 'beta', formatted: 'beta' },
            ],
            [
                { raw: 'gamma', formatted: 'gamma' },
                { raw: '1', formatted: 'Zulu' },
                { raw: 'gamma', formatted: 'gamma' },
            ],
        ]);
    });

    it('preserves requested row shape for an empty native indexed projection', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());

        await expect(source.read_raw_columns_indexed_async(
            0,
            [2, 0, 2],
            [],
            () => false,
        )).resolves.toEqual({ rows: [[], [], []] });
    });

    it('rejects initially cancelled empty asynchronous raw reads', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());

        await expect(source.read_raw_columns_async(0, 0, 0, [0], () => true))
            .rejects.toMatchObject({ name: 'AbortError' });
        await expect(source.read_raw_columns_indexed_async(0, [], [0], () => true))
            .rejects.toMatchObject({ name: 'AbortError' });
    });

    it('decodes sparse indexed rows once and caches the runs', async () => {
        decode_spy.mockClear();
        const source = await DtaDataSource.create(build_dta_fixture());
        expect(source.read_rows_indexed(0, [3, 0, 3]).rows).toHaveLength(3);
        expect(decode_spy).toHaveBeenCalledTimes(2);
        source.read_rows_indexed(0, [3, 0, 3]);
        expect(decode_spy).toHaveBeenCalledTimes(2);
    });

    it('reports an async dangling strL after scanning exactly to the section end', async () => {
        const fixture = keep_release118_gso_prefix(build_dta_fixture(), 1);
        const pointer = find_tag_end(fixture, '<data>') + 15;
        new DataView(fixture.buffer).setUint32(pointer + 2, 2, true);
        const source = await DtaDataSource.create(fixture);

        expect(await rejected_code(source.read_raw_columns_async(0, 0, 1, [4], () => false))).toBe('DTA_CORRUPT');
    });

    it('calls a read failure corrupt only when dta-parser says so', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const reader = (source as unknown as { reader_handle: { readColumns: () => unknown } }).reader_handle;
        for (const [code, message] of [
            ['DTA_CORRUPT', /^Corrupt \.dta file: /u],
            ['DTA_TOO_LARGE', /^Could not read Stata file: /u],
        ] as const) {
            const failure = Object.assign(new Error('parser failure'), { code });
            vi.spyOn(reader, 'readColumns').mockImplementationOnce(() => {
                throw failure;
            });
            let caught: unknown;
            try {
                source.read_raw_columns(0, 0, 1, [0]);
            } catch (error) {
                caught = error;
            }
            expect((caught as Error).message).toMatch(message);
            expect((caught as Error).cause).toBe(failure);
        }
    });

    it('dispatches .dta directly without an Excel header projection', async () => {
        const source = await build_source_from_buffer(build_dta_fixture(), '/tmp/example.dta');
        expect(source).toBeInstanceOf(DtaDataSource);
        expect(source.meta().sheets[0].rowCount).toBe(4);
    });

    it('rejects negative legacy expansion lengths', async () => {
        expect(await rejected_code(DtaDataSource.create(build_legacy_dta_fixture(-5)))).toBe('DTA_CORRUPT');
    });

    it('allows exactly 10,000 zero-length legacy expansion fields', async () => {
        const source = await DtaDataSource.create(build_legacy_dta_fixture(0, 10_000));
        expect(source.meta().sheets[0].rowCount).toBe(3);
    });

    it('reads supported legacy releases through the buffer entrypoint', async () => {
        const source = await DtaDataSource.create(build_legacy_dta_fixture());
        expect(source.meta().sheets[0]).toMatchObject({
            rowCount: 3,
            columnNames: ['legacy_value', 'legacy_text'],
        });
        const rows = source.read_rows(0, 0, 3).rows;
        expect(rows.map((row) => row[0]?.raw)).toEqual(['3', '1', '2']);
        expect(rows[0][1]?.raw).toBe('café');
        expect(rows[0][0]?.formatted).toBe('Café');
    });

    it('reads a legacy value-label table through the file-backed descriptor', async () => {
        await with_temporary_dta(build_legacy_dta_fixture(), async (file_path) => {
            const source = await FileDtaDataSource.open(file_path);
            try {
                expect(source.read_rows(0, 0, 1).rows[0][0]?.formatted).toBe('Café');
            } finally {
                source.close();
            }
        });
    });

    // Declared counts are checked by dta-parser before it allocates; this
    // limit bounds the labels it actually decodes.
    it('rejects more decoded value-label entries than the safety limit', async () => {
        const dense = build_dta_fixture(4, false, {
            statusLabels: Array.from({ length: 65_537 }, (_, value) => ({ value, label: 'x' })),
        });
        await with_temporary_dta(dense, async (file_path) => {
            await expect(FileDtaDataSource.open(file_path)).rejects.toThrow(
                /65,536 entry safety limit/u,
            );
        });
    });

    it('fails closed on malformed modern value-label framing', async () => {
        const malformed = build_dta_fixture();
        const tag = new TextEncoder().encode('<value_labels>');
        const offset = Buffer.from(malformed).indexOf(tag);
        expect(offset).toBeGreaterThanOrEqual(0);
        malformed[offset] = '!'.charCodeAt(0);
        await with_temporary_dta(malformed, async (file_path) => {
            expect(await rejected_code(FileDtaDataSource.open(file_path))).toBe('DTA_CORRUPT');
        });
    });

    it('fails closed on a corrupt modern value-label table length', async () => {
        const malformed = build_dta_fixture();
        const table_offset = Buffer.from(malformed).indexOf('<lbl>');
        expect(table_offset).toBeGreaterThanOrEqual(0);
        const view = new DataView(
            malformed.buffer,
            malformed.byteOffset,
            malformed.byteLength,
        );
        const length_offset = table_offset + '<lbl>'.length;
        view.setInt32(length_offset, view.getInt32(length_offset, true) + 1, true);
        await with_temporary_dta(malformed, async (file_path) => {
            expect(await rejected_code(FileDtaDataSource.open(file_path))).toBe('DTA_CORRUPT');
        });
    });

    it('fails closed on a corrupt modern value-label table closer', async () => {
        const malformed = build_dta_fixture();
        const close_offset = Buffer.from(malformed).indexOf('</lbl>');
        expect(close_offset).toBeGreaterThanOrEqual(0);
        malformed[close_offset] = '!'.charCodeAt(0);
        await with_temporary_dta(malformed, async (file_path) => {
            expect(await rejected_code(FileDtaDataSource.open(file_path))).toBe('DTA_CORRUPT');
        });
    });

    it.each([
        ['windows-1252', 'caf€', 'Caf€'],
        ['latin1', 'caf\x80', 'Caf\x80'],
    ] as const)(
        'honors explicit %s decoding for legacy fixed strings and value labels',
        async (encoding, expected_text, expected_label) => {
            const source = await DtaDataSource.create(
                build_legacy_dta_fixture(0, 0, 0x80, 0x80),
                { encoding },
            );
            const row = source.read_rows(0, 0, 1).rows[0];
            expect(row[1]?.raw).toBe(expected_text);
            expect(row[0]?.formatted).toBe(expected_label);
        },
    );

    it('preserves a UTF-8 BOM in fixed strings, label names, and label text', async () => {
        const bom = String.fromCharCode(0xfeff);
        const label_name = `${bom}labels`;
        const label_text = `${bom}shown`;
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            firstName: `${bom}x`,
            valueLabelNames: { status: label_name },
            statusValueLabelTableName: label_name,
            statusLabels: [{ value: 1, label: label_text }],
        }));

        expect(source.read_raw_columns(0, 0, 1, [2]).rows[0][0]?.raw).toBe(`${bom}x`);
        expect(source.column_filter_metadata(0, 0)?.valueLabel?.('1')).toBe(label_text);
    });

    it('decodes release 105 fixed-width value-label tables', async () => {
        const fixture = build_pre111_value_label_fixture(105);
        const source = await DtaDataSource.create(fixture);
        expect(source.read_rows(0, 0, 1).rows[0][0]).toMatchObject({
            raw: '3',
            formatted: 'Third',
        });

        const async_source = await DtaDataSource.create(fixture);
        const metadata = await async_source.column_filter_metadata_async(0, 0, () => false);
        expect(metadata?.valueLabel?.('1')).toBe('One');
        expect(metadata?.valueLabel?.('3')).toBe('Third');
    });

    it.each([9, 33])(
        'decodes release 108 value-label tables with %i-byte names',
        async (table_name_width) => {
            const source = await DtaDataSource.create(
                build_pre111_value_label_fixture(108, table_name_width),
            );
            expect(source.read_rows(0, 0, 1).rows[0][0]).toMatchObject({
                raw: '3',
                formatted: 'Third',
            });
        },
    );

    it('reads all six release 118 observation bytes without low-word aliasing', async () => {
        const fixture = build_dta_fixture();
        const pointer = find_tag_end(fixture, '<data>') + 15;
        fixture[pointer + 6] = 1;
        const source = await DtaDataSource.create(fixture);
        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it.each([
        ['variable', 0, 6],
        ['observation', 2, 5],
    ] as const)('rejects out-of-range strL pointer %s ids', async (_field, offset, value) => {
        const fixture = build_dta_fixture();
        const pointer = find_tag_end(fixture, '<data>') + 15;
        new DataView(fixture.buffer).setUint16(pointer + offset, value, true);
        const source = await DtaDataSource.create(fixture);
        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it('resolves physically out-of-order strL objects', async () => {
        const fixture = build_dta_fixture();
        reorder_release118_gso_prefix(fixture, [1, 0]);
        const source = await DtaDataSource.create(fixture);
        expect(source.read_raw_columns(0, 0, 2, [4]).rows.map((row) => row[0]?.raw))
            .toEqual(['a long first value', 'second long value']);
    });

    it('stops a resolved strL batch before an unrelated corrupt object', async () => {
        const fixture = build_dta_fixture();
        const first_gso = find_tag_end(fixture, '<strls>');
        const first_content_length = new DataView(fixture.buffer).getUint32(first_gso + 16, true);
        const second_gso_variable = first_gso + 20 + first_content_length + 3;
        new DataView(fixture.buffer).setUint32(second_gso_variable, 6, true);
        const source = await DtaDataSource.create(fixture);
        expect(source.read_raw_columns(0, 0, 1, [4]).rows[0][0]?.raw)
            .toBe('a long first value');
    });

    it('rejects out-of-range ids in scanned strL objects', async () => {
        const fixture = build_dta_fixture();
        const first_gso_variable = find_tag_end(fixture, '<strls>') + 3;
        new DataView(fixture.buffer).setUint32(first_gso_variable, 6, true);
        const source = await DtaDataSource.create(fixture);
        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it('rejects nonadjacent duplicate strL ids', async () => {
        const fixture = build_dta_fixture();
        const records = release118_gso_records(fixture);
        const view = new DataView(fixture.buffer);
        view.setBigUint64(records[2].start + 7, 1n, true);
        const source = await DtaDataSource.create(fixture);
        // Rows before the duplicate keep their own values, or the read fails.
        let first_rows: unknown;
        try {
            first_rows = source.read_raw_columns(0, 0, 2, [4]).rows.map((row) => row[0]?.raw);
        } catch {
            first_rows = 'rejected';
        }
        expect(first_rows === 'rejected' || JSON.stringify(first_rows)
            === JSON.stringify(['a long first value', 'second long value'])).toBe(true);
        expect(thrown_code(() => source.read_raw_columns(0, 0, 4, [4]))).toBe('DTA_CORRUPT');
    });

    it.each([
        ['117', build_release117_fixture, 1, 'café'],
        ['118', build_dta_fixture, 4, 'a long first value'],
        ['119', build_release119_strl_fixture, 0, 'hello'],
    ] as const)(
        'reads release %s strL data through the parser integration',
        async (_release, build_fixture, column, expected) => {
            const source = await DtaDataSource.create(build_fixture());
            expect(source.read_rows(0, 0, 1).rows[0][column]?.raw).toBe(expected);
        },
    );

    it('rejects release 119 pointers to a non-strL variable', async () => {
        const fixture = build_release119_strl_rows_fixture([
            new TextEncoder().encode('hello\0'),
        ], 130, true);
        fixture[find_tag_end(fixture, '<data>') + 1] = 1;
        const source = await DtaDataSource.create(fixture);

        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it('does not consume the strls closing tag as binary GSO content', async () => {
        const fixture = build_release119_strl_rows_fixture([Uint8Array.of(1, 2, 3)]);
        const gso = find_tag_end(fixture, '<strls>');
        const view = new DataView(fixture.buffer);
        view.setUint32(gso + 16, view.getUint32(gso + 16, true) + 8, true);
        const source = await DtaDataSource.create(fixture);

        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it('decodes release 117 fixed and strL strings as Windows-1252', async () => {
        const source = await DtaDataSource.create(build_release117_fixture());
        const row = source.read_rows(0, 0, 1).rows[0];
        expect(row[0]?.raw).toBe('café');
        expect(row[1]?.raw).toBe('café');
    });

    it.each([
        ['windows-1252', 'caf€'],
        ['latin1', 'caf\x80'],
    ] as const)(
        'honors explicit %s decoding for release 117 fixed and strL strings',
        async (encoding, expected) => {
            const source = await DtaDataSource.create(
                build_release117_fixture(0x80),
                { encoding },
            );
            const row = source.read_rows(0, 0, 1).rows[0];
            expect(row[0]?.raw).toBe(expected);
            expect(row[1]?.raw).toBe(expected);
        },
    );

    it('rejects metadata-complete files with truncated observations', async () => {
        const fixture = build_dta_fixture();
        const data_start = find_tag_end(fixture, '<data>');
        expect(await rejected_code(DtaDataSource.create(fixture.slice(0, data_start + 1)))).toBe('DTA_CORRUPT');
    });

    it('copies nonzero-offset Node Buffer views before parsing', async () => {
        const fixture = Buffer.from(build_dta_fixture());
        const pooled = Buffer.concat([Buffer.from('unrelated-prefix'), fixture]);
        const view = pooled.subarray(pooled.length - fixture.length);
        const source = await DtaDataSource.create(view);
        expect(source.meta().sheets[0].rowCount).toBe(4);
    });

    it('releases the file bytes on idempotent close and rejects post-close entry points', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        source.column_filter_metadata(0, 0);
        source.read_rows(0, 0, 4);
        source.close();
        source.close();
        expect(() => source.read_rows(0, 0, 1)).toThrow(/closed/);
        expect(() => source.read_raw_columns(0, 0, 0, [])).toThrow(/closed/);
        expect(() => source.column_filter_metadata(0, 1)).toThrow(/closed/);
        await expect(source.read_raw_columns_async(0, 0, 0, [], () => false))
            .rejects.toThrow(/closed/);
        await expect(source.column_filter_metadata_async(0, 1, () => false))
            .rejects.toThrow(/closed/);
    });

    it('rejects section offsets that do not point at their declared tags', async () => {
        const corrupt = build_dta_fixture();
        const map = find_tag_end(corrupt, '<map>');
        const view = new DataView(corrupt.buffer);
        const data_entry = map + 9 * 8;
        view.setBigUint64(data_entry, view.getBigUint64(data_entry, true) + 1n, true);
        expect(await rejected_code(DtaDataSource.create(corrupt))).toBe('DTA_CORRUPT');
    });

    // dta-parser 1.0 does not need the map's end-of-file offset, and reads on.
    it('opens a file whose map puts the end of file past its end', async () => {
        const fixture = build_dta_fixture();
        const map = find_tag_end(fixture, '<map>');
        const corrupt = fixture.slice();
        new DataView(corrupt.buffer).setBigUint64(
            map + 13 * 8,
            BigInt(corrupt.length + 1),
            true,
        );
        const source = await DtaDataSource.create(corrupt);
        const intact = await DtaDataSource.create(fixture);
        expect(source.read_rows(0, 0, 4).rows).toEqual(intact.read_rows(0, 0, 4).rows);
    });

    it('rejects modern value-label tables without an exact closing tag', async () => {
        const corrupt = build_dta_fixture();
        const closing_tag = find_tag_end(corrupt, '</lbl>') - '</lbl>'.length;
        corrupt[closing_tag] = 'X'.charCodeAt(0);
        const source = await DtaDataSource.create(corrupt);

        expect(thrown_code(() => source.column_filter_metadata(0, 0))).toBe('DTA_CORRUPT');
    });

    it('verifies the modern terminal before returning a requested descriptor', async () => {
        const corrupt = build_dta_fixture();
        const closing_tag = find_tag_end(corrupt, '</value_labels>')
            - '</value_labels>'.length;
        corrupt[closing_tag] = 'X'.charCodeAt(0);
        // dta-parser 1.0 checks the section terminal when the file is opened.
        expect(await rejected_code(DtaDataSource.create(corrupt))).toBe('DTA_CORRUPT');
    });

    it('does not let a modern value-label entry consume the section terminal', async () => {
        const corrupt = build_dta_fixture();
        const payload_start = first_release118_value_label_payload_start(corrupt);
        const section_end = find_tag_end(corrupt, '</value_labels>')
            - '</value_labels>'.length;
        const entry_length = section_end + 1 - payload_start;
        const first_lbl = find_tag_end(corrupt, '<lbl>') - '<lbl>'.length;
        new DataView(corrupt.buffer).setInt32(first_lbl + '<lbl>'.length, entry_length, true);
        const source = await DtaDataSource.create(corrupt);

        expect(thrown_code(() => source.column_filter_metadata(0, 0))).toBe('DTA_CORRUPT');
    });

    it('requires the complete modern value-label closing tag inside the section', async () => {
        const corrupt = build_dta_fixture();
        const payload_start = first_release118_value_label_payload_start(corrupt);
        const section_end = find_tag_end(corrupt, '</value_labels>')
            - '</value_labels>'.length;
        const entry_length = section_end - payload_start;
        const first_lbl = find_tag_end(corrupt, '<lbl>') - '<lbl>'.length;
        new DataView(corrupt.buffer).setInt32(first_lbl + '<lbl>'.length, entry_length, true);
        const source = await DtaDataSource.create(corrupt);

        expect(thrown_code(() => source.column_filter_metadata(0, 0))).toBe('DTA_CORRUPT');
    });

    it('rejects a negative value-label text offset', async () => {
        const corrupt = build_dta_fixture();
        const payload_start = first_release118_value_label_payload_start(corrupt);
        new DataView(corrupt.buffer).setInt32(payload_start + 8, -1, true);
        const source = await DtaDataSource.create(corrupt);

        expect(thrown_code(() => source.column_filter_metadata(0, 0))).toBe('DTA_CORRUPT');
    });

    // dta-parser 1.0 reads label text leniently: text starting at the end of
    // the block is empty, never another label's text.
    it('reads value-label text starting at the end of the text block as empty', async () => {
        const corrupt = build_dta_fixture();
        const payload_start = first_release118_value_label_payload_start(corrupt);
        const view = new DataView(corrupt.buffer);
        view.setInt32(payload_start + 8, view.getInt32(payload_start + 4, true), true);
        const source = await DtaDataSource.create(corrupt);

        expect(source.column_filter_metadata(0, 0)?.valueLabel?.('1')).toBe('');
    });

    // dta-parser 1.0 reads label text without a NUL up to the end of the block.
    it('reads value-label text without a NUL up to the end of the block', async () => {
        const corrupt = build_dta_fixture(4, false, {
            statusLabels: [{ value: 1, label: 'Only' }],
        });
        const payload_start = first_release118_value_label_payload_start(corrupt);
        const view = new DataView(corrupt.buffer);
        const count = view.getInt32(payload_start, true);
        const text_length = view.getInt32(payload_start + 4, true);
        const text_start = payload_start + 8 + count * 8;
        corrupt[text_start + text_length - 1] = 'X'.charCodeAt(0);
        const source = await DtaDataSource.create(corrupt);

        expect(source.column_filter_metadata(0, 0)?.valueLabel?.('1')).toBe('OnlyX');
    });

    it('requires an exact modern value-label payload length', async () => {
        const corrupt = build_dta_fixture();
        const payload_start = first_release118_value_label_payload_start(corrupt);
        const view = new DataView(corrupt.buffer);
        view.setInt32(
            payload_start + 4,
            view.getInt32(payload_start + 4, true) - 1,
            true,
        );
        const source = await DtaDataSource.create(corrupt);

        expect(thrown_code(() => source.column_filter_metadata(0, 0))).toBe('DTA_CORRUPT');
    });

    it('rejects pre-Unicode value-label payloads beyond their declared entry length', async () => {
        const corrupt = build_legacy_dta_fixture();
        const table_length_offset = corrupt.length - (4 + 33 + 3 + 8 + 8 + 5);
        const declared_length_without_text = 8 + 8;
        new DataView(corrupt.buffer).setInt32(
            table_length_offset,
            declared_length_without_text,
            true,
        );
        const source = await DtaDataSource.create(corrupt);
        expect(thrown_code(() => source.read_rows(0, 0, 1))).toBe('DTA_CORRUPT');
    });

    it('surfaces rejected releases as a clean open error', async () => {
        await expect(DtaDataSource.create(Uint8Array.of(104))).rejects.toThrow(
            /^Could not open Stata file:/,
        );
    });
});

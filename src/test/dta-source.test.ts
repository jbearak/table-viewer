import { Buffer } from 'node:buffer';
import { spawnSync } from 'node:child_process';
import { join } from 'node:path';
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
const gso_decode_spy = vi.hoisted(() => vi.fn());
const gso_index_spy = vi.hoisted(() => vi.fn());
vi.mock('@jbearak/dta-parser', async (import_original) => {
    const actual = await import_original<typeof import('@jbearak/dta-parser')>();
    return {
        ...actual,
        decode_gso_entry: (...args: Parameters<typeof actual.decode_gso_entry>) => {
            gso_decode_spy(...args);
            return actual.decode_gso_entry(...args);
        },
        build_gso_index: (...args: Parameters<typeof actual.build_gso_index>) => {
            gso_index_spy(...args);
            return actual.build_gso_index(...args);
        },
        read_rows_from_buffer: (...args: Parameters<typeof actual.read_rows_from_buffer>) => {
            decode_spy(...args);
            return actual.read_rows_from_buffer(...args);
        },
    };
});

import { DtaDataSource } from '../data-source/dta-source';
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
        const encoded = new TextEncoder().encode(value);
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
    readonly statusLabels?: readonly FixtureValueLabelEntry[];
    readonly extraValueLabelTables?: readonly FixtureValueLabelTable[];
}

/** Build a tiny release-118 file in memory; no binary fixture is committed. */
function build_dta_fixture(
    observation_count = 4,
    second_strl = false,
    options: DtaFixtureOptions = {},
): Uint8Array {
    const writer = new ByteWriter();
    const variables: FixtureVariable[] = [
        { name: 'status', typeCode: 65530, format: '%8.0g', valueLabel: 'status_lbl' },
        { name: 'amount', typeCode: 65526, format: '%9.2f' },
        { name: 'name', typeCode: 5, format: '%-5s' },
        { name: 'missing', typeCode: 65530, format: '%8.0g', valueLabel: 'missing_lbl' },
        { name: 'long_text', typeCode: 32768, format: '%9s' },
    ];
    if (second_strl) {
        variables.push({ name: 'long_text_2', typeCode: 32768, format: '%9s' });
    }
    const observations: Array<[number, number, string, number, string]> = [
        [1, 12.5, 'alpha', 101, 'a long first value'],
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
    writer.i32(observations.length);
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
        const payload_length = 129 + 3 + 8 + entries.length * 8 + text_length;
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
    write_value_label_table('status_lbl', options.statusLabels ?? [
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

function build_legacy_dta_fixture(
    expansion_length = 0,
    zero_length_fields = 0,
): Uint8Array {
    const writer = new ByteWriter();
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
    writer.fixed('legacy_lbl', 33); writer.fixed('', 33);
    writer.fixed('', 81); writer.fixed('', 81);
    for (let field = 0; field < zero_length_fields; field++) {
        writer.u8(1); writer.i32(0);
    }
    writer.u8(0); writer.i32(expansion_length); // expansion-fields terminator
    writer.i8(3); writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(0xe9); writer.u8(0);
    writer.i8(1); writer.fixed('plain', 5);
    writer.i8(2); writer.fixed('text', 5);
    const label = Uint8Array.of(0x43, 0x61, 0x66, 0xe9, 0);
    writer.i32(33 + 3 + 8 + 8 + label.length);
    writer.fixed('legacy_lbl', 33);
    writer.u8(0); writer.u8(0); writer.u8(0);
    writer.i32(1);
    writer.i32(label.length);
    writer.i32(0);
    writer.i32(3);
    for (const byte of label) writer.u8(byte);
    return writer.finish();
}

function build_release117_fixture(): Uint8Array {
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
    writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(0xe9); writer.u8(0);
    writer.i32(2); writer.i32(1);
    writer.text('</data>');
    mark('strls'); writer.text('<strls>GSO');
    writer.i32(2); writer.i32(1); writer.u8(130); writer.i32(5);
    writer.u8(0x63); writer.u8(0x61); writer.u8(0x66); writer.u8(0xe9); writer.u8(0);
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
): Uint8Array {
    const writer = new ByteWriter();
    const offsets = new Map<string, number>();
    const mark = (name: string) => offsets.set(name, writer.length);
    mark('stata_data');
    writer.text('<stata_dta><header><release>119</release><byteorder>LSF</byteorder><K>');
    writer.i32(1);
    writer.text('</K><N>'); writer.u64(contents.length);
    writer.text('</N><label>'); writer.u16(0);
    writer.text('</label><timestamp>'); writer.u8(0);
    writer.text('</timestamp></header>');
    mark('map'); writer.text('<map>');
    const map_offset = writer.length;
    for (let index = 0; index < 14; index++) writer.u64(0);
    writer.text('</map>');
    mark('variable_types'); writer.text('<variable_types>'); writer.u16(32768);
    writer.text('</variable_types>');
    mark('varnames'); writer.text('<varnames>'); writer.fixed('long_text', 129);
    writer.text('</varnames>');
    mark('sortlist'); writer.text('<sortlist>'); writer.i32(0); writer.i32(0);
    writer.text('</sortlist>');
    mark('formats'); writer.text('<formats>'); writer.fixed('%9s', 57);
    writer.text('</formats>');
    mark('value_label_names'); writer.text('<value_label_names>'); writer.fixed('', 129);
    writer.text('</value_label_names>');
    mark('variable_labels'); writer.text('<variable_labels>'); writer.fixed('', 321);
    writer.text('</variable_labels>');
    mark('characteristics'); writer.text('<characteristics></characteristics>');
    mark('data'); writer.text('<data>');
    for (let row = 0; row < contents.length; row++) {
        // Release 119 packs v into 3 bytes and o into 5 bytes.
        writer.u8(1); writer.u8(0); writer.u8(0);
        writer.i32(row + 1); writer.u8(0);
    }
    writer.text('</data>');
    mark('strls'); writer.text('<strls>');
    for (let row = 0; row < contents.length; row++) {
        const content = contents[row];
        writer.text('GSO');
        writer.i32(1); writer.u64(row + 1); writer.u8(type); writer.i32(content.length);
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

function find_tag_end(bytes: Uint8Array, tag: string): number {
    const encoded = new TextEncoder().encode(tag);
    for (let offset = 0; offset <= bytes.length - encoded.length; offset++) {
        if (encoded.every((byte, index) => bytes[offset + index] === byte)) {
            return offset + encoded.length;
        }
    }
    throw new Error(`fixture is missing ${tag}`);
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
                merges: [],
                hasFormatting: true,
                columnNames: ['status', 'amount', 'name', 'missing', 'long_text'],
            }],
        });
        expect(decode_spy).not.toHaveBeenCalled();
    });

    it('keeps raw numbers while formatting labels and display formats', async () => {
        gso_index_spy.mockClear();
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
        expect(gso_index_spy).not.toHaveBeenCalled();

        const sorted = await compute_transform(source, 0, {
            sort: [{ colIndex: 0, direction: 'asc' }],
            filters: [],
        });
        expect([...sorted.indices!]).toEqual([0, 2, 1, 3]);
    });

    it('returns identical canonical raw values from fast and rendered paths', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const fast = source.read_raw_columns(0, 0, 4, [0, 1, 2, 3, 4]).rows;
        const internals = source as unknown as {
            decoded_value_label_tables: Map<string, Map<number, string>>;
        };
        expect(internals.decoded_value_label_tables.size).toBe(0);
        const rendered = source.read_rows(0, 0, 4).rows;
        expect([...internals.decoded_value_label_tables.keys()])
            .toEqual(['status_lbl', 'missing_lbl']);
        expect(fast).toEqual(rendered.map((row) => row.map((cell) =>
            cell === null
                ? null
                : { raw: cell.raw, rawType: cell.rawType },
        )));
        expect(fast.map((row) => row[3])).toEqual([
            { raw: '.', rawType: 'number' },
            { raw: '.a', rawType: 'number' },
            { raw: '.b', rawType: 'number' },
            { raw: '.z', rawType: 'number' },
        ]);
        expect(fast[0]).toEqual([
            { raw: '1', rawType: 'number' },
            { raw: '12.5', rawType: 'number' },
            { raw: 'alpha', rawType: 'string' },
            { raw: '.', rawType: 'number' },
            { raw: 'a long first value', rawType: 'string' },
        ]);
        expect(rendered[0][0]?.formatted).toBe('Zulu');
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

    it('decodes shared value-label text offsets once and accounts for one string', async () => {
        const shared_label = 'A shared long label';
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            statusLabels: [
                { value: 1, label: shared_label, textKey: 'shared' },
                { value: 2, label: shared_label, textKey: 'shared' },
                { value: 3, label: shared_label, textKey: 'shared' },
            ],
        }));
        const internals = source as unknown as {
            unicode_decoder: TextDecoder;
            decoded_value_label_tables: Map<string, {
                labels: Map<number, string>;
                decodedBytes: number;
            }>;
            decoded_value_label_cache_bytes: number;
        };
        const label_decode_spy = vi.spyOn(internals.unicode_decoder, 'decode');

        const metadata = source.column_filter_metadata(0, 0)!;
        expect(metadata.valueLabel?.('1')).toBe(shared_label);
        expect(metadata.valueLabel?.('2')).toBe(shared_label);
        expect(metadata.valueLabel?.('3')).toBe(shared_label);
        // One decode for the table name and one for the shared text offset.
        expect(label_decode_spy).toHaveBeenCalledTimes(2);
        const cached = internals.decoded_value_label_tables.get('status_lbl')!;
        expect(cached.labels.size).toBe(3);
        expect(cached.decodedBytes).toBe(shared_label.length * 2);
        expect(internals.decoded_value_label_cache_bytes).toBe(shared_label.length * 2);
    });

    it('rejects value-label tables above the entry limit without caching a partial table', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        const internals = source as unknown as {
            value_label_table_entry_limit: number;
            decoded_value_label_tables: Map<string, unknown>;
        };
        internals.value_label_table_entry_limit = 2;

        expect(() => source.column_filter_metadata(0, 0)).toThrow(
            'Value label table has too many entries to decode safely (max 2 entries)',
        );
        expect(internals.decoded_value_label_tables.size).toBe(0);
    });

    it.each([
        ['release 118', () => build_dta_fixture(), 0],
        ['pre-Unicode', () => build_legacy_dta_fixture(), 0],
    ] as const)(
        'enforces the decoded UTF-16 value-label budget for %s tables',
        async (_format, fixture, column) => {
            const source = await DtaDataSource.create(fixture());
            const internals = source as unknown as {
                value_label_table_decoded_byte_limit: number;
                decoded_value_label_tables: Map<string, unknown>;
            };
            internals.value_label_table_decoded_byte_limit = 7;

            expect(() => source.column_filter_metadata(0, column)).toThrow(
                'Value label table exceeds its decoded text budget (max 7 UTF-16 bytes)',
            );
            expect(internals.decoded_value_label_tables.size).toBe(0);
        },
    );

    it('evicts decoded value-label tables by aggregate bytes in LRU order', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            extraValueLabelTables: [{
                name: 'tiny_lbl',
                entries: [{ value: 1, label: 'X' }],
            }],
        }));
        const internals = source as unknown as {
            value_label_cache_byte_limit: number;
            decoded_value_label_cache_bytes: number;
            decoded_value_label_tables: Map<string, unknown>;
            value_labels: (name: string) => Map<number, string> | undefined;
        };
        internals.value_label_cache_byte_limit = 40;

        expect(internals.value_labels('status_lbl')?.get(1)).toBe('Zulu');
        expect(internals.value_labels('missing_lbl')?.get(2147483622)).toBe('Refused');
        expect(internals.decoded_value_label_cache_bytes).toBe(40);
        expect(internals.value_labels('status_lbl')?.get(2)).toBe('Alpha');
        expect(internals.value_labels('tiny_lbl')?.get(1)).toBe('X');

        expect([...internals.decoded_value_label_tables.keys()])
            .toEqual(['status_lbl', 'tiny_lbl']);
        expect(internals.decoded_value_label_cache_bytes).toBe(28);
    });

    it('checks cancellation while decoding a requested value-label table', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            statusLabels: Array.from({ length: 257 }, (_, index) => ({
                value: index,
                label: `Label ${index}`,
            })),
        }));
        const internals = source as unknown as {
            decoded_value_label_tables: Map<string, unknown>;
        };
        const is_cancelled = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValue(true);

        await expect(source.column_filter_metadata_async(0, 0, is_cancelled))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(is_cancelled).toHaveBeenCalledTimes(2);
        expect(internals.decoded_value_label_tables.size).toBe(0);
    });

    it('cancels value-label decoding closed during its cooperative yield', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            statusLabels: Array.from({ length: 257 }, (_, index) => ({
                value: index,
                label: `Label ${index}`,
            })),
        }));
        const internals = source as unknown as {
            bytes?: Uint8Array;
            unicode_decoder: TextDecoder;
            decoded_value_label_tables: Map<string, unknown>;
            decoded_value_label_cache_bytes: number;
            missing_value_label_table_names: Set<string>;
        };
        const decode = vi.spyOn(internals.unicode_decoder, 'decode');

        const reading = source.column_filter_metadata_async(0, 0, () => false);
        expect(decode).toHaveBeenCalledTimes(257);
        source.close();

        await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        expect(internals.bytes).toBeUndefined();
        expect(internals.decoded_value_label_tables.size).toBe(0);
        expect(internals.decoded_value_label_cache_bytes).toBe(0);
        expect(internals.missing_value_label_table_names.size).toBe(0);
    });

    it('does not publish a missing value-label marker after close during table scanning', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(4, false, {
            extraValueLabelTables: Array.from({ length: 254 }, (_, index) => ({
                name: `extra_${index}`,
                entries: [],
            })),
        }));
        const internals = source as unknown as {
            metadata: { variables: Array<{ value_label_name: string }> };
            unicode_decoder: TextDecoder;
            decoded_value_label_tables: Map<string, unknown>;
            decoded_value_label_cache_bytes: number;
            missing_value_label_table_names: Set<string>;
        };
        internals.metadata.variables[0].value_label_name = 'absent_lbl';
        const decode = vi.spyOn(internals.unicode_decoder, 'decode');

        const reading = source.column_filter_metadata_async(0, 0, () => false);
        expect(decode).toHaveBeenCalledTimes(256);
        source.close();

        await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        expect(internals.decoded_value_label_tables.size).toBe(0);
        expect(internals.decoded_value_label_cache_bytes).toBe(0);
        expect(internals.missing_value_label_table_names.size).toBe(0);
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
        const internals = source as unknown as {
            gso_digest_cache: Map<number, string>;
            binary_digest_computations: number;
        };
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
        expect(internals.gso_digest_cache.size).toBe(0);
        expect(internals.binary_digest_computations).toBe(0);

        const key = await binary_comparison_identity(fast).resolveKey(() => false);
        expect(key).toMatch(/^stata-binary:sha256:[0-9a-f]{64}:2097152$/);
        expect(internals.gso_digest_cache.size).toBe(1);
        expect(internals.binary_digest_computations).toBe(1);
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

    it('cancels chunked hashing without caching partial work and retries cleanly', async () => {
        const source = await DtaDataSource.create(
            build_release119_strl_fixture(new Uint8Array(64).fill(0x4c), 129),
        );
        const cell = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        const internals = source as unknown as {
            binary_identity_chunk_bytes: number;
            binary_digest_computations: number;
            gso_digest_cache: Map<number, string>;
            pending_binary_identities: Map<number, unknown>;
        };
        internals.binary_identity_chunk_bytes = 8;
        const cancelled = vi.fn()
            .mockReturnValueOnce(false)
            .mockReturnValueOnce(false)
            .mockReturnValue(true);

        await expect(binary_comparison_identity(cell).resolveKey(cancelled))
            .rejects.toMatchObject({ name: 'AbortError' });
        expect(internals.binary_digest_computations).toBe(1);
        expect(internals.gso_digest_cache.size).toBe(0);
        expect(internals.pending_binary_identities.size).toBe(0);

        await expect(binary_comparison_identity(cell).resolveKey(() => false))
            .resolves.toMatch(/^stata-binary:sha256:/);
        expect(internals.binary_digest_computations).toBe(2);
        expect(internals.gso_digest_cache.size).toBe(1);
    });

    it('does not publish a binary digest after close during chunked hashing', async () => {
        const source = await DtaDataSource.create(
            build_release119_strl_fixture(new Uint8Array(64).fill(0x58), 129),
        );
        const cell = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        const internals = source as unknown as {
            binary_identity_chunk_bytes: number;
            gso_digest_cache: Map<number, string>;
            gso_digest_cache_bytes: number;
            pending_binary_identities: Map<number, unknown>;
        };
        internals.binary_identity_chunk_bytes = 8;

        const resolving = binary_comparison_identity(cell).resolveKey(() => false);
        expect(internals.pending_binary_identities.size).toBe(1);
        source.close();

        await expect(resolving).rejects.toMatchObject({ name: 'AbortError' });
        await new Promise<void>((resolve) => setImmediate(resolve));
        expect(internals.gso_digest_cache.size).toBe(0);
        expect(internals.gso_digest_cache_bytes).toBe(0);
        expect(internals.pending_binary_identities.size).toBe(0);
    });

    it('shares comparison and filter hashing while cancelling only one waiter', async () => {
        const source = await DtaDataSource.create(
            build_release119_strl_fixture(new Uint8Array(64).fill(0x6d), 129),
        );
        const cell = source.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
        const internals = source as unknown as {
            binary_identity_chunk_bytes: number;
            binary_digest_computations: number;
        };
        internals.binary_identity_chunk_bytes = 8;
        let cancelled_checks = 0;
        const live = binary_comparison_identity(cell).resolveKey(() => false);
        const cancelled = binary_filter_identity(cell).resolveKey(
            () => ++cancelled_checks > 1,
        );

        await expect(cancelled).rejects.toMatchObject({ name: 'AbortError' });
        const key = await live;
        expect(key).toMatch(/^stata-binary:sha256:/);
        expect(binary_filter_identity(cell).cachedKey()).toBe(key);
        expect(internals.binary_digest_computations).toBe(1);
    });

    it('bounds completed binary identities by entry count and logical bytes', async () => {
        const contents = Array.from({ length: 4 }, (_, index) =>
            new Uint8Array(40).fill(index + 1));
        const source = await DtaDataSource.create(
            build_release119_strl_rows_fixture(contents),
        );
        const cells = source.read_raw_columns(0, 0, contents.length, [0]).rows
            .map((row) => row[0]!);
        const internals = source as unknown as {
            gso_digest_cache: Map<number, string>;
            gso_digest_cache_bytes: number;
            gso_digest_cache_entry_limit: number;
            gso_digest_cache_byte_limit: number;
        };
        internals.gso_digest_cache_entry_limit = 2;
        internals.gso_digest_cache_byte_limit = 10_000;
        for (const cell of cells.slice(0, 3)) {
            await binary_comparison_identity(cell).resolveKey(() => false);
        }
        expect(internals.gso_digest_cache.size).toBe(2);
        expect(internals.gso_digest_cache_bytes).toBe(
            [...internals.gso_digest_cache.values()]
                .reduce((bytes, key) => bytes + key.length * 2, 0),
        );

        const one_key_bytes = [...internals.gso_digest_cache.values()][0].length * 2;
        internals.gso_digest_cache.clear();
        internals.gso_digest_cache_bytes = 0;
        internals.gso_digest_cache_entry_limit = 10;
        internals.gso_digest_cache_byte_limit = one_key_bytes + 1;
        for (const cell of cells) {
            await binary_comparison_identity(cell).resolveKey(() => false);
        }
        expect(internals.gso_digest_cache.size).toBe(1);
        expect(internals.gso_digest_cache_bytes).toBeLessThanOrEqual(one_key_bytes + 1);
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
        expect((left as unknown as { binary_digest_computations: number })
            .binary_digest_computations).toBe(0);
        expect((right as unknown as { binary_digest_computations: number })
            .binary_digest_computations).toBe(0);
        const left_key = await binary_comparison_identity(left_cell).resolveKey(() => false);
        const right_key = await binary_comparison_identity(right_cell).resolveKey(() => false);
        expect(left_key).not.toBe(right_key);
    });

    it.each(['left', 'right'] as const)(
        'cancels direct binary equality when the %s source closes during a yield',
        async (closed_side) => {
            const payload = new Uint8Array(64).fill(0x39);
            const left = await DtaDataSource.create(
                build_release119_strl_fixture(payload, 129),
            );
            const right = await DtaDataSource.create(
                build_release119_strl_fixture(payload, 129),
            );
            const left_cell = left.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
            const right_cell = right.read_raw_columns(0, 0, 1, [0]).rows[0][0]!;
            type EqualityInternals = {
                bytes?: Uint8Array;
                binary_identity_chunk_bytes: number;
                gso_digest_cache: Map<number, string>;
                pending_binary_identities: Map<number, unknown>;
            };
            const left_internals = left as unknown as EqualityInternals;
            const right_internals = right as unknown as EqualityInternals;
            left_internals.binary_identity_chunk_bytes = 8;
            right_internals.binary_identity_chunk_bytes = 8;

            const equal = cells_exactly_equal(left_cell, right_cell, () => false);
            expect(typeof equal).not.toBe('boolean');
            const closed = closed_side === 'left' ? left : right;
            closed.close();

            await expect(equal as Promise<boolean>)
                .rejects.toMatchObject({ name: 'AbortError' });
            expect((closed as unknown as EqualityInternals).bytes).toBeUndefined();
            expect(left_internals.gso_digest_cache.size).toBe(0);
            expect(right_internals.gso_digest_cache.size).toBe(0);
            expect(left_internals.pending_binary_identities.size).toBe(0);
            expect(right_internals.pending_binary_identities.size).toBe(0);
        },
    );

    it('does not rehash evicted binary identities while counting aligned changes', async () => {
        const originals = Array.from({ length: 6 }, (_, index) => {
            const payload = new Uint8Array(64).fill(index + 1);
            payload[0] = index;
            return payload;
        });
        const modified = originals.map((payload) => payload.slice());
        modified[2][63] ^= 0xff;
        const original_source = await DtaDataSource.create(
            build_release119_strl_rows_fixture(originals),
        );
        const modified_source = await DtaDataSource.create(
            build_release119_strl_rows_fixture(modified),
        );
        type IdentityInternals = {
            gso_digest_cache_entry_limit: number;
            binary_digest_computations: number;
        };
        (original_source as unknown as IdentityInternals).gso_digest_cache_entry_limit = 2;
        (modified_source as unknown as IdentityInternals).gso_digest_cache_entry_limit = 2;

        const alignment = await align_sheet(original_source, modified_source, {
            status: 'matched', name: 'Sheet1', originalIndex: 0, modifiedIndex: 0,
        });
        expect(alignment.changedCells).toBe(1);
        expect(alignment.changedRowIndices).toEqual([2]);
        expect((original_source as unknown as IdentityInternals)
            .binary_digest_computations).toBe(originals.length);
        expect((modified_source as unknown as IdentityInternals)
            .binary_digest_computations).toBe(modified.length);
    });

    it('rejects oversized text strLs before decoding their payload', async () => {
        const payload = new TextEncoder().encode('hello\0');
        const source = await DtaDataSource.create(build_release119_strl_fixture(payload));
        const internals = source as unknown as { text_gso_decode_byte_limit: number };
        expect(internals.text_gso_decode_byte_limit).toBe(16 * 1024 * 1024);
        internals.text_gso_decode_byte_limit = payload.length - 1;
        gso_decode_spy.mockClear();

        await expect(source.read_raw_columns_async(0, 0, 1, [0], () => false))
            .rejects.toThrow(
                `Stata text strL payload is too large to decode safely `
                + `(max ${payload.length - 1} bytes)`,
            );
        expect(gso_decode_spy).not.toHaveBeenCalled();

        const exact = await DtaDataSource.create(build_release119_strl_fixture(payload));
        (exact as unknown as { text_gso_decode_byte_limit: number })
            .text_gso_decode_byte_limit = payload.length;
        expect(exact.read_raw_columns(0, 0, 1, [0]).rows[0][0]?.raw).toBe('hello');
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

    it('decodes sparse indexed rows once and caches the runs', async () => {
        decode_spy.mockClear();
        const source = await DtaDataSource.create(build_dta_fixture());
        expect(source.read_rows_indexed(0, [3, 0, 3]).rows).toHaveLength(3);
        expect(decode_spy).toHaveBeenCalledTimes(2);
        source.read_rows_indexed(0, [3, 0, 3]);
        expect(decode_spy).toHaveBeenCalledTimes(2);
    });

    it('cancels a GSO scan closed during its cooperative yield without resurrecting state', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(300));
        const internals = source as unknown as {
            bytes?: Uint8Array;
            gso_index: Map<string, unknown>;
            gso_cache: Map<string, unknown>;
            gso_cache_bytes: number;
            gso_checkpoints: unknown[];
            gso_entries_scanned: number;
            gso_last_order?: unknown;
            gso_start_position: number;
            gso_scan_position: number;
        };

        const reading = source.read_raw_columns_async(0, 256, 1, [4], () => false);
        expect(internals.gso_entries_scanned).toBe(256);
        expect(internals.gso_index.size).toBe(256);
        expect(internals.gso_checkpoints.length).toBeGreaterThan(0);
        source.close();

        await expect(reading).rejects.toMatchObject({ name: 'AbortError' });
        expect(internals.bytes).toBeUndefined();
        expect(internals.gso_index.size).toBe(0);
        expect(internals.gso_cache.size).toBe(0);
        expect(internals.gso_cache_bytes).toBe(0);
        expect(internals.gso_checkpoints).toEqual([]);
        expect(internals.gso_entries_scanned).toBe(0);
        expect(internals.gso_last_order).toBeUndefined();
        expect(internals.gso_scan_position).toBe(internals.gso_start_position);
    });

    it('finds an evicted GSO before scanning the unvisited tail', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(2_000));
        source.read_rows(0, 0, 1_100);
        const internals = source as unknown as {
            windows: Map<string, unknown>;
            gso_index: Map<string, unknown>;
            gso_cache: Map<string, unknown>;
            gso_scan_position: number;
        };
        expect(internals.gso_index.size).toBeLessThanOrEqual(1_024);
        const partial_position = internals.gso_scan_position;
        internals.windows.clear();
        internals.gso_cache.clear();
        expect(source.read_rows(0, 0, 1).rows[0][4]?.raw).toBe('a long first value');
        expect(internals.gso_scan_position).toBe(partial_position);
        expect(internals.gso_index.has('5:1')).toBe(true);
    });

    it('resolves an evicted strL window in one ordered scan with per-cell parity', async () => {
        const fixture = build_dta_fixture(2_000);
        const batched = await DtaDataSource.create(fixture);
        batched.read_rows(0, 0, 2_000);
        const internals = batched as unknown as {
            windows: Map<string, unknown>;
            gso_index: Map<string, unknown>;
            gso_cache: Map<string, unknown>;
            read_gso_at: (...args: unknown[]) => unknown;
        };
        internals.windows.clear();
        internals.gso_index.clear();
        internals.gso_cache.clear();
        const original_read_gso_at = internals.read_gso_at.bind(batched);
        let headers_read = 0;
        internals.read_gso_at = (...args) => {
            headers_read += 1;
            return original_read_gso_at(...args);
        };

        const batch_values = batched.read_raw_columns(0, 0, 256, [4]).rows;
        const per_cell = await DtaDataSource.create(fixture);
        const per_cell_values = Array.from({ length: 256 }, (_, row) =>
            per_cell.read_raw_columns(0, row, 1, [4]).rows[0]);
        expect(batch_values).toEqual(per_cell_values);
        expect(headers_read).toBeLessThanOrEqual(320);
    });

    it('keeps checkpoints ordered for observation-major multi-strL data', async () => {
        const source = await DtaDataSource.create(build_dta_fixture(1_100, true));
        source.read_rows(0, 0, 1_100);
        const internals = source as unknown as {
            windows: Map<string, unknown>;
            gso_index: Map<string, unknown>;
            gso_cache: Map<string, unknown>;
            gso_checkpoints: unknown[];
            gso_scan_position: number;
        };
        expect(internals.gso_index.size).toBeLessThanOrEqual(1_024);
        expect(internals.gso_checkpoints.length).toBeLessThanOrEqual(1_024);
        const exhausted_position = internals.gso_scan_position;
        internals.windows.clear();
        internals.gso_cache.clear();
        expect(source.read_columns(0, 0, 1, [4, 5]).rows[0].map((cell) => cell?.raw))
            .toEqual(['a long first value', 'second 0']);
        expect(internals.gso_scan_position).toBe(exhausted_position);
        expect(internals.gso_index.size).toBeLessThanOrEqual(1_024);
    });

    it('dispatches .dta directly without an Excel header projection', async () => {
        const source = await build_source_from_buffer(build_dta_fixture(), '/tmp/example.dta');
        expect(source).toBeInstanceOf(DtaDataSource);
        expect(source.meta().sheets[0].rowCount).toBe(4);
    });

    it.skipIf(process.env.TABLE_VIEWER_LEGACY_HANG_CHILD === '1')(
        'rejects negative legacy expansion lengths without hanging',
        () => {
            const child = spawnSync(process.execPath, [
                join(process.cwd(), 'node_modules/vitest/vitest.mjs'),
                'run',
                'src/test/dta-source.test.ts',
                '-t',
                'negative legacy expansion child',
            ], {
                cwd: process.cwd(),
                env: { ...process.env, TABLE_VIEWER_LEGACY_HANG_CHILD: '1' },
                encoding: 'utf8',
                timeout: 60_000,
            });
            const timed_out = child.error !== undefined
                && 'code' in child.error
                && child.error.code === 'ETIMEDOUT';
            const diagnostic = timed_out
                ? 'Legacy expansion-field child exceeded the 60-second hang guard'
                : child.stderr;
            expect(child.error, diagnostic).toBeUndefined();
            expect(child.signal, diagnostic).toBeNull();
            expect(child.status, diagnostic).toBe(0);
        },
    );

    it.runIf(process.env.TABLE_VIEWER_LEGACY_HANG_CHILD === '1')(
        'negative legacy expansion child',
        async () => {
            await expect(DtaDataSource.create(build_legacy_dta_fixture(-5)))
                .rejects.toThrow('expansion field has negative length');
        },
    );

    it('allows exactly 10,000 zero-length legacy expansion fields', async () => {
        const source = await DtaDataSource.create(build_legacy_dta_fixture(0, 10_000));
        expect(source.meta().sheets[0].rowCount).toBe(3);
    });

    it('rejects excessive zero-length legacy expansion fields', async () => {
        await expect(DtaDataSource.create(build_legacy_dta_fixture(0, 10_001)))
            .rejects.toThrow('too many expansion fields');
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

    it('rejects release 118 strL pointers whose observation exceeds 32 bits', async () => {
        const fixture = build_dta_fixture();
        const pointer = find_tag_end(fixture, '<data>') + 15;
        fixture[pointer + 6] = 1;
        const source = await DtaDataSource.create(fixture);
        expect(() => source.read_rows(0, 0, 1)).toThrow(
            'strL observation number exceeds 32-bit range',
        );
    });

    it.each([
        ['variable', 0, 6],
        ['observation', 2, 5],
    ] as const)('rejects out-of-range strL pointer %s ids', async (_field, offset, value) => {
        const fixture = build_dta_fixture();
        const pointer = find_tag_end(fixture, '<data>') + 15;
        new DataView(fixture.buffer).setUint16(pointer + offset, value, true);
        const source = await DtaDataSource.create(fixture);
        expect(() => source.read_rows(0, 0, 1)).toThrow(
            /Corrupt \.dta file: strL pointer id .* is outside the dataset range/,
        );
    });

    it('rejects physically out-of-order strL objects', async () => {
        const fixture = build_dta_fixture();
        const first_gso = find_tag_end(fixture, '<strls>');
        const view = new DataView(fixture.buffer);
        const first_end = first_gso + 20 + view.getUint32(first_gso + 16, true);
        const second_end = first_end + 20 + view.getUint32(first_end + 16, true);
        const first = fixture.slice(first_gso, first_end);
        const second = fixture.slice(first_end, second_end);
        fixture.set(second, first_gso);
        fixture.set(first, first_gso + second.length);

        const source = await DtaDataSource.create(fixture);
        expect(() => source.read_raw_columns(0, 0, 1, [4])).toThrow(
            'Corrupt .dta file: strL objects are out of observation-major order',
        );
    });

    it('rejects an out-of-order strL batch without a recovery rescan', async () => {
        const fixture = build_dta_fixture(2_000);
        const first_gso = find_tag_end(fixture, '<strls>');
        const view = new DataView(fixture.buffer);
        const first_end = first_gso + 20 + view.getUint32(first_gso + 16, true);
        const second_end = first_end + 20 + view.getUint32(first_end + 16, true);
        const first = fixture.slice(first_gso, first_end);
        const second = fixture.slice(first_end, second_end);
        fixture.set(second, first_gso);
        fixture.set(first, first_gso + second.length);

        const source = await DtaDataSource.create(fixture);
        const internals = source as unknown as {
            read_gso_at: (...args: unknown[]) => unknown;
        };
        const original_read_gso_at = internals.read_gso_at.bind(source);
        let headers_read = 0;
        internals.read_gso_at = (...args) => {
            headers_read += 1;
            return original_read_gso_at(...args);
        };
        await expect(source.read_raw_columns_async(0, 0, 256, [4], () => false))
            .rejects.toThrow(
                'Corrupt .dta file: strL objects are out of observation-major order',
            );
        expect(headers_read).toBe(2);
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
        expect(() => source.read_rows(0, 0, 1)).toThrow(
            /Corrupt \.dta file: strL object id .* is outside the dataset range/,
        );
    });

    it('rejects duplicate strL ids before mutating the cache or index', async () => {
        const fixture = build_dta_fixture();
        const first_gso = find_tag_end(fixture, '<strls>');
        const view = new DataView(fixture.buffer);
        const second_gso = first_gso + 20 + view.getUint32(first_gso + 16, true);
        view.setBigUint64(second_gso + 7, 1n, true);
        const source = await DtaDataSource.create(fixture);
        const internals = source as unknown as {
            gso_index: Map<string, { content_offset: number }>;
            gso_cache: Map<string, string>;
            gso_entries_scanned: number;
            gso_scan_position: number;
        };
        expect(source.read_raw_columns(0, 0, 1, [4]).rows[0][0]?.raw)
            .toBe('a long first value');
        const indexed_first = internals.gso_index.get('5:1');
        const cached_before_duplicate = [...internals.gso_cache];

        expect(() => source.read_raw_columns(0, 1, 1, [4])).toThrow(
            'Corrupt .dta file: duplicate strL object id 5:1',
        );
        expect(internals.gso_index.size).toBe(1);
        expect(internals.gso_index.get('5:1')).toBe(indexed_first);
        expect(indexed_first?.content_offset).toBe(first_gso + 20);
        expect([...internals.gso_cache]).toEqual(cached_before_duplicate);
        expect(internals.gso_entries_scanned).toBe(1);
        expect(internals.gso_scan_position).toBe(second_gso);
    });

    it('decodes release 119 strL pointers with the 3+5-byte layout', async () => {
        const source = await DtaDataSource.create(build_release119_strl_fixture());
        expect(source.read_rows(0, 0, 1).rows[0][0]?.raw).toBe('hello');
    });

    it('decodes release 117 fixed and strL strings as Windows-1252', async () => {
        const source = await DtaDataSource.create(build_release117_fixture());
        const row = source.read_rows(0, 0, 1).rows[0];
        expect(row[0]?.raw).toBe('café');
        expect(row[1]?.raw).toBe('café');
    });

    it('rejects metadata-complete files with truncated observations', async () => {
        const fixture = build_dta_fixture();
        const data_start = find_tag_end(fixture, '<data>');
        await expect(DtaDataSource.create(fixture.slice(0, data_start + 1))).rejects.toThrow(
            /observation data is truncated/,
        );
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
        source.close();
        source.close();
        expect((source as unknown as { bytes?: Uint8Array }).bytes).toBeUndefined();
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
        await expect(DtaDataSource.create(corrupt)).rejects.toThrow(
            /invalid data section tag/,
        );
    });

    it('rejects declared section offsets beyond the file', async () => {
        const fixture = build_dta_fixture();
        const map = find_tag_end(fixture, '<map>');
        const corrupt = fixture.slice();
        new DataView(corrupt.buffer).setBigUint64(
            map + 13 * 8,
            BigInt(corrupt.length + 1),
            true,
        );
        await expect(DtaDataSource.create(corrupt)).rejects.toThrow(
            /invalid end_of_file section offset/,
        );
    });

    it('rejects pre-Unicode value-label payloads beyond their declared entry length', async () => {
        const corrupt = build_legacy_dta_fixture();
        const table_length_offset = corrupt.length - (4 + 33 + 3 + 8 + 8 + 5);
        const declared_length_without_text = 33 + 3 + 8 + 8;
        new DataView(corrupt.buffer).setInt32(
            table_length_offset,
            declared_length_without_text,
            true,
        );
        const source = await DtaDataSource.create(corrupt);
        expect(() => source.read_rows(0, 0, 1)).toThrow(
            'Corrupt value label table: payload exceeds entry bounds',
        );
    });

    it('surfaces rejected releases as a clean open error', async () => {
        await expect(DtaDataSource.create(Uint8Array.of(104))).rejects.toThrow(
            /^Could not open Stata file:/,
        );
    });
});

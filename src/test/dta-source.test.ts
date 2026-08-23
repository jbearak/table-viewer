import { Buffer } from 'node:buffer';
import { describe, expect, it, vi } from 'vitest';
import { displayed_text } from '../webview/cell-renderer';
import { compute_transform } from '../table-transform';
import { align_sheet } from '../diff-compare/row-alignment';

const decode_spy = vi.hoisted(() => vi.fn());
const gso_index_spy = vi.hoisted(() => vi.fn());
vi.mock('@jbearak/dta-parser', async (import_original) => {
    const actual = await import_original<typeof import('@jbearak/dta-parser')>();
    return {
        ...actual,
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

/** Build a tiny release-118 file in memory; no binary fixture is committed. */
function build_dta_fixture(): Uint8Array {
    const writer = new ByteWriter();
    const variables: FixtureVariable[] = [
        { name: 'status', typeCode: 65530, format: '%8.0g', valueLabel: 'status_lbl' },
        { name: 'amount', typeCode: 65526, format: '%9.2f' },
        { name: 'name', typeCode: 5, format: '%-5s' },
        { name: 'missing', typeCode: 65530, format: '%8.0g', valueLabel: 'status_lbl' },
        { name: 'long_text', typeCode: 32768, format: '%9s' },
    ];
    const observations: Array<[number, number, string, number, string]> = [
        [1, 12.5, 'alpha', 101, 'a long first value'],
        [2, 2, 'beta', 102, 'second long value'],
        [1, 1000, 'gamma', 103, 'third long value'],
        [2, -3.25, 'delta', 127, 'fourth long value'],
    ];
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
        writer.u16(variables.length);
        writer.i32(row + 1);
        writer.u16(0);
    }
    writer.text('</data>');

    mark('strls');
    writer.text('<strls>');
    for (let row = 0; row < observations.length; row++) {
        const content = new TextEncoder().encode(`${observations[row][4]}\0`);
        writer.text('GSO');
        writer.i32(variables.length);
        writer.u64(row + 1);
        writer.u8(130);
        writer.i32(content.length);
        for (const byte of content) writer.u8(byte);
    }
    writer.text('</strls>');

    mark('value_labels');
    writer.text('<value_labels><lbl>');
    const labels = [
        new TextEncoder().encode('Zulu\0'),
        new TextEncoder().encode('Alpha\0'),
        new TextEncoder().encode('Refused\0'),
    ];
    const label_values = [1, 2, 2147483622]; // .a's value-label key
    const text_length = labels.reduce((total, label) => total + label.length, 0);
    const payload_length = 129 + 3 + 8 + labels.length * 8 + text_length;
    writer.i32(payload_length);
    writer.fixed('status_lbl', 129);
    writer.u8(0); writer.u8(0); writer.u8(0);
    writer.i32(labels.length);
    writer.i32(text_length);
    let label_offset = 0;
    for (const label of labels) {
        writer.i32(label_offset);
        label_offset += label.length;
    }
    for (const value of label_values) writer.i32(value);
    for (const label of labels) for (const byte of label) writer.u8(byte);
    writer.text('</lbl></value_labels>');

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

function build_legacy_dta_fixture(): Uint8Array {
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
    writer.u8(0); writer.i32(0); // expansion-fields terminator
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

function build_release119_strl_fixture(): Uint8Array {
    const writer = new ByteWriter();
    const offsets = new Map<string, number>();
    const mark = (name: string) => offsets.set(name, writer.length);
    mark('stata_data');
    writer.text('<stata_dta><header><release>119</release><byteorder>LSF</byteorder><K>');
    writer.i32(1);
    writer.text('</K><N>'); writer.u64(1);
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
    // Release 119 packs v into 3 bytes and o into 5 bytes.
    writer.u8(1); writer.u8(0); writer.u8(0);
    writer.i32(1); writer.u8(0);
    writer.text('</data>');
    mark('strls'); writer.text('<strls>GSO');
    writer.i32(1); writer.u64(1); writer.u8(130); writer.i32(6);
    writer.text('hello'); writer.u8(0);
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

    it('preserves binary strL payloads as distinct hexadecimal raw values', async () => {
        const original_fixture = build_dta_fixture();
        const modified_fixture = build_dta_fixture();
        const original_gso = find_tag_end(original_fixture, '<strls>');
        const modified_gso = find_tag_end(modified_fixture, '<strls>');
        const type_offset = 3 + 4 + 8;
        const content_offset = type_offset + 1 + 4;
        original_fixture[original_gso + type_offset] = 129;
        modified_fixture[modified_gso + type_offset] = 129;
        original_fixture[original_gso + content_offset] = 0x80;
        modified_fixture[modified_gso + content_offset] = 0x81;

        const original = await DtaDataSource.create(original_fixture);
        const modified = await DtaDataSource.create(modified_fixture);
        const original_raw = original.read_rows(0, 0, 1).rows[0][4]?.raw;
        const modified_raw = modified.read_rows(0, 0, 1).rows[0][4]?.raw;
        expect(original_raw).toMatch(/^hex:80/);
        expect(modified_raw).toMatch(/^hex:81/);
        expect(original_raw).not.toBe(modified_raw);
        const alignment = await align_sheet(original, modified, {
            status: 'matched', name: 'Sheet1', originalIndex: 0, modifiedIndex: 0,
        });
        expect(alignment.changedCells).toBe(1);
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

    it('reuses indexed GSO offsets instead of rescanning old strL entries', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        source.read_rows(0, 0, 4);
        const internals = source as unknown as {
            windows: Map<string, unknown>;
            gso_index: Map<number, number>;
            gso_cache: Map<number, string>;
            gso_scan_position: number;
        };
        expect(internals.gso_index.size).toBe(4);
        const exhausted_position = internals.gso_scan_position;
        internals.windows.clear();
        internals.gso_cache.clear();
        source.read_rows(0, 0, 1);
        expect(internals.gso_scan_position).toBe(exhausted_position);
    });

    it('dispatches .dta directly without an Excel header projection', async () => {
        const source = await build_source_from_buffer(build_dta_fixture(), '/tmp/example.dta');
        expect(source).toBeInstanceOf(DtaDataSource);
        expect(source.meta().sheets[0].rowCount).toBe(4);
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

    it('releases the file bytes on close', async () => {
        const source = await DtaDataSource.create(build_dta_fixture());
        source.close();
        expect((source as unknown as { bytes?: Uint8Array }).bytes).toBeUndefined();
        expect(() => source.read_rows(0, 0, 1)).toThrow(/closed/);
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
        // The final table starts after three 6-byte observations.
        const table_length_offset = corrupt.length - (4 + 33 + 3 + 8 + 8 + 5);
        new DataView(corrupt.buffer).setInt32(table_length_offset, 1, true);
        const source = await DtaDataSource.create(corrupt);
        expect(() => source.read_rows(0, 0, 1)).toThrow(/truncated header/);
    });

    it('surfaces rejected releases as a clean open error', async () => {
        await expect(DtaDataSource.create(Uint8Array.of(104))).rejects.toThrow(
            /^Could not open Stata file:/,
        );
    });
});

import { describe, expect, it } from 'vitest';
import type {
    DataSource,
    RenderedCell,
    RowWindow,
    WorkbookMeta,
} from '../data-source/interface';
import { serialize_csv } from '../serialize-csv';
import { plan_csv_save, type SavePlanInput } from '../viewer-controller';

function cell(raw: string): RenderedCell {
    return { raw, formatted: raw, bold: false, italic: false, rawType: 'string' };
}

class RecordingSource implements DataSource {
    readonly lineEnding: '\r\n' | '\r' | '\n';
    readonly reads: Array<{ start: number; count: number }> = [];

    constructor(
        private readonly row_count: number,
        private readonly events: string[],
        readonly headerLine?: string,
        line_ending: '\r\n' | '\r' | '\n' = '\n',
        private readonly column_count = 1,
        private readonly max_rows_per_read = Number.POSITIVE_INFINITY,
    ) {
        this.lineEnding = line_ending;
    }

    meta(): WorkbookMeta {
        return {
            hasFormatting: false,
            sheets: [{
                name: 'Sheet1',
                rowCount: this.row_count,
                sourceRowCount: this.row_count,
                columnCount: this.row_count === 0 ? 0 : this.column_count,
                merges: [],
                hasFormatting: false,
            }],
        };
    }

    read_rows(_sheet_index: number, start: number, count: number): RowWindow {
        this.reads.push({ start, count });
        this.events.push(`read:${start}:${count}`);
        const end = Math.min(
            start + count,
            start + this.max_rows_per_read,
            this.row_count,
        );
        return {
            startRow: start,
            rows: Array.from(
                { length: Math.max(0, end - start) },
                (_, offset) => [cell(`row ${start + offset}`)],
            ),
        };
    }

    close(): void {}
}

class RecordingEncoder {
    readonly texts: string[] = [];
    private readonly native = new TextEncoder();

    constructor(private readonly events: string[]) {}

    encode(text: string) {
        this.events.push(`encode:${this.texts.length}`);
        this.texts.push(text);
        return this.native.encode(text);
    }
}

function save_input(
    source: DataSource,
    edits: Readonly<Record<string, string>> = {},
    wanted_bases: ReadonlySet<string> = new Set(),
): SavePlanInput {
    return {
        source,
        file_path: '/tmp/windowed.csv',
        worksheets: [{
            sheet_index: 0,
            edits,
            wanted_bases,
        }],
    };
}

describe('plan_csv_save window encoding', () => {
    it('encodes each 10,000-row window before reading the next', () => {
        const events: string[] = [];
        const source = new RecordingSource(10_001, events, 'Name', '\r\n', 3);
        const encoder = new RecordingEncoder(events);
        const edits = {
            '0:0': 'FIRST',
            '9999:0': 'café, "quoted"',
            '10000:0': '😀',
            '10000:2': 'tail\r\nvalue',
        };
        const plan = plan_csv_save(
            save_input(source, edits, new Set(['9999:0', '10000:0'])),
            encoder,
        );

        expect(source.reads).toEqual([
            { start: 0, count: 10_000 },
            { start: 10_000, count: 10_000 },
        ]);
        expect(events).toEqual([
            'read:0:10000',
            'encode:0',
            'read:10000:10000',
            'encode:1',
        ]);
        expect(encoder.texts).toHaveLength(2);
        expect(encoder.texts[0].startsWith('Name\r\nFIRST\r\n')).toBe(true);
        expect(encoder.texts[1]).toBe('😀,,"tail\r\nvalue"\r\n');
        expect(plan.observed_bases[0].get('9999:0')).toBe('row 9999');
        expect(plan.observed_bases[0].get('10000:0')).toBe('row 10000');

        function* expected_rows() {
            for (let row = 0; row < 10_001; row += 1) {
                yield [cell(`row ${row}`)];
            }
        }
        const expected = new TextEncoder().encode(serialize_csv(
            expected_rows(),
            ',',
            edits,
            undefined,
            source.lineEnding,
            source.headerLine,
        ));
        const produced = plan.produce(new Uint8Array([0xff]));

        expect(produced).toEqual(expected);
        expect(plan.produce(new Uint8Array())).toBe(produced);
        expect(encoder.texts).toHaveLength(2);
    });

    it('continues from partial source windows without skipping rows', () => {
        const events: string[] = [];
        const source = new RecordingSource(
            10_001,
            events,
            undefined,
            '\n',
            1,
            4_000,
        );
        const encoder = new RecordingEncoder(events);
        const plan = plan_csv_save(save_input(source), encoder);

        expect(source.reads).toEqual([
            { start: 0, count: 10_000 },
            { start: 4_000, count: 10_000 },
            { start: 8_000, count: 10_000 },
        ]);
        expect(events).toEqual([
            'read:0:10000',
            'encode:0',
            'read:4000:10000',
            'encode:1',
            'read:8000:10000',
            'encode:2',
        ]);

        function* expected_rows() {
            for (let row = 0; row < 10_001; row += 1) {
                yield [cell(`row ${row}`)];
            }
        }
        expect(plan.produce(new Uint8Array())).toEqual(
            new TextEncoder().encode(serialize_csv(expected_rows(), ',')),
        );
    });

    it('rejects malformed or out-of-sheet edit coordinates before reading rows', () => {
        for (const key of ['01:0', '0:9007199254740991']) {
            const events: string[] = [];
            const source = new RecordingSource(1, events);
            const encoder = new RecordingEncoder(events);

            expect(() => plan_csv_save(
                save_input(source, { [key]: 'forged' }, new Set([key])),
                encoder,
            )).toThrow();
            expect(events).toEqual([]);
        }
    });

    it('does not encode a completely empty file', () => {
        const events: string[] = [];
        const encoder = new RecordingEncoder(events);
        const plan = plan_csv_save(
            save_input(new RecordingSource(0, events)),
            encoder,
        );

        expect(events).toEqual([]);
        expect(plan.produce(new Uint8Array())).toEqual(new Uint8Array());
    });

    it('encodes a blank header even when there are no data rows', () => {
        const events: string[] = [];
        const encoder = new RecordingEncoder(events);
        const plan = plan_csv_save(
            save_input(new RecordingSource(0, events, '', '\r')),
            encoder,
        );

        expect(events).toEqual(['encode:0']);
        expect(encoder.texts).toEqual(['\r']);
        expect(new TextDecoder().decode(plan.produce(new Uint8Array()))).toBe('\r');
    });
});

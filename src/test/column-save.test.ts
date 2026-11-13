// Saving column changes to CSV and TSV (row and column structure design,
// delivery step 8, "CSV and TSV"): the header line rewritten from its raw
// fields, so untouched fields keep their exact bytes; every record written in
// live column order at the prospective width; Pending Column values for
// source rows, inserted rows, and appended rows; and the receipt's column map.
import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { build_csv_source, plan_csv_save, type SavePlanInput } from '../viewer-controller';
import type { PendingColumn, PendingStructuralChanges, StructuralBasis } from '../pending-changes';
import { split_csv_raw_fields, split_csv_rows } from '../data-source/line-index';
import { delimited_column_writer } from '../structural-save';
import type { ColumnLayout, RowLayout } from '../worksheet-layout';

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function basis_of(bytes: Uint8Array, rows: number, columns: number): StructuralBasis {
    return {
        kind: 'delimited',
        byteLength: bytes.byteLength,
        digest: createHash('sha256').update(bytes).digest('hex'),
        sourceRowCount: rows,
        sourceColumnCount: columns,
    };
}

function column(id: string, header: string, cells: Record<string, string> = {}, order = 1): PendingColumn {
    return {
        id,
        header,
        cells: Object.fromEntries(Object.entries(cells).map(([key, value]) => [key, { value }])),
        format: { kind: 'none' },
        createdOrder: order,
    };
}

function changes(
    bytes: Uint8Array,
    rows: number,
    columns: number,
    layout: ColumnLayout,
    pending: readonly PendingColumn[] = [],
    extra: Partial<PendingStructuralChanges> = {},
): PendingStructuralChanges {
    return {
        formatTemplates: [],
        appendedRows: [],
        tailRemovals: [],
        conflicts: [],
        columnLayout: layout,
        ...(pending.length === 0 ? {} : { pendingColumns: pending }),
        structuralBasis: basis_of(bytes, rows, columns),
        ...extra,
    };
}

function layout(
    columns: ColumnLayout['columns'],
    removed: readonly number[] = [],
    discarded: ColumnLayout['discardedPendingColumns'] = [],
): ColumnLayout {
    return { columns, removedSourceColumns: removed, discardedPendingColumns: discarded };
}

const s = (sourceColumn: number) => ({ kind: 'source' as const, sourceColumn });
const p = (pendingColumnId: string) => ({ kind: 'pending' as const, pendingColumnId });

async function plan(
    text: string,
    file_path: string,
    structural: ((bytes: Uint8Array) => PendingStructuralChanges) | undefined,
    edits: Record<string, string> = {},
) {
    const bytes = encoder.encode(text);
    const source = await build_csv_source(bytes, file_path);
    const input: SavePlanInput = {
        source,
        file_path,
        worksheets: [{
            sheet_index: 0,
            edits,
            wanted_bases: new Set(Object.keys(edits)),
            structural_changes: structural?.(bytes),
        }],
    };
    const result = plan_csv_save(input);
    return { output: decoder.decode(result.produce(bytes)), result };
}

describe('raw header fields', () => {
    it('keep their source text and unquote to the parsed fields', () => {
        for (const [line, delimiter] of [
            ['name,"unit, price","say ""hi""",,"multi\nline",plain"quote', ','],
            ['a\t"b\tc"\t""', '\t'],
            ['', ','],
        ] as const) {
            const raw = split_csv_raw_fields(line, delimiter);
            expect(raw.join(delimiter)).toBe(line);
            const parsed = split_csv_rows(line, delimiter)[0] ?? [''];
            expect(raw.map((field) => split_csv_rows(field, delimiter)[0]?.[0] ?? '')).toEqual(parsed);
        }
    });
});

describe('plan_csv_save with a column layout', () => {
    const SOURCE = 'name,"unit, price","note\nline",qty\napple,"1,25",x,3\nbanana,0.5\ncherry,2,"y ""z""",7\n';

    it('inserts a column, keeping every untouched header field byte for byte and padding short rows', async () => {
        const { output, result } = await plan(SOURCE, '/tmp/c.csv', (bytes) => changes(
            bytes, 3, 4,
            layout([s(0), s(1), p('origin'), s(2), s(3)]),
            [column('origin', 'from, where', { 's:0': 'Spain', 's:2': 'a "b"' })],
        ));
        expect(output).toBe([
            'name,"unit, price","from, where","note\nline",qty',
            'apple,"1,25",Spain,x,3',
            'banana,0.5,,,',
            'cherry,2,"a ""b""","y ""z""",7',
            '',
        ].join('\n'));
        expect(result.receipt?.structure?.[0]).toMatchObject({
            columnMap: [0, 1, 3, 4],
            insertedColumns: [{ pendingColumnId: 'origin', column: 2 }],
            rowRuns: [{ from: 0, count: 3, to: 0 }],
        });
    });

    it('deletes and moves columns, dropping removed fields from the header and every record', async () => {
        const { output, result } = await plan(SOURCE, '/tmp/c.csv', (bytes) => changes(
            bytes, 3, 4,
            layout([s(3), s(0), s(1), s(2)], [1]),
        ), { '0:3': 'thirty', '2:0': 'Cherry, red' });
        expect(output).toBe([
            'qty,name,"note\nline"',
            'thirty,apple,x',
            ',banana,',
            '7,"Cherry, red","y ""z"""',
            '',
        ].join('\n'));
        expect(result.receipt?.structure?.[0]?.columnMap).toEqual([1, null, 2, 0]);
        expect(result.observed_bases[0]).toEqual(new Map([['0:3', '3'], ['2:0', 'cherry']]));
    });

    for (const [label, newline] of [['LF', '\n'], ['CRLF', '\r\n'], ['CR', '\r']] as const) {
        it(`moves and inserts TSV columns with ${label} newlines`, async () => {
            const text = ['h1\t"h\t2"\th3', 'a\tb\tc', 'd\te\tf'].join(newline) + newline;
            const { output } = await plan(text, '/tmp/c.tsv', (bytes) => changes(
                bytes, 2, 3,
                layout([s(2), p('n'), s(0), s(1)]),
                [column('n', 'tab\there', { 's:1': 'two\nlines' })],
            ));
            expect(output).toBe([
                'h3\t"tab\there"\th1\t"h\t2"',
                'c\t\ta\tb',
                `f\t"two\nlines"\td\te`,
            ].join(newline) + newline);
        });
    }

    it('writes Pending Column values for inserted and appended rows by their identities', async () => {
        const text = 'name,qty\na,1\nb,2\n';
        const names = { columnCount: 2, columnNames: ['name', 'qty'] };
        const { output, result } = await plan(text, '/tmp/c.csv', (bytes) => changes(
            bytes, 2, 2,
            layout([s(0), p('c'), s(1)]),
            [column('c', 'note', { 's:1': 'second', 'p:ins': 'inserted', 'p:app': 'appended' })],
            {
                rowLayout: {
                    runs: [
                        { kind: 'source', start: 0, count: 1 },
                        { kind: 'pending', ids: ['ins'] },
                        { kind: 'source', start: 1, count: 1 },
                    ],
                    removedSourceRows: [],
                    discardedPendingRows: [],
                } satisfies RowLayout,
                formatTemplates: [{ id: 'plain', format: { kind: 'none' } }],
                appendBasis: {
                    sourceRowCount: 2,
                    columnCount: 2,
                    schemaFingerprint: `sha256:${createHash('sha256').update(JSON.stringify(names)).digest('hex')}`,
                },
                appendedRows: [
                    { id: 'ins', origin: 'insert', cells: { 0: { value: 'new' } }, formatTemplateId: 'plain', createdOrder: 1 },
                    { id: 'app', cells: { 1: { value: '9' } }, formatTemplateId: 'plain', createdOrder: 2 },
                ],
            },
        ));
        expect(output).toBe('name,note,qty\na,,1\nnew,inserted,\nb,second,2\n,appended,9\n');
        expect(result.receipt?.structure?.[0]?.insertedColumns).toEqual([{ pendingColumnId: 'c', column: 1 }]);
        expect(result.receipt?.appendedRows.map((row) => [row.pendingRowId, row.sourceRow])).toEqual([['app', 3]]);
    });

    it('matches the old path byte for byte when the column layout holds only tombstones', async () => {
        const text = 'h,"q ""x"""\r\n1,"a\r\nb"\r\n2\r\n';
        const plain = await plan(text, '/tmp/c.csv', undefined, { '1:1': 'z' });
        const tombstones = await plan(text, '/tmp/c.csv', (bytes) => ({
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            columnLayout: layout([s(0), p('gone'), s(1)], [], [{ id: 'gone', createdOrder: 1 }]),
        } satisfies PendingStructuralChanges), { '1:1': 'z' });
        expect(tombstones.output).toBe(plain.output);
        expect(tombstones.result.receipt?.structure).toBeUndefined();
    });

    it('rewrites the header only when the column layout changes, keeping ragged rows otherwise', async () => {
        const text = 'a,"b, c"\n1\n2,3\n';
        const rows_only = await plan(text, '/tmp/c.csv', (bytes) => ({
            formatTemplates: [],
            appendedRows: [],
            tailRemovals: [],
            conflicts: [],
            rowLayout: { runs: [{ kind: 'source', start: 1, count: 1 }, { kind: 'source', start: 0, count: 1 }], removedSourceRows: [], discardedPendingRows: [] },
            structuralBasis: basis_of(bytes, 2, 2),
        }));
        expect(rows_only.output).toBe('a,"b, c"\n2,3\n1\n');
    });

    it('refuses an edit in a removed column and rich content in a Pending Column', async () => {
        await expect(plan('a,b\n1,2\n', '/tmp/c.csv', (bytes) => changes(bytes, 1, 2, layout([s(0), s(1)], [1])), { '0:1': 'x' }))
            .rejects.toThrow('addresses a removed row or column');
        expect(() => delimited_column_writer(layout([s(0), p('r')]), [{
            ...column('r', 'rich'),
            cells: { 's:0': { value: 'x', valueRuns: { runs: [{ text: 'x' }] } } },
        } as unknown as PendingColumn], ',')).toThrow('cannot contain rich text');
    });

    it('refuses a column layout whose basis describes another width', async () => {
        await expect(plan('a,b\n1,2\n', '/tmp/c.csv', (bytes) => ({
            ...changes(bytes, 1, 2, layout([s(1), s(0)])),
            structuralBasis: basis_of(bytes, 1, 3),
        }))).rejects.toMatchObject({ conflict: { reason: 'structuralBasisChanged' } });
    });
});

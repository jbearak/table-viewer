// Non-structural `.xlsx` saves are unchanged by the structural save stage
// (delivery step 9c). Two comparisons, both independent of the machine:
//
// - In the same run, a save with structural editing on writes exactly the
//   bytes the same save writes with it off.
// - Against the commit before step 9c (437e4a8), the saved package's
//   content digest matches. That digest covers everything in the package
//   except the DEFLATE streams: entry order and names, every local and
//   central header field but the compressed size and offset, and each
//   entry's inflated bytes. Rewritten parts are recompressed with Node's
//   zlib, whose output differs between zlib builds (macOS and Linux CI
//   disagree), so whole-file digests cannot be pinned. The repository's ZIP
//   writer itself is deterministic: it copies untouched entries verbatim,
//   keeps a rewritten entry's DOS time, and stamps an added one 1980-01-01,
//   never the clock.
//
// The pinned digests were produced by this same test on 437e4a8 with
// `PRINT_XLSX_SAVE_DIGESTS=1`.
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { simulate_process_restart_for_tests } from '../viewer-controller';
import { ZipPackage } from '../zip-package';
import { open_xlsx } from './helpers/xlsx-viewer';
import { representative_workbook } from './helpers/xlsx-structure-fixture';
import * as vscode_mock from './mocks/vscode';

afterEach(() => {
    for (const panel of vscode_mock.__getPanels()) panel.dispose();
    vi.restoreAllMocks();
    vscode_mock.__reset();
    simulate_process_restart_for_tests();
});

const fixture = (name: string) => new Uint8Array(readFileSync(join(__dirname, 'fixtures', name)));

const GOLDEN: Record<string, string> = {
    'formatted.xlsx cell edit': 'cfebbe6efac35e2d1b93939e58d8f8545981f328a98cad78a46425cb14c80f3c',
    'formatted.xlsx append': '3051c8b761685cd0279e545d9bd22f6a1864faf509d6a9267f1990a3e3a4a021',
    'representative cell and formula edit': 'c3f6827c5076f472f068be69f62555fff7045e410092c954ae28af7c20c9cd1a',
    'representative append': 'c4f0f08634046d2dd4c02bf4b74c010ba0048798f2cc753a0c1ebb0efb1edb37',
};

/**
 * A digest of a ZIP package without its compressed streams: per central
 * directory entry in order, the central and local header bytes with the
 * compressed size and offset zeroed, and the SHA-256 of the inflated content.
 */
function package_content_digest(bytes: Uint8Array): string {
    const buffer = Buffer.from(bytes);
    const eocd = buffer.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    const entries = buffer.readUInt16LE(eocd + 10);
    const zip = ZipPackage.open(bytes);
    const hash = createHash('sha256');
    let offset = buffer.readUInt32LE(eocd + 16);
    for (let index = 0; index < entries; index += 1) {
        const name_length = buffer.readUInt16LE(offset + 28);
        const extra_length = buffer.readUInt16LE(offset + 30);
        const comment_length = buffer.readUInt16LE(offset + 32);
        const length = 46 + name_length + extra_length + comment_length;
        const central = Buffer.from(buffer.subarray(offset, offset + length));
        const local_offset = central.readUInt32LE(42);
        central.writeUInt32LE(0, 20);
        central.writeUInt32LE(0, 42);
        const local_length = 30 + buffer.readUInt16LE(local_offset + 26) + buffer.readUInt16LE(local_offset + 28);
        const local = Buffer.from(buffer.subarray(local_offset, local_offset + local_length));
        local.writeUInt32LE(0, 18);
        const name = central.subarray(46, 46 + name_length).toString('utf8');
        hash.update(central).update(local);
        if (!name.endsWith('/')) hash.update(createHash('sha256').update(zip.read(`/${name}`)!).digest('hex'));
        offset += length;
    }
    return hash.digest('hex');
}

type Viewer = Awaited<ReturnType<typeof open_xlsx>>;
type Save = (viewer: Viewer) => Promise<void>;

/** The saved bytes with structural editing on and off, from the same input. */
async function saved_both_ways(input: Uint8Array, save: Save): Promise<{ on: Uint8Array; off: Uint8Array }> {
    const saved: Uint8Array[] = [];
    for (const structuralEditingEnabled of [true, false]) {
        const viewer = await open_xlsx(input, { structuralEditingEnabled });
        await save(viewer);
        saved.push(viewer.file.bytes);
        viewer.dispose();
        vscode_mock.__reset();
        simulate_process_restart_for_tests();
    }
    return { on: saved[0]!, off: saved[1]! };
}

async function check(label: string, input: Uint8Array, save: Save): Promise<void> {
    const { on, off } = await saved_both_ways(input, save);
    expect(Buffer.from(on).equals(Buffer.from(input))).toBe(false);
    expect(Buffer.from(on).equals(Buffer.from(off))).toBe(true);
    const digest = package_content_digest(on);
    if (process.env.PRINT_XLSX_SAVE_DIGESTS) console.log(`GOLDEN ${JSON.stringify(label)}: '${digest}',`);
    else expect([label, digest]).toEqual([label, GOLDEN[label]]);
}

const append_one = (cells: Record<number, { value: string }>): Save => async (viewer) => {
    const append = await viewer.append('append', 1);
    await viewer.settle('append', true);
    const result = await viewer.save([{
        sheetIndex: 0,
        structural: {
            formatTemplates: [append.formatTemplate!],
            appendedRows: [{
                id: append.rowIds![0]!,
                cells,
                formatTemplateId: append.formatTemplate!.id,
                createdOrder: 1,
            }],
            appendBasis: append.appendBasis!,
        },
    }]);
    expect(result).toMatchObject({ success: true });
};

describe('non-structural .xlsx saves', () => {
    it('write a cell edit as before', async () => {
        await check('formatted.xlsx cell edit', fixture('formatted.xlsx'), async (viewer) => {
            // The first attempt learns the cell's base from the host's rejection.
            const probe = await viewer.save([{ sheetIndex: 0, cells: { '0:0': { value: 'changed', base: '\u0000' } } }]);
            const base = (probe.rejection as { observedBases?: Record<string, { value: string }> })
                .observedBases!['0:0']!.value;
            const result = await viewer.save([{ sheetIndex: 0, cells: { '0:0': { value: 'changed', base } } }]);
            expect(result).toMatchObject({ success: true });
        });
    });

    it('write an append as before', async () => {
        await check('formatted.xlsx append', fixture('formatted.xlsx'), append_one({ 0: { value: 'appended' } }));
    });

    it('write cell and formula edits on a workbook with cross-sheet formulas as before', async () => {
        await check('representative cell and formula edit', representative_workbook({ calcChain: true }), async (viewer) => {
            const result = await viewer.save([
                { sheetIndex: 0, cells: { '2:1': { value: '6', base: '5' } } },
                { sheetIndex: 1, cells: { '1:1': { value: '=Data!B3*2', base: '=Data!B5' } } },
            ]);
            expect(result).toMatchObject({ success: true });
        });
    });

    it('write an append on a workbook with cross-sheet formulas as before', async () => {
        await check(
            'representative append',
            representative_workbook({ calcChain: true }),
            append_one({ 0: { value: 'Grape' }, 1: { value: '4' } }),
        );
    });
});

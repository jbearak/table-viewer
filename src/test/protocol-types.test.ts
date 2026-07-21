import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { describe, it, expect } from 'vitest';
import type { HostMessage, WebviewMessage } from '../types';
import type { WorkbookMeta, RenderedCell } from '../data-source/interface';
import type { RetainedSnapshotCommandResult } from '../viewer-snapshot';

function protocol_sources(directory: string): string[] {
    return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
        const path = join(directory, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'test') return [];
            return protocol_sources(path);
        }
        return /\.tsx?$/.test(entry.name) ? [path] : [];
    });
}

type AssertNever<T extends never> = T;

describe('paginated protocol message shapes', () => {
    const meta: WorkbookMeta = {
        hasFormatting: false,
        sheets: [{ name: 'Sheet1', rowCount: 3, columnCount: 2, merges: [], hasFormatting: false }],
    };

    it('rejects removed metadata discriminants at compile time', () => {
        type RemovedSheetMessage = `sheet${'Meta'}`;
        type RemovedReloadMessage = `meta${'Reload'}`;
        type RemovedRecoveryMessage = `meta${'Reload'}${'Recovery'}`;
        type RemovedHeaderErrorMessage = `excelFirstRowHeader${'Error'}`;
        const proof: readonly [
            AssertNever<Extract<HostMessage, { type: RemovedSheetMessage }>>,
            AssertNever<Extract<HostMessage, { type: RemovedReloadMessage }>>,
            AssertNever<Extract<HostMessage, { type: RemovedRecoveryMessage }>>,
            AssertNever<Extract<HostMessage, { type: RemovedHeaderErrorMessage }>>,
        ] | null = null;

        expect(proof).toBeNull();
    });

    it('has no removed metadata discriminants in protocol source', () => {
        const source_root = join(__dirname, '..');
        const forbidden = [
            `sheet${'Meta'}`,
            `meta${'Reload'}`,
            `meta${'Reload'}${'Recovery'}`,
            `excelFirstRowHeader${'Error'}`,
        ];
        const matches = protocol_sources(source_root).flatMap((path) => {
            const contents = readFileSync(path, 'utf8');
            return forbidden
                .filter((message_type) => contents.includes(message_type))
                .map((message_type) => `${relative(source_root, path)}: ${message_type}`);
        });
        expect(matches).toEqual([]);
    });

    it('carries a complete workbookSnapshot authority envelope', () => {
        const msg: HostMessage = {
            type: 'workbookSnapshot',
            snapshot: {
                identity: {
                    deliveryId: 12,
                    authority: { fileId: 'file:people.xlsx', revision: 9 },
                    stateRevision: 44,
                    sourceBasis: {
                        physicalRevision: 7,
                        projectionRevision: 2,
                    },
                },
                generation: 5,
                sourceGeneration: 4,
                presentation: 'refresh',
                reason: 'excelHeader',
                meta,
                state: {
                    columnWidths: [],
                    rowHeights: [],
                    scrollPosition: [],
                    activeSheetIndex: 0,
                    tabOrientation: null,
                    transforms: [],
                    columnVisibility: [],
                },
                configuration: {
                    defaultTabOrientation: 'horizontal',
                    previewMode: false,
                },
                capabilities: {
                    csvEditable: false,
                    csvEditingSupported: false,
                    csvSaveLifecycle: { revision: 0, state: 'idle' },
                },
                truncationMessage: null,
                commandResult: {
                    type: 'excelFirstRowHeader',
                    requestId: 'header:1',
                    outcome: 'applied',
                },
            },
        };
        expect(msg.snapshot.identity.stateRevision).toBe(44);
        expect(msg.snapshot.commandResult?.requestId).toBe('header:1');
    });

    it('types every retained Excel header terminal outcome', () => {
        const results: RetainedSnapshotCommandResult[] = [
            {
                type: 'excelFirstRowHeader',
                requestId: 'applied',
                outcome: 'applied',
            },
            {
                type: 'excelFirstRowHeader',
                requestId: 'recovered',
                outcome: 'recovered',
                error: 'Recovered after an ambiguous finalization.',
            },
            {
                type: 'excelFirstRowHeader',
                requestId: 'rejected',
                outcome: 'rejected',
                error: 'The worksheet changed.',
            },
        ];

        expect(results.map(({ outcome }) => outcome)).toEqual([
            'applied',
            'recovered',
            'rejected',
        ]);
    });

    it('HostMessage carries a rowData variant addressed by sheet/start/requestId', () => {
        const cell: RenderedCell = { raw: 'a', formatted: 'a', bold: false, italic: false };
        const msg: HostMessage = {
            type: 'rowData',
            sheetIndex: 0,
            startRow: 100,
            rows: [[cell, null]],
            requestId: 'req-1',
            generation: 3,
        };
        expect(msg.type).toBe('rowData');
        if (msg.type === 'rowData') {
            expect(msg.startRow).toBe(100);
            expect(msg.rows[0][0]?.raw).toBe('a');
            expect(msg.rows[0][1]).toBeNull();
            expect(msg.requestId).toBe('req-1');
        }
    });

    it('echoes exact snapshot identity and disposition in snapshotApplied', () => {
        const msg: WebviewMessage = {
            type: 'snapshotApplied',
            identity: {
                deliveryId: 12,
                authority: { fileId: 'file:people.xlsx', revision: 9 },
                stateRevision: 44,
                sourceBasis: {
                    physicalRevision: 7,
                    projectionRevision: 2,
                },
            },
            disposition: 'stale',
        };
        expect(msg.identity.deliveryId).toBe(12);
        expect(msg.disposition).toBe('stale');
    });

    it('WebviewMessage fences state snapshots by source generation', () => {
        const msg: WebviewMessage = {
            type: 'stateChanged',
            sourceGeneration: 3,
            snapshotIdentity: {
                deliveryId: 12,
                authority: { fileId: 'file:people.xlsx', revision: 9 },
                stateRevision: 44,
                sourceBasis: {
                    physicalRevision: 7,
                    projectionRevision: 2,
                },
            },
            state: {
                rowHeights: [{ 0: 44 }],
                scrollPosition: [{ top: 100, left: 20 }],
            },
        };
        expect(msg.sourceGeneration).toBe(3);
        expect(msg.snapshotIdentity.deliveryId).toBe(12);
    });

    it('rejects stateChanged without a snapshot identity at compile time', () => {
        type StateChanged = Extract<WebviewMessage, { type: 'stateChanged' }>;
        type IdentitylessStateChanged = Omit<StateChanged, 'snapshotIdentity'>;
        type MissingIdentityIsAccepted = IdentitylessStateChanged extends StateChanged
            ? true
            : false;
        const proof: MissingIdentityIsAccepted = false;
        expect(proof).toBe(false);
    });

    it('WebviewMessage carries a showWarning variant with a message', () => {
        const msg: WebviewMessage = {
            type: 'showWarning',
            message: 'Copied data was clipped.',
        };
        expect(msg.type).toBe('showWarning');
        if (msg.type === 'showWarning') {
            expect(msg.message).toBe('Copied data was clipped.');
        }
    });

    it('retains header and column visibility request shapes', () => {
        const request: WebviewMessage = {
            type: 'setExcelFirstRowHeader',
            sheetIndex: 1,
            sheetName: 'People',
            enabled: true,
            requestId: 'header:1',
            generation: 2,
            sourceGeneration: 3,
        };
        const visibility: WebviewMessage = {
            type: 'setColumnVisibility',
            sheetIndex: 1,
            sheetName: 'People',
            state: undefined,
            sourceGeneration: 3,
            snapshotIdentity: {
                deliveryId: 12,
                authority: { fileId: 'file:people.xlsx', revision: 9 },
                stateRevision: 44,
                sourceBasis: {
                    physicalRevision: 7,
                    projectionRevision: 2,
                },
            },
        };
        expect(request.type).toBe('setExcelFirstRowHeader');
        expect(visibility.type).toBe('setColumnVisibility');
        expect(visibility.snapshotIdentity.deliveryId).toBe(12);
    });

    it('rejects setColumnVisibility without a snapshot identity at compile time', () => {
        type Visibility = Extract<WebviewMessage, { type: 'setColumnVisibility' }>;
        type IdentitylessVisibility = Omit<Visibility, 'snapshotIdentity'>;
        type MissingIdentityIsAccepted = IdentitylessVisibility extends Visibility
            ? true
            : false;
        const proof: MissingIdentityIsAccepted = false;
        expect(proof).toBe(false);
    });

    it('WebviewMessage carries a requestRows variant', () => {
        const msg: WebviewMessage = {
            type: 'requestRows',
            sheetIndex: 0,
            startRow: 100,
            count: 50,
            requestId: 'req-1',
            generation: 3,
        };
        expect(msg.type).toBe('requestRows');
        if (msg.type === 'requestRows') {
            expect(msg.count).toBe(50);
            expect(msg.generation).toBe(3);
        }
    });
});

import { describe, expect, it } from 'vitest';
import type { WorkbookMeta } from '../data-source/interface';
import type {
    FileAuthoritySnapshot,
    ProjectionAuthorityCommitReceipt,
} from '../file-coordinator';
import {
    build_workbook_snapshot,
    classify_snapshot,
    type BuildWorkbookSnapshotInput,
    type RetainedSnapshotCommandResult,
    type WorkbookSnapshotIdentity,
} from '../viewer-snapshot';

describe('workbook snapshot builder', () => {
    it('keeps commit and observed source inputs mutually exclusive', () => {
        type CommitInput = Extract<BuildWorkbookSnapshotInput, { source: 'commitReceipt' }>;
        type ObservedInput = Extract<BuildWorkbookSnapshotInput, { source: 'observed' }>;
        type CommitHasIndependentAuthority = 'authority' extends keyof CommitInput
            ? true
            : false;
        type CommitHasIndependentState = 'state_snapshot' extends keyof CommitInput
            ? true
            : false;
        type ObservedHasReceipt = 'receipt' extends keyof ObservedInput ? true : false;
        const shape: [
            CommitHasIndependentAuthority,
            CommitHasIndependentState,
            ObservedHasReceipt,
        ] = [false, false, false];

        expect(shape).toEqual([false, false, false]);
    });

    it('maps every authority and generation identity exactly', () => {
        const authority: FileAuthoritySnapshot = {
            fileKey: '/canonical/book.xlsx',
            commitSequence: 19,
            authorityRevision: 13,
            physicalRevision: 8,
            projectionRevision: 5,
            physicalDigest: 'digest',
        };
        const authorityReceipt: ProjectionAuthorityCommitReceipt = {
            operationKind: 'projection',
            operationOrdinal: 22,
            previousBasis: {
                ...authority,
                authorityRevision: 12,
                projectionRevision: 4,
            },
            resultingBasis: authority,
            stateSnapshot: { state: {}, revision: 41 },
        };
        const snapshot = build_workbook_snapshot({
            deliveryId: 27,
            canonicalFileId: 'file:/canonical/book.xlsx',
            source: 'commitReceipt',
            receipt: authorityReceipt,
            core: {
                generation: 7,
                sourceGeneration: 6,
                meta: { sheets: [], hasFormatting: false },
            },
            presentation: 'refresh',
            reason: 'retry',
            configuration: {
                defaultTabOrientation: 'vertical',
                previewMode: false,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
                csvSaveLifecycle: { revision: 0, state: 'idle' },
            },
            diagnostics: { truncationMessage: null },
        });

        expect(snapshot.identity).toEqual({
            deliveryId: 27,
            authority: {
                fileId: 'file:/canonical/book.xlsx',
                revision: 13,
            },
            stateRevision: 41,
            sourceBasis: {
                physicalRevision: 8,
                projectionRevision: 5,
            },
        });
        expect(snapshot.generation).toBe(7);
        expect(snapshot.sourceGeneration).toBe(6);
        expect(snapshot.configuration.previewMode).toBe(false);
        expect(snapshot.capabilities).toEqual({
            csvEditable: false,
            csvEditingSupported: false,
            csvSaveLifecycle: { revision: 0, state: 'idle' },
        });
    });

    it('builds complete state and isolates all retained delivery material', () => {
        const meta: WorkbookMeta = {
            hasFormatting: true,
            sheets: [{
                name: 'People',
                rowCount: 3,
                columnCount: 2,
                merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
                hasFormatting: true,
                columnNames: ['Name', 'Age'],
            }],
        };
        const state: {
            pendingEdits: Record<string, string>;
            excelFirstRowHeaders: Record<string, 'on' | 'off'>;
        } = {
            pendingEdits: { '0:0': 'Ada' },
            excelFirstRowHeaders: { People: 'on' },
        };
        const configuration = {
            defaultTabOrientation: 'horizontal' as const,
            previewMode: false,
        };
        const capabilities = {
            csvEditable: false,
            csvEditingSupported: false,
            csvSaveLifecycle: { revision: 0, state: 'idle' as const },
        };
        const diagnostics = { truncationMessage: 'Rows were truncated.' as string | null };
        const commandResult: RetainedSnapshotCommandResult = {
            type: 'excelFirstRowHeader',
            requestId: 'header:1',
            outcome: 'recovered',
            error: 'Ambiguous finalization was reconciled.',
        };
        const snapshot = build_workbook_snapshot({
            deliveryId: 1,
            canonicalFileId: '/book.xlsx',
            source: 'observed',
            authority: {
                fileKey: '/book.xlsx',
                commitSequence: 2,
                authorityRevision: 2,
                physicalRevision: 1,
                projectionRevision: 1,
            },
            state_snapshot: { state, revision: 9 },
            core: { generation: 4, sourceGeneration: 3, meta },
            presentation: 'initial',
            reason: 'ready',
            configuration,
            capabilities,
            diagnostics,
            commandResult,
        });

        meta.sheets[0].name = 'Mutated';
        meta.sheets[0].merges[0].endCol = 99;
        meta.sheets[0].columnNames![0] = 'Changed';
        state.pendingEdits['0:0'] = 'Grace';
        state.excelFirstRowHeaders.People = 'off';
        configuration.previewMode = true;
        capabilities.csvEditable = true;
        diagnostics.truncationMessage = null;
        (commandResult as { error?: string }).error = 'Changed';

        expect(snapshot.meta.sheets[0]).toMatchObject({
            name: 'People',
            merges: [{ endCol: 1 }],
            columnNames: ['Name', 'Age'],
        });
        expect(snapshot.state).toMatchObject({
            columnWidths: [],
            rowHeights: [],
            scrollPosition: [],
            activeSheetIndex: 0,
            tabOrientation: null,
            transforms: [undefined],
            columnVisibility: [undefined],
            pendingEdits: { '0:0': 'Ada' },
            excelFirstRowHeaders: { People: 'on' },
        });
        expect(snapshot.configuration.previewMode).toBe(false);
        expect(snapshot.capabilities.csvEditable).toBe(false);
        expect(snapshot.truncationMessage).toBe('Rows were truncated.');
        expect(snapshot.commandResult?.error).toBe('Ambiguous finalization was reconciled.');
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.meta.sheets[0].merges)).toBe(true);
        expect(Object.isFrozen(snapshot.state.pendingEdits)).toBe(true);
        expect(Object.isFrozen(snapshot.commandResult)).toBe(true);
    });
});

describe('snapshot classification', () => {
    const identity = (
        deliveryId: number,
        overrides: Partial<WorkbookSnapshotIdentity> = {},
    ): WorkbookSnapshotIdentity => ({
        deliveryId,
        authority: { fileId: 'file:test', revision: 4 },
        stateRevision: 7,
        sourceBasis: { physicalRevision: 5, projectionRevision: 2 },
        ...overrides,
    });

    it.each([
        'capability-only delivery',
        'result-only delivery',
        'same-authority generation change',
        'new ready receiver epoch',
    ])('applies a new same-basis identity for %s', () => {
        expect(classify_snapshot(identity(2), identity(1))).toBe('applied');
    });

    it('classifies a retry with the same delivery ID as duplicate', () => {
        expect(classify_snapshot(identity(1), identity(1))).toBe('duplicate');
    });

    it.each([
        identity(2, { stateRevision: 6 }),
        identity(2, {
            sourceBasis: { physicalRevision: 4, projectionRevision: 2 },
        }),
        identity(2, {
            sourceBasis: { physicalRevision: 5, projectionRevision: 1 },
        }),
        identity(2, {
            stateRevision: 8,
            sourceBasis: { physicalRevision: 4, projectionRevision: 2 },
        }),
    ])('rejects a lower semantic basis as stale', (incoming) => {
        expect(classify_snapshot(incoming, identity(1))).toBe('stale');
    });

    it.each([
        identity(2, { stateRevision: 8 }),
        identity(2, {
            sourceBasis: { physicalRevision: 6, projectionRevision: 2 },
        }),
        identity(2, {
            sourceBasis: { physicalRevision: 5, projectionRevision: 3 },
        }),
    ])('applies a greater semantic basis', (incoming) => {
        expect(classify_snapshot(incoming, identity(1))).toBe('applied');
    });

    it('rejects an older delivery with an equal semantic basis', () => {
        expect(classify_snapshot(identity(1), identity(2))).toBe('stale');
    });
});

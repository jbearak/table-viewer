import { describe, expect, it } from 'vitest';
import type { WorkbookMeta } from '../data-source/interface';
import { cell_highlight_states_equal } from '../cell-highlights';
import { transform_schema_for_sheet } from '../types';
import type {
    FileAuthoritySnapshot,
    ProjectionAuthorityCommitReceipt,
} from '../file-coordinator';
import {
    build_workbook_snapshot,
    classify_snapshot,
    normalize_workbook_snapshot_state,
    type BuildWorkbookSnapshotInput,
    type RetainedSnapshotCommandResult,
    type WorkbookSnapshotIdentity,
} from '../viewer-snapshot';
import { sheet_edits } from './pending-edits-helper';
import type { PerFileState } from '../types';

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
                hiddenEditedCellKeys: [],
                rowHeightProjection: [],
                mappingGenerations: [],
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
                sourceRowCount: 3,
                columnCount: 2,
                merges: [{ startRow: 0, startCol: 0, endRow: 0, endCol: 1 }],
                hasFormatting: true,
                columnNames: ['Name', 'Age'],
            }],
        };
        const state: {
            pendingEdits: PerFileState['pendingEdits'];
            excelFirstRowHeaders: Record<string, 'on' | 'off'>;
            rowHeights: (Record<number, number> | undefined)[];
        } = {
            pendingEdits: sheet_edits({ '0:0': 'Ada' }),
            excelFirstRowHeaders: { People: 'on' },
            // Present in durable state and asserted *absent* from the delivery below.
            // `NormalizedPerFileState` omits the field: the webview renders from
            // `rowHeightProjection` and must never be handed the source-keyed map beside
            // the display-keyed one, which for a pre-cap legacy select-all map would also
            // be the largest thing on the wire.
            rowHeights: [{ 2: 44 }],
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
        // Per sheet, and mutated below with everything else: the core re-samples these
        // for every delivery, so an issued snapshot sharing the array would let a later
        // sample rewrite what an earlier delivery said was out of sight.
        const hidden_edited_cell_keys = [['2:0']];
        // Same reason, and the consequence of sharing it is worse: a later sample
        // rewriting an issued delivery's projection would render heights against a
        // permutation that delivery never described.
        //
        // The *entries* are frozen and the array is not, deliberately: that isolates the
        // array half of the freeze guard in `build_workbook_snapshot`, which is the half
        // the `[0] = …` mutation below exercises. The entry half is covered by its own
        // half-frozen case further down, where the array is frozen and the map is not.
        const row_height_projection: (Readonly<Record<number, number>> | undefined)[] =
            [Object.freeze({ 2: 44 })];
        // And once more for the third permutation-relative value sampled in the same
        // statement. Numbers, so there is no entry half to freeze — but the array is
        // resampled on every delivery just like the two above, and an issued snapshot
        // sharing it would let a later install rewrite the verdict an earlier delivery
        // gave a webview about whether its display-keyed overlay was still valid.
        const mapping_generations = [2];
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
                physicalDigest: 'digest',
            },
            state_snapshot: { state, revision: 9 },
            core: {
                generation: 4,
                sourceGeneration: 3,
                meta,
                hiddenEditedCellKeys: hidden_edited_cell_keys,
                rowHeightProjection: row_height_projection,
                mappingGenerations: mapping_generations,
            },
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
        state.pendingEdits![0]!.cells['0:0'] = 'Grace';
        state.excelFirstRowHeaders.People = 'off';
        configuration.previewMode = true;
        capabilities.csvEditable = true;
        diagnostics.truncationMessage = null;
        hidden_edited_cell_keys[0].push('3:0');
        row_height_projection[0] = { 9: 99 };
        mapping_generations[0] = 99;
        (commandResult as { error?: string }).error = 'Changed';

        expect(snapshot.meta.sheets[0]).toMatchObject({
            name: 'People',
            merges: [{ endCol: 1 }],
            columnNames: ['Name', 'Age'],
        });
        expect(snapshot.state).not.toHaveProperty('rowHeights');
        expect(snapshot.state).toMatchObject({
            columnWidths: [],
            scrollPosition: [],
            activeSheetIndex: 0,
            tabOrientation: null,
            transforms: [undefined],
            columnVisibility: [undefined],
            cellHighlights: undefined,
            pendingEdits: sheet_edits({ '0:0': 'Ada' }),
            excelFirstRowHeaders: { People: 'on' },
        });
        expect(snapshot.configuration.previewMode).toBe(false);
        expect(snapshot.capabilities.csvEditable).toBe(false);
        expect(snapshot.truncationMessage).toBe('Rows were truncated.');
        expect(snapshot.hiddenEditedCellKeys).toEqual([['2:0']]);
        expect(snapshot.rowHeightProjection).toEqual([{ 2: 44 }]);
        expect(snapshot.mappingGenerations).toEqual([2]);
        expect(snapshot.commandResult?.error).toBe('Ambiguous finalization was reconciled.');
        expect(Object.isFrozen(snapshot)).toBe(true);
        expect(Object.isFrozen(snapshot.hiddenEditedCellKeys[0])).toBe(true);
        expect(Object.isFrozen(snapshot.rowHeightProjection[0])).toBe(true);
        expect(Object.isFrozen(snapshot.mappingGenerations)).toBe(true);
        expect(Object.isFrozen(snapshot.meta.sheets[0].merges)).toBe(true);
        expect(Object.isFrozen(snapshot.state.pendingEdits)).toBe(true);
        expect(Object.isFrozen(snapshot.commandResult)).toBe(true);
    });

    it('shares an already-frozen row-height projection instead of copying it', () => {
        // The other half of the isolation test above, and the reason that one passes an
        // *unfrozen* array. `ViewerPanelCore` freezes the projection at its source
        // precisely so the memoized value can be published by reference, and the memo only
        // pays for itself if the delivery path stops copying it: a pre-cap legacy map can
        // hold hundreds of thousands of entries, and the walk to clone it would happen on
        // every scroll-triggered delivery. Identity is the only observable that tells a
        // share from a copy, so identity is what this asserts.
        const projection = Object.freeze([Object.freeze({ 2: 44 }), undefined]);
        const snapshot = build_workbook_snapshot({
            deliveryId: 3,
            canonicalFileId: '/book.xlsx',
            source: 'observed',
            authority: {
                fileKey: '/book.xlsx',
                commitSequence: 1,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
                physicalDigest: 'digest',
            },
            state_snapshot: { state: {}, revision: 1 },
            core: {
                generation: 1,
                sourceGeneration: 1,
                meta: { sheets: [], hasFormatting: false },
                hiddenEditedCellKeys: [],
                rowHeightProjection: projection,
                mappingGenerations: [],
            },
            presentation: 'initial',
            reason: 'ready',
            configuration: { defaultTabOrientation: 'horizontal', previewMode: false },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
                csvSaveLifecycle: { revision: 0, state: 'idle' },
            },
            diagnostics: { truncationMessage: null },
        });

        expect(snapshot.rowHeightProjection).toBe(projection);
        expect(snapshot.rowHeightProjection[0]).toBe(projection[0]);
        // And the sharing did not cost the snapshot its own freeze.
        expect(Object.isFrozen(snapshot)).toBe(true);
    });

    it('still isolates a frozen projection array holding a mutable map', () => {
        // The half-frozen shape, which is the only one the entry-level part of the guard
        // can see: a frozen *array* whose entries are not. The core never produces this —
        // it freezes each map before the array — but the guard is what makes sharing safe
        // for any caller rather than only for the one that happens to freeze deeply, and
        // sharing this would let a later mutation rewrite an issued delivery's heights.
        const mutable_entry: Record<number, number> = { 2: 44 };
        const projection = Object.freeze([mutable_entry]);
        const snapshot = build_workbook_snapshot({
            deliveryId: 4,
            canonicalFileId: '/book.xlsx',
            source: 'observed',
            authority: {
                fileKey: '/book.xlsx',
                commitSequence: 1,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
                physicalDigest: 'digest',
            },
            state_snapshot: { state: {}, revision: 1 },
            core: {
                generation: 1,
                sourceGeneration: 1,
                meta: { sheets: [], hasFormatting: false },
                hiddenEditedCellKeys: [],
                rowHeightProjection: projection,
                mappingGenerations: [],
            },
            presentation: 'initial',
            reason: 'ready',
            configuration: { defaultTabOrientation: 'horizontal', previewMode: false },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
                csvSaveLifecycle: { revision: 0, state: 'idle' },
            },
            diagnostics: { truncationMessage: null },
        });

        mutable_entry[2] = 99;

        expect(snapshot.rowHeightProjection[0]).not.toBe(mutable_entry);
        expect(snapshot.rowHeightProjection).toEqual([{ 2: 44 }]);
        expect(Object.isFrozen(snapshot.rowHeightProjection[0])).toBe(true);
    });

    it('restores and freezes canonical highlights for the authority digest', () => {
        const sheet = {
            name: 'People',
            rowCount: 2,
            sourceRowCount: 2,
            columnCount: 2,
            merges: [],
            hasFormatting: false,
            columnNames: ['Name', 'Age'],
        };
        const snapshot = build_workbook_snapshot({
            deliveryId: 2,
            canonicalFileId: '/book.xlsx',
            source: 'observed',
            authority: {
                fileKey: '/book.xlsx',
                commitSequence: 1,
                authorityRevision: 1,
                physicalRevision: 1,
                projectionRevision: 0,
                physicalDigest: 'digest-1',
            },
            state_snapshot: {
                revision: 3,
                state: {
                    cellHighlights: {
                        sourceDigest: 'digest-1',
                        sheets: [{
                            schema: transform_schema_for_sheet(sheet),
                            cells: { '1:1': 'green', '0:0': 'yellow' },
                        }],
                    },
                },
            },
            core: {
                generation: 1,
                sourceGeneration: 1,
                meta: { sheets: [sheet], hasFormatting: false },
                hiddenEditedCellKeys: [[]],
                rowHeightProjection: [undefined],
                mappingGenerations: [1],
            },
            presentation: 'initial',
            reason: 'ready',
            configuration: {
                defaultTabOrientation: 'horizontal',
                previewMode: false,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
                csvSaveLifecycle: { revision: 0, state: 'idle' },
            },
            diagnostics: { truncationMessage: null },
        });

        expect(snapshot.state.cellHighlights).toEqual({
            sourceDigest: 'digest-1',
            sheets: [{
                schema: transform_schema_for_sheet(sheet),
                cells: { '0:0': 'yellow', '1:1': 'green' },
            }],
        });
        expect(Object.isFrozen(snapshot.state.cellHighlights)).toBe(true);
        expect(Object.isFrozen(snapshot.state.cellHighlights?.sheets[0]?.cells)).toBe(true);
    });
});

describe('snapshot state normalization', () => {
    it('projects stale-schema highlights positionally and canonicalizes malformed cells', () => {
        const sheet = {
            name: 'People',
            rowCount: 2,
            sourceRowCount: 2,
            columnCount: 2,
            merges: [],
            hasFormatting: false,
        };
        const metadata: WorkbookMeta = { sheets: [sheet], hasFormatting: false };
        const stored = {
            cellHighlights: {
                sourceDigest: 'digest-1',
                sheets: [{
                    schema: 'stale-schema',
                    cells: {
                        '1:1': 'green' as const,
                        '0:0': 'yellow' as const,
                        '2:0': 'blue' as const,
                        bad: 'pink' as const,
                        '0:1': 'orange' as never,
                    },
                }],
            },
        };

        const normalized = normalize_workbook_snapshot_state(
            stored,
            metadata,
            'digest-1',
        );
        expect(normalized.cellHighlights?.sheets[0]?.cells).toEqual({
            '0:0': 'yellow',
            '1:1': 'green',
        });
        expect(normalized.cellHighlights?.sheets[0]?.schema)
            .toBe(transform_schema_for_sheet(sheet));
        const renormalized = normalize_workbook_snapshot_state(normalized, metadata);
        expect(cell_highlight_states_equal(
            normalized.cellHighlights,
            renormalized.cellHighlights,
        )).toBe(true);
        expect(normalize_workbook_snapshot_state(
            stored,
            metadata,
            'digest-2',
        ).cellHighlights).toEqual({
            sourceDigest: 'digest-2',
            sheets: [{
                schema: transform_schema_for_sheet(sheet),
                cells: { '0:0': 'yellow', '1:1': 'green' },
            }],
        });
        expect(normalize_workbook_snapshot_state(
            stored,
            metadata,
            null,
        ).cellHighlights?.sourceDigest).toBe('digest-1');
    });

    it('uses sourceRowCount when projected rowCount is smaller', () => {
        const sheet = {
            name: 'People',
            rowCount: 1,
            sourceRowCount: 2,
            columnCount: 1,
            merges: [],
            hasFormatting: false,
        };
        const metadata = {
            sheets: [sheet],
            hasFormatting: false,
        } as WorkbookMeta;
        const normalized = normalize_workbook_snapshot_state({
            cellHighlights: {
                sourceDigest: 'digest-1',
                sheets: [{
                    schema: transform_schema_for_sheet(sheet),
                    cells: { '1:0': 'pink' },
                }],
            },
        }, metadata, 'digest-1');

        expect(normalized.cellHighlights?.sheets[0]?.cells).toEqual({
            '1:0': 'pink',
        });
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

    it('applies a newer delivery with equal authority and semantic basis', () => {
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

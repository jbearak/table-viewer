import type { WorkbookMeta } from './data-source/interface';
import type {
    AuthorityCommitReceiptBase,
    FileAuthoritySnapshot,
} from './file-coordinator';
import type { FileStateSnapshot } from './state';
import { deep_clone_and_freeze } from './immutable';
import {
    sanitize_excel_header_active,
    sanitize_excel_header_overrides,
    transform_schema_for_sheet,
    type PerFileState,
    type ScrollPosition,
    type StoredPerFileState,
} from './types';
import { sanitize_column_visibility_state } from './webview/column-projection';
import {
    normalize_per_file_state,
    sanitize_transform_state,
} from './webview/sheet-state';

/**
 * Opaque file-global authority identity. `fileId` identifies one logical file;
 * `revision` must increase whenever any authoritative snapshot input changes.
 */
export interface SnapshotAuthorityIdentity {
    readonly fileId: string;
    readonly revision: number;
}

/** Structured source basis reserved for the physical/projection coordinators. */
export interface SnapshotSourceBasis {
    readonly physicalRevision: number;
    readonly projectionRevision: number;
}

/** Exact identity echoed by snapshotApplied and corrective stateChanged. */
export interface WorkbookSnapshotIdentity {
    /** Monotonic within one panel's host-to-webview delivery stream. */
    readonly deliveryId: number;
    readonly authority: SnapshotAuthorityIdentity;
    /** Semantic FileStateStore revision from the Phase 1 CAS protocol. */
    readonly stateRevision: number;
    readonly sourceBasis: SnapshotSourceBasis;
}

export type WorkbookSnapshotReason =
    | 'ready'
    | 'fileReload'
    | 'excelHeader'
    | 'recovery'
    | 'save'
    | 'retry'
    | 'other';

export interface ExcelHeaderSnapshotResult {
    readonly type: 'excelFirstRowHeader';
    readonly requestId: string;
    readonly outcome: 'applied' | 'recovered' | 'rejected';
    readonly error?: string;
}

export type RetainedSnapshotCommandResult = ExcelHeaderSnapshotResult;

/** Fully explicit configuration and capabilities; absence is not overloaded. */
export interface WorkbookSnapshotConfiguration {
    readonly defaultTabOrientation: 'horizontal' | 'vertical';
    readonly previewMode: boolean;
}

export interface WorkbookSnapshotCapabilities {
    readonly csvEditable: boolean;
    readonly csvEditingSupported: boolean;
    readonly csvEditSessionId?: string;
}

export interface NormalizedPerFileState extends PerFileState {
    columnWidths: (Record<number, number> | undefined)[];
    rowHeights: (Record<number, number> | undefined)[];
    scrollPosition: (ScrollPosition | undefined)[];
    activeSheetIndex: number;
    tabOrientation: 'horizontal' | 'vertical' | null;
    transforms: NonNullable<PerFileState['transforms']>;
    columnVisibility: NonNullable<PerFileState['columnVisibility']>;
}

export interface WorkbookSnapshot {
    readonly identity: WorkbookSnapshotIdentity;
    readonly generation: number;
    readonly sourceGeneration: number;
    readonly presentation: 'initial' | 'refresh';
    readonly reason: WorkbookSnapshotReason;
    readonly meta: WorkbookMeta;
    readonly state: NormalizedPerFileState;
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
    readonly truncationMessage: string | null;
    readonly commandResult?: RetainedSnapshotCommandResult;
}

export interface WorkbookSnapshotCoreMaterial<Meta extends WorkbookMeta = WorkbookMeta> {
    readonly generation: number;
    readonly sourceGeneration: number;
    readonly meta: Meta;
}

export interface WorkbookSnapshotDiagnostics {
    readonly truncationMessage: string | null;
}

interface BuildWorkbookSnapshotCommonInput<Meta extends WorkbookMeta> {
    readonly deliveryId: number;
    readonly canonicalFileId: string;
    readonly core: WorkbookSnapshotCoreMaterial<Meta>;
    readonly presentation: WorkbookSnapshot['presentation'];
    readonly reason: WorkbookSnapshotReason;
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
    readonly diagnostics: WorkbookSnapshotDiagnostics;
    readonly commandResult?: RetainedSnapshotCommandResult;
}

export type BuildWorkbookSnapshotInput<Meta extends WorkbookMeta = WorkbookMeta> =
    BuildWorkbookSnapshotCommonInput<Meta> & (
        | {
            readonly source: 'commitReceipt';
            readonly receipt: AuthorityCommitReceiptBase;
        }
        | {
            readonly source: 'observed';
            readonly authority: FileAuthoritySnapshot;
            readonly state_snapshot: FileStateSnapshot;
        }
    );

export type SnapshotDisposition = 'applied' | 'duplicate' | 'stale';

/** Build one complete, immutable host delivery without mutating source material. */
export function build_workbook_snapshot<Meta extends WorkbookMeta>(
    input: BuildWorkbookSnapshotInput<Meta>,
): WorkbookSnapshot {
    const authority = input.source === 'commitReceipt'
        ? input.receipt.resultingBasis
        : input.authority;
    const state_snapshot = input.source === 'commitReceipt'
        ? input.receipt.stateSnapshot
        : input.state_snapshot;
    const snapshot: WorkbookSnapshot = {
        identity: {
            deliveryId: input.deliveryId,
            authority: {
                fileId: input.canonicalFileId,
                revision: authority.authorityRevision,
            },
            stateRevision: state_snapshot.revision,
            sourceBasis: {
                physicalRevision: authority.physicalRevision,
                projectionRevision: authority.projectionRevision,
            },
        },
        generation: input.core.generation,
        sourceGeneration: input.core.sourceGeneration,
        presentation: input.presentation,
        reason: input.reason,
        meta: input.core.meta,
        state: normalize_workbook_snapshot_state(
            state_snapshot.state,
            input.core.meta,
        ),
        configuration: input.configuration,
        capabilities: input.capabilities,
        truncationMessage: input.diagnostics.truncationMessage,
        ...(input.commandResult === undefined
            ? {}
            : { commandResult: input.commandResult }),
    };
    return deep_clone_and_freeze(snapshot);
}

/**
 * Compare a received snapshot with the last applied authority. Same-file
 * authority and semantic revisions are primary; panel delivery order fences
 * file changes and intentionally new same-basis receiver epochs.
 */
export function classify_snapshot(
    incoming: WorkbookSnapshotIdentity,
    applied: WorkbookSnapshotIdentity | null,
): SnapshotDisposition {
    if (!applied) return 'applied';
    if (incoming.deliveryId === applied.deliveryId) return 'duplicate';
    if (incoming.authority.fileId !== applied.authority.fileId) {
        return incoming.deliveryId > applied.deliveryId ? 'applied' : 'stale';
    }
    if (incoming.authority.revision !== applied.authority.revision) {
        return incoming.authority.revision > applied.authority.revision
            ? 'applied'
            : 'stale';
    }

    const incoming_basis = [
        incoming.stateRevision,
        incoming.sourceBasis.physicalRevision,
        incoming.sourceBasis.projectionRevision,
    ] as const;
    const applied_basis = [
        applied.stateRevision,
        applied.sourceBasis.physicalRevision,
        applied.sourceBasis.projectionRevision,
    ] as const;
    if (incoming_basis.some((value, index) => value < applied_basis[index])) {
        return 'stale';
    }
    if (incoming_basis.some((value, index) => value > applied_basis[index])) {
        return 'applied';
    }
    return incoming.deliveryId > applied.deliveryId ? 'applied' : 'stale';
}

/** Normalize legacy/current state while retaining host-owned Excel fields. */
export function normalize_complete_per_file_state(
    stored: StoredPerFileState,
    sheet_names: string[],
): PerFileState {
    const normalized = normalize_per_file_state(stored, sheet_names);
    if ('excelFirstRowHeaders' in stored) {
        normalized.excelFirstRowHeaders = sanitize_excel_header_overrides(
            stored.excelFirstRowHeaders,
        );
    }
    if ('excelFirstRowHeaderActive' in stored) {
        normalized.excelFirstRowHeaderActive = sanitize_excel_header_active(
            stored.excelFirstRowHeaderActive,
        );
    }
    if (
        'excelFirstRowHeaderVersion' in stored
        && stored.excelFirstRowHeaderVersion === 1
    ) {
        normalized.excelFirstRowHeaderVersion = 1;
    }
    return normalized;
}

/** Fill every layout/view field required by the snapshot wire shape. */
export function complete_normalized_per_file_state(
    stored: StoredPerFileState,
    sheet_names: string[],
): NormalizedPerFileState {
    const normalized = normalize_complete_per_file_state(stored, sheet_names);
    return {
        ...normalized,
        columnWidths: normalized.columnWidths ?? [],
        rowHeights: normalized.rowHeights ?? [],
        scrollPosition: normalized.scrollPosition ?? [],
        activeSheetIndex: normalized.activeSheetIndex ?? 0,
        tabOrientation: normalized.tabOrientation ?? null,
        transforms: normalized.transforms ?? [],
        columnVisibility: normalized.columnVisibility ?? [],
    };
}

/** Canonical runtime normalization used by snapshot producers and consumers. */
export function normalize_workbook_snapshot_state(
    stored: StoredPerFileState,
    meta: WorkbookMeta,
): NormalizedPerFileState {
    const normalized = complete_normalized_per_file_state(
        stored,
        meta.sheets.map((sheet) => sheet.name),
    );
    const transforms = meta.sheets.map((sheet, index) =>
        sanitize_transform_state(
            normalized.transforms?.[index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
        ));
    const column_visibility = meta.sheets.map((sheet, index) =>
        sanitize_column_visibility_state(
            normalized.columnVisibility?.[index],
            sheet.columnCount,
            transform_schema_for_sheet(sheet),
        ));
    return {
        ...normalized,
        transforms,
        columnVisibility: column_visibility,
    };
}

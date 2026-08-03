import { createHash } from 'node:crypto';
import * as vscode from 'vscode';
import type { PhysicalEditActivationBoundary } from './physical-edit-activation';
import { ordered_memento_file_state_source } from './state';
import {
    bridge_capsule_identity,
    MIGRATION_ARMING_STATE_KEY,
    MIGRATION_CAPSULE_MAX_UTF8_BYTES,
    migration_companion_directory_durability_supported,
    migration_placement_key_digest,
    new_operation_id,
    read_migration_arming_state,
    require_migration_companion,
    write_migration_arming_state,
    type FinalizedMigrationArmingState,
    type MigrationArmingInProgressState,
    type MigrationArmingState,
} from './migration-companion';

const ARM_ATTESTATION = 'I Attest Every Other VS Code Window Is Closed';
const COLD_ATTESTATION = 'I Attest Every VS Code Window Was Closed';

function extension_version(context: vscode.ExtensionContext): string {
    const value = context.extension.packageJSON.version;
    if (typeof value !== 'string' || value.length === 0) throw new Error('Table Viewer has no valid extension version.');
    return value;
}

function in_progress_state(
    context: vscode.ExtensionContext,
    orderedSourceJson: string,
    capsuleMutation: 'submit' | 'archiveDrift' | 'replaceAfterUpgrade',
    armedAtMs: number,
    flushCompleted: boolean,
    expectedNamespace?: { profileDatabaseId: string; storageEnvironmentId: string },
): MigrationArmingInProgressState {
    return {
        version: 1,
        phase: 'armingInProgress',
        extensionVersion: extension_version(context),
        placementKeyDigest: migration_placement_key_digest(context),
        sourceDigest: create_source_digest(orderedSourceJson),
        flushCompleted,
        capsuleMutation,
        namespaceOperationId: new_operation_id(),
        capsuleOperationId: new_operation_id(),
        armedAtMs,
        ...(expectedNamespace === undefined ? {} : {
            expectedProfileDatabaseId: expectedNamespace.profileDatabaseId,
            expectedStorageEnvironmentId: expectedNamespace.storageEnvironmentId,
        }),
    };
}

function finalized_state(
    context: vscode.ExtensionContext,
    progress: MigrationArmingInProgressState,
    namespace: { profileDatabaseId: string; storageEnvironmentId: string },
    capsule: ReturnType<typeof bridge_capsule_identity>,
): FinalizedMigrationArmingState {
    return {
        version: 1,
        phase: 'awaitingColdStart',
        extensionVersion: extension_version(context),
        profileDatabaseId: namespace.profileDatabaseId,
        storageEnvironmentId: namespace.storageEnvironmentId,
        capsuleId: capsule.capsuleId,
        sourceFormat: capsule.sourceFormat,
        sourceDigest: capsule.sourceDigest,
        namespaceOperationId: progress.namespaceOperationId,
        armedAtMs: progress.armedAtMs,
    };
}

async function reconcile_arming_in_progress(
    context: vscode.ExtensionContext,
    progress: MigrationArmingInProgressState,
    orderedSourceJson: string,
): Promise<FinalizedMigrationArmingState> {
    if (!progress.flushCompleted) {
        throw new Error('The interrupted arming operation did not complete its viewer flush.');
    }
    if (extension_version(context) !== progress.extensionVersion) {
        throw new Error('The interrupted arming operation belongs to another Table Viewer version.');
    }
    if (migration_placement_key_digest(context) !== progress.placementKeyDigest) {
        throw new Error('The interrupted arming operation belongs to another concrete host placement.');
    }
    const currentSourceDigest = create_source_digest(orderedSourceJson);

    // The durable Memento checkpoint above is authoritative. Only after it exists
    // may activation or mutation of the companion occur. Reusing both operation IDs
    // makes an ambiguous namespace/capsule commit reconcile by exact receipt replay.
    const companion = await require_migration_companion(context);
    const namespace = await companion.namespace({
        placementKeyDigest: progress.placementKeyDigest,
        operationId: progress.namespaceOperationId,
    });
    if ((progress.expectedProfileDatabaseId !== undefined
            && namespace.profileDatabaseId !== progress.expectedProfileDatabaseId)
        || (progress.expectedStorageEnvironmentId !== undefined
            && namespace.storageEnvironmentId !== progress.expectedStorageEnvironmentId)) {
        throw new Error('The interrupted arming operation resolved to a different permanent namespace.');
    }
    let activeBeforeRecovery: ReturnType<typeof bridge_capsule_identity> | undefined;
    try {
        activeBeforeRecovery = bridge_capsule_identity(await companion.activeCapsule());
    } catch (error) {
        if (!(error instanceof Error) || !/No active migration capsule is armed/.test(error.message)) {
            throw error;
        }
    }
    if (progress.capsuleMutation === 'replaceAfterUpgrade') {
        progress = {
            ...progress,
            capsuleMutation: activeBeforeRecovery === undefined ? 'submit' : 'archiveDrift',
            ...(activeBeforeRecovery === undefined ? {} : {
                expectedProfileDatabaseId: namespace.profileDatabaseId,
                expectedStorageEnvironmentId: namespace.storageEnvironmentId,
            }),
        };
        await write_migration_arming_state(context, progress);
    }
    if (currentSourceDigest !== progress.sourceDigest
        && activeBeforeRecovery?.sourceDigest === currentSourceDigest) {
        const recovered = { ...progress, sourceDigest: currentSourceDigest };
        const finalized = finalized_state(context, recovered, namespace, activeBeforeRecovery);
        await write_migration_arming_state(context, finalized);
        return finalized;
    }

    let checkpoint = progress;
    if (currentSourceDigest !== progress.sourceDigest
        || (progress.capsuleMutation === 'submit'
            && activeBeforeRecovery !== undefined
            && activeBeforeRecovery.sourceDigest !== currentSourceDigest)) {
        const {
            expectedProfileDatabaseId: _expectedProfileDatabaseId,
            expectedStorageEnvironmentId: _expectedStorageEnvironmentId,
            ...checkpointBase
        } = progress;
        void _expectedProfileDatabaseId;
        void _expectedStorageEnvironmentId;
        checkpoint = {
            ...checkpointBase,
            sourceDigest: currentSourceDigest,
            capsuleMutation: activeBeforeRecovery === undefined ? 'submit' : 'archiveDrift',
            capsuleOperationId: new_operation_id(),
            ...(activeBeforeRecovery === undefined ? {} : {
                expectedProfileDatabaseId: namespace.profileDatabaseId,
                expectedStorageEnvironmentId: namespace.storageEnvironmentId,
            }),
        };
        await write_migration_arming_state(context, checkpoint);
    }

    let submitted: { capsuleId: string; sourceDigest: string } | undefined;
    if (checkpoint.capsuleMutation === 'submit') {
        submitted = await companion.submitCapsuleCandidate({
            operationId: checkpoint.capsuleOperationId,
            orderedSourceJson,
        });
    } else {
        await companion.archiveDrift({
            operationId: checkpoint.capsuleOperationId,
            orderedSourceJson,
        });
    }
    const active = bridge_capsule_identity(await companion.activeCapsule());
    if (active.sourceDigest !== checkpoint.sourceDigest
        || (submitted !== undefined
            && (submitted.sourceDigest !== checkpoint.sourceDigest
                || submitted.capsuleId !== active.capsuleId))) {
        throw new Error('The active companion capsule does not match the checkpointed Memento digest.');
    }
    const finalized = finalized_state(context, checkpoint, namespace, active);
    await write_migration_arming_state(context, finalized);
    return finalized;
}

async function begin_and_reconcile_arming(
    context: vscode.ExtensionContext,
    orderedSourceJson: string,
    capsuleMutation: 'submit' | 'archiveDrift',
    armedAtMs: number,
    expectedNamespace?: { profileDatabaseId: string; storageEnvironmentId: string },
): Promise<FinalizedMigrationArmingState> {
    const progress = in_progress_state(
        context,
        orderedSourceJson,
        capsuleMutation,
        armedAtMs,
        true,
        expectedNamespace,
    );
    await write_migration_arming_state(context, progress);
    return reconcile_arming_in_progress(context, progress, orderedSourceJson);
}

export async function prepare_sqlite_migration_arming(
    context: vscode.ExtensionContext,
    boundary: PhysicalEditActivationBoundary,
    stopViewers: () => void | Promise<void>,
): Promise<boolean> {
    const accepted = await vscode.window.showWarningMessage(
        'Prepare Table Viewer SQLite migration only after closing every other VS Code window, including local, Remote SSH, Dev Container, WSL, and Codespaces windows. This window will stop state-writing UI, flush every accepted Memento write, store one complete ordered source capsule in the exact-version local UI companion, and then must also be closed. Memento remains the sole authority; this release creates no canonical environment database.',
        { modal: true },
        ARM_ATTESTATION,
    );
    if (accepted !== ARM_ATTESTATION) return false;

    const previousState = read_migration_arming_state(context);
    let orderedSourceJson = await ordered_memento_file_state_source(context);
    if (Buffer.byteLength(orderedSourceJson, 'utf8') > MIGRATION_CAPSULE_MAX_UTF8_BYTES) {
        await vscode.window.showErrorMessage(
            `SQLite migration arming requires a Memento capsule no larger than ${MIGRATION_CAPSULE_MAX_UTF8_BYTES} UTF-8 bytes. Memento remains authoritative and writable; reduce retained state before trying again.`,
            { modal: true },
        );
        return false;
    }
    let progress = in_progress_state(context, orderedSourceJson, 'submit', Date.now(), false);
    await write_migration_arming_state(context, progress);
    const restorePreviousState = async (): Promise<void> => {
        try {
            await context.globalState.update(MIGRATION_ARMING_STATE_KEY, previousState);
        } catch (error) {
            await stopViewers();
            await boundary.drain();
            await boundary.enter_view_only();
            throw error;
        }
    };
    let directoryDurabilitySupported: boolean;
    try {
        directoryDurabilitySupported = await migration_companion_directory_durability_supported(context);
    } catch (error) {
        await restorePreviousState();
        throw error;
    }
    if (!directoryDurabilitySupported) {
        await restorePreviousState();
        await vscode.window.showErrorMessage(
            'SQLite migration arming is view-only because the local UI companion host cannot prove durable directory-entry installation. Memento remains authoritative; use a supported local UI host to arm migration.',
            { modal: true },
        );
        return false;
    }

    try {
        await stopViewers();
        await boundary.drain();
    } catch (flushError) {
        try {
            await context.globalState.update(MIGRATION_ARMING_STATE_KEY, previousState);
        } catch (restoreError) {
            await boundary.enter_view_only();
            throw new AggregateError(
                [flushError, restoreError],
                'Table Viewer could not flush every viewer or roll back the migration checkpoint.',
            );
        }
        throw flushError;
    }

    await boundary.enter_view_only();
    orderedSourceJson = await ordered_memento_file_state_source(context);
    if (Buffer.byteLength(orderedSourceJson, 'utf8') > MIGRATION_CAPSULE_MAX_UTF8_BYTES) {
        await restorePreviousState();
        await boundary.enter_view_only();
        await vscode.window.showErrorMessage(
            `The drained Memento capsule exceeded the ${MIGRATION_CAPSULE_MAX_UTF8_BYTES}-byte UTF-8 limit after state-writing UI had already stopped. Memento remains authoritative, but this window is now view-only; reopen Table Viewer to resume Memento writes, reduce retained state, and try again.`,
            { modal: true },
        );
        return false;
    }

    const drainedSourceDigest = create_source_digest(orderedSourceJson);
    progress = {
        ...progress,
        sourceDigest: drainedSourceDigest,
        flushCompleted: true,
    };
    await write_migration_arming_state(context, progress);
    await reconcile_arming_in_progress(context, progress, orderedSourceJson);
    await vscode.window.showInformationMessage(
        'The ordered Memento capsule is durably armed. Close this window and every remaining VS Code window, then start a fresh window to perform cold identity and digest confirmation. Table Viewer remains Memento-authoritative and view-only after this boundary.',
        { modal: true },
    );
    return true;
}

export interface ColdArmingResult {
    readonly blocksStateWriters: boolean;
    readonly phase: 'unarmed' | 'awaitingColdStart' | 'coldConfirmed' | 'failedClosed';
}

async function archive_drift_and_require_another_cold_start(
    context: vscode.ExtensionContext,
    previous: FinalizedMigrationArmingState,
    orderedSourceJson: string,
    reason: string,
): Promise<ColdArmingResult> {
    await begin_and_reconcile_arming(
        context,
        orderedSourceJson,
        'archiveDrift',
        previous.armedAtMs,
        {
            profileDatabaseId: previous.profileDatabaseId,
            storageEnvironmentId: previous.storageEnvironmentId,
        },
    );
    await vscode.window.showWarningMessage(
        `${reason} The new complete source was archived and armed while Memento remains authoritative. Close every VS Code window again and perform another cold start; Table Viewer will not create or migrate a canonical SQLite database in this release.`,
        { modal: true },
    );
    return { blocksStateWriters: true, phase: 'awaitingColdStart' };
}

export async function evaluate_sqlite_migration_cold_start(
    context: vscode.ExtensionContext,
): Promise<ColdArmingResult> {
    let persisted: MigrationArmingState | undefined;
    try {
        persisted = read_migration_arming_state(context);
    } catch {
        await vscode.window.showErrorMessage(
            'Table Viewer could not validate the persisted SQLite migration arming state. Memento remains authoritative, but state-writing UI is blocked until the arming metadata is repaired.',
            { modal: true },
        );
        return { blocksStateWriters: true, phase: 'failedClosed' };
    }
    if (!persisted) return { blocksStateWriters: false, phase: 'unarmed' };

    try {
        if (persisted.phase === 'armingInProgress' && !persisted.flushCompleted) {
            throw new Error('The interrupted arming operation did not complete its viewer flush.');
        }
        if (!await migration_companion_directory_durability_supported(context)) {
            await vscode.window.showErrorMessage(
                'Table Viewer SQLite migration is view-only because the local UI companion host cannot prove durable directory-entry installation. Memento remains authoritative and no canonical SQLite database was created.',
                { modal: true },
            );
            return { blocksStateWriters: true, phase: 'failedClosed' };
        }
        const orderedSourceJson = await ordered_memento_file_state_source(context);
        if (persisted.phase === 'armingInProgress') {
            if (persisted.extensionVersion !== extension_version(context)) {
                persisted = in_progress_state(
                    context,
                    orderedSourceJson,
                    'replaceAfterUpgrade',
                    persisted.armedAtMs,
                    true,
                );
                await write_migration_arming_state(context, persisted);
            }
            persisted = await reconcile_arming_in_progress(context, persisted, orderedSourceJson);
        }
        if (persisted.extensionVersion !== extension_version(context)) {
            return await archive_drift_and_require_another_cold_start(
                context,
                persisted,
                orderedSourceJson,
                'Table Viewer was upgraded directly after the previous seed.',
            );
        }

        const placementKeyDigest = migration_placement_key_digest(context);
        const companion = await require_migration_companion(context);
        const namespace = await companion.namespace({
            placementKeyDigest,
            operationId: persisted.namespaceOperationId,
        });
        if (namespace.profileDatabaseId !== persisted.profileDatabaseId
            || namespace.storageEnvironmentId !== persisted.storageEnvironmentId) {
            throw new Error('The current host placement resolved to a different permanent profile/environment namespace.');
        }
        const active = bridge_capsule_identity(await companion.activeCapsule());
        if (active.capsuleId !== persisted.capsuleId
            || active.sourceFormat !== persisted.sourceFormat) {
            throw new Error('The active companion capsule identity differs from the persisted arming identity.');
        }
        if (active.sourceDigest !== persisted.sourceDigest) {
            throw new Error('The active companion capsule digest differs from the persisted arming identity.');
        }
        const sourceDigest = create_source_digest(orderedSourceJson);
        if (sourceDigest !== persisted.sourceDigest) {
            return await archive_drift_and_require_another_cold_start(
                context,
                persisted,
                orderedSourceJson,
                'The current host Memento source no longer exactly matches the armed capsule digest.',
            );
        }

        if (persisted.phase === 'coldConfirmed') {
            return { blocksStateWriters: true, phase: 'coldConfirmed' };
        }
        const accepted = await vscode.window.showWarningMessage(
            'Continue only if every VS Code window, including all remote windows, was closed after the Table Viewer capsule was armed. This is an explicit operational attestation; VS Code does not prove that every old extension host exited. The current Memento source, permanent profile/environment namespace, and active capsule digest have matched exactly.',
            { modal: true },
            COLD_ATTESTATION,
        );
        if (accepted !== COLD_ATTESTATION) {
            return { blocksStateWriters: true, phase: 'awaitingColdStart' };
        }
        await write_migration_arming_state(context, {
            ...persisted,
            phase: 'coldConfirmed',
            coldConfirmedAtMs: Date.now(),
        });
        await vscode.window.showInformationMessage(
            'Table Viewer confirmed the cold capsule boundary. Memento remains the sole authority and this arming release remains view-only; canonical SQLite environment databases are not created until the separately gated cutover release.',
        );
        return { blocksStateWriters: true, phase: 'coldConfirmed' };
    } catch {
        await vscode.window.showErrorMessage(
            'Table Viewer could not route to the exact-version local UI companion or confirm the permanent profile/environment/capsule identity. Memento remains authoritative, no canonical SQLite database was created, and state-writing UI is blocked. Use explicit user-mediated recovery/import rather than forcing UI placement or guessing a route.',
            { modal: true },
        );
        return { blocksStateWriters: true, phase: 'failedClosed' };
    }
}

export function create_source_digest(orderedSourceJson: string): string {
    return createHash('sha256').update(orderedSourceJson).digest('hex');
}

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
const INVALID_ARMING_STATE_MESSAGE = 'Table Viewer could not validate the persisted SQLite migration arming state. Memento remains authoritative, but state-writing UI is blocked until the arming metadata is repaired.';

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

class InactiveActivationError extends Error {}

const NEVER_ABORTED_SIGNAL = new AbortController().signal;

function require_active_operation(isActive: () => boolean): void {
    if (!isActive()) throw new InactiveActivationError();
}

async function await_ui_while_active<T>(
    open: () => Thenable<T>,
    isActive: () => boolean,
    signal: AbortSignal,
): Promise<T> {
    require_active_operation(isActive);
    if (signal.aborted) throw new InactiveActivationError();
    const ui = Promise.resolve(open());
    let abort!: () => void;
    const inactive = new Promise<never>((_resolve, reject) => {
        abort = () => reject(new InactiveActivationError());
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
    });
    try {
        const result = await Promise.race([ui, inactive]);
        require_active_operation(isActive);
        return result;
    } finally {
        signal.removeEventListener('abort', abort);
    }
}

async function reconcile_arming_in_progress(
    context: vscode.ExtensionContext,
    progress: MigrationArmingInProgressState,
    orderedSourceJson: string,
    isActive: () => boolean = () => true,
    onStatefulMutationStart: () => void = () => undefined,
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
    require_active_operation(isActive);
    const companion = await require_migration_companion(context);
    require_active_operation(isActive);
    onStatefulMutationStart();
    const namespace = await companion.namespace({
        placementKeyDigest: progress.placementKeyDigest,
        operationId: progress.namespaceOperationId,
    });
    require_active_operation(isActive);
    if ((progress.expectedProfileDatabaseId !== undefined
            && namespace.profileDatabaseId !== progress.expectedProfileDatabaseId)
        || (progress.expectedStorageEnvironmentId !== undefined
            && namespace.storageEnvironmentId !== progress.expectedStorageEnvironmentId)) {
        throw new Error('The interrupted arming operation resolved to a different permanent namespace.');
    }
    let activeBeforeRecovery: ReturnType<typeof bridge_capsule_identity> | undefined;
    try {
        activeBeforeRecovery = bridge_capsule_identity(await companion.activeCapsule());
        require_active_operation(isActive);
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
        require_active_operation(isActive);
        await write_migration_arming_state(context, progress);
        require_active_operation(isActive);
    }
    if (currentSourceDigest !== progress.sourceDigest
        && activeBeforeRecovery?.sourceDigest === currentSourceDigest) {
        const recovered = { ...progress, sourceDigest: currentSourceDigest };
        const finalized = finalized_state(context, recovered, namespace, activeBeforeRecovery);
        require_active_operation(isActive);
        await write_migration_arming_state(context, finalized);
        require_active_operation(isActive);
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
        require_active_operation(isActive);
        await write_migration_arming_state(context, checkpoint);
        require_active_operation(isActive);
    }

    let submitted: { capsuleId: string; sourceDigest: string } | undefined;
    require_active_operation(isActive);
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
    require_active_operation(isActive);
    const active = bridge_capsule_identity(await companion.activeCapsule());
    require_active_operation(isActive);
    if (active.sourceDigest !== checkpoint.sourceDigest
        || (submitted !== undefined
            && (submitted.sourceDigest !== checkpoint.sourceDigest
                || submitted.capsuleId !== active.capsuleId))) {
        throw new Error('The active companion capsule does not match the checkpointed Memento digest.');
    }
    const finalized = finalized_state(context, checkpoint, namespace, active);
    require_active_operation(isActive);
    await write_migration_arming_state(context, finalized);
    require_active_operation(isActive);
    return finalized;
}

async function begin_and_reconcile_arming(
    context: vscode.ExtensionContext,
    orderedSourceJson: string,
    capsuleMutation: 'submit' | 'archiveDrift',
    armedAtMs: number,
    expectedNamespace?: { profileDatabaseId: string; storageEnvironmentId: string },
    isActive: () => boolean = () => true,
): Promise<FinalizedMigrationArmingState> {
    const progress = in_progress_state(
        context,
        orderedSourceJson,
        capsuleMutation,
        armedAtMs,
        true,
        expectedNamespace,
    );
    require_active_operation(isActive);
    await write_migration_arming_state(context, progress);
    require_active_operation(isActive);
    return reconcile_arming_in_progress(context, progress, orderedSourceJson, isActive);
}

export async function prepare_sqlite_migration_arming(
    context: vscode.ExtensionContext,
    boundary: PhysicalEditActivationBoundary,
    stopViewers: () => void | Promise<void>,
    isActive: () => boolean = () => true,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
): Promise<boolean> {
    const accepted = await await_ui_while_active(() => vscode.window.showWarningMessage(
        'Prepare Table Viewer SQLite migration only after closing every other VS Code window, including local, Remote SSH, Dev Container, WSL, and Codespaces windows. This window will stop state-writing UI, flush every accepted Memento write, store one complete ordered source capsule in the exact-version local UI companion, and then must also be closed. Memento remains the sole authority; this release creates no canonical environment database.',
        { modal: true },
        ARM_ATTESTATION,
    ), isActive, signal);
    require_active_operation(isActive);
    if (accepted !== ARM_ATTESTATION) return false;

    let previousState: MigrationArmingState | undefined;
    try {
        previousState = read_migration_arming_state(context);
    } catch {
        await await_ui_while_active(() => vscode.window.showErrorMessage(
            INVALID_ARMING_STATE_MESSAGE,
            { modal: true },
        ), isActive, signal);
        return false;
    }
    let orderedSourceJson = await ordered_memento_file_state_source(context);
    require_active_operation(isActive);
    if (Buffer.byteLength(orderedSourceJson, 'utf8') > MIGRATION_CAPSULE_MAX_UTF8_BYTES) {
        await await_ui_while_active(() => vscode.window.showErrorMessage(
            `SQLite migration arming requires a Memento capsule no larger than ${MIGRATION_CAPSULE_MAX_UTF8_BYTES} UTF-8 bytes. Memento remains authoritative and writable; reduce retained state before trying again.`,
            { modal: true },
        ), isActive, signal);
        return false;
    }
    let progress = in_progress_state(context, orderedSourceJson, 'submit', Date.now(), false);
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
    const restoreIfInactiveBeforeMutation = async (): Promise<void> => {
        if (isActive()) return;
        await restorePreviousState();
        throw new InactiveActivationError();
    };
    require_active_operation(isActive);
    await write_migration_arming_state(context, progress);
    await restoreIfInactiveBeforeMutation();
    let directoryDurabilitySupported: boolean;
    try {
        directoryDurabilitySupported = await migration_companion_directory_durability_supported(context);
        await restoreIfInactiveBeforeMutation();
    } catch (error) {
        if (!(error instanceof InactiveActivationError)) await restorePreviousState();
        throw error;
    }
    if (!directoryDurabilitySupported) {
        await restorePreviousState();
        require_active_operation(isActive);
        await await_ui_while_active(() => vscode.window.showErrorMessage(
            'SQLite migration arming is view-only because the local UI companion host cannot prove durable directory-entry installation. Memento remains authoritative; use a supported local UI host to arm migration.',
            { modal: true },
        ), isActive, signal);
        return false;
    }

    try {
        await stopViewers();
        await restoreIfInactiveBeforeMutation();
        await boundary.drain();
        await restoreIfInactiveBeforeMutation();
    } catch (flushError) {
        if (flushError instanceof InactiveActivationError) throw flushError;
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

    await restoreIfInactiveBeforeMutation();
    await boundary.enter_view_only();
    await restoreIfInactiveBeforeMutation();
    orderedSourceJson = await ordered_memento_file_state_source(context);
    await restoreIfInactiveBeforeMutation();
    if (Buffer.byteLength(orderedSourceJson, 'utf8') > MIGRATION_CAPSULE_MAX_UTF8_BYTES) {
        await restorePreviousState();
        require_active_operation(isActive);
        await boundary.enter_view_only();
        require_active_operation(isActive);
        await await_ui_while_active(() => vscode.window.showErrorMessage(
            `The drained Memento capsule exceeded the ${MIGRATION_CAPSULE_MAX_UTF8_BYTES}-byte UTF-8 limit after state-writing UI had already stopped. Memento remains authoritative, but this window is now view-only; reopen Table Viewer to resume Memento writes, reduce retained state, and try again.`,
            { modal: true },
        ), isActive, signal);
        return false;
    }

    const drainedSourceDigest = create_source_digest(orderedSourceJson);
    progress = {
        ...progress,
        sourceDigest: drainedSourceDigest,
        flushCompleted: true,
    };
    await restoreIfInactiveBeforeMutation();
    await write_migration_arming_state(context, progress);
    await restoreIfInactiveBeforeMutation();
    let statefulMutationStarted = false;
    try {
        await reconcile_arming_in_progress(
            context,
            progress,
            orderedSourceJson,
            isActive,
            () => { statefulMutationStarted = true; },
        );
    } catch (error) {
        if (!statefulMutationStarted && !isActive()) await restorePreviousState();
        throw error;
    }
    require_active_operation(isActive);
    await await_ui_while_active(() => vscode.window.showInformationMessage(
        'The ordered Memento capsule is durably armed. Close this window and every remaining VS Code window, then start a fresh window to perform cold identity and digest confirmation. Table Viewer remains Memento-authoritative and view-only after this boundary.',
        { modal: true },
    ), isActive, signal);
    return true;
}

export interface ColdArmingResult {
    readonly blocksStateWriters: boolean;
    readonly phase: 'unarmed' | 'awaitingColdStart' | 'coldConfirmed' | 'failedClosed';
}

export function sqlite_migration_blocks_state_writers_on_activation(
    context: vscode.ExtensionContext,
): boolean {
    try {
        return read_migration_arming_state(context) !== undefined;
    } catch {
        return true;
    }
}

async function archive_drift_and_require_another_cold_start(
    context: vscode.ExtensionContext,
    previous: FinalizedMigrationArmingState,
    orderedSourceJson: string,
    reason: string,
    isActive: () => boolean,
    signal: AbortSignal,
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
        isActive,
    );
    require_active_operation(isActive);
    await await_ui_while_active(() => vscode.window.showWarningMessage(
        `${reason} The new complete source was archived and armed while Memento remains authoritative. Close every VS Code window again and perform another cold start; Table Viewer will not create or migrate a canonical SQLite database in this release.`,
        { modal: true },
    ), isActive, signal);
    require_active_operation(isActive);
    return { blocksStateWriters: true, phase: 'awaitingColdStart' };
}

export async function evaluate_sqlite_migration_cold_start(
    context: vscode.ExtensionContext,
    isActive: () => boolean = () => true,
    signal: AbortSignal = NEVER_ABORTED_SIGNAL,
): Promise<ColdArmingResult> {
    let persisted: MigrationArmingState | undefined;
    try {
        persisted = read_migration_arming_state(context);
    } catch {
        try {
            await await_ui_while_active(() => vscode.window.showErrorMessage(
                INVALID_ARMING_STATE_MESSAGE,
                { modal: true },
            ), isActive, signal);
        } catch (error) {
            if (!(error instanceof InactiveActivationError)) throw error;
        }
        return { blocksStateWriters: true, phase: 'failedClosed' };
    }
    if (!persisted) return { blocksStateWriters: false, phase: 'unarmed' };

    try {
        if (persisted.phase === 'armingInProgress' && !persisted.flushCompleted) {
            throw new Error('The interrupted arming operation did not complete its viewer flush.');
        }
        const directoryDurabilitySupported = await migration_companion_directory_durability_supported(context);
        require_active_operation(isActive);
        if (!directoryDurabilitySupported) {
            await await_ui_while_active(() => vscode.window.showErrorMessage(
                'Table Viewer SQLite migration is view-only because the local UI companion host cannot prove durable directory-entry installation. Memento remains authoritative and no canonical SQLite database was created.',
                { modal: true },
            ), isActive, signal);
            require_active_operation(isActive);
            return { blocksStateWriters: true, phase: 'failedClosed' };
        }
        const orderedSourceJson = await ordered_memento_file_state_source(context);
        require_active_operation(isActive);
        if (persisted.phase === 'armingInProgress') {
            if (persisted.extensionVersion !== extension_version(context)) {
                persisted = in_progress_state(
                    context,
                    orderedSourceJson,
                    'replaceAfterUpgrade',
                    persisted.armedAtMs,
                    true,
                );
                require_active_operation(isActive);
                await write_migration_arming_state(context, persisted);
                require_active_operation(isActive);
            }
            persisted = await reconcile_arming_in_progress(
                context,
                persisted,
                orderedSourceJson,
                isActive,
            );
            // Reconciliation may have created or replaced the capsule during this
            // activation. Even an exact replay therefore requires a later process
            // start before the user can truthfully attest that every window closed
            // after this durable winner was armed.
            await await_ui_while_active(() => vscode.window.showWarningMessage(
                'Table Viewer durably reconciled the interrupted capsule operation. Close this window and every other VS Code window, then start another fresh window to perform cold identity and digest confirmation. Memento remains authoritative and this window remains view-only.',
                { modal: true },
            ), isActive, signal);
            require_active_operation(isActive);
            return { blocksStateWriters: true, phase: 'awaitingColdStart' };
        }
        if (persisted.extensionVersion !== extension_version(context)) {
            return await archive_drift_and_require_another_cold_start(
                context,
                persisted,
                orderedSourceJson,
                'Table Viewer was upgraded directly after the previous seed.',
                isActive,
                signal,
            );
        }

        const placementKeyDigest = migration_placement_key_digest(context);
        const companion = await require_migration_companion(context);
        require_active_operation(isActive);
        const namespace = await companion.namespace({
            placementKeyDigest,
            operationId: persisted.namespaceOperationId,
        });
        require_active_operation(isActive);
        if (namespace.profileDatabaseId !== persisted.profileDatabaseId
            || namespace.storageEnvironmentId !== persisted.storageEnvironmentId) {
            throw new Error('The current host placement resolved to a different permanent profile/environment namespace.');
        }
        const active = bridge_capsule_identity(await companion.activeCapsule());
        require_active_operation(isActive);
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
                isActive,
                signal,
            );
        }

        if (persisted.phase === 'coldConfirmed') {
            return { blocksStateWriters: true, phase: 'coldConfirmed' };
        }
        const accepted = await await_ui_while_active(() => vscode.window.showWarningMessage(
            'Continue only if every VS Code window, including all remote windows, was closed after the Table Viewer capsule was armed. This is an explicit operational attestation; VS Code does not prove that every old extension host exited. The current Memento source, permanent profile/environment namespace, and active capsule digest have matched exactly.',
            { modal: true },
            COLD_ATTESTATION,
        ), isActive, signal);
        require_active_operation(isActive);
        if (accepted !== COLD_ATTESTATION) {
            return { blocksStateWriters: true, phase: 'awaitingColdStart' };
        }
        require_active_operation(isActive);
        await write_migration_arming_state(context, {
            ...persisted,
            phase: 'coldConfirmed',
            coldConfirmedAtMs: Date.now(),
        });
        require_active_operation(isActive);
        await await_ui_while_active(() => vscode.window.showInformationMessage(
            'Table Viewer confirmed the cold capsule boundary. Memento remains the sole authority and this arming release remains view-only; canonical SQLite environment databases are not created until the separately gated cutover release.',
        ), isActive, signal);
        require_active_operation(isActive);
        return { blocksStateWriters: true, phase: 'coldConfirmed' };
    } catch (error) {
        if (error instanceof InactiveActivationError || !isActive()) {
            return { blocksStateWriters: true, phase: 'failedClosed' };
        }
        try {
            await await_ui_while_active(() => vscode.window.showErrorMessage(
                'Table Viewer could not route to the exact-version local UI companion or confirm the permanent profile/environment/capsule identity. Memento remains authoritative, no canonical SQLite database was created, and state-writing UI is blocked. Use explicit user-mediated recovery/import rather than forcing UI placement or guessing a route.',
                { modal: true },
            ), isActive, signal);
        } catch (uiError) {
            if (!(uiError instanceof InactiveActivationError)) throw uiError;
        }
        return { blocksStateWriters: true, phase: 'failedClosed' };
    }
}

export function create_source_digest(orderedSourceJson: string): string {
    return createHash('sha256').update(orderedSourceJson).digest('hex');
}

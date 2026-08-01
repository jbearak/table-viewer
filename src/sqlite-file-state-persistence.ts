import { randomUUID } from 'node:crypto';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
    create_coordinated_keyed_authority_store,
    drain_keyed_state_runtime,
    state_has_pending_edits,
    type CoordinatedAuthorityFileStateStore,
    type CoordinatedKeyedFileStatePersistence,
    type DurableFileAuthority,
    type PersistedCompleteKeyedStateEntry,
    type PersistedKeyedStateEntry,
    type PersistedPhysicalWriteReservationRecord,
    type PhysicalWriteRecoveryRequired,
    type PreparedInstallCleanupObservation,
    type PhysicalWriteReservation,
    type ReservedPhysicalWriteIo,
} from './state';
import {
    initialize_sqlite_database_no_clobber,
    type SqliteInitializeOptions,
} from './sqlite-open-recovery';
import {
    categorize_sqlite_file_state_error,
    sqlite_file_state_error,
} from './sqlite-file-state-errors';
import type {
    SqliteFileStateIdentity,
    SqliteFileStateMigrationOptions,
} from './sqlite-file-state-schema';
import {
    open_sqlite_runtime,
    type SqliteRuntimeHandle,
    type SqliteRuntimeHooks,
    type SqliteWriteTransactionContext,
} from './sqlite-runtime';
import {
    create_sqlite_file_state_read_repository,
    create_sqlite_file_state_write_repository,
    SqliteFileStateRepository,
} from './sqlite-file-state-repository';
import { decode_stored_per_file_state } from './types';
import { PhysicalResourceLockManager } from './physical-resource-lock';
import {
    reopen_prepared_physical_install,
    resume_prepared_physical_install_cleanup,
    type PlatformConditionalInstaller,
} from './prepared-physical-install';

export interface SqliteFileStatePersistenceOptions {
    readonly identity: SqliteFileStateIdentity;
    readonly migration: SqliteFileStateMigrationOptions;
    readonly clientKind: string;
    readonly clientVersion: string;
    readonly supportedProtocol?: number;
    readonly requiresPendingEditRecovery?: boolean;
    readonly timeoutMs?: number;
    readonly now?: () => number;
    readonly randomId?: () => string;
    readonly hooks?: SqliteRuntimeHooks;
    readonly initialization?: SqliteInitializeOptions;
}

export interface OpenedSqliteFileStateStore {
    readonly store: CoordinatedAuthorityFileStateStore;
    readonly persistence: CoordinatedKeyedFileStatePersistence;
    close(): Promise<void>;
}

export interface ReopenReservedPhysicalWriteOptions {
    readonly targetPath: string;
    readonly lockManager: PhysicalResourceLockManager;
    readonly installer: PlatformConditionalInstaller;
}

export type ReopenedReservedPhysicalWrite =
    | { readonly type: 'notReserved' }
    | {
        readonly type: 'recoveryRequired';
        readonly reason: 'lockEvidenceMissing' | 'preparedEvidenceInvalid' | 'bindingMismatch';
    }
    | {
        readonly type: 'reopened';
        readonly reservation: PhysicalWriteReservation;
        readonly io: ReservedPhysicalWriteIo;
        cleanupPreparedInstall(): Promise<void>;
        releaseHostLock(): Promise<void>;
    };

/**
 * Reconstruct a reserved physical-write adapter from durable SQLite, lock, and
 * prepared-install evidence. No pre-restart lock, bundle, directory, or I/O
 * closure is accepted as authority.
 */
export async function reopen_reserved_physical_write(
    persistence: CoordinatedKeyedFileStatePersistence,
    options: ReopenReservedPhysicalWriteOptions,
): Promise<ReopenedReservedPhysicalWrite> {
    const record = await persistence.read_transaction((tx) => (
        tx.read_physical_write_reservation(options.targetPath)
    ));
    if (!record) return { type: 'notReserved' };
    const directory = path.join(
        path.dirname(options.targetPath),
        `.table-viewer-prepared-${record.preparedInstallId}`,
    );
    let hostLock: ReturnType<PhysicalResourceLockManager['attest_reservation_lock']>;
    try {
        hostLock = options.lockManager.attest_reservation_lock(options.targetPath, {
            hostLockId: record.hostLockId,
            physicalResourceLockKey: record.physicalResourceLockKey,
        });
    } catch {
        return { type: 'recoveryRequired', reason: 'lockEvidenceMissing' };
    }
    if (!hostLock) return { type: 'recoveryRequired', reason: 'lockEvidenceMissing' };
    const failAfterAttestation = async (
        reason: Extract<ReopenedReservedPhysicalWrite, { type: 'recoveryRequired' }>['reason'],
    ): Promise<ReopenedReservedPhysicalWrite> => {
        try { await hostLock.release(); } catch { /* Failure remains fail-closed. */ }
        return { type: 'recoveryRequired', reason };
    };
    try {
        if (!await hostLock.verify()) return failAfterAttestation('lockEvidenceMissing');
    } catch {
        return failAfterAttestation('lockEvidenceMissing');
    }
    let bundle: ReturnType<typeof reopen_prepared_physical_install>;
    try {
        bundle = reopen_prepared_physical_install({
            targetPath: options.targetPath,
            directory,
            hostLock,
        });
    } catch {
        return failAfterAttestation('preparedEvidenceInvalid');
    }
    if (bundle.preparedInstallId !== record.preparedInstallId
        || bundle.hostLockId !== record.hostLockId
        || bundle.previousPhysicalResourceLockKey !== record.previousPhysicalResourceLockKey
        || bundle.physicalResourceLockKey !== record.physicalResourceLockKey
        || bundle.expectedPhysicalDigest !== record.expectedPhysicalDigest
        || bundle.intendedPhysicalDigest !== record.intendedPhysicalDigest) {
        return failAfterAttestation('bindingMismatch');
    }
    const binding = Object.freeze({
        preparedInstallId: record.preparedInstallId,
        expectedPhysicalDigest: record.expectedPhysicalDigest,
        intendedPhysicalDigest: record.intendedPhysicalDigest,
        hostLockId: record.hostLockId,
        previousPhysicalResourceLockKey: record.previousPhysicalResourceLockKey,
        physicalResourceLockKey: record.physicalResourceLockKey,
    });
    return {
        type: 'reopened',
        reservation: {
            reservationId: record.reservationId,
            saveOperationId: record.saveOperationId,
            stageId: record.stageId,
            preparedInstallId: record.preparedInstallId,
            ...(record.recoveryRecordId === undefined ? {} : {
                recoveryRecordId: record.recoveryRecordId,
            }),
        },
        io: bundle.createReservedIo(options.installer),
        async cleanupPreparedInstall() {
            try {
                await bundle.cleanup();
            } catch (error) {
                resume_prepared_physical_install_cleanup({
                    targetPath: options.targetPath,
                    directory,
                    binding,
                });
                throw error;
            }
        },
        releaseHostLock: () => hostLock.release(),
    };
}

function supported_protocol(options: SqliteFileStatePersistenceOptions): number | undefined {
    const configured = options.supportedProtocol;
    const initialization = options.initialization?.supportedProtocol;
    if (configured !== undefined && initialization !== undefined
        && configured !== initialization) {
        throw sqlite_file_state_error('protocol', {
            operation: 'supported-protocol-configuration',
            protocol: configured,
        });
    }
    return configured ?? initialization;
}

/** Adapt one runtime handle to the keyed semantic persistence port. */
export function create_sqlite_file_state_persistence_from_runtime(
    runtime: SqliteRuntimeHandle,
    options: {
        readonly now?: () => number;
        readonly supportsRecoveryRecords?: boolean;
    } = {},
): CoordinatedKeyedFileStatePersistence {
    let closePromise: Promise<void> | undefined;
    const now = options.now ?? Date.now;
    const repository = (tx: SqliteWriteTransactionContext) => (
        new SqliteFileStateRepository(tx, {
            writerSessionId: runtime.writer_session_id,
            now,
        })
    );
    const authorityEqual = (left: DurableFileAuthority, right: DurableFileAuthority): boolean => (
        left.commitSequence === right.commitSequence
        && left.authorityRevision === right.authorityRevision
        && left.physicalRevision === right.physicalRevision
        && left.projectionRevision === right.projectionRevision
        && left.physicalDigest === right.physicalDigest
    );
    const ioMatchesReservation = (
        io: Parameters<CoordinatedKeyedFileStatePersistence['execute_reserved_physical_write']>[3],
        record: PersistedPhysicalWriteReservationRecord,
    ): boolean => (
        io.binding !== undefined
        && io.binding.preparedInstallId === record.preparedInstallId
        && io.binding.hostLockId === record.hostLockId
        && io.binding.physicalResourceLockKey === record.physicalResourceLockKey
        && io.binding.expectedPhysicalDigest === record.expectedPhysicalDigest
        && io.binding.intendedPhysicalDigest === record.intendedPhysicalDigest
    );
    const cleanupRecordsEqual = (
        left: Extract<PreparedInstallCleanupObservation, { type: 'observed' }>['record'],
        right: Extract<PreparedInstallCleanupObservation, { type: 'observed' }>['record'],
    ): boolean => (
        left.targetPath === right.targetPath
        && left.reservationId === right.reservationId
        && left.saveOperationId === right.saveOperationId
        && left.stageId === right.stageId
        && left.preparedInstallId === right.preparedInstallId
        && left.hostLockId === right.hostLockId
        && left.previousPhysicalResourceLockKey === right.previousPhysicalResourceLockKey
        && left.physicalResourceLockKey === right.physicalResourceLockKey
        && left.expectedPhysicalDigest === right.expectedPhysicalDigest
        && left.intendedPhysicalDigest === right.intendedPhysicalDigest
        && left.recoveryRecordId === right.recoveryRecordId
        && left.finalizedAtMs === right.finalizedAtMs
    );
    const recoveryRequired = (
        physicalWriteCommitted = false,
        conditionalFenceReleasePending = false,
    ): PhysicalWriteRecoveryRequired => ({
        type: 'recoveryRequired',
        ...(physicalWriteCommitted ? { physicalWriteCommitted: true } : {}),
        ...(conditionalFenceReleasePending ? { conditionalFenceReleasePending: true } : {}),
    });
    const releaseFenceForRecovery = async (
        io: ReservedPhysicalWriteIo,
        physicalWriteCommitted: boolean,
    ): Promise<PhysicalWriteRecoveryRequired> => {
        try {
            await io.releaseConditionalInstallFence();
            return recoveryRequired(physicalWriteCommitted);
        } catch {
            return recoveryRequired(physicalWriteCommitted, true);
        }
    };
    const releaseFenceAfterThrownOperation = async (
        io: ReservedPhysicalWriteIo,
        operationError: unknown,
    ): Promise<never> => {
        try {
            await io.releaseConditionalInstallFence();
        } catch (releaseError) {
            throw new AggregateError(
                [operationError, releaseError],
                'Reserved physical write failed and its conditional fence release is pending',
            );
        }
        throw operationError;
    };
    const finalizeReservation = (
        repo: SqliteFileStateRepository,
        record: PersistedPhysicalWriteReservationRecord,
    ): DurableFileAuthority => {
        const current = repo.read_entry(record.entryPath);
        const stage = current?.stages.find((candidate) => candidate.id === record.stageId);
        if (!current || !stage || stage.kind !== 'physical'
            || current.entry.stateRevision !== record.expectedStateRevision
            || !authorityEqual(current.entry.authority, record.expectedAuthority)
            || stage.expectedStateRevision !== record.expectedStateRevision
            || stage.expectedCommitSequence !== record.expectedAuthority.commitSequence
            || stage.physicalDigest !== record.intendedPhysicalDigest) {
            throw sqlite_file_state_error('recovery', { operation: 'reservation-finalize-basis' });
        }
        const nextAuthority: DurableFileAuthority = {
            ...current.entry.authority,
            commitSequence: current.entry.authority.commitSequence + 1,
        };
        if (nextAuthority.physicalDigest !== stage.physicalDigest) {
            nextAuthority.physicalRevision += 1;
            nextAuthority.authorityRevision += 1;
            nextAuthority.physicalDigest = stage.physicalDigest;
        }
        const oldState = decode_stored_per_file_state(JSON.parse(current.entry.stateJson));
        const nextState = stage.nextState === undefined
            ? oldState
            : decode_stored_per_file_state(stage.nextState);
        const nextJson = JSON.stringify(nextState);
        const revision = nextJson === JSON.stringify(oldState)
            ? current.entry.stateRevision
            : repo.allocate_revision();
        if (!repo.transition_reservation_to_cleanup(
            record.entryPath,
            record.reservationId,
            now(),
        )) {
            throw sqlite_file_state_error('recovery', {
                operation: 'prepared-install-cleanup-transition',
            });
        }
        if (!repo.delete_reservation(record.entryPath, record.reservationId)) {
            throw sqlite_file_state_error('recovery', { operation: 'reservation-delete' });
        }
        const complete: PersistedCompleteKeyedStateEntry = {
            entry: {
                ...current.entry,
                stateRevision: revision,
                stateJson: nextJson,
                hasPendingEdits: state_has_pending_edits(nextState),
                authority: nextAuthority,
                recencyOrder: repo.allocate_recency_order(),
                updatedAtMs: Math.max(current.entry.updatedAtMs ?? now(), now()),
                ...(record.recoveryRecordId === undefined ? {} : {
                    recoveryRecordId: record.recoveryRecordId,
                }),
            } as PersistedKeyedStateEntry,
            stages: current.stages.filter((candidate) => candidate.id !== record.stageId),
        };
        repo.write_entry(complete);
        repo.set_updated_at(now());
        return nextAuthority;
    };
    const persistence: CoordinatedKeyedFileStatePersistence = {
        runtime_key: runtime.runtime_key,
        canonicalization_revision_policy: 'allocate-revision-when-target-absent',
        supports_recovery_records: options.supportsRecoveryRecords ?? false,
        read_transaction: (body) => runtime.read_transaction((tx) => body(
            create_sqlite_file_state_read_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now,
            }),
        )),
        write_transaction: (kind, body) => runtime.write_transaction(kind, (tx) => body(
            create_sqlite_file_state_write_repository(tx, {
                writerSessionId: runtime.writer_session_id,
                now,
            }),
        )),
        async acquire_edit_session(canonicalPath, canonicalKey, hostLock) {
            if (!canonicalPath || !hostLock.hostLockId || !hostLock.physicalResourceLockKey) {
                return { type: 'unsupportedIdentity' } as const;
            }
            if (!await hostLock.verify()) return { type: 'busy' } as const;
            return runtime.async_write_transaction('acquireEditSession', async (tx) => {
                const repo = repository(tx);
                const aliases = repo.scan_entry_metadata().filter((entry) => (
                    entry.path === canonicalPath || canonicalKey(entry.path) === canonicalPath
                ));
                if (aliases.some((entry) => entry.path !== canonicalPath)) {
                    return { type: 'unsupportedIdentity' } as const;
                }
                const existing = repo.read_edit_session(canonicalPath);
                if (existing) {
                    if (existing.ownerWriterSessionId === runtime.writer_session_id
                        && existing.hostLockId === hostLock.hostLockId
                        && existing.physicalResourceLockKey === hostLock.physicalResourceLockKey) {
                        if (!await hostLock.verify()) return { type: 'busy' } as const;
                        return {
                            type: 'acquired',
                            session: {
                                editSessionId: existing.editSessionId,
                                ownershipGeneration: existing.ownershipGeneration,
                            },
                        } as const;
                    }
                    return { type: 'busy' } as const;
                }
                const conflicting = tx.prepare(`SELECT 1 AS present FROM edit_sessions
                    WHERE physical_resource_lock_key = ? OR host_lock_id = ? LIMIT 1`).get(
                    hostLock.physicalResourceLockKey,
                    hostLock.hostLockId,
                );
                if (conflicting) return { type: 'busy' } as const;
                if (!await hostLock.verify()) return { type: 'busy' } as const;
                const timestamp = now();
                if (!repo.read_entry_metadata(canonicalPath)) {
                    const absenceRevision = repo.metadata().absenceRevision;
                    repo.insert_empty_entry({
                        path: canonicalPath,
                        stateRevision: absenceRevision,
                        hasPendingEdits: false,
                        authority: {
                            commitSequence: 0,
                            authorityRevision: 0,
                            physicalRevision: 0,
                            projectionRevision: 0,
                        },
                        recencyOrder: repo.allocate_recency_order(),
                        recoveryEntryId: canonicalPath,
                        authorityStageCount: 0,
                    });
                    repo.set_updated_at(timestamp);
                }
                const session = {
                    editSessionId: randomUUID(),
                    ownershipGeneration: repo.allocate_ownership_generation(),
                };
                repo.insert_edit_session({
                    entryPath: canonicalPath,
                    physicalResourceLockKey: hostLock.physicalResourceLockKey,
                    hostLockId: hostLock.hostLockId,
                    ownerWriterSessionId: runtime.writer_session_id,
                    ...session,
                    acquiredAtMs: timestamp,
                    lastConfirmedAtMs: timestamp,
                });
                return { type: 'acquired', session } as const;
            });
        },
        release_edit_session(_filePath, session) {
            return runtime.write_transaction('releaseEditSession', (tx) => {
                const repo = repository(tx);
                const current = repo.read_edit_session_by_identity(
                    session.editSessionId,
                    session.ownershipGeneration,
                );
                if (!current) return;
                if (current.ownerWriterSessionId !== runtime.writer_session_id) {
                    throw sqlite_file_state_error('contention', { operation: 'edit-session-release' });
                }
                if (repo.read_physical_write_reservation(current.entryPath)) {
                    throw sqlite_file_state_error('contention', { operation: 'reservation-busy' });
                }
                if (!repo.delete_edit_session(
                    current.entryPath,
                    session.editSessionId,
                    session.ownershipGeneration,
                )) {
                    throw sqlite_file_state_error('contention', { operation: 'edit-session-release' });
                }
            });
        },
        reserve_physical_write(filePath, session, request) {
            return runtime.write_transaction('reservePhysicalWrite', (tx) => {
                const repo = repository(tx);
                const existing = repo.read_physical_write_reservation(filePath);
                if (existing) {
                    if (existing.saveOperationId === request.saveOperationId
                        && existing.stageId === request.stageId
                        && existing.preparedInstallId === request.preparedInstall.preparedInstallId
                        && existing.recoveryRecordId === request.recoveryRecordId
                        && existing.editSessionId === session.editSessionId
                        && existing.ownershipGeneration === session.ownershipGeneration
                        && existing.expectedStateRevision === request.expectedStateRevision
                        && authorityEqual(existing.expectedAuthority, request.expectedAuthority)
                        && existing.hostLockId === request.preparedInstall.hostLockId
                        && existing.previousPhysicalResourceLockKey
                            === request.preparedInstall.previousPhysicalResourceLockKey
                        && existing.physicalResourceLockKey === request.preparedInstall.physicalResourceLockKey
                        && existing.expectedPhysicalDigest === request.preparedInstall.expectedPhysicalDigest
                        && existing.intendedPhysicalDigest === request.preparedInstall.intendedPhysicalDigest) {
                        return {
                            type: 'reserved',
                            reservation: {
                                reservationId: existing.reservationId,
                                saveOperationId: existing.saveOperationId,
                                stageId: existing.stageId,
                                preparedInstallId: existing.preparedInstallId,
                                ...(existing.recoveryRecordId === undefined ? {} : {
                                    recoveryRecordId: existing.recoveryRecordId,
                                }),
                            },
                        } as const;
                    }
                    return { type: 'reservationBusy' } as const;
                }
                const conflicting = tx.prepare(`SELECT 1 AS present FROM file_write_reservations
                    WHERE save_operation_id = ? OR physical_resource_lock_key = ?
                       OR host_lock_id = ? OR prepared_install_id = ? LIMIT 1`).get(
                    request.saveOperationId,
                    request.preparedInstall.physicalResourceLockKey,
                    request.preparedInstall.hostLockId,
                    request.preparedInstall.preparedInstallId,
                );
                if (conflicting) return { type: 'reservationBusy' } as const;
                const owner = repo.read_edit_session(filePath);
                const entry = repo.read_entry(filePath);
                const authority = entry?.entry.authority ?? {
                    commitSequence: 0, authorityRevision: 0, physicalRevision: 0, projectionRevision: 0,
                };
                const stage = entry?.stages.find((candidate) => candidate.id === request.stageId);
                if (!owner || owner.ownerWriterSessionId !== runtime.writer_session_id
                    || owner.editSessionId !== session.editSessionId
                    || owner.ownershipGeneration !== session.ownershipGeneration
                    || owner.hostLockId !== request.preparedInstall.hostLockId
                    || (owner.physicalResourceLockKey
                        !== request.preparedInstall.previousPhysicalResourceLockKey
                        && owner.physicalResourceLockKey
                            !== request.preparedInstall.physicalResourceLockKey)
                    || !entry || entry.entry.stateRevision !== request.expectedStateRevision
                    || !authorityEqual(authority, request.expectedAuthority)
                    || request.expectedAuthority.physicalDigest === undefined
                    || request.preparedInstall.expectedPhysicalDigest
                        !== request.expectedAuthority.physicalDigest
                    || !stage || stage.kind !== 'physical'
                    || stage.expectedStateRevision !== request.expectedStateRevision
                    || stage.expectedCommitSequence !== request.expectedAuthority.commitSequence
                    || stage.physicalDigest !== request.preparedInstall.intendedPhysicalDigest) {
                    return { type: 'conflict', authority } as const;
                }
                if (owner.physicalResourceLockKey
                    === request.preparedInstall.previousPhysicalResourceLockKey
                    && owner.physicalResourceLockKey
                        !== request.preparedInstall.physicalResourceLockKey) {
                    const update = repo.update_edit_session_lock_set(
                        filePath,
                        session.editSessionId,
                        session.ownershipGeneration,
                        request.preparedInstall.hostLockId,
                        request.preparedInstall.previousPhysicalResourceLockKey,
                        request.preparedInstall.physicalResourceLockKey,
                    );
                    if (update === 'busy') return { type: 'reservationBusy' } as const;
                    if (update !== 'updated') return { type: 'conflict', authority } as const;
                }
                const record: PersistedPhysicalWriteReservationRecord = {
                    reservationId: randomUUID(),
                    saveOperationId: request.saveOperationId,
                    entryPath: filePath,
                    physicalResourceLockKey: request.preparedInstall.physicalResourceLockKey,
                    previousPhysicalResourceLockKey:
                        request.preparedInstall.previousPhysicalResourceLockKey,
                    hostLockId: request.preparedInstall.hostLockId,
                    editSessionId: owner.editSessionId,
                    ownershipGeneration: owner.ownershipGeneration,
                    reservedGeneration: runtime.coordination_generation,
                    stageId: request.stageId,
                    preparedInstallId: request.preparedInstall.preparedInstallId,
                    expectedStateRevision: request.expectedStateRevision,
                    expectedAuthority: request.expectedAuthority,
                    expectedPhysicalDigest: request.preparedInstall.expectedPhysicalDigest,
                    intendedPhysicalDigest: request.preparedInstall.intendedPhysicalDigest,
                    ...(request.recoveryRecordId === undefined ? {} : {
                        recoveryRecordId: request.recoveryRecordId,
                    }),
                    acquiredAtMs: now(),
                };
                repo.insert_reservation(record);
                return {
                    type: 'reserved',
                    reservation: {
                        reservationId: record.reservationId,
                        saveOperationId: record.saveOperationId,
                        stageId: record.stageId,
                        preparedInstallId: record.preparedInstallId,
                        ...(record.recoveryRecordId === undefined ? {} : {
                            recoveryRecordId: record.recoveryRecordId,
                        }),
                    },
                } as const;
            });
        },
        execute_reserved_physical_write(filePath, session, reservation, io) {
            return runtime.async_write_transaction('executeReservedPhysicalWrite', async (tx) => {
                const repo = repository(tx);
                const record = repo.read_physical_write_reservation(filePath);
                const owner = repo.read_edit_session(filePath);
                if (!record || record.reservationId !== reservation.reservationId
                    || record.saveOperationId !== reservation.saveOperationId
                    || record.stageId !== reservation.stageId
                    || record.preparedInstallId !== reservation.preparedInstallId
                    || record.recoveryRecordId !== reservation.recoveryRecordId
                    || !owner || owner.editSessionId !== session.editSessionId
                    || owner.ownershipGeneration !== session.ownershipGeneration
                    || record.editSessionId !== session.editSessionId
                    || record.ownershipGeneration !== session.ownershipGeneration
                    || owner.hostLockId !== record.hostLockId
                    || owner.physicalResourceLockKey !== record.physicalResourceLockKey
                    || record.reservedGeneration !== runtime.coordination_generation
                    || !ioMatchesReservation(io, record)) {
                    return { type: 'conflict', authority: repo.read_entry_metadata(filePath)?.authority ?? {
                        commitSequence: 0, authorityRevision: 0, physicalRevision: 0, projectionRevision: 0,
                    } } as const;
                }
                if (!await io.verifyHostLock() || !await io.verifyPreparedBundle()) {
                    return recoveryRequired();
                }
                if (await io.inspectTarget() !== 'expected') return recoveryRequired();
                const fence = await io.acquireConditionalInstallFence('expected');
                if (fence !== 'acquired') return recoveryRequired();
                try {
                    if (!await io.verifyHostLock()) return releaseFenceForRecovery(io, false);
                    const installed = await io.installPreparedBundle();
                    if (installed.displacedPhysicalDigest !== record.expectedPhysicalDigest
                        || !await io.verifyInstalledDurable()
                        || await io.inspectTarget() !== 'intended') {
                        return releaseFenceForRecovery(io, true);
                    }
                    try {
                        await io.releaseConditionalInstallFence();
                    } catch {
                        return recoveryRequired(true, true);
                    }
                } catch (error) {
                    return releaseFenceAfterThrownOperation(io, error);
                }
                return { type: 'committed', authority: finalizeReservation(repo, record) } as const;
            });
        },
        reconcile_reserved_physical_write(filePath, reservationId, io) {
            return runtime.async_write_transaction('reconcileReservedPhysicalWrite', async (tx) => {
                const repo = repository(tx);
                const record = repo.read_physical_write_reservation(filePath);
                if (!record || record.reservationId !== reservationId
                    || record.reservedGeneration !== runtime.coordination_generation
                    || !ioMatchesReservation(io, record)
                    || !await io.verifyHostLock() || !await io.verifyPreparedBundle()) {
                    return recoveryRequired();
                }
                const target = await io.inspectTarget();
                if (target === 'expected') {
                    const fence = await io.acquireConditionalInstallFence('expected');
                    if (fence !== 'acquired') return recoveryRequired();
                    try {
                        if (!await io.verifyHostLock()
                            || await io.inspectTarget() !== 'expected') {
                            return releaseFenceForRecovery(io, false);
                        }
                        try {
                            await io.releaseConditionalInstallFence();
                        } catch {
                            return recoveryRequired(false, true);
                        }
                    } catch (error) {
                        return releaseFenceAfterThrownOperation(io, error);
                    }
                    if (!repo.clear_reserved_install_lifecycle(
                        record.entryPath,
                        record.reservationId,
                    ) || !repo.delete_reservation(record.entryPath, record.reservationId)) {
                        throw sqlite_file_state_error('recovery', {
                            operation: 'reservation-abort',
                        });
                    }
                    return { type: 'notInstalled' } as const;
                }
                if (target !== 'intended') return recoveryRequired();
                const fence = await io.acquireConditionalInstallFence('intended');
                if (fence !== 'acquired') return recoveryRequired();
                try {
                    if (!await io.verifyHostLock()
                        || !await io.verifyInstalledDurable()
                        || await io.inspectTarget() !== 'intended') {
                        return releaseFenceForRecovery(io, true);
                    }
                    try {
                        await io.releaseConditionalInstallFence();
                    } catch {
                        return recoveryRequired(true, true);
                    }
                } catch (error) {
                    return releaseFenceAfterThrownOperation(io, error);
                }
                return { type: 'finalized', authority: finalizeReservation(repo, record) } as const;
            });
        },
        discover_prepared_install_cleanups() {
            return persistence.read_transaction((tx) => tx.read_physical_write_cleanups());
        },
        async resume_prepared_install_cleanup(reservationId) {
            const record = (await persistence.discover_prepared_install_cleanups())
                .find((candidate) => candidate.reservationId === reservationId);
            if (!record) return { type: 'notFound' } as const;
            const physicalState = resume_prepared_physical_install_cleanup({
                targetPath: record.targetPath,
                directory: path.join(
                    path.dirname(record.targetPath),
                    `.table-viewer-prepared-${record.preparedInstallId}`,
                ),
                binding: record,
            });
            return { type: 'observed', physicalState, record } as const;
        },
        async complete_prepared_install_cleanup(observation) {
            if (observation.type === 'notFound' || observation.physicalState !== 'missing') {
                return false;
            }
            const currentObservation = await persistence.resume_prepared_install_cleanup(
                observation.record.reservationId,
            );
            if (currentObservation.type === 'notFound') return false;
            if (!cleanupRecordsEqual(currentObservation.record, observation.record)) {
                throw sqlite_file_state_error('recovery', {
                    operation: 'prepared-install-cleanup-binding',
                });
            }
            if (currentObservation.physicalState !== 'missing') return false;
            return runtime.write_transaction('completePreparedInstallCleanup', (tx) => {
                const repo = repository(tx);
                const matches = repo.read_physical_write_cleanups()
                    .filter((candidate) => candidate.reservationId
                        === observation.record.reservationId);
                if (matches.length === 0) return false;
                if (matches.length !== 1
                    || !cleanupRecordsEqual(matches[0], observation.record)
                    || !repo.clear_prepared_install_cleanup(observation.record)) {
                    throw sqlite_file_state_error('recovery', {
                        operation: 'prepared-install-cleanup-complete',
                    });
                }
                return true;
            });
        },
        close(): Promise<void> {
            closePromise ??= drain_keyed_state_runtime(runtime.runtime_key)
                .then(() => runtime.close());
            return closePromise;
        },
    };
    return persistence;
}

/**
 * Initialize without clobbering an existing database, then transfer the same
 * gated connection into the process-local runtime interned by canonical path.
 */
export async function open_sqlite_file_state_persistence(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
): Promise<CoordinatedKeyedFileStatePersistence> {
    try {
        await fs.promises.mkdir(path.dirname(path.resolve(databasePath)), {
            recursive: true,
            mode: 0o700,
        });
    } catch (error) {
        const code = (error as NodeJS.ErrnoException | null)?.code;
        if (code === 'EROFS') {
            throw sqlite_file_state_error('readonly', { operation: 'persistence-directory-create' });
        }
        throw categorize_sqlite_file_state_error(error, { operation: 'persistence-directory-create' });
    }
    const supportedProtocol = supported_protocol(options);
    const initialized = await initialize_sqlite_database_no_clobber(
        databasePath,
        options.identity,
        options.migration,
        {
            ...options.initialization,
            timeoutMs: options.timeoutMs,
            supportedProtocol,
        },
    );
    const runtime = await open_sqlite_runtime(initialized.database.canonicalPath, {
        identity: options.identity,
        adoptedConnection: initialized.database,
        clientKind: options.clientKind,
        clientVersion: options.clientVersion,
        supportedProtocol,
        requiresPendingEditRecovery: options.requiresPendingEditRecovery,
        timeoutMs: options.timeoutMs,
        now: options.now,
        randomId: options.randomId,
        hooks: options.hooks,
    });
    return create_sqlite_file_state_persistence_from_runtime(runtime, {
        now: options.now,
        supportsRecoveryRecords: options.requiresPendingEditRecovery,
    });
}

export async function recover_stale_sqlite_coordination(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
    confirmation: { readonly allProcessesClosed: true },
): Promise<number> {
    if (confirmation.allProcessesClosed !== true) {
        throw sqlite_file_state_error('recovery', { operation: 'coordination-reclaim-confirmation' });
    }
    const supportedProtocol = supported_protocol(options);
    const initialized = await initialize_sqlite_database_no_clobber(
        databasePath,
        options.identity,
        options.migration,
        {
            ...options.initialization,
            timeoutMs: options.timeoutMs,
            supportedProtocol,
        },
    );
    const database = initialized.database.database;
    try {
        database.exec('BEGIN IMMEDIATE');
        try {
            const reservationStatement = database.prepare(
                'SELECT count(*) AS count FROM file_write_reservations',
            );
            reservationStatement.setReadBigInts(true);
            const reservationValue = reservationStatement.get()?.count;
            const reservationCount = typeof reservationValue === 'bigint'
                ? Number(reservationValue)
                : reservationValue;
            if (!Number.isSafeInteger(reservationCount) || (reservationCount as number) < 0) {
                throw sqlite_file_state_error('counter', { operation: 'reservation-count' });
            }
            if ((reservationCount as number) > 0) {
                throw sqlite_file_state_error('recovery', {
                    operation: 'coordination-reclaim-reservations',
                    rowCount: reservationCount as number,
                });
            }
            const statement = database.prepare(`SELECT coordination_generation
                FROM state_meta WHERE singleton = 1`);
            statement.setReadBigInts(true);
            const value = statement.get()?.coordination_generation;
            const generation = typeof value === 'bigint' ? Number(value) : value;
            if (!Number.isSafeInteger(generation) || (generation as number) < 1
                || (generation as number) >= Number.MAX_SAFE_INTEGER - 1) {
                throw sqlite_file_state_error('counter', { operation: 'coordination-generation' });
            }
            const next = (generation as number) + 1;
            database.prepare(`UPDATE state_meta SET coordination_generation = ?
                WHERE singleton = 1 AND coordination_generation = ?`).run(next, generation as number);
            database.exec(`DELETE FROM entry_leases;
                DELETE FROM edit_sessions
                    WHERE NOT EXISTS (SELECT 1 FROM file_write_reservations r
                        WHERE r.entry_path = edit_sessions.entry_path);
                DELETE FROM writer_sessions
                    WHERE writer_session_id NOT IN (
                        SELECT owner_writer_session_id FROM edit_sessions
                    )`);
            database.exec('COMMIT');
            return next;
        } catch (error) {
            try { database.exec('ROLLBACK'); } catch { /* Preserve recovery failure. */ }
            throw error;
        }
    } finally {
        await initialized.database.close();
    }
}

/** Unwired coordinated owner used by backend tests; products deliberately do not call this yet. */
export async function open_sqlite_file_state_store(
    databasePath: string,
    options: SqliteFileStatePersistenceOptions,
    getMaxStoredFiles?: () => number,
): Promise<OpenedSqliteFileStateStore> {
    const persistence = await open_sqlite_file_state_persistence(databasePath, options);
    const store = create_coordinated_keyed_authority_store(persistence, getMaxStoredFiles);
    return {
        store,
        persistence,
        close: () => persistence.close(),
    };
}


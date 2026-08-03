import { createHash, randomUUID } from 'node:crypto';
import * as path from 'node:path';
import * as vscode from 'vscode';
import {
    acquire_sqlite_exclusive_recovery_gate,
    inspect_sqlite_recovery_gate,
    preserve_sqlite_basename_set,
    quarantine_malformed_sqlite_gate_markers,
    reclaim_stale_sqlite_exclusive_intent,
    resume_sqlite_basename_preservation,
} from '../../src/sqlite-open-recovery';
import { SqliteFileStateError } from '../../src/sqlite-file-state-errors';
import {
    CompanionStore,
    type CapsuleRecoveryRecord,
    type RecoveryRecord,
} from './companion-store';
import {
    original_file_resource_path,
    UnsafeRecoveryExportTargetError,
    write_recovery_export_safely,
} from './recovery-export-safety';

export const COMPANION_COMMANDS = {
    hostCapabilities: 'tableViewerCompanion.hostCapabilities.v1',
    namespace: 'tableViewerCompanion.namespace.v1',
    activeCapsule: 'tableViewerCompanion.activeCapsule.v1',
    submitCapsuleCandidate: 'tableViewerCompanion.submitCapsuleCandidate.v1',
    archiveDrift: 'tableViewerCompanion.archiveDrift.v1',
    beginEnvironmentImport: 'tableViewerCompanion.beginEnvironmentImport.v1',
    environmentImportStatus: 'tableViewerCompanion.environmentImportStatus.v1',
    abandonEnvironmentImport: 'tableViewerCompanion.abandonEnvironmentImport.v1',
    confirmEnvironment: 'tableViewerCompanion.confirmEnvironment.v1',
    confirmEnvironmentSourceRetirement: 'tableViewerCompanion.confirmEnvironmentSourceRetirement.v1',
    preparePendingEditRecovery: 'tableViewerCompanion.preparePendingEditRecovery.v1',
    confirmPendingEditRecovery: 'tableViewerCompanion.confirmPendingEditRecovery.v1',
    openRecovery: 'tableViewerCompanion.openRecovery',
    retireCapsule: 'tableViewerCompanion.retireCapsule',
} as const;

const DATABASE_BASENAME = 'namespace-recovery.sqlite3';
const RETRY = 'Try Again';
const DIAGNOSTICS = 'Open Diagnostics Folder';
const PRESERVE = 'Set Aside Complete State and Retry…';
const PRESERVE_ATTESTATION = 'I Closed Every Table Viewer Process — Set Aside Complete State';

let activeStore: CompanionStore | undefined;
let readyRegistrations: vscode.Disposable[] = [];

function database_path(globalStoragePath: string): string {
    return path.join(globalStoragePath, 'state', DATABASE_BASENAME);
}

function format_record(record: RecoveryRecord): string {
    return JSON.stringify({
        format: 'tableViewer.pendingEditRecovery.v1',
        recoveryRecordId: record.recoveryRecordId,
        storageEnvironmentId: record.storageEnvironmentId,
        databaseId: record.databaseId,
        recoveryEntryId: record.recoveryEntryId,
        kind: record.kind,
        resourceIdentity: record.resourceIdentity,
        basis: {
            authorityRevision: record.authorityRevision,
            physicalRevision: record.physicalRevision,
            projectionRevision: record.projectionRevision,
            ...(record.physicalDigest === undefined ? {} : { physicalDigest: record.physicalDigest }),
        },
        status: record.status,
        preparedAtMs: record.preparedAtMs,
        ...(record.committedStateRevision === undefined ? {} : {
            committedStateRevision: record.committedStateRevision,
        }),
        ...(record.pendingEdits === undefined ? {} : { pendingEdits: record.pendingEdits }),
    }, null, 2);
}

type RecoveryChoice =
    | { readonly kind: 'pendingEdit'; readonly record: RecoveryRecord }
    | { readonly kind: 'capsule'; readonly capsule: CapsuleRecoveryRecord };

async function choose_recovery(store: CompanionStore): Promise<RecoveryChoice | undefined> {
    const [records, capsules] = await Promise.all([
        store.listRecoveryRecords(),
        store.listCapsulesForRecovery(),
    ]);
    if (records.length === 0 && capsules.length === 0) {
        await vscode.window.showInformationMessage('Table Viewer has no retained recovery records or frozen migration capsules.');
        return undefined;
    }
    const items = [
        ...records.map((record) => ({
            label: `${record.kind === 'snapshot' ? 'Pending edits' : 'Clear marker'} — ${record.status}`,
            description: new Date(record.preparedAtMs).toLocaleString(),
            detail: JSON.stringify(record.resourceIdentity),
            choice: { kind: 'pendingEdit', record } as const,
        })),
        ...capsules.map((capsule) => ({
            label: `Frozen Memento capsule — ${capsule.status}`,
            description: new Date(capsule.createdAtMs).toLocaleString(),
            detail: `SHA-256 ${capsule.sourceDigest}`,
            choice: { kind: 'capsule', capsule } as const,
        })),
    ];
    return (await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose retained Table Viewer recovery data. Sensitive details remain in this companion-owned UI.',
        matchOnDescription: true,
        matchOnDetail: true,
    }))?.choice;
}

async function export_recovery(record: RecoveryRecord, globalStoragePath: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
        title: 'Export Table Viewer Pending-Edit Recovery Bundle',
        filters: { JSON: ['json'] },
        saveLabel: 'Export Recovery Bundle',
    });
    if (!target) return;
    if (target.scheme !== 'file') {
        await vscode.window.showErrorMessage('Recovery bundles can only be exported to a local file outside Table Viewer state and outside the original resource.');
        return;
    }
    try {
        write_recovery_export_safely({
            targetPath: target.fsPath,
            stateRootPath: path.join(globalStoragePath, 'state'),
            originalSourcePath: original_file_resource_path(record.resourceIdentity),
            contents: format_record(record),
        });
    } catch (error) {
        if (error instanceof UnsafeRecoveryExportTargetError) {
            await vscode.window.showErrorMessage(error.message);
            return;
        }
        await vscode.window.showErrorMessage('The recovery bundle could not be exported. No Table Viewer state or source resource was intentionally changed.');
        return;
    }
    await vscode.window.showInformationMessage('The basis-aware Table Viewer recovery bundle was exported. It was not applied to any resource.');
}

async function validate_basis(record: RecoveryRecord): Promise<void> {
    if (!record.physicalDigest) {
        await vscode.window.showWarningMessage('This recovery record has no physical digest. Automatic application is unavailable; export it for manual recovery.');
        return;
    }
    const selected = await vscode.window.showOpenDialog({
        title: 'Choose the Restored Resource to Validate',
        canSelectMany: false,
        canSelectFiles: true,
        canSelectFolders: false,
        openLabel: 'Validate Physical Basis',
    });
    if (!selected?.[0]) return;
    const bytes = await vscode.workspace.fs.readFile(selected[0]);
    const digest = createHash('sha256').update(bytes).digest('hex');
    if (digest === record.physicalDigest) {
        await vscode.window.showInformationMessage('The selected resource matches the recovery record physical digest. Export remains explicit; this arming release does not apply edits automatically.');
    } else {
        await vscode.window.showWarningMessage('The selected resource does not match the recorded physical basis. Table Viewer will not apply positional edits; export the recovery bundle for manual recovery.');
    }
}

function capsule_source_file_paths(capsule: CapsuleRecoveryRecord): string[] {
    const paths: string[] = [];
    for (const key of capsule.sourceResourceKeys) {
        if (path.isAbsolute(key)) {
            paths.push(key);
            continue;
        }
        try {
            const uri = vscode.Uri.parse(key);
            if (uri.scheme === 'file') paths.push(uri.fsPath);
        } catch {
            // A non-URI remote resource key cannot alias a local export target.
        }
    }
    return paths;
}

async function export_capsule(capsule: CapsuleRecoveryRecord, globalStoragePath: string): Promise<void> {
    const target = await vscode.window.showSaveDialog({
        title: 'Export Frozen Table Viewer Memento Capsule',
        filters: { JSON: ['json'] },
        saveLabel: 'Export Frozen Capsule',
    });
    if (!target) return;
    if (target.scheme !== 'file') {
        await vscode.window.showErrorMessage('Frozen capsules can only be exported to a local file outside Table Viewer state and outside every original resource.');
        return;
    }
    try {
        write_recovery_export_safely({
            targetPath: target.fsPath,
            stateRootPath: path.join(globalStoragePath, 'state'),
            originalSourcePaths: capsule_source_file_paths(capsule),
            contents: JSON.stringify({
                format: 'tableViewer.frozenMementoCapsule.v1',
                capsuleId: capsule.capsuleId,
                sourceFormat: capsule.sourceFormat,
                sourceDigest: capsule.sourceDigest,
                status: capsule.status,
                createdAtMs: capsule.createdAtMs,
                orderedSourceJson: capsule.orderedSourceJson,
            }, null, 2),
        });
    } catch (error) {
        if (error instanceof UnsafeRecoveryExportTargetError) {
            await vscode.window.showErrorMessage(error.message);
            return;
        }
        await vscode.window.showErrorMessage('The frozen capsule could not be exported. No Table Viewer state or source resource was intentionally changed.');
        return;
    }
    await vscode.window.showInformationMessage('The frozen Memento capsule was exported for manual recovery. It was not applied and Memento was not changed.');
}

async function open_recovery_ui(store: CompanionStore, globalStoragePath: string): Promise<void> {
    const choice = await choose_recovery(store);
    if (!choice) return;
    if (choice.kind === 'capsule') {
        await export_capsule(choice.capsule, globalStoragePath);
        return;
    }
    const { record } = choice;
    const exportLabel = 'Export Recovery Bundle';
    const validateLabel = 'Validate Restored Resource Basis';
    const action = await vscode.window.showInformationMessage(
        `Recovery basis: authority ${record.authorityRevision}, physical ${record.physicalRevision}, projection ${record.projectionRevision}. Table Viewer never guesses a destination or applies these positional edits without a matching physical basis.`,
        { modal: true, detail: JSON.stringify(record.resourceIdentity, null, 2) },
        validateLabel,
        exportLabel,
    );
    if (action === exportLabel) await export_recovery(record, globalStoragePath);
    if (action === validateLabel) await validate_basis(record);
}

function failure_detail(error: unknown): string {
    if (!(error instanceof SqliteFileStateError)) {
        return 'The companion state database did not open. The underlying error text was withheld because it may contain local paths or persisted data.';
    }
    const category = error.category.replace('-', ' ');
    const operation = error.metadata.operation === undefined ? '' : ` Safe operation: ${error.metadata.operation}.`;
    return `Failure category: ${category}.${operation} No path, SQL text, or persisted value is included.`;
}

async function choose_capsule_for_retirement(store: CompanionStore): Promise<string | undefined> {
    const capsules = await store.listCapsulesForRetirement();
    if (capsules.length === 0) {
        await vscode.window.showInformationMessage('Table Viewer has no retained migration capsule payload to retire.');
        return undefined;
    }
    const items = capsules.map((capsule) => ({
        label: `${capsule.status === 'drifted' ? 'Archived drift' : 'Active capsule'} — ${capsule.status}`,
        description: new Date(capsule.createdAtMs).toLocaleString(),
        detail: `SHA-256 ${capsule.sourceDigest}`,
        capsuleId: capsule.capsuleId,
    }));
    return (await vscode.window.showQuickPick(items, {
        placeHolder: 'Choose a retained Table Viewer migration capsule payload to retire.',
        matchOnDescription: true,
        matchOnDetail: true,
    }))?.capsuleId;
}

function exact_rpc_request<T>(
    value: unknown,
    required: readonly string[],
    optional: readonly string[] = [],
): T {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new TypeError('Companion RPC request must be an object.');
    }
    const record = value as Record<string, unknown>;
    const allowed = new Set([...required, ...optional]);
    if (Object.keys(record).some((key) => !allowed.has(key))
        || required.some((key) => !Object.hasOwn(record, key))) {
        throw new TypeError('Companion RPC request has an invalid property set.');
    }
    return record as T;
}

function register_ready_commands(context: vscode.ExtensionContext, store: CompanionStore): void {
    if (readyRegistrations.length !== 0) return;
    const registrations: vscode.Disposable[] = [
        vscode.commands.registerCommand(COMPANION_COMMANDS.namespace, (input) => store.namespace(exact_rpc_request(input, ['placementKeyDigest', 'operationId']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.activeCapsule, (input) => {
            if (input !== undefined) throw new TypeError('The active-capsule RPC accepts no request object.');
            return store.activeCapsule();
        }),
        vscode.commands.registerCommand(COMPANION_COMMANDS.submitCapsuleCandidate, (input) => store.submitCapsuleCandidate(exact_rpc_request(input, ['operationId', 'orderedSourceJson']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.archiveDrift, (input) => store.archiveDrift(exact_rpc_request(input, ['operationId', 'orderedSourceJson']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.beginEnvironmentImport, (input) => store.beginEnvironmentImport(exact_rpc_request(input, ['operationId', 'capsuleId', 'sourceDigest', 'storageEnvironmentId', 'databaseId']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.environmentImportStatus, (input) => store.environmentImportStatus(exact_rpc_request(input, ['importClaimId', 'capsuleId', 'storageEnvironmentId', 'databaseId']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.abandonEnvironmentImport, (input) => store.abandonEnvironmentImport(exact_rpc_request(input, ['operationId', 'importClaimId', 'capsuleId', 'storageEnvironmentId', 'databaseId', 'abandonmentEvidenceDigest']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.confirmEnvironment, (input) => store.confirmEnvironment(exact_rpc_request(input, ['operationId', 'importClaimId', 'capsuleId', 'sourceDigest', 'storageEnvironmentId', 'databaseId']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.confirmEnvironmentSourceRetirement, (input) => store.confirmEnvironmentSourceRetirement(exact_rpc_request(input, ['operationId', 'capsuleId', 'sourceDigest', 'storageEnvironmentId', 'databaseId', 'retirementKind', 'sourceStateDigest']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.preparePendingEditRecovery, (input) => store.preparePendingEditRecovery(exact_rpc_request(input, ['storageEnvironmentId', 'databaseId', 'recoveryEntryId', 'operationId', 'kind', 'resourceIdentityJson', 'authorityRevision', 'physicalRevision', 'projectionRevision'], ['pendingEditsJson', 'physicalDigest']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.confirmPendingEditRecovery, (input) => store.confirmPendingEditRecovery(exact_rpc_request(input, ['operationId', 'recoveryRecordId', 'committedStateRevision']))),
        vscode.commands.registerCommand(COMPANION_COMMANDS.retireCapsule, async () => {
            const capsuleId = await choose_capsule_for_retirement(store);
            if (capsuleId === undefined) return;
            const attestation = 'Retire Frozen Source Payload';
            const accepted = await vscode.window.showWarningMessage(
                'Retire this frozen Memento capsule only after every claimed environment incarnation has confirmed source retirement and after confirming that no never-claimed environment still needs it. The digest tombstone, namespace registry, and RPC receipts remain permanent. Original Memento is not cleared.',
                { modal: true },
                attestation,
            );
            if (accepted !== attestation) return;
            await store.retireCapsule({
                operationId: randomUUID(),
                capsuleId,
                noNeverClaimedEnvironmentAttested: true,
            });
            await vscode.window.showInformationMessage('The capsule payload was retired. Its identity tombstone and routing registry were retained.');
        }),
        { dispose: () => { void store.close(); } },
    ];
    readyRegistrations = registrations;
    context.subscriptions.push(...registrations);
}

async function preserve_complete_basename(globalStoragePath: string): Promise<void> {
    const databasePath = database_path(globalStoragePath);
    const confirmation = { allProcessesClosed: true as const };
    await quarantine_malformed_sqlite_gate_markers(databasePath, confirmation);
    const before = inspect_sqlite_recovery_gate(databasePath);
    if (before.exclusiveIntentTokenId) {
        await reclaim_stale_sqlite_exclusive_intent(databasePath, before.exclusiveIntentTokenId, confirmation);
    }
    const gate = await acquire_sqlite_exclusive_recovery_gate(databasePath);
    let completed = false;
    let releaseError: unknown;
    try {
        for (const tokenId of gate.listReaderTokenIds()) {
            await gate.reclaimStaleReaderToken(tokenId, confirmation);
        }
        if (inspect_sqlite_recovery_gate(databasePath).recoveryBlocked) {
            await resume_sqlite_basename_preservation(databasePath, { gate });
        } else {
            if (before.recoveryBlocked) {
            await resume_sqlite_basename_preservation(databasePath, { gate });
        } else {
            await preserve_sqlite_basename_set(databasePath, { gate });
        }
        }
        completed = true;
    } finally {
        try {
            if (!inspect_sqlite_recovery_gate(databasePath).recoveryBlocked) {
                await gate.release();
            }
        } catch (error) {
            releaseError = error;
        }
    }
    if (completed && releaseError !== undefined) throw releaseError;
}

export async function activate(context: vscode.ExtensionContext): Promise<void> {
    const manifestVersion = String(context.extension.packageJSON.version ?? '');
    const globalStoragePath = context.globalStorageUri.fsPath;
    const isUiPlacement = context.extension.extensionKind === vscode.ExtensionKind.UI;
    let openFailure: unknown = isUiPlacement
        ? undefined
        : new Error('The Table Viewer companion is not running in the local UI extension host.');
    let opening: Promise<CompanionStore | undefined> | undefined;

    const tryOpen = (): Promise<CompanionStore | undefined> => {
        if (!isUiPlacement) return Promise.resolve(undefined);
        if (opening) return opening;
        opening = CompanionStore.open(globalStoragePath, manifestVersion).then((store) => {
            activeStore = store;
            openFailure = undefined;
            register_ready_commands(context, store);
            return store;
        }, (error: unknown) => {
            openFailure = error;
            return undefined;
        }).finally(() => { opening = undefined; });
        return opening;
    };

    // These commands must exist even when opening the database fails. No stateful
    // bridge RPC is registered until tryOpen has produced a fully validated store.
    const capabilityRegistration = vscode.commands.registerCommand(
        COMPANION_COMMANDS.hostCapabilities,
        () => ({
            extensionId: context.extension.id,
            extensionVersion: manifestVersion,
            extensionKind: context.extension.extensionKind === vscode.ExtensionKind.UI ? 'ui' : 'workspace',
            protocolVersion: 1,
            directoryDurabilitySupported: process.platform !== 'win32' && activeStore !== undefined,
        }),
    );
    const recoveryRegistration = vscode.commands.registerCommand(COMPANION_COMMANDS.openRecovery, async () => {
        if (!isUiPlacement) {
            await vscode.window.showErrorMessage(
                'Table Viewer companion recovery is unavailable because the companion is not running in the local UI extension host.',
                { modal: true },
            );
            return;
        }
        if (activeStore) {
            await open_recovery_ui(activeStore, globalStoragePath);
            return;
        }
        const choice = await vscode.window.showErrorMessage(
            'Table Viewer could not open its migration and pending-edit recovery state.',
            { modal: true, detail: failure_detail(openFailure) },
            RETRY,
            DIAGNOSTICS,
            PRESERVE,
        );
        if (choice === DIAGNOSTICS) {
            await vscode.commands.executeCommand('revealFileInOS', context.globalStorageUri);
            return;
        }
        if (choice === RETRY) {
            await tryOpen();
            return;
        }
        if (choice !== PRESERVE) return;
        const accepted = await vscode.window.showWarningMessage(
            'Close every Table Viewer window and process first. Continuing quarantines malformed gate evidence, reclaims only explicitly attested stale gate tokens, resumes any interrupted preservation, and moves the complete companion SQLite basename set — database, journal, WAL, SHM, and setup candidates — into a preserved recovery generation. It never silently resets or deletes that evidence.',
            { modal: true },
            PRESERVE_ATTESTATION,
        );
        if (accepted !== PRESERVE_ATTESTATION) return;
        try {
            await preserve_complete_basename(globalStoragePath);
            await tryOpen();
        } catch {
            await vscode.window.showErrorMessage('Table Viewer could not complete the attested state preservation. Evidence was not silently reset; retry recovery to resume any interrupted preservation.');
        }
    });
    context.subscriptions.push(capabilityRegistration, recoveryRegistration);
    await tryOpen();
}

export async function deactivate(): Promise<void> {
    const registrations = readyRegistrations;
    readyRegistrations = [];
    for (const registration of registrations) registration.dispose();
    const store = activeStore;
    activeStore = undefined;
    await store?.close();
}

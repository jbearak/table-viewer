import type { FileAuthoritySnapshot, AuthorityCommitReceiptBase } from './file-coordinator';
import { deep_clone_and_freeze } from './immutable';
import type { FileStateSnapshot } from './state';
import type { HostMessage } from './types';
import {
    build_workbook_snapshot,
    type RetainedSnapshotCommandResult,
    type SnapshotDisposition,
    type WorkbookSnapshot,
    type WorkbookSnapshotCapabilities,
    type WorkbookSnapshotConfiguration,
    type WorkbookSnapshotCoreMaterial,
    type WorkbookSnapshotDiagnostics,
    type WorkbookSnapshotIdentity,
    type WorkbookSnapshotReason,
} from './viewer-snapshot';

export type PanelSessionLifecycle = 'awaitingReady' | 'ready' | 'active' | 'disposed';

export interface PanelAdoptionProjection {
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
}

/**
 * Immutable caller-owned description of one already-adopted source. PanelSession
 * retains its object identity for ACK gating but owns no DataSource, core,
 * authority, parser, watcher, or durable state. `project` is sampled exactly once
 * at replacement time; source ownership can move here in Phase 4.5 through the
 * explicit release callback without coupling this transport checkpoint to it.
 */
interface PanelAdoptionCommon {
    readonly canonicalFileId: string;
    readonly core: WorkbookSnapshotCoreMaterial;
    readonly diagnostics: WorkbookSnapshotDiagnostics;
    readonly warnings?: readonly string[];
    readonly reason: WorkbookSnapshotReason;
    readonly project: () => PanelAdoptionProjection;
}

export type PanelAdoption = PanelAdoptionCommon & (
    | {
        readonly source: 'commitReceipt';
        readonly receipt: AuthorityCommitReceiptBase;
    }
    | {
        readonly source: 'observed';
        readonly authority: FileAuthoritySnapshot;
        readonly stateSnapshot: Readonly<FileStateSnapshot>;
    }
);

export interface PanelSessionScheduler<Handle = unknown> {
    readonly schedule: (callback: () => void, delayMs: number) => Handle;
    readonly clear: (handle: Handle) => void;
}

type SnapshotMessage = Extract<HostMessage, { type: 'workbookSnapshot' }>;

export interface PanelSessionOptions<Handle = ReturnType<typeof setTimeout>> {
    readonly postMessage: (
        message: SnapshotMessage,
    ) => boolean | Thenable<boolean> | Promise<boolean>;
    readonly scheduler?: PanelSessionScheduler<Handle>;
    readonly backoffMs?: readonly number[];
    readonly ackTimeoutMs?: number;
    readonly issuedLedgerLimit?: number;
    readonly onNeedsInitialSource?: () => void;
    readonly onNeedsResyncSource?: (adoption: PanelAdoption) => void;
    readonly onCurrentAdoptionAcknowledged?: (adoption: PanelAdoption) => void;
    readonly onAdoptionReleased?: (adoption: PanelAdoption) => void;
}

export type PanelReadyResult =
    | { readonly type: 'ready'; readonly receiverEpoch: number }
    | { readonly type: 'needsInitialSource'; readonly receiverEpoch: number };

type CapturedAdoptionMaterial = Omit<PanelAdoptionCommon, 'project'> & {
    readonly projection: PanelAdoptionProjection;
} & (
    | {
        readonly source: 'commitReceipt';
        readonly receipt: AuthorityCommitReceiptBase;
    }
    | {
        readonly source: 'observed';
        readonly authority: FileAuthoritySnapshot;
        readonly stateSnapshot: Readonly<FileStateSnapshot>;
    }
);

interface CapturedAdoption {
    /** Original opaque identity used only for association and callbacks. */
    readonly adoption: PanelAdoption;
    readonly epoch: number;
    /** Isolated immutable basis sampled atomically by replace_adoption(). */
    readonly material: CapturedAdoptionMaterial;
}

interface IssuedDelivery {
    readonly deliveryId: number;
    readonly receiverEpoch: number;
    readonly adoption: CapturedAdoption;
    readonly snapshot: WorkbookSnapshot;
    readonly commandResult?: RetainedSnapshotCommandResult;
    attempted: boolean;
    status: 'desired' | 'posted' | 'acked' | 'superseded' | 'stale';
}

const DEFAULT_BACKOFF_MS = Object.freeze([25, 50, 100, 200]);
const DEFAULT_ACK_TIMEOUT_MS = 1_000;
const DEFAULT_LEDGER_LIMIT = 32;

function default_scheduler(): PanelSessionScheduler<ReturnType<typeof setTimeout>> {
    return {
        schedule: (callback, delay_ms) => setTimeout(callback, delay_ms),
        clear: (handle) => clearTimeout(handle),
    };
}

function identities_equal(
    left: WorkbookSnapshotIdentity,
    right: WorkbookSnapshotIdentity,
): boolean {
    return left.deliveryId === right.deliveryId
        && left.authority.fileId === right.authority.fileId
        && left.authority.revision === right.authority.revision
        && left.stateRevision === right.stateRevision
        && left.sourceBasis.physicalRevision === right.sourceBasis.physicalRevision
        && left.sourceBasis.projectionRevision === right.sourceBasis.projectionRevision;
}

function capture_adoption(adoption: PanelAdoption): CapturedAdoptionMaterial {
    const common = {
        canonicalFileId: adoption.canonicalFileId,
        core: adoption.core,
        diagnostics: adoption.diagnostics,
        warnings: adoption.warnings,
        reason: adoption.reason,
        projection: adoption.project(),
    } as const;
    if (adoption.source === 'commitReceipt') {
        const receipt = adoption.receipt;
        return deep_clone_and_freeze({
            ...common,
            source: 'commitReceipt' as const,
            receipt: {
                operationKind: receipt.operationKind,
                operationOrdinal: receipt.operationOrdinal,
                previousBasis: receipt.previousBasis,
                resultingBasis: receipt.resultingBasis,
                stateSnapshot: receipt.stateSnapshot,
            },
        });
    }
    return deep_clone_and_freeze({
        ...common,
        source: 'observed' as const,
        authority: adoption.authority,
        stateSnapshot: adoption.stateSnapshot,
    });
}

function physical_digest(adoption: CapturedAdoption): string | undefined {
    return adoption.material.source === 'commitReceipt'
        ? adoption.material.receipt.resultingBasis.physicalDigest
        : adoption.material.authority.physicalDigest;
}

/** Reliable, readiness-gated transport for complete immutable workbook snapshots. */
export class PanelSession<Handle = ReturnType<typeof setTimeout>> {
    private _lifecycle: PanelSessionLifecycle = 'awaitingReady';
    private readonly post_message: PanelSessionOptions<Handle>['postMessage'];
    private readonly scheduler: PanelSessionScheduler<Handle>;
    private readonly backoff_ms: readonly number[];
    private readonly ack_timeout_ms: number;
    private readonly ledger_limit: number;
    private readonly on_needs_initial_source?: () => void;
    private readonly on_needs_resync_source?: (adoption: PanelAdoption) => void;
    private readonly on_current_adoption_acknowledged?: (adoption: PanelAdoption) => void;
    private readonly on_adoption_released?: (adoption: PanelAdoption) => void;

    private receiver_epoch = 0;
    private adoption_epoch = 0;
    private replacement_token = 0;
    private next_delivery_id = 1;
    private current?: CapturedAdoption;
    private desired?: IssuedDelivery;
    private acknowledged?: IssuedDelivery;
    private retained_result?: RetainedSnapshotCommandResult;
    private acknowledged_adoption_epoch?: number;
    private readonly ledger = new Map<number, IssuedDelivery>();
    private timer?: Handle;
    private timer_token = 0;
    private attempt_token = 0;
    private retry_index = 0;
    private receiver_baseline_file_id?: string;
    private stale_adoption_epoch?: number;

    constructor(options: PanelSessionOptions<Handle>) {
        this.post_message = options.postMessage;
        this.scheduler = options.scheduler
            ?? (default_scheduler() as unknown as PanelSessionScheduler<Handle>);
        this.backoff_ms = Object.freeze([...(options.backoffMs ?? DEFAULT_BACKOFF_MS)]);
        this.ack_timeout_ms = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
        this.ledger_limit = Math.max(1, options.issuedLedgerLimit ?? DEFAULT_LEDGER_LIMIT);
        this.on_needs_initial_source = options.onNeedsInitialSource;
        this.on_needs_resync_source = options.onNeedsResyncSource;
        this.on_current_adoption_acknowledged = options.onCurrentAdoptionAcknowledged;
        this.on_adoption_released = options.onAdoptionReleased;
    }

    get lifecycle(): PanelSessionLifecycle {
        return this._lifecycle;
    }

    /**
     * Every ready call denotes a new receiver epoch. Duplicate notifications are
     * therefore safe but intentionally restart delivery with a new deliveryId.
     */
    ready(): PanelReadyResult {
        if (this._lifecycle === 'disposed') {
            return { type: 'needsInitialSource', receiverEpoch: this.receiver_epoch };
        }
        const receiver_epoch = ++this.receiver_epoch;
        this.receiver_baseline_file_id = undefined;
        this.stale_adoption_epoch = undefined;
        this.invalidate_transport();
        this.supersede_desired();
        this.acknowledged = undefined;
        if (!this.current) {
            this._lifecycle = 'ready';
            this.on_needs_initial_source?.();
            // A callback may synchronously establish a source or even start a newer
            // receiver epoch. This invocation reports its own captured epoch and
            // never creates duplicate work after that reentrant continuation.
            return this.current
                ? { type: 'ready', receiverEpoch: receiver_epoch }
                : { type: 'needsInitialSource', receiverEpoch: receiver_epoch };
        }
        this._lifecycle = 'active';
        this.create_desired('initial', 'ready');
        return { type: 'ready', receiverEpoch: receiver_epoch };
    }

    /** Replace the opaque adopted context. Passing undefined clears the source. */
    replace_adoption(adoption: PanelAdoption | undefined): void {
        if (this._lifecycle === 'disposed') return;
        const replacement_token = ++this.replacement_token;
        const material = adoption === undefined ? undefined : capture_adoption(adoption);
        if (
            this.lifecycle === 'disposed'
            || this.replacement_token !== replacement_token
        ) {
            // The candidate was never installed. Its ownership remains entirely
            // with the caller, while any reentrant replacement/disposal stands.
            return;
        }
        const previous = this.current?.adoption;
        this.invalidate_transport();
        this.supersede_desired();
        this.acknowledged = undefined;
        this.acknowledged_adoption_epoch = undefined;
        this.stale_adoption_epoch = undefined;
        this.adoption_epoch += 1;
        this.current = adoption === undefined || material === undefined
            ? undefined
            : { adoption, epoch: this.adoption_epoch, material };
        const release_previous = () => {
            if (previous && previous !== adoption) this.on_adoption_released?.(previous);
        };
        if (!this.current) {
            if (this.receiver_epoch > 0) this._lifecycle = 'ready';
            release_previous();
            return;
        }
        if (this.receiver_epoch === 0) {
            release_previous();
            return;
        }
        this._lifecycle = 'active';
        const presentation = this.receiver_baseline_file_id
            === this.current.material.canonicalFileId
            ? 'refresh'
            : 'initial';
        this.create_desired(presentation, this.current.material.reason);
        // Release only after the replacement is current and its desired delivery
        // exists. If an injected release callback throws, the new session state is
        // still coherent and its transport attempt is already underway.
        release_previous();
    }

    current_adoption(): PanelAdoption | undefined {
        return this._lifecycle === 'disposed' ? undefined : this.current?.adoption;
    }

    /** Retain one locally-originated result until a current containing ACK settles it. */
    retain_command_result(result: RetainedSnapshotCommandResult): void {
        if (this._lifecycle === 'disposed') return;
        this.retained_result = deep_clone_and_freeze(result);
        if (
            !this.current
            || this.receiver_epoch === 0
            || this.stale_adoption_epoch === this.current.epoch
        ) return;
        this.invalidate_transport();
        this.supersede_desired();
        this.acknowledged = undefined;
        const presentation = this.receiver_baseline_file_id
            === this.current.material.canonicalFileId
            ? 'refresh'
            : 'initial';
        this.create_desired(presentation, 'excelHeader');
    }

    /** Restart a bounded retry burst without changing snapshot identity or contents. */
    wake_delivery(): void {
        if (this._lifecycle === 'disposed' || !this.desired) return;
        if (this.desired.status === 'acked') return;
        this.invalidate_transport();
        this.retry_index = 0;
        this.desired.status = 'desired';
        this.post_desired(this.desired);
    }

    handle_snapshot_applied(
        identity: WorkbookSnapshotIdentity,
        disposition: SnapshotDisposition,
    ): void {
        if (this._lifecycle === 'disposed') return;
        const issued = this.ledger.get(identity.deliveryId);
        if (!issued || !issued.attempted || !identities_equal(issued.snapshot.identity, identity)) {
            return;
        }
        if (issued !== this.desired) {
            issued.status = disposition === 'stale' ? 'stale' : 'acked';
            this.ledger.delete(issued.snapshot.identity.deliveryId);
            return;
        }
        if (issued.status === 'acked') return;
        if (disposition === 'stale') {
            issued.status = 'stale';
            this.ledger.delete(issued.snapshot.identity.deliveryId);
            this.invalidate_transport();
            this.desired = undefined;
            this.acknowledged = undefined;
            if (this.current && issued.adoption === this.current) {
                this.receiver_baseline_file_id = issued.adoption.material.canonicalFileId;
                this.stale_adoption_epoch = issued.adoption.epoch;
                // The known-stale basis is not wakeable. Retained command results
                // remain local and will be included only after the owner supplies a
                // fresh adoption in response to this resync request.
                this.on_needs_resync_source?.(this.current.adoption);
            }
            return;
        }
        this.invalidate_transport();
        issued.status = 'acked';
        this.acknowledged = issued;
        this.receiver_baseline_file_id = issued.adoption.material.canonicalFileId;
        if (
            issued.commandResult !== undefined
            && issued.commandResult === this.retained_result
        ) {
            this.retained_result = undefined;
        }
        const adoption_epoch = issued.adoption.epoch;
        if (this.acknowledged_adoption_epoch !== adoption_epoch) {
            // Set before invoking caller code so reentrant ready/ACK handling cannot
            // duplicate the callback. A reentrant replacement resets the scalar.
            this.acknowledged_adoption_epoch = adoption_epoch;
            this.on_current_adoption_acknowledged?.(issued.adoption.adoption);
        }
    }

    acknowledged_current(): boolean {
        if (this._lifecycle === 'disposed' || !this.current || !this.desired) return false;
        const acknowledged = this.acknowledged;
        return acknowledged === this.desired
            && acknowledged.status === 'acked'
            && acknowledged.adoption === this.current
            && acknowledged.receiverEpoch === this.receiver_epoch
            && acknowledged.snapshot.generation === this.desired.snapshot.generation
            && acknowledged.snapshot.sourceGeneration === this.desired.snapshot.sourceGeneration;
    }

    acknowledged_physical_digest(): string | undefined {
        return this.acknowledged_current() && this.current
            ? physical_digest(this.current)
            : undefined;
    }

    acknowledged_identity(): WorkbookSnapshotIdentity | undefined {
        return this.acknowledged_current()
            ? this.acknowledged?.snapshot.identity
            : undefined;
    }

    dispose(): void {
        if (this._lifecycle === 'disposed') return;
        this._lifecycle = 'disposed';
        this.replacement_token += 1;
        this.invalidate_transport();
        const adoption = this.current?.adoption;
        this.current = undefined;
        this.desired = undefined;
        this.acknowledged = undefined;
        this.retained_result = undefined;
        this.acknowledged_adoption_epoch = undefined;
        this.stale_adoption_epoch = undefined;
        this.ledger.clear();
        if (adoption) this.on_adoption_released?.(adoption);
    }

    private create_desired(
        presentation: WorkbookSnapshot['presentation'],
        reason: WorkbookSnapshotReason,
    ): void {
        const adoption = this.current;
        if (!adoption || this._lifecycle === 'disposed') return;
        this.invalidate_transport();
        this.supersede_desired();
        this.retry_index = 0;
        const delivery_id = this.next_delivery_id++;
        const material = adoption.material;
        const common = {
            deliveryId: delivery_id,
            canonicalFileId: material.canonicalFileId,
            core: material.core,
            presentation,
            reason,
            configuration: material.projection.configuration,
            capabilities: material.projection.capabilities,
            diagnostics: material.diagnostics,
            commandResult: this.retained_result,
        } as const;
        const snapshot = material.source === 'commitReceipt'
            ? build_workbook_snapshot({
                ...common,
                source: 'commitReceipt',
                receipt: material.receipt,
            })
            : build_workbook_snapshot({
                ...common,
                source: 'observed',
                authority: material.authority,
                state_snapshot: material.stateSnapshot,
            });
        const issued: IssuedDelivery = {
            deliveryId: delivery_id,
            receiverEpoch: this.receiver_epoch,
            adoption,
            snapshot,
            commandResult: this.retained_result,
            attempted: false,
            status: 'desired',
        };
        this.desired = issued;
        this.ledger.set(delivery_id, issued);
        this.trim_ledger();
        this.post_desired(issued);
    }

    private post_desired(issued: IssuedDelivery): void {
        if (
            this._lifecycle === 'disposed'
            || this.receiver_epoch === 0
            || this.desired !== issued
        ) return;
        const token = ++this.attempt_token;
        const snapshot = issued.snapshot;
        issued.attempted = true;
        this.arm_attempt_timeout(issued, token);
        let posted: boolean | Thenable<boolean> | Promise<boolean>;
        try {
            posted = this.post_message({ type: 'workbookSnapshot', snapshot });
        } catch {
            this.handle_post_failure(issued, token);
            return;
        }
        Promise.resolve(posted).then(
            (accepted) => {
                if (!this.attempt_is_current(issued, token)) return;
                if (!accepted) {
                    this.handle_post_failure(issued, token);
                    return;
                }
                issued.status = 'posted';
                this.arm_ack_timeout(issued);
            },
            () => this.handle_post_failure(issued, token),
        );
    }

    private handle_post_failure(issued: IssuedDelivery, token: number): void {
        if (!this.attempt_is_current(issued, token)) return;
        issued.status = 'desired';
        this.schedule_retry(issued);
    }

    private arm_attempt_timeout(issued: IssuedDelivery, attempt_token: number): void {
        this.clear_timer();
        const timer_token = ++this.timer_token;
        this.timer = this.scheduler.schedule(() => {
            if (
                !this.timer_is_current(issued, timer_token)
                || !this.attempt_is_current(issued, attempt_token)
            ) return;
            this.timer = undefined;
            this.attempt_token += 1;
            issued.status = 'desired';
            this.schedule_retry(issued);
        }, this.ack_timeout_ms);
    }

    private arm_ack_timeout(issued: IssuedDelivery): void {
        this.clear_timer();
        const timer_token = ++this.timer_token;
        this.timer = this.scheduler.schedule(() => {
            if (!this.timer_is_current(issued, timer_token)) return;
            this.timer = undefined;
            issued.status = 'desired';
            this.schedule_retry(issued);
        }, this.ack_timeout_ms);
    }

    private schedule_retry(issued: IssuedDelivery): void {
        this.clear_timer();
        const delay = this.backoff_ms[this.retry_index];
        if (delay === undefined) return;
        this.retry_index += 1;
        const timer_token = ++this.timer_token;
        this.timer = this.scheduler.schedule(() => {
            if (!this.timer_is_current(issued, timer_token)) return;
            this.timer = undefined;
            this.post_desired(issued);
        }, delay);
    }

    private attempt_is_current(issued: IssuedDelivery, token: number): boolean {
        return this._lifecycle !== 'disposed'
            && this.desired === issued
            && this.attempt_token === token;
    }

    private timer_is_current(issued: IssuedDelivery, token: number): boolean {
        return this._lifecycle !== 'disposed'
            && this.desired === issued
            && this.timer_token === token;
    }

    private invalidate_transport(): void {
        this.attempt_token += 1;
        this.clear_timer();
    }

    private clear_timer(): void {
        if (this.timer !== undefined) {
            this.scheduler.clear(this.timer);
            this.timer = undefined;
        }
        this.timer_token += 1;
    }

    private supersede_desired(): void {
        if (this.desired && this.desired.status !== 'acked') {
            this.desired.status = 'superseded';
        }
        this.desired = undefined;
    }

    private trim_ledger(): void {
        while (this.ledger.size > this.ledger_limit) {
            const oldest = this.ledger.keys().next().value;
            if (oldest === undefined) return;
            if (this.desired?.deliveryId === oldest) return;
            this.ledger.delete(oldest);
        }
    }
}

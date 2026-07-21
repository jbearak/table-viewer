import type { FileAuthoritySnapshot, AuthorityCommitReceiptBase } from './file-coordinator';
import { deep_clone_and_freeze } from './immutable';
import type { FileStateSnapshot } from './state';
import type { DataSource } from './data-source/interface';
import type { ViewerPanelCore } from './panel-core';
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
    type NormalizedPerFileState,
} from './viewer-snapshot';

export type PanelSessionLifecycle = 'awaitingReady' | 'ready' | 'active' | 'disposed';

export interface PanelAdoptionProjection {
    readonly configuration: WorkbookSnapshotConfiguration;
    readonly capabilities: WorkbookSnapshotCapabilities;
    /** Optional panel-specific state projection; the durable receipt remains exact. */
    readonly stateSnapshot?: Readonly<FileStateSnapshot>;
}

export interface PanelAdoptionResources {
    readonly source: DataSource;
    readonly core: ViewerPanelCore;
}

/**
 * One installed source/core adoption. PanelSession is the sole lifecycle owner of
 * these resources after replacement succeeds; callers may only borrow them through
 * current_adoption(). `project` is sampled exactly once at replacement time.
 */
interface PanelAdoptionCommon {
    readonly canonicalFileId: string;
    readonly resources: PanelAdoptionResources;
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
    readonly dormantRetryMs?: number;
    readonly issuedLedgerLimit?: number;
    readonly onNeedsInitialSource?: () => void;
    readonly onNeedsResyncSource?: (adoption: PanelAdoption) => void;
    readonly onCurrentAdoptionAcknowledged?: (adoption: PanelAdoption) => void;
    readonly onAdoptionReleased?: (adoption: PanelAdoption) => void;
}

export interface PanelReadyEpoch {
    readonly receiverEpoch: number;
    readonly hasSource: boolean;
}

export type PanelReadyResult =
    | { readonly type: 'ready'; readonly receiverEpoch: number }
    | { readonly type: 'needsInitialSource'; readonly receiverEpoch: number }
    | { readonly type: 'stale'; readonly receiverEpoch: number };

type CapturedAdoptionMaterial = Omit<PanelAdoptionCommon, 'project' | 'resources'> & {
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
    /** Immutable source/core/authority basis sampled by replace_adoption(). */
    readonly material: CapturedAdoptionMaterial;
    /** Latest configuration/capability projection for future deliveries. */
    projection: PanelAdoptionProjection;
    /** Latest panel-projected durable state used only for future deliveries. */
    stateSnapshot: Readonly<FileStateSnapshot>;
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
const DEFAULT_DORMANT_RETRY_MS = 30_000;
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

function captured_state_snapshot(
    material: CapturedAdoptionMaterial,
): Readonly<FileStateSnapshot> {
    const state = material.projection.stateSnapshot
        ?? (material.source === 'commitReceipt'
            ? material.receipt.stateSnapshot
            : material.stateSnapshot);
    return deep_clone_and_freeze(state);
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
    private readonly dormant_retry_ms: number;
    private readonly ledger_limit: number;
    private readonly on_needs_initial_source?: () => void;
    private readonly on_needs_resync_source?: (adoption: PanelAdoption) => void;
    private readonly on_current_adoption_acknowledged?: (adoption: PanelAdoption) => void;
    private readonly on_adoption_released?: (adoption: PanelAdoption) => void;

    private receiver_epoch = 0;
    /** Set only while a receiver epoch is waiting for async state preparation. */
    private ready_gate_epoch?: number;
    private adoption_epoch = 0;
    private replacement_token = 0;
    private next_delivery_id = 1;
    private current?: CapturedAdoption;
    private desired?: IssuedDelivery;
    private acknowledged?: IssuedDelivery;
    private readonly retained_results = new Map<string, RetainedSnapshotCommandResult>();
    private readonly settled_result_ids = new Set<string>();
    private acknowledged_adoption_epoch?: number;
    private readonly ledger = new Map<number, IssuedDelivery>();
    private timer?: Handle;
    private timer_token = 0;
    private attempt_token = 0;
    private retry_index = 0;
    private transport_mode: 'normal' | 'dormant' = 'normal';
    private receiver_baseline_file_id?: string;
    private stale_adoption_epoch?: number;

    constructor(options: PanelSessionOptions<Handle>) {
        if (typeof options.postMessage !== 'function') {
            throw new TypeError('PanelSession requires snapshot postMessage configuration.');
        }
        this.post_message = options.postMessage;
        this.scheduler = options.scheduler
            ?? (default_scheduler() as unknown as PanelSessionScheduler<Handle>);
        this.backoff_ms = Object.freeze([...(options.backoffMs ?? DEFAULT_BACKOFF_MS)]);
        this.ack_timeout_ms = options.ackTimeoutMs ?? DEFAULT_ACK_TIMEOUT_MS;
        this.dormant_retry_ms = options.dormantRetryMs ?? DEFAULT_DORMANT_RETRY_MS;
        this.ledger_limit = Math.max(1, options.issuedLedgerLimit ?? DEFAULT_LEDGER_LIMIT);
        this.on_needs_initial_source = options.onNeedsInitialSource;
        this.on_needs_resync_source = options.onNeedsResyncSource;
        this.on_current_adoption_acknowledged = options.onCurrentAdoptionAcknowledged;
        this.on_adoption_released = options.onAdoptionReleased;
    }

    get lifecycle(): PanelSessionLifecycle {
        return this._lifecycle;
    }

    get current_receiver_epoch(): number {
        return this.receiver_epoch;
    }

    /**
     * Start a receiver epoch synchronously. This immediately invalidates every old
     * post continuation, retry, and ACK timer, but deliberately posts nothing until
     * complete_ready() after the caller has prepared current durable state.
     */
    begin_ready(): PanelReadyEpoch {
        if (this._lifecycle === 'disposed') {
            return { receiverEpoch: this.receiver_epoch, hasSource: false };
        }
        const receiver_epoch = ++this.receiver_epoch;
        this.ready_gate_epoch = receiver_epoch;
        this.receiver_baseline_file_id = undefined;
        this.stale_adoption_epoch = undefined;
        this.invalidate_transport();
        this.supersede_desired();
        this.acknowledged = undefined;
        this._lifecycle = 'ready';
        return { receiverEpoch: receiver_epoch, hasSource: this.current !== undefined };
    }

    ready_epoch_is_current(receiver_epoch: number): boolean {
        return this._lifecycle !== 'disposed'
            && this.receiver_epoch === receiver_epoch
            && this.ready_gate_epoch === receiver_epoch;
    }

    /** Finish the current receiver epoch and create its initial delivery exactly once. */
    complete_ready(receiver_epoch: number): PanelReadyResult {
        if (!this.ready_epoch_is_current(receiver_epoch)) {
            return { type: 'stale', receiverEpoch: receiver_epoch };
        }
        this.ready_gate_epoch = undefined;
        if (!this.current) {
            this._lifecycle = 'ready';
            this.on_needs_initial_source?.();
            // A callback may synchronously establish a source or begin a newer epoch.
            if (this.receiver_epoch !== receiver_epoch) {
                return { type: 'stale', receiverEpoch: receiver_epoch };
            }
            return this.current
                ? { type: 'ready', receiverEpoch: receiver_epoch }
                : { type: 'needsInitialSource', receiverEpoch: receiver_epoch };
        }
        this._lifecycle = 'active';
        this.create_desired('initial', 'ready');
        return { type: 'ready', receiverEpoch: receiver_epoch };
    }

    /** Synchronous convenience used by standalone callers and legacy tests. */
    ready(): PanelReadyResult {
        const begun = this.begin_ready();
        return this.complete_ready(begun.receiverEpoch);
    }

    /**
     * Replace the adopted context. `onAccepted` runs after installation but before
     * transport or release callbacks, allowing candidate ownership to transfer
     * atomically. False means ownership remained with the caller.
     */
    replace_adoption(
        adoption: PanelAdoption | undefined,
        onAccepted?: () => void,
    ): boolean {
        if (this._lifecycle === 'disposed') return false;
        const replacement_token = ++this.replacement_token;
        const material = adoption === undefined ? undefined : capture_adoption(adoption);
        if (
            this.lifecycle === 'disposed'
            || this.replacement_token !== replacement_token
        ) {
            // The candidate was never installed. Its ownership remains entirely
            // with the caller, while any reentrant replacement/disposal stands.
            return false;
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
            : {
                adoption,
                epoch: this.adoption_epoch,
                material,
                projection: material.projection,
                stateSnapshot: captured_state_snapshot(material),
            };
        onAccepted?.();
        if (
            this.replacement_token !== replacement_token
            || this.current?.adoption !== adoption
        ) {
            // Ownership was accepted, then reentrant caller work superseded or
            // disposed it; that newer operation is responsible for release.
            return true;
        }
        const release_previous = () => {
            if (previous && previous !== adoption) this.on_adoption_released?.(previous);
        };
        if (!this.current) {
            if (this.receiver_epoch > 0) this._lifecycle = 'ready';
            release_previous();
            return true;
        }
        if (
            this.receiver_epoch === 0
            || this.ready_gate_epoch === this.receiver_epoch
        ) {
            this._lifecycle = this.receiver_epoch === 0 ? this._lifecycle : 'ready';
            release_previous();
            return true;
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
        return true;
    }

    current_adoption(): PanelAdoption | undefined {
        return this._lifecycle === 'disposed' ? undefined : this.current?.adoption;
    }

    /** Detached immutable state from the exact current acknowledged delivery. */
    acknowledged_state_snapshot(
        identity: WorkbookSnapshotIdentity,
    ): Readonly<NormalizedPerFileState> | undefined {
        if (!this.acknowledged_current()) return undefined;
        const acknowledged = this.acknowledged;
        if (!acknowledged || !identities_equal(acknowledged.snapshot.identity, identity)) {
            return undefined;
        }
        return deep_clone_and_freeze(acknowledged.snapshot.state);
    }

    /**
     * Replace only the mutable panel-state material for future snapshots. Existing
     * issued deliveries remain immutable. By default this never echoes a delivery;
     * `deliver: true` supersedes any current desired delivery and emits a refresh.
     */
    update_state_snapshot(
        stateSnapshot: Readonly<FileStateSnapshot>,
        options: { readonly deliver?: boolean } = {},
    ): boolean {
        if (this._lifecycle === 'disposed' || !this.current) return false;
        if (stateSnapshot.revision < this.current.stateSnapshot.revision) return false;
        this.current.stateSnapshot = deep_clone_and_freeze(stateSnapshot);
        if (options.deliver === true) this.deliver_material_refresh();
        return true;
    }

    /** Re-sample only configuration/capabilities from the current adoption.
     * Source/core/authority identity and generations remain unchanged, while every
     * already-issued snapshot stays immutable. */
    recapture_current_projection(
        options: { readonly deliver?: boolean } = {},
    ): boolean {
        if (this._lifecycle === 'disposed' || !this.current) return false;
        let projection: PanelAdoptionProjection;
        try {
            projection = this.current.adoption.project();
        } catch {
            return false;
        }
        this.current.projection = deep_clone_and_freeze({
            configuration: projection.configuration,
            capabilities: projection.capabilities,
        });
        if (options.deliver === true) this.deliver_material_refresh();
        return true;
    }

    /**
     * Retain a locally-originated terminal result until an exact containing ACK
     * settles it. `deliver: false` stages a committed result for the next source
     * adoption without ever attaching it to the obsolete current source.
     */
    retain_command_result(
        result: RetainedSnapshotCommandResult,
        options: { readonly deliver?: boolean } = {},
    ): void {
        if (this._lifecycle === 'disposed' || this.settled_result_ids.has(result.requestId)) {
            return;
        }
        const existing = this.retained_results.get(result.requestId);
        if (existing) return;
        this.retained_results.set(result.requestId, deep_clone_and_freeze(result));
        if (
            options.deliver === false
            || !this.current
            || this.receiver_epoch === 0
            || this.ready_gate_epoch === this.receiver_epoch
            || this.stale_adoption_epoch === this.current.epoch
            || this.desired?.commandResult !== undefined
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
        this.transport_mode = 'normal';
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
        if (issued.commandResult !== undefined) {
            const retained = this.retained_results.get(issued.commandResult.requestId);
            if (retained === issued.commandResult) {
                this.retained_results.delete(issued.commandResult.requestId);
                this.settled_result_ids.add(issued.commandResult.requestId);
                while (this.settled_result_ids.size > this.ledger_limit) {
                    const oldest = this.settled_result_ids.values().next().value;
                    if (oldest === undefined) break;
                    this.settled_result_ids.delete(oldest);
                }
            }
        }
        const adoption_epoch = issued.adoption.epoch;
        if (this.acknowledged_adoption_epoch !== adoption_epoch) {
            // Set before invoking caller code so reentrant ready/ACK handling cannot
            // duplicate the callback. A reentrant replacement resets the scalar.
            this.acknowledged_adoption_epoch = adoption_epoch;
            this.on_current_adoption_acknowledged?.(issued.adoption.adoption);
        }
        if (
            this.current === issued.adoption
            && this.retained_results.size > 0
            && issued.commandResult !== undefined
        ) {
            this.create_desired('refresh', 'excelHeader');
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
        this.ready_gate_epoch = undefined;
        this.invalidate_transport();
        const adoption = this.current?.adoption;
        this.current = undefined;
        this.desired = undefined;
        this.acknowledged = undefined;
        this.retained_results.clear();
        this.settled_result_ids.clear();
        this.acknowledged_adoption_epoch = undefined;
        this.stale_adoption_epoch = undefined;
        this.ledger.clear();
        if (adoption) this.on_adoption_released?.(adoption);
    }

    private deliver_material_refresh(): void {
        if (
            !this.current
            || this._lifecycle === 'disposed'
            || this.receiver_epoch === 0
            || this.ready_gate_epoch === this.receiver_epoch
            || this.stale_adoption_epoch === this.current.epoch
        ) return;
        this.invalidate_transport();
        this.supersede_desired();
        this.acknowledged = undefined;
        this.create_desired('refresh', 'other');
    }

    private create_desired(
        presentation: WorkbookSnapshot['presentation'],
        reason: WorkbookSnapshotReason,
    ): void {
        const adoption = this.current;
        if (!adoption || this._lifecycle === 'disposed') return;
        const live_material = adoption.adoption.resources.core.snapshot_material();
        if (this.current !== adoption || this.lifecycle === 'disposed') return;
        this.invalidate_transport();
        this.supersede_desired();
        this.retry_index = 0;
        this.transport_mode = 'normal';
        const delivery_id = this.next_delivery_id++;
        const material = adoption.material;
        const command_result = this.retained_results.values().next().value as
            RetainedSnapshotCommandResult | undefined;
        const common = {
            deliveryId: delivery_id,
            canonicalFileId: material.canonicalFileId,
            core: live_material.core,
            presentation,
            reason,
            configuration: adoption.projection.configuration,
            capabilities: adoption.projection.capabilities,
            diagnostics: live_material.diagnostics,
            commandResult: command_result,
        } as const;
        const snapshot = material.source === 'commitReceipt'
            ? build_workbook_snapshot({
                ...common,
                source: 'commitReceipt',
                receipt: {
                    ...material.receipt,
                    stateSnapshot: adoption.stateSnapshot,
                },
            })
            : build_workbook_snapshot({
                ...common,
                source: 'observed',
                authority: material.authority,
                state_snapshot: adoption.stateSnapshot,
            });
        const issued: IssuedDelivery = {
            deliveryId: delivery_id,
            receiverEpoch: this.receiver_epoch,
            adoption,
            snapshot,
            commandResult: command_result,
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
        if (this.transport_mode === 'dormant') {
            this.schedule_dormant_probe(issued);
            return;
        }
        const delay = this.backoff_ms[this.retry_index];
        if (delay === undefined) {
            this.transport_mode = 'dormant';
            this.schedule_dormant_probe(issued);
            return;
        }
        this.retry_index += 1;
        const timer_token = ++this.timer_token;
        this.timer = this.scheduler.schedule(() => {
            if (!this.timer_is_current(issued, timer_token)) return;
            this.timer = undefined;
            this.post_desired(issued);
        }, delay);
    }

    private schedule_dormant_probe(issued: IssuedDelivery): void {
        const timer_token = ++this.timer_token;
        this.timer = this.scheduler.schedule(() => {
            if (!this.timer_is_current(issued, timer_token)) return;
            this.timer = undefined;
            this.post_desired(issued);
        }, this.dormant_retry_ms);
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

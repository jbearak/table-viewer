import { describe, expect, it, vi } from 'vitest';
import type { DataSource } from '../data-source/interface';
import type { ViewerPanelCore } from '../panel-core';
import type {
    AuthorityCommitReceiptBase,
    FileAuthoritySnapshot,
} from '../file-coordinator';
import {
    PanelSession,
    type PanelAdoption,
    type PanelSessionScheduler,
} from '../panel-session';
import type { HostMessage } from '../types';
import type {
    RetainedSnapshotCommandResult,
    WorkbookSnapshot,
    WorkbookSnapshotIdentity,
} from '../viewer-snapshot';

type SnapshotMessage = Extract<HostMessage, { type: 'workbookSnapshot' }>;

interface Scheduled {
    callback: () => void;
    delay: number;
    cancelled: boolean;
}

class ManualScheduler implements PanelSessionScheduler<number> {
    readonly entries = new Map<number, Scheduled>();
    private next_id = 1;

    readonly schedule = (callback: () => void, delay: number): number => {
        const id = this.next_id++;
        this.entries.set(id, { callback, delay, cancelled: false });
        return id;
    };

    readonly clear = (id: number): void => {
        const entry = this.entries.get(id);
        if (entry) entry.cancelled = true;
    };

    pending(): Scheduled[] {
        return [...this.entries.values()].filter((entry) => !entry.cancelled);
    }

    run_next(): void {
        const item = [...this.entries.entries()].find(([, entry]) => !entry.cancelled);
        if (!item) throw new Error('No scheduled callback.');
        const [id, entry] = item;
        this.entries.delete(id);
        entry.callback();
    }
}

interface Deferred<T> {
    promise: Promise<T>;
    resolve: (value: T) => void;
    reject: (error: unknown) => void;
}

function deferred<T>(): Deferred<T> {
    let resolve!: (value: T) => void;
    let reject!: (error: unknown) => void;
    const promise = new Promise<T>((res, rej) => {
        resolve = res;
        reject = rej;
    });
    return { promise, resolve, reject };
}

function authority(revision = 3): FileAuthoritySnapshot {
    return {
        fileKey: '/book.xlsx',
        commitSequence: revision,
        authorityRevision: revision,
        physicalRevision: 2,
        projectionRevision: 1,
        physicalDigest: 'authority-digest',
    };
}

type ObservedAdoption = Extract<PanelAdoption, { source: 'observed' }>;

function adoption(overrides: Partial<ObservedAdoption> = {}): ObservedAdoption {
    return {
        source: 'observed',
        canonicalFileId: 'file:/book.xlsx',
        resources: {
            source: { close: vi.fn() } as unknown as DataSource,
            core: { dispose: vi.fn() } as unknown as ViewerPanelCore,
        },
        authority: authority(),
        stateSnapshot: { state: {}, revision: 7 },
        core: {
            generation: 5,
            sourceGeneration: 4,
            meta: {
                hasFormatting: false,
                sheets: [{
                    name: 'Sheet1',
                    rowCount: 2,
                    columnCount: 1,
                    merges: [],
                    hasFormatting: false,
                    columnNames: ['Value'],
                }],
            },
        },
        diagnostics: { truncationMessage: null },
        warnings: ['warning'],
        reason: 'fileReload',
        project: () => ({
            configuration: {
                defaultTabOrientation: 'horizontal',
                previewMode: false,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
            },
        }),
        ...overrides,
    };
}

function make_session(options: {
    responses?: Array<boolean | Promise<boolean> | Error>;
    backoffMs?: number[];
    ackTimeoutMs?: number;
    onNeedsInitialSource?: () => void;
    onNeedsResyncSource?: (value: PanelAdoption) => void;
    onCurrentAdoptionAcknowledged?: (value: PanelAdoption) => void;
    onAdoptionReleased?: (value: PanelAdoption) => void;
} = {}) {
    const scheduler = new ManualScheduler();
    const posted: SnapshotMessage[] = [];
    const responses = [...(options.responses ?? [])];
    const post = vi.fn((message: SnapshotMessage): boolean | Promise<boolean> => {
        posted.push(message);
        const response = responses.shift() ?? true;
        if (response instanceof Error) throw response;
        return response;
    });
    const session = new PanelSession<number>({
        postMessage: post,
        scheduler,
        backoffMs: options.backoffMs ?? [25, 50, 100, 200],
        ackTimeoutMs: options.ackTimeoutMs ?? 500,
        onNeedsInitialSource: options.onNeedsInitialSource,
        onNeedsResyncSource: options.onNeedsResyncSource,
        onCurrentAdoptionAcknowledged: options.onCurrentAdoptionAcknowledged,
        onAdoptionReleased: options.onAdoptionReleased,
    });
    return { session, scheduler, posted, post, responses };
}

async function settle(): Promise<void> {
    await Promise.resolve();
    await Promise.resolve();
}

function snapshot(messages: SnapshotMessage[], index = -1): WorkbookSnapshot {
    return messages.at(index)!.snapshot;
}

function ack(
    session: PanelSession<number>,
    delivered: WorkbookSnapshot,
    disposition: 'applied' | 'duplicate' | 'stale' = 'applied',
): void {
    session.handle_snapshot_applied(delivered.identity, disposition);
}

describe('PanelSession lifecycle and reliable snapshot transport', () => {
    it('does not post before ready and activates when a missing initial source arrives', async () => {
        const needs = vi.fn();
        const { session, posted } = make_session({ onNeedsInitialSource: needs });
        session.replace_adoption(adoption());
        expect(posted).toHaveLength(0);

        const empty = make_session({ onNeedsInitialSource: needs });
        expect(empty.session.ready()).toEqual({ type: 'needsInitialSource', receiverEpoch: 1 });
        expect(empty.session.lifecycle).toBe('ready');
        expect(needs).toHaveBeenCalledOnce();
        empty.session.replace_adoption(adoption());
        await settle();
        expect(empty.posted).toHaveLength(1);
        expect(snapshot(empty.posted).presentation).toBe('initial');
        expect(snapshot(empty.posted).reason).toBe('fileReload');
        expect(empty.session.lifecycle).toBe('active');
    });

    it('returns ready when the initial-source callback installs synchronously', async () => {
        const source = adoption();
        const needs = vi.fn();
        let session_ref!: PanelSession<number>;
        const created = make_session({
            onNeedsInitialSource: () => {
                needs();
                session_ref.replace_adoption(source);
            },
        });
        session_ref = created.session;
        expect(created.session.ready()).toEqual({ type: 'ready', receiverEpoch: 1 });
        await settle();
        expect(needs).toHaveBeenCalledOnce();
        expect(created.posted).toHaveLength(1);
        expect(snapshot(created.posted).presentation).toBe('initial');
        expect(created.session.current_adoption()).toBe(source);
        expect(created.session.lifecycle).toBe('active');
    });

    it('keeps distinct epochs when initial-source handling reenters ready', async () => {
        const source = adoption();
        let session_ref!: PanelSession<number>;
        let callback_count = 0;
        let inner_result: ReturnType<PanelSession<number>['ready']> | undefined;
        const created = make_session({
            onNeedsInitialSource: () => {
                callback_count += 1;
                if (callback_count === 1) {
                    inner_result = session_ref.ready();
                } else {
                    session_ref.replace_adoption(source);
                }
            },
        });
        session_ref = created.session;
        const outer_result = created.session.ready();
        await settle();
        expect(outer_result).toEqual({ type: 'stale', receiverEpoch: 1 });
        expect(inner_result).toEqual({ type: 'ready', receiverEpoch: 2 });
        expect(created.posted).toHaveLength(1);
        expect(created.session.lifecycle).toBe('active');
        expect(created.session.current_adoption()).toBe(source);
    });

    it('posts an initial snapshot on ready and restarts each receiver epoch', async () => {
        const { session, posted, scheduler } = make_session();
        const source = adoption();
        session.replace_adoption(source);
        expect(session.ready()).toEqual({ type: 'ready', receiverEpoch: 1 });
        await settle();
        const first = snapshot(posted);
        expect(first.presentation).toBe('initial');
        expect(first.reason).toBe('ready');
        expect(session.lifecycle).toBe('active');
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([500]);

        session.ready();
        await settle();
        const second = snapshot(posted);
        expect(second.identity.deliveryId).toBeGreaterThan(first.identity.deliveryId);
        expect(second.generation).toBe(first.generation);
        expect(second.sourceGeneration).toBe(first.sourceGeneration);
        expect(scheduler.pending()).toHaveLength(1);
    });

    it.each([
        ['false', () => false],
        ['rejection', () => Promise.reject(new Error('rejected'))],
        ['synchronous throw', () => new Error('thrown')],
    ])('retries the exact frozen object after %s', async (_name, make_response) => {
        const { session, posted, scheduler } = make_session({ responses: [make_response(), true] });
        session.replace_adoption(adoption());
        session.ready();
        await settle();
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([25]);
        const first = snapshot(posted);
        scheduler.run_next();
        await settle();
        expect(snapshot(posted)).toBe(first);
        expect(snapshot(posted).identity.deliveryId).toBe(first.identity.deliveryId);
        expect(Object.isFrozen(first)).toBe(true);
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([500]);
    });

    it('times out a still-pending post and fences its late completion', async () => {
        const pending = deferred<boolean>();
        const { session, posted, scheduler } = make_session({
            responses: [pending.promise, true],
            backoffMs: [15],
            ackTimeoutMs: 100,
        });
        session.replace_adoption(adoption());
        session.ready();
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([100]);
        const original = snapshot(posted);
        scheduler.run_next();
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([15]);
        scheduler.run_next();
        await settle();
        expect(snapshot(posted)).toBe(original);
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([100]);
        pending.resolve(true);
        await settle();
        expect(scheduler.pending().map(({ delay }) => delay)).toEqual([100]);
    });

    it('retransmits after a lost ACK, exhausts into dormancy, and wakes a new burst', async () => {
        const { session, posted, scheduler } = make_session({
            responses: [true, true, false, false],
            backoffMs: [10, 20],
            ackTimeoutMs: 100,
        });
        session.replace_adoption(adoption());
        session.ready();
        await settle();
        const original = snapshot(posted);
        expect(scheduler.pending()[0].delay).toBe(100);

        scheduler.run_next(); // ACK timeout
        expect(scheduler.pending()[0].delay).toBe(10);
        scheduler.run_next(); // retransmit true
        await settle();
        expect(snapshot(posted)).toBe(original);
        scheduler.run_next(); // second ACK timeout
        expect(scheduler.pending()[0].delay).toBe(20);
        scheduler.run_next(); // false, burst exhausted
        await settle();
        expect(scheduler.pending()).toHaveLength(0);

        session.wake_delivery();
        await settle();
        expect(snapshot(posted)).toBe(original);
        expect(scheduler.pending()[0].delay).toBe(10);
    });

    it.each(['applied', 'duplicate'] as const)(
        'accepts an exact current %s ACK idempotently',
        async (disposition) => {
            const warned = vi.fn();
            const { session, posted, scheduler } = make_session({
                onCurrentAdoptionAcknowledged: warned,
            });
            const source = adoption();
            session.replace_adoption(source);
            session.ready();
            await settle();
            const delivered = snapshot(posted);
            ack(session, delivered, disposition);
            expect(session.acknowledged_current()).toBe(true);
            expect(session.acknowledged_identity()).toBe(delivered.identity);
            expect(session.acknowledged_physical_digest()).toBe('authority-digest');
            expect(warned).toHaveBeenCalledOnce();
            expect(warned).toHaveBeenCalledWith(source);
            expect(scheduler.pending()).toHaveLength(0);
            ack(session, delivered, disposition);
            session.handle_snapshot_applied(delivered.identity, 'stale');
            expect(warned).toHaveBeenCalledOnce();
            expect(posted).toHaveLength(1);
            expect(session.acknowledged_current()).toBe(true);
        },
    );

    it('ignores fabricated identities and resyncs a stale current ACK', async () => {
        const warned = vi.fn();
        const resync_needed = vi.fn();
        const source = adoption();
        const { session, posted } = make_session({
            onCurrentAdoptionAcknowledged: warned,
            onNeedsResyncSource: resync_needed,
        });
        session.replace_adoption(source);
        session.ready();
        await settle();
        const first = snapshot(posted);
        const fabricated: WorkbookSnapshotIdentity = {
            ...first.identity,
            stateRevision: first.identity.stateRevision + 1,
        };
        session.handle_snapshot_applied(fabricated, 'applied');
        expect(session.acknowledged_current()).toBe(false);
        expect(posted).toHaveLength(1);

        ack(session, first, 'stale');
        await settle();
        expect(posted).toHaveLength(1);
        expect(resync_needed).toHaveBeenCalledOnce();
        expect(resync_needed).toHaveBeenCalledWith(source);
        session.wake_delivery();
        await settle();
        expect(posted).toHaveLength(1);
        const refreshed = adoption({ authority: authority(4) });
        session.replace_adoption(refreshed);
        await settle();
        expect(posted).toHaveLength(2);
        const resync = snapshot(posted);
        expect(resync.identity.deliveryId).not.toBe(first.identity.deliveryId);
        expect(resync.generation).toBe(first.generation);
        expect(resync.sourceGeneration).toBe(first.sourceGeneration);
        expect(resync.reason).toBe('fileReload');
        expect(resync.presentation).toBe('refresh');
        expect(session.acknowledged_current()).toBe(false);
        expect(warned).not.toHaveBeenCalled();
    });

    it('makes old ACKs and late post completions inert after supersession', async () => {
        const old_post = deferred<boolean>();
        const warned = vi.fn();
        const { session, posted, scheduler } = make_session({
            responses: [old_post.promise, true],
            onCurrentAdoptionAcknowledged: warned,
        });
        session.replace_adoption(adoption());
        session.ready();
        const first = snapshot(posted);
        const newer = adoption({
            canonicalFileId: 'file:/new.xlsx',
            authority: {
                ...authority(4),
                fileKey: '/new.xlsx',
                physicalDigest: 'new-digest',
            },
        });
        session.replace_adoption(newer);
        await settle();
        const second = snapshot(posted);
        expect(second.identity.deliveryId).toBeGreaterThan(first.identity.deliveryId);
        expect(second.presentation).toBe('initial');
        expect(scheduler.pending()).toHaveLength(1);

        ack(session, first);
        expect(session.acknowledged_current()).toBe(false);
        expect(warned).not.toHaveBeenCalled();
        ack(session, second);
        expect(session.acknowledged_current()).toBe(true);
        expect(session.acknowledged_physical_digest()).toBe('new-digest');
        expect(scheduler.pending()).toHaveLength(0);
        old_post.resolve(true);
        await settle();
        expect(scheduler.pending()).toHaveLength(0);
        expect(posted).toHaveLength(2);
        expect(session.acknowledged_current()).toBe(true);
    });

    it('does not resurrect a session disposed reentrantly during adoption capture', () => {
        const released = vi.fn();
        const { session, posted } = make_session({ onAdoptionReleased: released });
        const projection = adoption().project();
        const candidate = adoption({
            project: () => {
                session.dispose();
                return projection;
            },
        });
        const accepted = vi.fn();

        expect(session.replace_adoption(candidate, accepted)).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
        expect(session.lifecycle).toBe('disposed');
        expect(session.current_adoption()).toBeUndefined();
        expect(posted).toHaveLength(0);
        // The candidate was never installed, so the caller still owns it.
        expect(released).not.toHaveBeenCalled();
    });

    it('disposal during replacement capture releases only the installed adoption', async () => {
        const released = vi.fn();
        const { session, posted, scheduler } = make_session({ onAdoptionReleased: released });
        const installed = adoption();
        session.replace_adoption(installed);
        session.ready();
        await settle();
        const projection = adoption().project();
        const candidate = adoption({
            project: () => {
                session.dispose();
                return projection;
            },
        });
        const accepted = vi.fn();

        expect(session.replace_adoption(candidate, accepted)).toBe(false);
        expect(accepted).not.toHaveBeenCalled();
        expect(session.lifecycle).toBe('disposed');
        expect(session.current_adoption()).toBeUndefined();
        expect(posted).toHaveLength(1);
        expect(scheduler.pending()).toHaveLength(0);
        expect(released).toHaveBeenCalledTimes(1);
        expect(released).toHaveBeenCalledWith(installed);
        expect(released).not.toHaveBeenCalledWith(candidate);
    });

    it('does not let an outer capture overwrite a reentrant newer adoption', async () => {
        const released = vi.fn();
        const { session, posted } = make_session({ onAdoptionReleased: released });
        const installed = adoption();
        const newer = adoption({ authority: authority(5) });
        const projection = adoption().project();
        const older = adoption({
            authority: authority(4),
            project: () => {
                session.replace_adoption(newer);
                return projection;
            },
        });
        session.replace_adoption(installed);
        session.ready();
        await settle();

        session.replace_adoption(older);
        await settle();
        expect(session.current_adoption()).toBe(newer);
        expect(session.lifecycle).toBe('active');
        expect(posted).toHaveLength(2);
        expect(snapshot(posted).identity.authority.revision).toBe(5);
        expect(released).toHaveBeenCalledTimes(1);
        expect(released).toHaveBeenCalledWith(installed);
        expect(released).not.toHaveBeenCalledWith(older);
        expect(released).not.toHaveBeenCalledWith(newer);
        ack(session, snapshot(posted));
        expect(session.acknowledged_current()).toBe(true);
    });

    it('keeps replacement state coherent when old-adoption release throws', async () => {
        const release_error = new Error('release failed');
        const released = vi.fn(() => { throw release_error; });
        const { session, posted } = make_session({ onAdoptionReleased: released });
        const first = adoption();
        const second = adoption({
            canonicalFileId: 'file:/replacement.xlsx',
            authority: { ...authority(4), fileKey: '/replacement.xlsx' },
        });
        session.replace_adoption(first);
        session.ready();
        await settle();
        expect(() => session.replace_adoption(second)).toThrow(release_error);
        expect(released).toHaveBeenCalledWith(first);
        expect(session.current_adoption()).toBe(second);
        expect(session.lifecycle).toBe('active');
        expect(posted).toHaveLength(2);
        await settle();
        ack(session, snapshot(posted));
        expect(session.acknowledged_current()).toBe(true);
    });

    it('retains a command result across failures, dormancy, and adoption', async () => {
        const result: RetainedSnapshotCommandResult = {
            type: 'excelFirstRowHeader',
            requestId: 'header:1',
            outcome: 'recovered',
            error: 'Recovered.',
        };
        const { session, posted, scheduler } = make_session({
            responses: [false, false, true],
            backoffMs: [5],
        });
        session.replace_adoption(adoption());
        session.retain_command_result(result);
        session.ready();
        await settle();
        const first = snapshot(posted);
        expect(first.commandResult).toEqual(result);
        scheduler.run_next();
        await settle();
        expect(snapshot(posted)).toBe(first);
        expect(scheduler.pending()).toHaveLength(0);

        session.replace_adoption(adoption({
            authority: authority(4),
        }));
        await settle();
        expect(snapshot(posted).commandResult).toEqual(result);
    });

    it('retains a new result without waking a known-stale adoption', async () => {
        const result: RetainedSnapshotCommandResult = {
            type: 'excelFirstRowHeader',
            requestId: 'header:stale',
            outcome: 'recovered',
        };
        const { session, posted } = make_session();
        session.replace_adoption(adoption());
        session.ready();
        await settle();
        ack(session, snapshot(posted), 'stale');
        session.retain_command_result(result);
        session.wake_delivery();
        await settle();
        expect(posted).toHaveLength(1);
        session.replace_adoption(adoption({ authority: authority(4) }));
        await settle();
        expect(posted).toHaveLength(2);
        expect(snapshot(posted).commandResult).toEqual(result);
    });

    it.each(['applied', 'duplicate'] as const)(
        'creates result-only delivery and clears it on a matching current %s ACK',
        async (disposition) => {
            const { session, posted } = make_session();
            session.replace_adoption(adoption());
            session.ready();
            await settle();
            const base = snapshot(posted);
            ack(session, base);
            const result: RetainedSnapshotCommandResult = {
                type: 'excelFirstRowHeader',
                requestId: 'header:2',
                outcome: 'applied',
            };
            session.retain_command_result(result);
            await settle();
            const with_result = snapshot(posted);
            expect(with_result.identity.deliveryId).toBeGreaterThan(base.identity.deliveryId);
            expect(with_result.generation).toBe(base.generation);
            expect(with_result.commandResult).toEqual(result);
            expect(session.acknowledged_current()).toBe(false);

            ack(session, base, 'duplicate');
            expect(session.acknowledged_current()).toBe(false);
            ack(session, with_result, disposition);
            session.ready();
            await settle();
            expect(snapshot(posted).commandResult).toBeUndefined();
        },
    );

    it('calls the acknowledgement hook once per adoption, not per receiver', async () => {
        const warned = vi.fn();
        const { session, posted } = make_session({ onCurrentAdoptionAcknowledged: warned });
        const source = adoption();
        session.replace_adoption(source);
        session.ready();
        await settle();
        ack(session, snapshot(posted));
        session.ready();
        await settle();
        ack(session, snapshot(posted), 'duplicate');
        expect(warned).toHaveBeenCalledOnce();

        const next = adoption({ authority: authority(4) });
        session.replace_adoption(next);
        await settle();
        ack(session, snapshot(posted));
        expect(warned).toHaveBeenCalledTimes(2);
        expect(warned).toHaveBeenLastCalledWith(next);
    });

    it('sets adoption acknowledgement before a reentrant receiver restart', async () => {
        let session_ref!: PanelSession<number>;
        let posted_ref!: SnapshotMessage[];
        const warned = vi.fn(() => {
            session_ref.ready();
            ack(session_ref, snapshot(posted_ref), 'duplicate');
        });
        const created = make_session({ onCurrentAdoptionAcknowledged: warned });
        session_ref = created.session;
        posted_ref = created.posted;
        session_ref.replace_adoption(adoption());
        session_ref.ready();
        await settle();

        ack(session_ref, snapshot(posted_ref));
        expect(warned).toHaveBeenCalledOnce();
        expect(posted_ref).toHaveLength(2);
        expect(session_ref.acknowledged_current()).toBe(true);
    });

    it('bounds acknowledgement state across many adoptions and receiver restarts', async () => {
        const warned = vi.fn();
        const { session, posted } = make_session({ onCurrentAdoptionAcknowledged: warned });
        session.ready();
        const adoption_count = 1_000;
        for (let index = 0; index < adoption_count; index += 1) {
            session.replace_adoption(adoption({ authority: authority(index + 1) }));
            ack(session, snapshot(posted));
        }
        expect(warned).toHaveBeenCalledTimes(adoption_count);

        const current = session.current_adoption();
        for (let index = 0; index < 100; index += 1) {
            session.ready();
            ack(session, snapshot(posted), 'duplicate');
        }
        await settle();
        expect(session.current_adoption()).toBe(current);
        expect(session.acknowledged_current()).toBe(true);
        expect(warned).toHaveBeenCalledTimes(adoption_count);
    });

    it('exposes exact current adoption and invalidates save APIs for newer desired work', async () => {
        const { session, posted } = make_session();
        const source = adoption();
        session.replace_adoption(source);
        expect(session.current_adoption()).toBe(source);
        session.ready();
        await settle();
        ack(session, snapshot(posted));
        expect(session.acknowledged_current()).toBe(true);

        session.retain_command_result({
            type: 'excelFirstRowHeader',
            requestId: 'newer',
            outcome: 'applied',
        });
        expect(session.acknowledged_current()).toBe(false);
        expect(session.acknowledged_identity()).toBeUndefined();
        expect(session.acknowledged_physical_digest()).toBeUndefined();
    });

    it('derives committed authority, state, and digest from one receipt', async () => {
        const stateSnapshot = { state: {}, revision: 29 };
        const resultingBasis = {
            ...authority(9),
            physicalRevision: 6,
            projectionRevision: 3,
            physicalDigest: 'receipt-digest',
        };
        const receipt: AuthorityCommitReceiptBase = {
            operationKind: 'projection',
            operationOrdinal: 8,
            previousBasis: authority(8),
            resultingBasis,
            stateSnapshot,
        };
        const base = adoption();
        const committed: PanelAdoption = {
            source: 'commitReceipt',
            receipt,
            canonicalFileId: base.canonicalFileId,
            resources: base.resources,
            core: base.core,
            diagnostics: base.diagnostics,
            warnings: base.warnings,
            reason: base.reason,
            project: base.project,
        };
        const { session, posted } = make_session();
        session.replace_adoption(committed);
        stateSnapshot.revision = 99;
        resultingBasis.authorityRevision = 99;
        session.ready();
        await settle();
        const delivered = snapshot(posted);
        expect(delivered.identity).toMatchObject({
            authority: { revision: 9 },
            stateRevision: 29,
            sourceBasis: { physicalRevision: 6, projectionRevision: 3 },
        });
        ack(session, delivered);
        expect(session.acknowledged_physical_digest()).toBe('receipt-digest');
    });

    it('disposes synchronously, cancels timers, releases ownership, and ignores late work', async () => {
        const pending = deferred<boolean>();
        const released = vi.fn();
        const warned = vi.fn();
        const { session, posted, scheduler } = make_session({
            responses: [pending.promise],
            onAdoptionReleased: released,
            onCurrentAdoptionAcknowledged: warned,
        });
        const source = adoption();
        session.replace_adoption(source);
        session.ready();
        const delivered = snapshot(posted);
        expect(scheduler.pending()).toHaveLength(1);
        session.dispose();
        expect(session.lifecycle).toBe('disposed');
        expect(session.current_adoption()).toBeUndefined();
        expect(session.acknowledged_current()).toBe(false);
        expect(scheduler.pending()).toHaveLength(0);
        expect(released).toHaveBeenCalledOnce();
        expect(released).toHaveBeenCalledWith(source);

        pending.resolve(true);
        await settle();
        ack(session, delivered);
        session.wake_delivery();
        session.retain_command_result({
            type: 'excelFirstRowHeader', requestId: 'late', outcome: 'applied',
        });
        session.replace_adoption(adoption());
        expect(posted).toHaveLength(1);
        expect(warned).not.toHaveBeenCalled();
    });

    it('begin_ready immediately cancels old transport while state preparation is gated', async () => {
        const old_post = deferred<boolean>();
        const { session, posted, scheduler } = make_session({
            responses: [old_post.promise, true],
        });
        session.replace_adoption(adoption());
        session.ready();
        const old = snapshot(posted);
        expect(scheduler.pending()).toHaveLength(1);

        const begun = session.begin_ready();
        expect(begun.hasSource).toBe(true);
        expect(scheduler.pending()).toHaveLength(0);
        expect(session.update_state_snapshot({
            revision: 8,
            state: { columnWidths: [{ 0: 151 }] },
        })).toBe(true);
        old_post.resolve(true);
        await settle();
        expect(posted).toHaveLength(1);
        expect(scheduler.pending()).toHaveLength(0);

        expect(session.complete_ready(begun.receiverEpoch)).toEqual({
            type: 'ready', receiverEpoch: begun.receiverEpoch,
        });
        await settle();
        const fresh = snapshot(posted);
        expect(posted).toHaveLength(2);
        expect(fresh.identity.deliveryId).toBeGreaterThan(old.identity.deliveryId);
        expect(fresh.identity.stateRevision).toBe(8);
        expect(fresh.state.columnWidths).toEqual([{ 0: 151 }]);
    });

    it('only completes the newest of two overlapping ready epochs', async () => {
        const { session, posted } = make_session();
        session.replace_adoption(adoption());
        const older = session.begin_ready();
        const newer = session.begin_ready();
        session.update_state_snapshot({ revision: 9, state: { rowHeights: [{ 0: 33 }] } });

        expect(session.complete_ready(older.receiverEpoch)).toEqual({
            type: 'stale', receiverEpoch: older.receiverEpoch,
        });
        expect(posted).toHaveLength(0);
        expect(session.complete_ready(newer.receiverEpoch)).toEqual({
            type: 'ready', receiverEpoch: newer.receiverEpoch,
        });
        await settle();
        expect(snapshot(posted).identity.stateRevision).toBe(9);
    });

    it('makes completion inert after disposal during ready preparation', () => {
        const { session, posted } = make_session();
        session.replace_adoption(adoption());
        const begun = session.begin_ready();
        session.dispose();

        expect(session.complete_ready(begun.receiverEpoch)).toEqual({
            type: 'stale', receiverEpoch: begun.receiverEpoch,
        });
        expect(posted).toHaveLength(0);
    });

    it('completes a ready gate against a replacement adopted during the read', async () => {
        const { session, posted } = make_session();
        session.replace_adoption(adoption());
        const begun = session.begin_ready();
        session.replace_adoption(adoption({ authority: authority(4) }));
        session.update_state_snapshot({ revision: 10, state: { activeSheetIndex: 0 } });
        expect(posted).toHaveLength(0);

        expect(session.complete_ready(begun.receiverEpoch).type).toBe('ready');
        await settle();
        expect(snapshot(posted).identity).toMatchObject({
            authority: { revision: 4 },
            stateRevision: 10,
        });
    });

    it('updates only future snapshot state without mutating or echoing issued work', async () => {
        const { session, posted } = make_session();
        session.replace_adoption(adoption());
        session.ready();
        await settle();
        const issued = snapshot(posted);

        expect(session.update_state_snapshot({
            revision: 8,
            state: { columnWidths: [{ 0: 144 }], activeSheetIndex: 0 },
        })).toBe(true);
        expect(posted).toHaveLength(1);
        expect(session.update_state_snapshot({ revision: 6, state: {} })).toBe(false);
        expect(issued.identity.stateRevision).toBe(7);
        expect(issued.state.columnWidths).toEqual([]);

        session.ready();
        await settle();
        const replay = snapshot(posted);
        expect(replay.identity.stateRevision).toBe(8);
        expect(replay.state.columnWidths).toEqual([{ 0: 144 }]);
        expect(replay.generation).toBe(issued.generation);
        expect(replay.sourceGeneration).toBe(issued.sourceGeneration);
        expect(replay.identity.sourceBasis).toEqual(issued.identity.sourceBasis);
        expect(issued.identity.stateRevision).toBe(7);
        expect(issued.state.columnWidths).toEqual([]);
    });

    it('isolates the immutable snapshot from later input mutation', async () => {
        const source = adoption();
        const mutable_state = source.stateSnapshot.state as { pendingEdits?: Record<string, string> };
        mutable_state.pendingEdits = { '0:0': 'Ada' };
        const mutable_meta = source.core.meta;
        const projection = {
            configuration: {
                defaultTabOrientation: 'horizontal' as const,
                previewMode: false,
            },
            capabilities: {
                csvEditable: false,
                csvEditingSupported: false,
            },
        };
        const mutable = adoption({ ...source, project: () => projection });
        const { session, posted } = make_session();
        session.replace_adoption(mutable);
        mutable_meta.sheets[0].name = 'Changed before ready';
        mutable_state.pendingEdits['0:0'] = 'Grace';
        projection.configuration.previewMode = true;
        projection.capabilities.csvEditable = true;
        session.ready();
        await settle();
        const delivered = snapshot(posted);
        expect(delivered.meta.sheets[0].name).toBe('Sheet1');
        expect(delivered.state.pendingEdits).toEqual({ '0:0': 'Ada' });
        expect(delivered.configuration.previewMode).toBe(false);
        expect(delivered.capabilities.csvEditable).toBe(false);
        expect(Object.isFrozen(delivered.meta.sheets[0])).toBe(true);

        mutable_meta.sheets[0].name = 'Changed before restart';
        mutable_state.pendingEdits['0:0'] = 'Katherine';
        session.ready();
        await settle();
        const restarted = snapshot(posted);
        expect(restarted.meta.sheets[0].name).toBe('Sheet1');
        expect(restarted.state.pendingEdits).toEqual({ '0:0': 'Ada' });
    });
});

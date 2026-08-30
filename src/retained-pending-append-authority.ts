import type { PendingAppendBasis, PendingRowFormatTemplate } from './pending-changes';

export interface RetainedPendingAppendAuthorityInput {
    readonly formatTemplate: PendingRowFormatTemplate;
    readonly formatTemplateId: string;
    readonly appendBasis?: PendingAppendBasis;
    readonly sourceGeneration: number;
}

export interface RetainedPendingAppendAuthority
    extends RetainedPendingAppendAuthorityInput {
    readonly byteCost: number;
}

/**
 * Bounded host authority for unsaved rows that are reachable only from history.
 *
 * Each row owns just the one format template named by its capability. Keeping
 * the cache here, rather than copying an admission ledger's complete template
 * map into every row, makes both that invariant and the aggregate byte bound
 * independently testable.
 */
export class RetainedPendingAppendAuthorityStore {
    private readonly authorities = new Map<
        string,
        Map<string, RetainedPendingAppendAuthority>
    >();
    private retained_bytes = 0;

    public constructor(private readonly max_bytes: number) {}

    public get byte_count(): number {
        return this.retained_bytes;
    }

    public get row_count(): number {
        let count = 0;
        for (const rows of this.authorities.values()) count += rows.size;
        return count;
    }

    public get(
        target_key: string,
        row_id: string,
    ): RetainedPendingAppendAuthority | undefined {
        return this.authorities.get(target_key)?.get(row_id);
    }

    public entries(): IterableIterator<[
        string,
        Map<string, RetainedPendingAppendAuthority>,
    ]> {
        return this.authorities.entries();
    }

    public forget(target_key: string, row_id: string): void {
        const rows = this.authorities.get(target_key);
        const prior = rows?.get(row_id);
        if (prior === undefined) return;
        rows!.delete(row_id);
        this.retained_bytes -= prior.byteCost;
        if (rows!.size === 0) this.authorities.delete(target_key);
    }

    public remember(
        target_key: string,
        row_id: string,
        authority: RetainedPendingAppendAuthorityInput,
    ): boolean {
        const owned = Object.freeze({
            ...authority,
            byteCost: Buffer.byteLength(JSON.stringify({ row_id, ...authority }), 'utf8') + 256,
        });
        if (owned.byteCost > this.max_bytes) return false;

        const rows = this.authorities.get(target_key)
            ?? new Map<string, RetainedPendingAppendAuthority>();
        const prior = rows.get(row_id);
        if (prior !== undefined) {
            rows.delete(row_id);
            this.retained_bytes -= prior.byteCost;
        }
        // A successful re-remember is a fresh use of the target and row. Move
        // both map keys to the end so eviction remains recency-ordered.
        this.authorities.delete(target_key);
        rows.set(row_id, owned);
        this.authorities.set(target_key, rows);
        this.retained_bytes += owned.byteCost;

        while (this.retained_bytes > this.max_bytes) {
            const first_target = this.authorities.entries().next().value as
                | [string, Map<string, RetainedPendingAppendAuthority>]
                | undefined;
            const first_row = first_target?.[1].keys().next().value as string | undefined;
            if (first_target === undefined || first_row === undefined) break;
            this.forget(first_target[0], first_row);
        }
        return this.get(target_key, row_id) !== undefined;
    }
}

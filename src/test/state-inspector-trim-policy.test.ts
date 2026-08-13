import { describe, expect, it } from 'vitest';
import {
    format_bytes,
    pending_edit_confirmation,
    trim_confirmation,
    trim_outcome_message,
} from '../state-inspector/trim-policy';
import type {
    StateInspectorPreview,
    StateInspectorTrimSummary,
} from '../state-inspector/protocol';

function preview(overrides: Partial<StateInspectorPreview> = {}): StateInspectorPreview {
    return {
        selection: { kind: 'paths', paths: ['/files/a.csv'] },
        targetPaths: ['/files/a.csv'],
        totalSizeBytes: 2048,
        pendingEditPaths: [],
        protectedPaths: [],
        ...overrides,
    };
}

describe('formatting sizes', () => {
    it('scales through the units and keeps small numbers readable', () => {
        expect(format_bytes(0)).toBe('0 B');
        expect(format_bytes(999)).toBe('999 B');
        expect(format_bytes(2048)).toBe('2.0 KB');
        expect(format_bytes(15 * 1024)).toBe('15 KB');
        expect(format_bytes(5.5 * 1024 * 1024)).toBe('5.5 MB');
        expect(format_bytes(3 * 1024 ** 3)).toBe('3.0 GB');
    });

    it('refuses to invent a size it does not have', () => {
        expect(format_bytes(Number.NaN)).toBe('—');
        expect(format_bytes(-1)).toBe('—');
    });
});

describe('the first confirmation', () => {
    it('states the count and the space, and that files are untouched', () => {
        const confirmation = trim_confirmation(preview({
            targetPaths: ['/a.csv', '/b.csv'],
            totalSizeBytes: 4096,
        }))!;

        expect(confirmation.title).toBe('Clear stored state for 2 files?');
        expect(confirmation.message).toContain('4.0 KB');
        expect(confirmation.message).toContain('not deleted, moved, or changed');
        expect(confirmation.destructive).toBe(false);
    });

    it('warns up front about entries it will have to keep', () => {
        const confirmation = trim_confirmation(preview({
            protectedPaths: ['/open.csv'],
        }))!;

        expect(confirmation.message).toContain('1 entry will be kept because it is open right now');
    });

    it('is absent when nothing matched, so no empty dialog can open', () => {
        expect(trim_confirmation(preview({ targetPaths: [] }))).toBeUndefined();
    });
});

describe('the unsaved-edits confirmation', () => {
    it('is absent when no target holds unsaved work', () => {
        expect(pending_edit_confirmation(preview())).toBeUndefined();
    });

    it('names every affected file rather than counting them', () => {
        const confirmation = pending_edit_confirmation(preview({
            pendingEditPaths: ['/one.csv', '/two.csv'],
        }))!;

        expect(confirmation.affectedFiles).toEqual(['/one.csv', '/two.csv']);
        expect(confirmation.destructive).toBe(true);
        expect(confirmation.message).toContain('holding the only copy');
        expect(confirmation.message).toContain('cannot be undone');
    });

    it('depends on the targets, not on which action produced them', () => {
        // The same targets must escalate identically whether they came from a
        // hand-picked selection or from "clear everything".
        const pendingEditPaths = ['/unsaved.csv'];
        const bulk = pending_edit_confirmation(
            preview({ selection: { kind: 'missingOnDisk' }, pendingEditPaths }),
        );
        const manual = pending_edit_confirmation(preview({
            selection: { kind: 'paths', paths: pendingEditPaths },
            pendingEditPaths,
        }));

        expect(bulk).toEqual(manual);
    });
});

describe('reporting the outcome', () => {
    const base: StateInspectorTrimSummary = {
        deletedCount: 3,
        skippedProtectedCount: 0,
        skippedUnconfirmedCount: 0,
        vacuum: 'vacuumed',
        reclaimedBytes: 4096,
    };

    it('reports what was deleted and what came back', () => {
        expect(trim_outcome_message(base))
            .toBe('Cleared stored state for 3 files. Reclaimed 4.0 KB of disk space.');
    });

    it('treats a busy vacuum as a delay rather than a failure', () => {
        expect(trim_outcome_message({ ...base, vacuum: 'deferred', reclaimedBytes: 0 }))
            .toContain('will be reclaimed once other windows using this database close');
    });

    it('reports a failed vacuum without disowning the deletions', () => {
        expect(trim_outcome_message({ ...base, vacuum: 'failed', reclaimedBytes: 0 }))
            .toBe('Cleared stored state for 3 files. Disk space could not be reclaimed yet; it will be recovered by a later cleanup.');
    });

    it('explains an empty result by what protected it', () => {
        expect(trim_outcome_message({ ...base, deletedCount: 0, skippedProtectedCount: 2 }))
            .toBe('Nothing was cleared — every matching entry is currently open.');
        expect(trim_outcome_message({ ...base, deletedCount: 0 })).toBe('Nothing was cleared.');
    });

    it('accounts for entries it had to keep', () => {
        const message = trim_outcome_message({
            ...base,
            skippedProtectedCount: 1,
            skippedUnconfirmedCount: 2,
        });

        expect(message).toContain('1 entry kept because it is open');
        expect(message).toContain('2 entries kept because of unsaved changes');
    });
});

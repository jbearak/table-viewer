/**
 * What the user is told before anything is deleted.
 *
 * Pure functions over an already-resolved preview, in the same shape as the
 * state-recovery dialog: no DOM, no `electron`, no `vscode`, so the wording and
 * the escalation rules can be tested directly instead of through a window.
 *
 * The important property is that the second confirmation is decided by the
 * *targets*, never by which button the user pressed. "Clear everything" and a
 * hand-picked selection reach the same gate, so no bulk path can quietly skip
 * the warning that a hand-picked one would have shown.
 */
import type { StateInspectorPreview, StateInspectorTrimSummary } from './protocol';

export interface TrimConfirmation {
    readonly title: string;
    readonly message: string;
    readonly confirmLabel: string;
    /** Listed verbatim so the user sees exactly which work they are discarding. */
    readonly affectedFiles: readonly string[];
    /** True for the unsaved-edits step, which is the one that destroys work. */
    readonly destructive: boolean;
}

export function format_bytes(bytes: number): string {
    if (!Number.isFinite(bytes) || bytes < 0) return '—';
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB', 'TB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

function plural(count: number, singular: string, plural_form = `${singular}s`): string {
    return `${count} ${count === 1 ? singular : plural_form}`;
}

/**
 * The first confirmation: how much is going, and what will be left behind.
 *
 * Returns undefined when there is nothing to confirm, so the caller can say
 * "nothing matched" rather than opening an empty dialog.
 */
export function trim_confirmation(preview: StateInspectorPreview): TrimConfirmation | undefined {
    if (preview.targetPaths.length === 0) return undefined;
    const parts = [
        `This clears the stored view state for ${
            plural(preview.targetPaths.length, 'file')
        }, freeing about ${format_bytes(preview.totalSizeBytes)}.`,
        'The files on disk are not deleted, moved, or changed — this only prunes'
            + ' what Table Viewer remembers about them: sorts, filters, column'
            + ' widths, and scroll positions.',
    ];
    if (preview.protectedPaths.length > 0) {
        // Say this up front. Reporting it only afterwards reads as a failure,
        // when it is the app protecting work that is currently in use.
        parts.push(
            `${plural(preview.protectedPaths.length, 'entry', 'entries')} will be kept because ${
                preview.protectedPaths.length === 1 ? 'it is' : 'they are'
            } open right now.`,
        );
    }
    return {
        title: `Clear stored state for ${plural(preview.targetPaths.length, 'file')}?`,
        message: parts.join('\n\n'),
        confirmLabel: 'Clear',
        affectedFiles: [],
        destructive: false,
    };
}

/**
 * The second confirmation, required only when unsaved edits are at stake.
 *
 * Undefined means no target holds unsaved work, so the first confirmation was
 * the whole conversation. When it is defined, the affected files are named
 * individually: "3 files have unsaved changes" is not enough for someone to
 * judge whether they care.
 */
export function pending_edit_confirmation(
    preview: StateInspectorPreview,
): TrimConfirmation | undefined {
    const affected = preview.pendingEditPaths;
    if (affected.length === 0) return undefined;
    return {
        title: `Discard unsaved changes to ${plural(affected.length, 'file')}?`,
        message: [
            `${
                affected.length === 1 ? 'This file has' : 'These files have'
            } edits that were never saved back to disk. Table Viewer is holding the only copy.`,
            'Clearing the stored state discards those edits permanently. This cannot be undone.',
        ].join('\n\n'),
        confirmLabel: affected.length === 1
            ? 'Discard Edits and Clear'
            : 'Discard All Edits and Clear',
        affectedFiles: affected,
        destructive: true,
    };
}

/** What to tell the user after a trim finishes. */
export function trim_outcome_message(summary: StateInspectorTrimSummary): string {
    if (summary.deletedCount === 0) {
        return summary.skippedProtectedCount > 0
            ? 'Nothing was cleared — every matching entry is currently open.'
            : 'Nothing was cleared.';
    }
    const parts = [`Cleared stored state for ${plural(summary.deletedCount, 'file')}.`];
    if (summary.vacuum === 'vacuumed' && summary.reclaimedBytes > 0) {
        parts.push(`Reclaimed ${format_bytes(summary.reclaimedBytes)} of disk space.`);
    } else if (summary.vacuum === 'deferred') {
        // Not a failure worth alarming anyone about: the rows are gone, and the
        // pages come back whenever the file is next free to be compacted.
        parts.push('Disk space will be reclaimed once other windows using this database close.');
    } else if (summary.vacuum === 'failed') {
        // The deletions committed; only the compaction pass came up empty. The
        // freed pages stay free and the next successful vacuum returns them.
        parts.push('Disk space could not be reclaimed yet; it will be recovered by a later cleanup.');
    }
    if (summary.skippedProtectedCount > 0) {
        parts.push(
            `${plural(summary.skippedProtectedCount, 'entry', 'entries')} kept because ${
                summary.skippedProtectedCount === 1 ? 'it is' : 'they are'
            } open.`,
        );
    }
    if (summary.skippedUnconfirmedCount > 0) {
        parts.push(
            `${
                plural(summary.skippedUnconfirmedCount, 'entry', 'entries')
            } kept because of unsaved changes.`,
        );
    }
    return parts.join(' ');
}

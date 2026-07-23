import { describe, expect, it } from 'vitest';
import { pending_sheet_action_to_run } from '../webview/sheet-action-model';

describe('pending_sheet_action_to_run', () => {
    it('runs when pending, active, and mounted sheet all match', () => {
        expect(pending_sheet_action_to_run(
            { sheet_index: 1, action: 'copy_sheet' },
            1,
            1,
        )).toBe('copy_sheet');
    });

    it('defers while the target sheet is not yet active', () => {
        expect(pending_sheet_action_to_run(
            { sheet_index: 1, action: 'select_all' },
            0,
            0,
        )).toBeNull();
    });

    it('defers while the mounted grid still belongs to the previous sheet', () => {
        // Active index flipped to the target, but the old grid handle lingers
        // during the keyed remount.
        expect(pending_sheet_action_to_run(
            { sheet_index: 1, action: 'select_all' },
            1,
            0,
        )).toBeNull();
    });

    it('returns null when there is no pending action', () => {
        expect(pending_sheet_action_to_run(null, 0, 0)).toBeNull();
    });

    it('resolves both action kinds', () => {
        expect(pending_sheet_action_to_run(
            { sheet_index: 2, action: 'select_all' },
            2,
            2,
        )).toBe('select_all');
        expect(pending_sheet_action_to_run(
            { sheet_index: 2, action: 'copy_sheet' },
            2,
            2,
        )).toBe('copy_sheet');
    });
});

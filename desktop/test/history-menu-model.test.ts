import { describe, expect, it } from 'vitest';
import {
    history_menu_item,
    sanitized_history_menu_state,
    type HistoryMenuState,
} from '../main/history-menu-model';

function state(overrides: Partial<HistoryMenuState> = {}): HistoryMenuState {
    return {
        undoAvailable: true,
        redoAvailable: false,
        undoLabel: 'Paste',
        redoLabel: undefined,
        textEditing: false,
        ...overrides,
    };
}

describe('what the desktop Edit menu says about undo', () => {
    it('names the gesture it would walk back', () => {
        expect(history_menu_item('undo', state())).toEqual({
            label: 'Undo Paste',
            enabled: true,
        });
    });

    it('greys out with a plain label when there is nothing to walk back', () => {
        expect(history_menu_item('undo', state({ undoAvailable: false }))).toEqual({
            label: 'Undo',
            enabled: false,
        });
    });

    it('leaves a text field to its own undo, whatever the workbook stack holds', () => {
        // Both halves matter: enabled even with an empty workbook stack, because
        // the text stack is a different one the menu cannot see; and labelled
        // plainly even with a full one, because it is not that gesture being undone.
        const in_text = state({ textEditing: true, undoAvailable: false });
        expect(history_menu_item('undo', in_text)).toEqual({ label: 'Undo', enabled: true });
        expect(history_menu_item('undo', state({ textEditing: true })))
            .toEqual({ label: 'Undo', enabled: true });
    });

    it('leaves a window with no history model alone', () => {
        // Welcome, preferences, the state inspector — and a viewer whose renderer
        // has not reported yet. Disabling here would take text undo away from them.
        expect(history_menu_item('undo', undefined)).toEqual({ label: 'Undo', enabled: true });
        expect(history_menu_item('redo', undefined)).toEqual({ label: 'Redo', enabled: true });
    });

    it('falls back to a plain label when the gesture had no name', () => {
        expect(history_menu_item('undo', state({ undoLabel: '' })).label).toBe('Undo');
        expect(history_menu_item('undo', state({ undoLabel: undefined })).label).toBe('Undo');
    });

    it('reads redo off its own half of the state', () => {
        const both = state({ redoAvailable: true, redoLabel: 'Clear highlights' });
        expect(history_menu_item('redo', both).label).toBe('Redo Clear highlights');
        expect(history_menu_item('undo', both).label).toBe('Undo Paste');
        // Each half also greys out on its own: the two stacks empty at different
        // times, and after one undo of a single gesture they are exact opposites.
        const undone = state({ undoAvailable: false, redoAvailable: true, redoLabel: 'Paste' });
        expect(history_menu_item('undo', undone)).toEqual({ label: 'Undo', enabled: false });
        expect(history_menu_item('redo', undone)).toEqual({ label: 'Redo Paste', enabled: true });
    });
});

describe('decoding what the renderer posted', () => {
    it('accepts a well-formed projection', () => {
        expect(sanitized_history_menu_state({
            undoAvailable: true,
            redoAvailable: true,
            undoLabel: 'Paste',
            redoLabel: 'Highlight',
            textEditing: false,
        })).toEqual({
            undoAvailable: true,
            redoAvailable: true,
            undoLabel: 'Paste',
            redoLabel: 'Highlight',
            textEditing: false,
        });
    });

    it('refuses a payload missing any of the three flags', () => {
        for (const missing of ['undoAvailable', 'redoAvailable', 'textEditing']) {
            const payload: Record<string, unknown> = {
                undoAvailable: true,
                redoAvailable: true,
                textEditing: false,
            };
            delete payload[missing];
            expect(sanitized_history_menu_state(payload), missing).toBeUndefined();
        }
        expect(sanitized_history_menu_state(null)).toBeUndefined();
        expect(sanitized_history_menu_state('undo')).toBeUndefined();
    });

    it('drops a label that is not a string rather than the whole payload', () => {
        // A missing label is legitimate — it is what "unavailable" looks like — so
        // a malformed one degrades to the plain item rather than to no menu state.
        const decoded = sanitized_history_menu_state({
            undoAvailable: true,
            redoAvailable: false,
            undoLabel: 42,
            textEditing: false,
        });
        expect(decoded?.undoLabel).toBeUndefined();
        expect(decoded?.undoAvailable).toBe(true);
    });

    it('caps a label the main process would otherwise retain whole', () => {
        const decoded = sanitized_history_menu_state({
            undoAvailable: true,
            redoAvailable: false,
            undoLabel: 'x'.repeat(5000),
            textEditing: false,
        });
        expect(decoded?.undoLabel).toHaveLength(200);
    });
});

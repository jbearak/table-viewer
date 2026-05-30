import { describe, it, expect } from 'vitest';
import {
    GLIDE_OVERLAY_EDITOR_SELECTOR,
    read_overlay_editor_value,
} from '../webview/live-editor';

function root_with(value: string | null): ParentNode {
    return {
        querySelector: (sel: string) =>
            sel === GLIDE_OVERLAY_EDITOR_SELECTOR && value !== null
                ? ({ value } as HTMLInputElement)
                : null,
    } as unknown as ParentNode;
}

describe('read_overlay_editor_value', () => {
    it('returns the live value of the mounted overlay editor', () => {
        expect(read_overlay_editor_value(root_with('typed text'))).toBe('typed text');
    });

    it('returns an empty string when the editor is mounted but empty', () => {
        expect(read_overlay_editor_value(root_with(''))).toBe('');
    });

    it('returns null when no overlay editor is mounted', () => {
        expect(read_overlay_editor_value(root_with(null))).toBeNull();
    });
});

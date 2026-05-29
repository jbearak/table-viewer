import { describe, it, expect } from 'vitest';
import { resolve_nav } from '../webview/grid-nav-model';

// Defaults for a plain (no-modifier) key press; override per case.
const base = {
    shift: false,
    ctrl: false,
    meta: false,
    alt: false,
    editable: false,
    has_merges: false,
};

describe('resolve_nav', () => {
    it('maps arrow keys to directions when the sheet has merges', () => {
        expect(resolve_nav({ ...base, key: 'ArrowUp', has_merges: true })).toEqual({
            direction: 'up',
        });
        expect(resolve_nav({ ...base, key: 'ArrowDown', has_merges: true })).toEqual({
            direction: 'down',
        });
        expect(resolve_nav({ ...base, key: 'ArrowLeft', has_merges: true })).toEqual({
            direction: 'left',
        });
        expect(resolve_nav({ ...base, key: 'ArrowRight', has_merges: true })).toEqual({
            direction: 'right',
        });
    });

    it('ignores arrow keys on a plain sheet (native Glide nav is correct)', () => {
        expect(resolve_nav({ ...base, key: 'ArrowDown', has_merges: false })).toBeNull();
        expect(resolve_nav({ ...base, key: 'ArrowRight', has_merges: false })).toBeNull();
    });

    it('maps hjkl to directions in view mode regardless of merges', () => {
        expect(resolve_nav({ ...base, key: 'k' })).toEqual({ direction: 'up' });
        expect(resolve_nav({ ...base, key: 'j' })).toEqual({ direction: 'down' });
        expect(resolve_nav({ ...base, key: 'h' })).toEqual({ direction: 'left' });
        expect(resolve_nav({ ...base, key: 'l' })).toEqual({ direction: 'right' });
    });

    it('ignores hjkl while editing so type-to-edit is preserved', () => {
        expect(resolve_nav({ ...base, key: 'j', editable: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'l', editable: true })).toBeNull();
    });

    it('still maps arrow keys while editing when the sheet has merges', () => {
        // editable + has_merges never co-occur in practice (CSV is editable but
        // has no merges), but arrows should remain merge-aware regardless.
        expect(
            resolve_nav({ ...base, key: 'ArrowDown', editable: true, has_merges: true }),
        ).toEqual({ direction: 'down' });
    });

    it('defers to Glide for shift (range extension)', () => {
        expect(
            resolve_nav({ ...base, key: 'ArrowDown', shift: true, has_merges: true }),
        ).toBeNull();
        expect(resolve_nav({ ...base, key: 'j', shift: true })).toBeNull();
    });

    it('defers to Glide for ctrl/meta/alt (copy, select-all, etc.)', () => {
        expect(
            resolve_nav({ ...base, key: 'ArrowDown', ctrl: true, has_merges: true }),
        ).toBeNull();
        expect(
            resolve_nav({ ...base, key: 'ArrowDown', meta: true, has_merges: true }),
        ).toBeNull();
        expect(
            resolve_nav({ ...base, key: 'ArrowDown', alt: true, has_merges: true }),
        ).toBeNull();
    });

    it('returns null for unrelated keys', () => {
        expect(resolve_nav({ ...base, key: 'a', has_merges: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'Enter', has_merges: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'Tab', has_merges: true })).toBeNull();
    });
});

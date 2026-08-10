import { describe, it, expect } from 'vitest';
import {
    resolve_nav,
    is_copy_key,
    move_sequential_cell,
} from '../webview/grid-nav-model';

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
            kind: 'direction',
            direction: 'up',
        });
        expect(resolve_nav({ ...base, key: 'ArrowDown', has_merges: true })).toEqual({
            kind: 'direction',
            direction: 'down',
        });
        expect(resolve_nav({ ...base, key: 'ArrowLeft', has_merges: true })).toEqual({
            kind: 'direction',
            direction: 'left',
        });
        expect(resolve_nav({ ...base, key: 'ArrowRight', has_merges: true })).toEqual({
            kind: 'direction',
            direction: 'right',
        });
    });

    it('ignores arrow keys on a plain sheet (native Glide nav is correct)', () => {
        expect(resolve_nav({ ...base, key: 'ArrowDown', has_merges: false })).toBeNull();
        expect(resolve_nav({ ...base, key: 'ArrowRight', has_merges: false })).toBeNull();
    });

    it('maps hjkl to directions in view mode regardless of merges', () => {
        expect(resolve_nav({ ...base, key: 'k' })).toEqual({ kind: 'direction', direction: 'up' });
        expect(resolve_nav({ ...base, key: 'j' })).toEqual({ kind: 'direction', direction: 'down' });
        expect(resolve_nav({ ...base, key: 'h' })).toEqual({ kind: 'direction', direction: 'left' });
        expect(resolve_nav({ ...base, key: 'l' })).toEqual({ kind: 'direction', direction: 'right' });
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
        ).toEqual({ kind: 'direction', direction: 'down' });
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

    it('intercepts Tab and Shift+Tab for row-major traversal', () => {
        expect(resolve_nav({ ...base, key: 'Tab' })).toEqual({
            kind: 'sequential',
            navigation: 'next',
        });
        expect(resolve_nav({ ...base, key: 'Tab', shift: true })).toEqual({
            kind: 'sequential',
            navigation: 'previous',
        });
    });

    it('defers modified Tab shortcuts', () => {
        expect(resolve_nav({ ...base, key: 'Tab', ctrl: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'Tab', meta: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'Tab', alt: true })).toBeNull();
    });

    it('returns null for unrelated keys', () => {
        expect(resolve_nav({ ...base, key: 'a', has_merges: true })).toBeNull();
        expect(resolve_nav({ ...base, key: 'Enter', has_merges: true })).toBeNull();
    });
});

describe('move_sequential_cell', () => {
    it('moves forward in row-major order and wraps rows', () => {
        expect(move_sequential_cell([0, 0], 'next', 3, 3)).toEqual([1, 0]);
        expect(move_sequential_cell([2, 0], 'next', 3, 3)).toEqual([0, 1]);
    });

    it('moves backward in row-major order and wraps rows', () => {
        expect(move_sequential_cell([2, 1], 'previous', 3, 3)).toEqual([1, 1]);
        expect(move_sequential_cell([0, 1], 'previous', 3, 3)).toEqual([2, 0]);
    });

    it('skips cells covered by merges', () => {
        const covered = (row: number, col: number) => row === 0 && col === 1;
        expect(move_sequential_cell([0, 0], 'next', 2, 3, covered)).toEqual([2, 0]);
        expect(move_sequential_cell([2, 0], 'previous', 2, 3, covered)).toEqual([0, 0]);
    });

    it('moves down without changing columns', () => {
        expect(move_sequential_cell([1, 0], 'below', 3, 3)).toEqual([1, 1]);
    });

    it('retains the current cell at every outer boundary', () => {
        expect(move_sequential_cell([2, 2], 'next', 3, 3)).toEqual([2, 2]);
        expect(move_sequential_cell([0, 0], 'previous', 3, 3)).toEqual([0, 0]);
        expect(move_sequential_cell([1, 2], 'below', 3, 3)).toEqual([1, 2]);
    });

    it('is total for an empty dimension', () => {
        expect(move_sequential_cell([0, 0], 'next', 0, 3)).toEqual([0, 0]);
        expect(move_sequential_cell([0, 0], 'next', 3, 0)).toEqual([0, 0]);
    });
});

describe('is_copy_key', () => {
    it('matches Ctrl+C and Cmd+C (either case)', () => {
        expect(is_copy_key({ ...base, key: 'c', ctrl: true })).toBe(true);
        expect(is_copy_key({ ...base, key: 'c', meta: true })).toBe(true);
        expect(is_copy_key({ ...base, key: 'C', ctrl: true })).toBe(true);
    });

    it('ignores a plain c and other keys', () => {
        expect(is_copy_key({ ...base, key: 'c' })).toBe(false);
        expect(is_copy_key({ ...base, key: 'v', ctrl: true })).toBe(false);
    });

    it('defers Shift/Alt combos so range-copy and other shortcuts stay native', () => {
        expect(is_copy_key({ ...base, key: 'c', ctrl: true, shift: true })).toBe(false);
        expect(is_copy_key({ ...base, key: 'c', meta: true, alt: true })).toBe(false);
    });
});

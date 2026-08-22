// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { LfsBanner, type LfsBannerProps } from '../webview/lfs-banner';
import type { UnresolvedLfsObject } from '../viewer-snapshot';

const UNRESOLVED: UnresolvedLfsObject = {
    side: 'file',
    oid: 'c'.repeat(64),
    size: 41_500_000,
    resolvable: true,
};

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
});

/**
 * Render the banner, reusing the root across calls within a test.
 *
 * Reused rather than recreated so that a second call is a *rerender* — which is
 * what the resolving-state case is actually about — instead of mounting a second
 * copy and leaking the first, which `afterEach` would never unmount.
 */
async function banner(props: Partial<LfsBannerProps> = {}): Promise<void> {
    if (!container || !root) {
        container = document.createElement('div');
        document.body.appendChild(container);
        root = createRoot(container);
    }
    await act(async () => {
        root!.render(React.createElement(LfsBanner, {
            unresolved: UNRESOLVED,
            resolving: false,
            on_resolve: () => {},
            ...props,
        }));
    });
}

const text = () => container?.textContent ?? '';
const button = () => container?.querySelector('button') ?? null;

describe('LfsBanner', () => {
    it('explains that the grid is empty, and offers the download', async () => {
        await banner();
        expect(text()).toContain('stored in Git LFS');
        expect(text()).toContain('The grid is empty');
        // Decimal units, matching how git-lfs itself quotes object sizes.
        expect(text()).toContain('41.5 MB');
        // The size describes the *download*, not the file on disk. A pointer is
        // a fixed ~130 bytes whatever it points at, so calling this figure the
        // placeholder's size — as this banner once did — was plainly false.
        expect(text()).not.toContain('placeholder');
        expect(button()?.textContent).toBe('Download contents');
    });

    it('describes the compare original as a missing diff, not a missing grid', async () => {
        // The two sides are genuinely different situations: here the user's
        // table is intact and only the comparison is unavailable, so a message
        // about an empty grid would simply be false.
        await banner({ unresolved: { ...UNRESOLVED, side: 'original' } });
        expect(text()).toContain('version being compared against');
        expect(text()).toContain('Differences are not shown');
        expect(text()).not.toContain('The grid is empty');
        expect(text()).not.toContain('placeholder');
    });

    it('drops the button when the host cannot resolve LFS objects', async () => {
        await banner({ unresolved: { ...UNRESOLVED, resolvable: false } });
        // The notice still stands — that is the point of reporting it at all.
        expect(text()).toContain('stored in Git LFS');
        expect(button()).toBeNull();
    });

    it('reports the click and then shows the download in progress', async () => {
        const on_resolve = vi.fn();
        await banner({ on_resolve });
        await act(async () => button()?.click());
        expect(on_resolve).toHaveBeenCalledTimes(1);
        // The button stays mounted and disabled rather than disappearing: a
        // control that vanishes mid-download reads as a click that failed.
        await banner({ resolving: true });
        expect(button()?.textContent).toBe('Downloading…');
        expect(button()?.disabled).toBe(true);
        // Rerendered in place, not mounted alongside the first copy.
        expect(container?.querySelectorAll('.lfs-banner')).toHaveLength(1);
        expect(document.querySelectorAll('.lfs-banner')).toHaveLength(1);
    });

    it('offers a retry after a download failure, quoting the reason', async () => {
        await banner({
            unresolved: {
                ...UNRESOLVED,
                failure: { reason: 'failed', detail: 'Object does not exist' },
            },
        });
        expect(text()).toContain('Object does not exist');
        expect(button()?.textContent).toBe('Try again');
    });

    it('drops the button entirely when git-lfs is not installed', async () => {
        // The one failure no number of clicks will change, so it says what to
        // do instead of inviting a retry that cannot work.
        await banner({
            unresolved: { ...UNRESOLVED, failure: { reason: 'lfsNotInstalled' } },
        });
        expect(text()).toContain('Git LFS is not installed');
        expect(button()).toBeNull();
    });

    it('tells the user to run git lfs install, and keeps the retry', async () => {
        // Observed against git-lfs 3.7: in a repository where `git lfs install`
        // was never run, `git lfs pull` prints "Skipping object checkout" and
        // exits 0 with the pointer untouched. The retry stays because running
        // that one command and clicking again is a real path to success.
        await banner({
            unresolved: { ...UNRESOLVED, failure: { reason: 'filtersNotConfigured' } },
        });
        expect(text()).toContain('not set up in this repository');
        expect(text()).toContain('git lfs install');
        expect(button()?.textContent).toBe('Try again');
    });

    it('drops the button when the object is missing from Git LFS', async () => {
        // The case that most needs saying plainly: the bytes do not exist to be
        // fetched, so a retry would be a button that cannot ever work — which
        // is exactly the confusion this banner exists to prevent.
        await banner({
            unresolved: { ...UNRESOLVED, failure: { reason: 'objectMissing' } },
        });
        expect(text()).toContain('missing from Git LFS');
        expect(text()).toContain('may not have pushed');
        expect(button()).toBeNull();
    });

    it('explains a file outside a repository without offering a retry', async () => {
        await banner({
            unresolved: { ...UNRESOLVED, failure: { reason: 'notARepository' } },
        });
        expect(text()).toContain('not inside a Git repository');
        expect(button()).toBeNull();
    });
});

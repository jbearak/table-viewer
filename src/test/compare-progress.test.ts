// @vitest-environment jsdom

import React, { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { CompareProgress } from '../webview/compare-progress';

let container: HTMLDivElement | undefined;
let root: Root | undefined;

afterEach(() => {
    act(() => root?.unmount());
    container?.remove();
    root = undefined;
    container = undefined;
});

async function progress(
    scannedRows: number,
    totalRows: number,
    on_cancel: () => void = () => {},
): Promise<void> {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    await act(async () => {
        root!.render(React.createElement(CompareProgress, {
            scannedRows,
            totalRows,
            on_cancel,
        }));
    });
}

const bar = (): HTMLElement => container!.querySelector('[role="progressbar"]')!;
const fill = (): HTMLElement => container!.querySelector('.compare-progress-fill')!;

describe('CompareProgress', () => {
    it('says how far the alignment has got', async () => {
        await progress(412_000, 900_000);
        expect(container!.textContent).toContain('Comparing…');
        expect(container!.textContent).toMatch(/412,000 of 900,000/u);
        expect(bar().getAttribute('aria-valuenow')).toBe('412000');
        expect(bar().getAttribute('aria-valuemax')).toBe('900000');
    });

    it('fills the bar in proportion', async () => {
        await progress(250, 1000);
        expect(fill().style.width).toBe('25%');
    });

    it('shows an empty bar rather than dividing by zero', async () => {
        await progress(0, 0);
        expect(fill().style.width).toBe('0%');
    });

    it('never overfills when a late report overshoots the total', async () => {
        await progress(1200, 1000);
        expect(fill().style.width).toBe('100%');
    });

    it('cancels on click', async () => {
        const on_cancel = vi.fn();
        await progress(1, 10, on_cancel);
        await act(async () =>
            (container!.querySelector('.compare-progress-cancel') as HTMLButtonElement).click());
        expect(on_cancel).toHaveBeenCalledTimes(1);
    });

    it('announces itself without stealing focus', async () => {
        await progress(1, 10);
        const status = container!.querySelector('[role="status"]');
        expect(status?.getAttribute('aria-live')).toBe('polite');
    });
});

// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

type DragCall = [phase: 'start' | 'move', x: number, y: number];
type FrameCallback = FrameRequestCallback;

function pointer_event(
    type: string,
    { pointerId = 1, button = 0, metaKey = false, screenX = 0, screenY = 0 } = {},
): PointerEvent {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, {
        pointerId: { value: pointerId },
        button: { value: button },
        metaKey: { value: metaKey },
        screenX: { value: screenX },
        screenY: { value: screenY },
    });
    return event as PointerEvent;
}

function controllable_raf(view: Window) {
    let next_id = 1;
    const frames = new Map<number, FrameCallback>();
    const request = vi.fn((callback: FrameCallback) => {
        const id = next_id++;
        frames.set(id, callback);
        return id;
    });
    const cancel = vi.fn((id: number) => {
        frames.delete(id);
    });
    Object.defineProperties(view, {
        requestAnimationFrame: { configurable: true, value: request },
        cancelAnimationFrame: { configurable: true, value: cancel },
    });
    return {
        request,
        cancel,
        flush() {
            const callbacks = [...frames.values()];
            frames.clear();
            for (const callback of callbacks) callback(0);
        },
        get pending() {
            return frames.size;
        },
    };
}

async function install_drag_titlebar() {
    vi.resetModules();
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
    const raf = controllable_raf(window);
    const calls: DragCall[] = [];
    const { install_titlebar } = await import('../shared/titlebar');
    install_titlebar(document, {
        title: 'Title',
        inset: 32,
        style: { background: 'black' },
        on_drag: (...call) => calls.push(call),
    });
    const label = document.querySelector<HTMLElement>('#tv-titlebar span')!;
    const captured = new Set<number>();
    const set_capture = vi.fn((pointer_id: number) => captured.add(pointer_id));
    const release_capture = vi.fn((pointer_id: number) => captured.delete(pointer_id));
    Object.defineProperties(label, {
        setPointerCapture: { configurable: true, value: set_capture },
        hasPointerCapture: {
            configurable: true,
            value: (pointer_id: number) => captured.has(pointer_id),
        },
        releasePointerCapture: { configurable: true, value: release_capture },
    });
    return { label, calls, raf, captured, set_capture, release_capture };
}

describe('interactive title-bar dragging', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('starts synchronously on an eligible pointerdown', async () => {
        const { label, calls, set_capture } = await install_drag_titlebar();

        const down = pointer_event('pointerdown', { screenX: 10, screenY: 20 });
        label.dispatchEvent(down);

        expect(down.defaultPrevented).toBe(true);
        expect(set_capture).toHaveBeenCalledWith(1);
        expect(calls).toEqual([['start', 10, 20]]);
    });

    it('coalesces pointermoves to the latest coordinates in one frame', async () => {
        const { label, calls, raf } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown', { screenX: 1, screenY: 2 }));

        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));

        expect(raf.request).toHaveBeenCalledTimes(1);
        expect(calls).toEqual([['start', 1, 2]]);
        raf.flush();
        expect(calls).toEqual([
            ['start', 1, 2],
            ['move', 30, 40],
        ]);
    });

    it('schedules a new update in the next frame', async () => {
        const { label, calls, raf } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown'));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));
        raf.flush();

        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));
        expect(raf.request).toHaveBeenCalledTimes(2);
        raf.flush();

        expect(calls).toEqual([
            ['start', 0, 0],
            ['move', 10, 20],
            ['move', 30, 40],
        ]);
    });

    it('sends pointermoves immediately when requestAnimationFrame is unavailable', async () => {
        const { label, calls } = await install_drag_titlebar();
        Object.defineProperty(window, 'requestAnimationFrame', {
            configurable: true,
            value: undefined,
        });
        label.dispatchEvent(pointer_event('pointerdown'));

        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));

        expect(calls).toEqual([
            ['start', 0, 0],
            ['move', 10, 20],
            ['move', 30, 40],
        ]);
    });

    it('flushes pointerup once, cancels its frame, releases capture, and ends the drag', async () => {
        const { label, calls, raf, release_capture } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown'));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));

        label.dispatchEvent(pointer_event('pointerup'));

        expect(calls).toEqual([
            ['start', 0, 0],
            ['move', 10, 20],
        ]);
        expect(raf.cancel).toHaveBeenCalledTimes(1);
        expect(raf.pending).toBe(0);
        expect(release_capture).toHaveBeenCalledWith(1);
        raf.flush();
        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));
        label.dispatchEvent(pointer_event('pointerup'));
        expect(calls).toHaveLength(2);
        expect(release_capture).toHaveBeenCalledTimes(1);
    });

    it('flushes and ends the drag on pointercancel', async () => {
        const { label, calls, raf, release_capture } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown'));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));

        label.dispatchEvent(pointer_event('pointercancel'));

        expect(calls.at(-1)).toEqual(['move', 10, 20]);
        expect(raf.cancel).toHaveBeenCalledTimes(1);
        expect(release_capture).toHaveBeenCalledWith(1);
        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));
        expect(calls).toHaveLength(2);
    });

    it('flushes and ends the drag when pointer capture is lost without releasing again', async () => {
        const { label, calls, raf, release_capture } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown'));
        label.dispatchEvent(pointer_event('pointermove', { screenX: 10, screenY: 20 }));

        label.dispatchEvent(pointer_event('lostpointercapture'));

        expect(calls.at(-1)).toEqual(['move', 10, 20]);
        expect(raf.cancel).toHaveBeenCalledTimes(1);
        expect(release_capture).not.toHaveBeenCalled();
        label.dispatchEvent(pointer_event('pointermove', { screenX: 30, screenY: 40 }));
        expect(calls).toHaveLength(2);
    });

    it('ignores other pointers during a drag', async () => {
        const { label, calls, raf, release_capture } = await install_drag_titlebar();
        label.dispatchEvent(pointer_event('pointerdown', { pointerId: 1 }));

        label.dispatchEvent(pointer_event('pointerdown', { pointerId: 2 }));
        label.dispatchEvent(pointer_event('pointermove', {
            pointerId: 2, screenX: 10, screenY: 20,
        }));
        label.dispatchEvent(pointer_event('pointerup', { pointerId: 2 }));

        expect(calls).toEqual([['start', 0, 0]]);
        expect(raf.request).not.toHaveBeenCalled();
        expect(release_capture).not.toHaveBeenCalled();
    });

    it('excludes non-left and Cmd pointerdowns', async () => {
        const { label, calls, set_capture } = await install_drag_titlebar();

        const right = pointer_event('pointerdown', { button: 2 });
        const command = pointer_event('pointerdown', { metaKey: true });
        label.dispatchEvent(right);
        label.dispatchEvent(command);

        expect(right.defaultPrevented).toBe(false);
        expect(command.defaultPrevented).toBe(false);
        expect(set_capture).not.toHaveBeenCalled();
        expect(calls).toEqual([]);
    });
});

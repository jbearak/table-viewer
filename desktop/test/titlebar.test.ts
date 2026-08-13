// @vitest-environment jsdom

import { beforeEach, describe, expect, it, vi } from 'vitest';

function mouse_event(type: string, { button = 0, metaKey = false } = {}): MouseEvent {
    return new MouseEvent(type, { bubbles: true, button, cancelable: true, metaKey });
}

async function install_path_titlebar() {
    vi.resetModules();
    document.body.innerHTML = '';
    document.body.removeAttribute('style');
    const open_path_menu = vi.fn();
    const { install_titlebar } = await import('../shared/titlebar');
    install_titlebar(document, {
        title: 'Title',
        inset: 32,
        style: { background: 'black' },
        on_path_menu: open_path_menu,
    });
    const bar = document.querySelector<HTMLElement>('#tv-titlebar')!;
    const label = bar.querySelector<HTMLElement>('span')!;
    return { bar, label, open_path_menu };
}

describe('interactive title-bar title', () => {
    beforeEach(() => {
        vi.restoreAllMocks();
    });

    it('places a native drag layer behind the title', async () => {
        const { bar, label } = await install_path_titlebar();
        const drag_region = bar.firstElementChild as HTMLElement;

        expect(drag_region).not.toBe(label);
        expect(drag_region.style.position).toBe('absolute');
        expect(drag_region.style.inset).toBe('0px');
        expect(drag_region.dataset.appRegion).toBe('drag');
        expect(label.style.position).toBe('relative');
        expect(label.getAttribute('style')).not.toContain('no-drag');
    });

    it('opens the path menu on Cmd-mousedown in the capture phase', async () => {
        const { bar, label, open_path_menu } = await install_path_titlebar();
        const bubbled = vi.fn();
        bar.addEventListener('mousedown', bubbled);
        const event = mouse_event('mousedown', { metaKey: true });

        label.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(open_path_menu).toHaveBeenCalledOnce();
        expect(bubbled).not.toHaveBeenCalled();
    });

    it('does not intercept ordinary or Cmd-right mousedown', async () => {
        const { bar, label, open_path_menu } = await install_path_titlebar();
        const bubbled = vi.fn();
        bar.addEventListener('mousedown', bubbled);
        const ordinary = mouse_event('mousedown');
        const command_right = mouse_event('mousedown', { button: 2, metaKey: true });

        label.dispatchEvent(ordinary);
        label.dispatchEvent(command_right);

        expect(ordinary.defaultPrevented).toBe(false);
        expect(command_right.defaultPrevented).toBe(false);
        expect(open_path_menu).not.toHaveBeenCalled();
        expect(bubbled).toHaveBeenCalledTimes(2);
    });

    it('opens the path menu and suppresses the page menu on right-click', async () => {
        const { label, open_path_menu } = await install_path_titlebar();
        const event = mouse_event('contextmenu');

        label.dispatchEvent(event);

        expect(event.defaultPrevented).toBe(true);
        expect(open_path_menu).toHaveBeenCalledOnce();
    });
});

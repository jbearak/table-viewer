// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../main/desktop-config';
import { theme_payload } from '../main/theme';
import type { AppUpdateWindowState } from '../main/app-update-window';

describe('application update renderer', () => {
    beforeEach(() => {
        vi.resetModules();
        document.head.innerHTML = '<title>Table Viewer Update</title>';
        document.body.innerHTML = `
          <main><div class="message"><div id="icon"></div><div>
            <h1 id="heading"></h1><p id="detail"></p>
          </div></div>
          <p id="dismissalNote" hidden></p>
          <div id="progress" hidden><progress id="progressBar" max="100"></progress>
            <span id="progressAmount"></span><span id="progressPercent"></span></div>
          <button id="secondary"></button><button id="primary"></button></main>`;
    });

    it('renders available, progress, and ready states with actionable controls', async () => {
        let state: AppUpdateWindowState = {
            kind: 'available', version: '2.5.0', installUpdates: true,
        };
        let state_listener: ((next: AppUpdateWindowState) => void) | undefined;
        const perform = vi.fn();
        Object.defineProperty(window, 'appUpdateApi', {
            configurable: true,
            value: {
                titlebar_inset: 0,
                titlebar_active: () => true,
                on_titlebar_active: () => {},
                titlebar_zoom: () => 1,
                on_titlebar_zoom: () => {},
                get_state: () => state,
                perform,
                on_state_changed: (listener: (next: AppUpdateWindowState) => void) => {
                    state_listener = listener;
                },
                get_theme: () => theme_payload('light'),
                on_theme_changed: () => {},
                get_settings: async () => DEFAULT_SETTINGS,
                on_settings_changed: () => {},
            },
        });

        await import('../renderer/app-update');
        expect(document.getElementById('heading')?.textContent)
            .toBe('Table Viewer 2.5.0 is available');
        expect(document.getElementById('dismissalNote')?.textContent)
            .toContain('won’t be notified about it again');
        expect(document.body.textContent).not.toContain('separate window');
        expect(document.getElementById('secondary')?.textContent).toBe('Skip 2.5.0');

        state = {
            kind: 'downloading',
            version: '2.5.0',
            progress: { percent: 46, transferred: 38_000_000, total: 82_000_000 },
        };
        state_listener?.(state);
        const downloading_heading = document.getElementById('heading')?.firstChild;
        expect(document.getElementById('heading')?.textContent)
            .toBe('Downloading Table Viewer 2.5.0');
        expect(document.getElementById('progressAmount')?.textContent).toBe('38 MB of 82 MB');
        expect(document.getElementById('progressPercent')?.textContent).toBe('46%');
        state_listener?.({
            ...state,
            progress: { percent: 47, transferred: 39_000_000, total: 82_000_000 },
        });
        expect(document.getElementById('heading')?.firstChild).toBe(downloading_heading);

        state = { kind: 'ready', version: '2.5.0' };
        state_listener?.(state);
        expect(document.getElementById('heading')?.textContent).toBe('Update ready to install');
        expect(document.getElementById('primary')?.textContent).toBe('Restart and install');
        (document.getElementById('primary') as HTMLButtonElement).click();
        expect(perform).toHaveBeenCalledWith('primary');
    });
});

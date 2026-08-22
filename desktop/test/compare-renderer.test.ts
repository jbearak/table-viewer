// @vitest-environment jsdom
//
// The Compare Files dialog's wiring: which verdict gates the button, and what
// happens to a check that is still in flight when the user acts again. The
// decisions themselves live in ../shared/compare-dialog-model and are tested
// there; this covers the parts that only exist once there is a DOM.
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../main/desktop-config';
import { theme_payload } from '../main/theme';
import type { ComparePathCheck, CompareSubmitResult } from '../shared/ipc';

const ok = (extension = 'csv'): ComparePathCheck => ({
    exists: true, supported: true, extension,
});
const missing = (extension = 'csv'): ComparePathCheck => ({
    exists: false, supported: true, extension,
});

const element = <T extends HTMLElement>(id: string): T =>
    document.getElementById(id) as T;
const input = (id: string) => element<HTMLInputElement>(id);
const compare_button = () => element<HTMLButtonElement>('compare');

/** Let the renderer's in-flight check promises settle. */
const settle = () => new Promise((resolve) => { setTimeout(resolve, 0); });

interface Harness {
    check_path: ReturnType<typeof vi.fn>;
    submit: ReturnType<typeof vi.fn>;
    cancel: ReturnType<typeof vi.fn>;
    browse: ReturnType<typeof vi.fn>;
}

async function mount(overrides: Partial<Harness> = {}): Promise<Harness> {
    const api: Harness = {
        check_path: vi.fn(async () => ok()),
        submit: vi.fn(async (): Promise<CompareSubmitResult> => ({ accepted: true })),
        cancel: vi.fn(),
        browse: vi.fn(async () => undefined),
        ...overrides,
    };
    Object.defineProperty(window, 'compareApi', {
        configurable: true,
        value: {
            ...api,
            titlebar_inset: 0,
            titlebar_active: () => true,
            on_titlebar_active: () => {},
            titlebar_zoom: () => 1,
            on_titlebar_zoom: () => {},
            get_theme: () => theme_payload('light'),
            on_theme_changed: () => {},
            get_settings: async () => DEFAULT_SETTINGS,
            on_settings_changed: () => {},
        },
    });
    await import('../renderer/compare');
    return api;
}

/** Type into a field the way the renderer's `input` listener sees it. */
async function type_into(id: string, value: string): Promise<void> {
    input(id).value = value;
    input(id).dispatchEvent(new Event('input'));
    await settle();
}

beforeEach(() => {
    vi.resetModules();
    document.body.innerHTML = `
      <div id="titlebar"></div>
      <input id="originalPath" type="text" />
      <button id="browseOriginal" type="button">Browse…</button>
      <div id="originalError" hidden></div>
      <button id="swap" type="button">Swap</button>
      <input id="modifiedPath" type="text" />
      <button id="browseModified" type="button">Browse…</button>
      <div id="modifiedError" hidden></div>
      <div id="warning" hidden></div>
      <button id="cancel" type="button">Cancel</button>
      <button id="compare" type="button" disabled>Compare</button>`;
});

describe('compare dialog renderer', () => {
    it('submits the path as typed, including a filename that begins with a space', async () => {
        // Trimming rewrote legal filenames: a file really can be called
        // ' leading.csv', and checking or opening 'leading.csv' is a different
        // file — or none.
        const api = await mount();
        await type_into('originalPath', ' leading.csv');
        await type_into('modifiedPath', 'other.csv');
        expect(api.check_path).toHaveBeenCalledWith(' leading.csv');
        compare_button().click();
        await settle();
        expect(api.submit).toHaveBeenCalledWith({
            originalPath: ' leading.csv',
            modifiedPath: 'other.csv',
        });
    });

    it('does not submit when Enter is pressed on a focused button', async () => {
        // Cancel already activates on Enter natively. Submitting as well would
        // both cancel and compare on one keypress.
        const api = await mount();
        await type_into('originalPath', 'a.csv');
        await type_into('modifiedPath', 'b.csv');
        expect(compare_button().disabled).toBe(false);
        element<HTMLButtonElement>('cancel').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await settle();
        expect(api.submit).not.toHaveBeenCalled();

        // From a path field it still submits, the way a native dialog does.
        input('originalPath').focus();
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter' }));
        await settle();
        expect(api.submit).toHaveBeenCalledTimes(1);
    });

    it('disables Compare while a browsed path is still being checked', async () => {
        // Browse used to leave the previous path's verdict standing, so the
        // button stayed enabled and could submit the new selection on the
        // strength of the old one's answer.
        let release: ((check: ComparePathCheck) => void) | undefined;
        const api = await mount({
            browse: vi.fn(async () => '/tmp/picked.xlsx'),
            check_path: vi.fn((path: string) => (
                path === '/tmp/picked.xlsx'
                    ? new Promise<ComparePathCheck>((resolve) => { release = resolve; })
                    : Promise.resolve(ok())
            )),
        });
        await type_into('originalPath', 'a.csv');
        await type_into('modifiedPath', 'b.csv');
        expect(compare_button().disabled).toBe(false);

        element<HTMLButtonElement>('browseOriginal').click();
        await settle();
        expect(input('originalPath').value).toBe('/tmp/picked.xlsx');
        expect(compare_button().disabled).toBe(true);

        release?.(ok('xlsx'));
        await settle();
        expect(compare_button().disabled).toBe(false);
        expect(api.browse).toHaveBeenCalledTimes(1);
    });

    it('does not let a check answered after Swap land on the other path', async () => {
        // The verdicts move with their paths; a request still in flight does
        // not, and would write its answer onto whichever side its token names.
        // Every resolver is kept, not just the latest: Swap re-asks for the
        // side whose verdict had not arrived, and releasing that second request
        // would not exercise the stale first one at all.
        const releases: ((check: ComparePathCheck) => void)[] = [];
        await mount({
            check_path: vi.fn((path: string) => (
                path === 'slow.csv'
                    ? new Promise<ComparePathCheck>((resolve) => { releases.push(resolve); })
                    : Promise.resolve(ok())
            )),
        });
        await type_into('modifiedPath', 'b.csv');
        await type_into('originalPath', 'slow.csv');
        // The original's check has not answered, so there is nothing to gate on.
        expect(compare_button().disabled).toBe(true);

        element<HTMLButtonElement>('swap').click();
        await settle();
        expect(input('modifiedPath').value).toBe('slow.csv');

        // The first request — issued while 'slow.csv' was the original — answers
        // only now, for a path that has since moved to the other side.
        expect(releases.length).toBeGreaterThan(0);
        releases[0](missing());
        await settle();
        // It must not have landed on the original, which now holds a checked,
        // existing file.
        expect(element('originalError').hidden).toBe(true);
    });

    it('shows the failure when main rejects a submit it re-validated', async () => {
        // The file went away between the dialog's check and the click. Returning
        // silently left Compare enabled on a stale verdict, so further clicks
        // did nothing visible.
        const api = await mount({
            submit: vi.fn(async (): Promise<CompareSubmitResult> => ({
                accepted: false,
                checks: { original: missing(), modified: ok() },
            })),
        });
        await type_into('originalPath', 'a.csv');
        await type_into('modifiedPath', 'b.csv');
        compare_button().click();
        await settle();
        expect(api.submit).toHaveBeenCalledTimes(1);
        expect(element('originalError').hidden).toBe(false);
        expect(element('originalError').textContent).toMatch(/no longer exists/u);
        expect(compare_button().disabled).toBe(true);
    });
});

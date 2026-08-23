// @vitest-environment jsdom
//
// The launcher's wiring: what the Recent rail renders, and the drag-and-drop
// handlers. The labelling rules live in ../shared/recent-display and are tested
// there; this covers the parts that only exist once there is a DOM.
import * as fs from 'fs';
import * as path from 'path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../main/desktop-config';
import { theme_payload } from '../main/theme';
import type { RecentEntry } from '../main/recent-documents';
import { SUPPORTED_FILE_EXTENSIONS } from '../main/windows-file-associations';

const file = (file_path: string, opened_at = 1): RecentEntry =>
    ({ kind: 'file', path: file_path, openedAt: opened_at });
const comparison = (original: string, modified: string): RecentEntry =>
    ({ kind: 'comparison', originalPath: original, modifiedPath: modified, openedAt: 1 });

const element = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const rows = () =>
    Array.from(document.querySelectorAll<HTMLButtonElement>('.recent-entry'));
const row_text = () => rows().map((row) => [
    row.querySelector('.name')?.textContent,
    row.querySelector('.location')?.textContent ?? '',
]);

interface Harness {
    open_files: ReturnType<typeof vi.fn>;
    open_compare: ReturnType<typeof vi.fn>;
    open_preferences: ReturnType<typeof vi.fn>;
    open_dropped: ReturnType<typeof vi.fn>;
    open_recent: ReturnType<typeof vi.fn>;
    clear_recent: ReturnType<typeof vi.fn>;
    get_recent: ReturnType<typeof vi.fn>;
    /** Push a new list the way main's broadcast does. */
    emit_recent: (entries: readonly RecentEntry[]) => void;
}

/**
 * Load welcome.html into the document and run the renderer against a stub API.
 *
 * The real HTML rather than a hand-built fixture: the renderer reaches for
 * elements by id, and a fixture that drifted from the markup would keep passing
 * while the app threw on load.
 */
async function mount(entries: readonly RecentEntry[] = []): Promise<Harness> {
    const markup = fs.readFileSync(
        path.join(__dirname, '..', 'renderer', 'welcome.html'),
        'utf8',
    );
    document.documentElement.innerHTML = markup
        .replace(/^[\s\S]*?<body>/, '')
        .replace(/<script[\s\S]*$/, '');
    document.body.className = '';

    let recent_listener: ((entries: readonly RecentEntry[]) => void) | undefined;
    const api = {
        open_files: vi.fn(),
        open_compare: vi.fn(),
        open_preferences: vi.fn(),
        open_dropped: vi.fn(),
        open_recent: vi.fn(),
        clear_recent: vi.fn(),
        get_recent: vi.fn(async () => entries),
    };
    Object.defineProperty(window, 'welcomeApi', {
        configurable: true,
        value: {
            ...api,
            on_recent_changed: (listener: (entries: readonly RecentEntry[]) => void) => {
                recent_listener = listener;
            },
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
    vi.resetModules();
    await import('../renderer/welcome');
    // The initial list arrives on a promise.
    await new Promise((resolve) => { setTimeout(resolve, 0); });
    return {
        ...api,
        emit_recent: (next) => recent_listener?.(next),
    };
}

/** A drag event jsdom will carry a DataTransfer-shaped payload on. */
function drag_event(type: string, files: readonly unknown[] = []): Event {
    const event = new Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, 'dataTransfer', {
        value: { files, dropEffect: 'none', items: files },
    });
    return event;
}

beforeEach(() => {
    document.documentElement.innerHTML = '';
});

describe('the launcher actions', () => {
    it('wires each button to its request', async () => {
        const api = await mount();

        element<HTMLButtonElement>('open').click();
        element<HTMLButtonElement>('compare').click();
        element<HTMLButtonElement>('preferences').click();

        expect(api.open_files).toHaveBeenCalledOnce();
        expect(api.open_compare).toHaveBeenCalledOnce();
        expect(api.open_preferences).toHaveBeenCalledOnce();
    });

    // The hint names the file types by extension, which is a promise about what
    // a drop will accept. A fifth supported format would otherwise leave the
    // launcher quietly claiming it is unsupported.
    it('names every supported extension in the drop hint, and nothing else', async () => {
        await mount();
        const hint = element('drop-hint').textContent ?? '';
        const named = Array.from(hint.matchAll(/\.([a-z0-9]+)\b/g), (match) => match[1]);

        expect(new Set(named)).toEqual(new Set(SUPPORTED_FILE_EXTENSIONS));
    });
});

describe('the Recent rail', () => {
    // An empty bordered column reads as a rendering failure, so a launcher with
    // nothing to offer must not show the rail at all.
    it('is hidden when there is nothing to show', async () => {
        await mount([]);
        expect(element('recent').hidden).toBe(true);
        expect(rows()).toHaveLength(0);
    });

    it('renders a row per entry, newest first as given', async () => {
        await mount([
            file('/Users/jo/data/survey.csv'),
            comparison('/Users/jo/data/before.csv', '/Users/jo/data/after.csv'),
        ]);

        expect(element('recent').hidden).toBe(false);
        expect(row_text()).toEqual([
            ['survey.csv', '~/data'],
            ['before.csv ↔ after.csv', '~/data'],
        ]);
    });

    it('sends the clicked entry back verbatim', async () => {
        const entry = comparison('/data/before.csv', '/data/after.csv');
        const api = await mount([file('/data/survey.csv'), entry]);

        rows()[1].click();

        expect(api.open_recent).toHaveBeenCalledWith(entry);
    });

    it('carries the full path in each row title attribute', async () => {
        await mount([file('/Users/jo/deeply/nested/survey.csv')]);
        expect(rows()[0].title).toBe('/Users/jo/deeply/nested/survey.csv');
    });

    // A file opened from *this* launcher lands in a viewer window, so a second
    // launcher still on screen would otherwise show a stale list.
    it('re-renders when main pushes a new list', async () => {
        const api = await mount([file('/data/first.csv')]);

        api.emit_recent([file('/data/second.csv'), file('/data/first.csv')]);

        expect(row_text().map(([name]) => name)).toEqual(['second.csv', 'first.csv']);
    });

    it('hides the rail again when the list is cleared', async () => {
        const api = await mount([file('/data/first.csv')]);

        element<HTMLButtonElement>('clear-recent').click();
        // Main clears and then broadcasts; the renderer only reacts.
        expect(api.clear_recent).toHaveBeenCalledOnce();
        api.emit_recent([]);

        expect(element('recent').hidden).toBe(true);
        expect(rows()).toHaveLength(0);
    });

    // Rendering appends, so a re-render has to clear first or the rail grows a
    // duplicate set of rows each time.
    it('replaces rather than appends on re-render', async () => {
        const api = await mount([file('/data/first.csv')]);
        api.emit_recent([file('/data/first.csv')]);

        expect(rows()).toHaveLength(1);
    });

    // The paths in the list come from opened files, and a name is rendered as
    // text rather than markup.
    it('renders a path containing markup as text', async () => {
        await mount([file('/data/<img src=x>.csv')]);

        expect(rows()[0].querySelector('.name')?.textContent).toBe('<img src=x>.csv');
        expect(document.querySelector('img')).toBeNull();
    });

    it('omits the location line for a file with no folder to name', async () => {
        await mount([file('/survey.csv')]);

        expect(rows()[0].querySelector('.location')).toBeNull();
    });
});

describe('drag and drop', () => {
    it('shows the overlay while a drag is over the window and hides it after', async () => {
        await mount();

        document.dispatchEvent(drag_event('dragenter'));
        expect(document.body.classList.contains('dragging')).toBe(true);

        document.dispatchEvent(drag_event('dragleave'));
        expect(document.body.classList.contains('dragging')).toBe(false);
    });

    // Nested elements each fire enter/leave as the pointer crosses them, so a
    // boolean flag would clear the overlay on the first inner leave.
    it('keeps the overlay up across a nested dragleave', async () => {
        await mount();

        document.dispatchEvent(drag_event('dragenter'));
        document.dispatchEvent(drag_event('dragenter'));
        document.dispatchEvent(drag_event('dragleave'));

        expect(document.body.classList.contains('dragging')).toBe(true);

        document.dispatchEvent(drag_event('dragleave'));
        expect(document.body.classList.contains('dragging')).toBe(false);
    });

    // The drop is refused unless the immediately preceding dragover was
    // cancelled, so every dragover must preventDefault — not merely the first.
    it('cancels every dragover', async () => {
        await mount();

        document.dispatchEvent(drag_event('dragenter'));
        for (let index = 0; index < 3; index += 1) {
            const event = drag_event('dragover');
            document.dispatchEvent(event);
            expect(event.defaultPrevented).toBe(true);
        }
    });

    it('hands the dropped files to the preload and clears the overlay', async () => {
        const api = await mount();
        const dropped = [{ name: 'a.csv' }, { name: 'b.csv' }];

        document.dispatchEvent(drag_event('dragenter'));
        const drop = drag_event('drop', dropped);
        document.dispatchEvent(drop);

        expect(drop.defaultPrevented).toBe(true);
        expect(api.open_dropped).toHaveBeenCalledWith(dropped);
        expect(document.body.classList.contains('dragging')).toBe(false);
    });

    it('ignores a drop carrying no files', async () => {
        const api = await mount();

        document.dispatchEvent(drag_event('dragenter'));
        document.dispatchEvent(drag_event('drop', []));

        expect(api.open_dropped).not.toHaveBeenCalled();
        expect(document.body.classList.contains('dragging')).toBe(false);
    });

    // A drag that left the window and came back must not need as many leaves as
    // the abandoned one accumulated enters.
    it('resets the depth on drop', async () => {
        await mount();

        document.dispatchEvent(drag_event('dragenter'));
        document.dispatchEvent(drag_event('dragenter'));
        document.dispatchEvent(drag_event('drop', [{ name: 'a.csv' }]));

        document.dispatchEvent(drag_event('dragenter'));
        expect(document.body.classList.contains('dragging')).toBe(true);
        document.dispatchEvent(drag_event('dragleave'));
        expect(document.body.classList.contains('dragging')).toBe(false);
    });
});

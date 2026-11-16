// Editing with no edit mode: an editable file takes an editing gesture as it
// is, the toolbar's Save button writes the result, and the editing session
// behind the gesture is acquired and released without the person seeing it.
//
// Each test launches its own app on its own copy of the fixture, and none of
// them uses the application menu, so nothing here depends on the window
// holding OS focus.
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { test, expect } from '@playwright/test';
import type { ElectronApplication, Page } from '@playwright/test';
import { isolated_user_data, launch_app, repo_dir } from './smoke-helpers';
import { open_column_menu } from './structure-helpers';
import { build_fixture_xlsx } from '../../src/test/helpers/xlsx-structure-fixture';

const GRID_CANVAS = '[data-testid="data-grid-canvas"]';
const VIEWER_URL_PREFIX = 'tv-app://viewer';
const fixture = path.join(repo_dir, 'src', 'test', 'fixtures', 'basic.csv');
const fixture_text = 'Name,Age,City\nAlice,30,New York\nBob,25,London\nCharlie,35,Paris\n';

let app: ElectronApplication | undefined;
let page: Page;
let csv: string;
let root: string;

test.beforeEach(async () => {
    root = fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), 'tv-edit-without-mode-')));
    csv = path.join(root, 'basic.csv');
    fs.copyFileSync(fixture, csv);
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
    app = await launch_app(isolated_user_data('tv-edit-without-mode-data-'), [csv]);
    await expect.poll(
        () => app!.windows().filter((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
        { timeout: 30_000 },
    ).toBe(1);
    page = app.windows().find((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX))!;
    await page.locator(GRID_CANVAS).first().waitFor({ state: 'visible' });
    await page.locator('#glide-cell-1-0').waitFor({ state: 'attached' });
});

test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
    fs.rmSync(root, { recursive: true, force: true });
});

const save = () => page.getByRole('button', { name: 'Save' });
const discard = () => page.getByRole('button', { name: 'Discard' });
const diff = () => page.getByRole('button', { name: 'Diff' });
const editor = () => page.locator('.cell-editor-input');
const cell = (column: number, row: number) => page.locator(`#glide-cell-${column}-${row}`);

/** Click the cell at `column`, `row` on the canvas and wait until it is selected. */
async function select_cell(column: number, row: number): Promise<void> {
    const box = (await page.locator(GRID_CANVAS).first().boundingBox())!;
    // Default layout of the three-column fixture: a row-number gutter, then
    // 120 px columns under a 36 px header, with 24 px rows.
    await page.mouse.click(box.x + 30 + (column - 1) * 120 + 60, box.y + 36 + row * 24 + 12);
    await expect(cell(column, row)).toHaveAttribute('aria-selected', 'true');
}

/** Undo, as the Edit menu sends it to the window. */
async function undo(): Promise<void> {
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'undo' }, '*'));
}

async function expect_nothing_unsaved(): Promise<void> {
    await expect(save()).toHaveAttribute('aria-disabled', 'true');
    await expect(save()).not.toHaveClass(/has-unsaved/);
    await expect(discard()).toHaveCount(0);
    await expect(diff()).toHaveCount(0);
}

test('an editable file opens ready to edit, with Save waiting and no Edit button', async () => {
    await expect(page.getByRole('button', { name: 'Edit', exact: true })).toHaveCount(0);
    await expect_nothing_unsaved();
    // Cells say they can be changed before anything has been.
    await expect(cell(1, 0)).toHaveAttribute('aria-readonly', 'false');
});

test('typing starts an edit and keeps every key; Save writes it', async () => {
    await select_cell(1, 0);
    // One key at a time, and long enough that the session is granted partway
    // through: the keys typed while it is being acquired, and those typed while
    // the editor opens on the grant, belong to the edit the first one started.
    // That includes a space, which the grid alone would take to mean "open the
    // editor".
    const typed = 'New York keeps its spaces';
    await page.keyboard.type(typed, { delay: 3 });
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue(typed);
    await page.keyboard.press('Enter');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText(typed);

    await expect(save()).toHaveClass(/has-unsaved/);
    await expect(save()).not.toHaveAttribute('aria-disabled', 'true');
    await expect(discard()).toBeVisible();
    await expect(diff()).toBeVisible();
    // Nothing reaches the file until Save.
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);

    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8'))
        .toBe(`Name,Age,City\n${typed},30,New York\nBob,25,London\nCharlie,35,Paris\n`);
    await expect_nothing_unsaved();
});

test('Tab typed before the session is granted commits the edit and moves on', async () => {
    await select_cell(1, 0);
    // Short enough that Tab usually comes before the grant. The grid alone
    // would take Tab to mean "select the next cell", and the edit waiting for
    // the session would then have nowhere to open.
    await page.keyboard.type('Hi you', { delay: 3 });
    await page.keyboard.press('Tab');
    await expect(cell(2, 0)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('Hi you');
    await expect(cell(2, 0)).toHaveText('30');
    await expect(save()).toHaveClass(/has-unsaved/);
});

/**
 * Press `keys` without waiting for each to be handled before sending the next,
 * so that they reach the app, in order, before the session is granted.
 */
async function press_at_once(keys: readonly string[]): Promise<void> {
    await Promise.all(keys.map((key) => page.keyboard.press(key)));
}

test('keys after an Enter typed before the session is granted start the next edit, as under one', async () => {
    await select_cell(1, 0);
    // Under a session, Enter commits "abc" and selects the cell below, where
    // "def" starts a new edit.
    await press_at_once(['a', 'b', 'c', 'Enter', 'd', 'e', 'f']);
    await expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('def');
    await expect(cell(1, 0)).toHaveText('abc');
    await page.keyboard.press('Enter');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 1)).toHaveText('def');
});

test('arrows typed before the session is granted move the caret, as in the open editor', async () => {
    await select_cell(1, 0);
    // In the open editor Left steps back a character, Home goes to the start,
    // and End to the end.
    await press_at_once(['a', 'b', 'ArrowLeft', 'c', 'Home', '<', 'End', '>']);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('<acb>');
    await expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
});

/**
 * Type `keys` as a non-US layout sends them, a key down and up for each
 * character such as ж or é, all at once as `press_at_once` does. Playwright
 * cannot press a key its US layout lacks, so this goes through CDP.
 */
async function type_on_layout(keys: readonly string[]): Promise<void> {
    const cdp = await page.context().newCDPSession(page);
    try {
        await Promise.all(keys.flatMap((key) => {
            const text = key === 'Enter' ? '\r' : key;
            const code = key === 'Enter' ? 'Enter' : undefined;
            const windowsVirtualKeyCode = key === 'Enter' ? 13 : undefined;
            return [
                cdp.send('Input.dispatchKeyEvent', {
                    type: 'keyDown', key, code, windowsVirtualKeyCode, text, unmodifiedText: text,
                }),
                cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key, code, windowsVirtualKeyCode }),
            ];
        }));
    } finally {
        await cdp.detach();
    }
}

for (const session of ['before the session is granted', 'under a session']) {
    test(`a character typed on a non-US layout starts an edit ${session}`, async () => {
        if (session === 'under a session') {
            // A change elsewhere keeps the session held.
            await select_cell(3, 2);
            await page.keyboard.press('Delete');
            await expect(cell(3, 2)).toHaveText('');
            await expect(save()).toHaveClass(/has-unsaved/);
        }
        await select_cell(1, 0);
        // ж starts the edit, Enter commits it and selects the cell below, and
        // ü starts the next edit there. Every key lands at once.
        await type_on_layout(['ж', 'é', 'Enter', 'ü', 'ß']);
        await expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
        await expect(editor()).toBeVisible();
        await expect(editor()).toHaveValue('üß');
        await expect(cell(1, 0)).toHaveText('жé');
        await page.keyboard.press('Enter');
        await expect(editor()).toBeHidden();
        await expect(cell(1, 1)).toHaveText('üß');
    });
}

// The Cocoa editing command each chord sends on macOS, as Playwright's own
// keyboard sends them. The open editor moves its caret by these.
const MAC_COMMANDS: Record<string, string> = {
    ArrowLeft: 'moveLeft', ArrowRight: 'moveRight', ArrowUp: 'moveUp', ArrowDown: 'moveDown',
    Home: 'scrollToBeginningOfDocument', End: 'scrollToEndOfDocument',
    Backspace: 'deleteBackward', Escape: 'cancelOperation',
    'Shift+ArrowLeft': 'moveLeftAndModifySelection', 'Shift+ArrowRight': 'moveRightAndModifySelection',
    'Alt+ArrowLeft': 'moveWordLeft', 'Alt+ArrowRight': 'moveWordRight',
    'Alt+Shift+ArrowLeft': 'moveWordLeftAndModifySelection',
    'Alt+Shift+ArrowRight': 'moveWordRightAndModifySelection',
    'Alt+Backspace': 'deleteWordBackward',
    'Meta+ArrowLeft': 'moveToLeftEndOfLine', 'Meta+ArrowRight': 'moveToRightEndOfLine',
    'Meta+ArrowUp': 'moveToBeginningOfDocument', 'Meta+ArrowDown': 'moveToEndOfDocument',
    'Meta+Shift+ArrowLeft': 'moveToLeftEndOfLineAndModifySelection',
};
const KEY_CODES: Record<string, [code: string, key_code: number]> = {
    ArrowLeft: ['ArrowLeft', 37], ArrowUp: ['ArrowUp', 38], ArrowRight: ['ArrowRight', 39],
    ArrowDown: ['ArrowDown', 40], Home: ['Home', 36], End: ['End', 35], Enter: ['Enter', 13],
    Escape: ['Escape', 27], Backspace: ['Backspace', 8], ' ': ['Space', 32],
};
const MODIFIER_BITS: Record<string, number> = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };

/**
 * `press_at_once` for chords, such as `Meta+ArrowLeft`. Playwright's own
 * presses share one modifier state, so chords sent at once would hold their
 * modifiers down over the keys around them; these go straight to the page,
 * each with its own modifiers, without waiting for one to be handled before
 * sending the next. Letters, digits, and the keys in KEY_CODES only.
 */
async function press_chords_at_once(chords: readonly string[]): Promise<void> {
    const session = await page.context().newCDPSession(page);
    const sent: Promise<unknown>[] = [];
    for (const chord of chords) {
        const parts = chord.split('+');
        const key = parts.pop()!;
        const modifiers = parts.reduce((bits, part) => bits | MODIFIER_BITS[part]!, 0);
        const shift = (modifiers & MODIFIER_BITS.Shift!) !== 0;
        const [code, key_code] = KEY_CODES[key]
            ?? [/\d/.test(key) ? `Digit${key}` : `Key${key.toUpperCase()}`, key.toUpperCase().charCodeAt(0)];
        const text = key === 'Enter' ? '\r' : key.length === 1 && (modifiers & ~MODIFIER_BITS.Shift!) === 0
            ? (shift ? key.toUpperCase() : key)
            : undefined;
        const name = ['Alt', 'Meta', 'Shift'].filter((part) => parts.includes(part)).concat(key).join('+');
        const commands = process.platform === 'darwin' && MAC_COMMANDS[name] ? [MAC_COMMANDS[name]] : [];
        const event = { key: text && key.length === 1 ? text : key, code, windowsVirtualKeyCode: key_code, modifiers };
        sent.push(session.send('Input.dispatchKeyEvent', {
            ...event, type: text ? 'keyDown' : 'rawKeyDown', text, unmodifiedText: text, commands,
        }));
        sent.push(session.send('Input.dispatchKeyEvent', { ...event, type: 'keyUp' }));
    }
    await Promise.all(sent);
    await session.detach();
}

test('Escape typed before the session is granted cancels the edit, as in the open editor', async () => {
    await select_cell(1, 0);
    // In the open editor Escape discards "ab" and leaves the cell selected,
    // where "x" starts a new edit.
    await press_at_once(['a', 'b', 'Escape', 'x']);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('x');
    await expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('Alice');
    // Nothing was committed, and the session went back.
    await expect_nothing_unsaved();
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
});

test('Escape after an Enter typed before the session is granted cancels only the next edit', async () => {
    await select_cell(1, 0);
    // Enter commits "ab" and selects the cell below. Escape discards "cd"
    // there, and "e" starts a new edit in the same cell.
    await press_at_once(['a', 'b', 'Enter', 'c', 'd', 'Escape', 'e']);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('e');
    await expect(cell(1, 1)).toHaveAttribute('aria-selected', 'true');
    await expect(cell(1, 0)).toHaveText('ab');
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 1)).toHaveText('Bob');
});

test('Cmd+arrows typed before the session is granted move the caret, as in the open editor', async () => {
    test.skip(process.platform !== 'darwin', 'macOS key bindings');
    await select_cell(1, 0);
    // In the open editor Cmd+Left and Cmd+Up go to the start, and Cmd+Right
    // and Cmd+Down to the end. On the grid they would jump to the edge of
    // the data, out from under the edit.
    await press_chords_at_once([
        'a', 'b', 'c', 'Meta+ArrowLeft', 'x', 'Meta+ArrowRight', 'y',
        'Meta+ArrowUp', '1', 'Meta+ArrowDown', '2',
    ]);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('1xabcy2');
    await expect(cell(1, 0)).toHaveAttribute('aria-selected', 'true');
});

test('Shift and Alt arrows typed before the session is granted select and move by word, as in the open editor', async () => {
    test.skip(process.platform !== 'darwin', 'macOS key bindings');
    await select_cell(1, 0);
    // "one two three": Alt+Left goes to the start of "three", Alt+Left again
    // to the start of "two", Alt+Shift+Right selects "two", and "2" replaces
    // it. Shift+Left twice then selects " 2", which "E" replaces. At the end,
    // Alt+Backspace deletes "three".
    await press_chords_at_once([
        'o', 'n', 'e', ' ', 't', 'w', 'o', ' ', 't', 'h', 'r', 'e', 'e',
        'Alt+ArrowLeft', 'Alt+ArrowLeft', 'Alt+Shift+ArrowRight', '2',
        'Shift+ArrowLeft', 'Shift+ArrowLeft', 'E', 'Meta+ArrowRight', 'Alt+Backspace',
    ]);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('oneE ');
});

test('Up, Down, Home, and End in lines of text typed before the session is granted go by line, as in the open editor', async () => {
    test.skip(process.platform !== 'darwin', 'macOS key bindings');
    await select_cell(1, 0);
    // Shift+Enter starts a second line. Up goes to the same place on the
    // first line, End to its end, Down back to the second, and Home to its
    // start. Cmd+Down goes to the end, for a third line.
    await press_chords_at_once([
        'a', 'b', 'c', 'Shift+Enter', 'd', 'e', 'ArrowUp', '1', 'End', '2', 'ArrowDown', 'Home', '3',
        // A third line, and Home in it.
        'Meta+ArrowDown', 'Shift+Enter', 'f', 'g', 'Home', '4',
    ]);
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('ab1c2\n3de\n4fg');
    await page.keyboard.press('Enter');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('ab1c2 3de 4fg');
});

test('an editor opened and cancelled leaves nothing behind, and the next edit just works', async () => {
    await select_cell(2, 0);
    await page.keyboard.press('Enter');
    await expect(editor()).toBeVisible();
    await expect(editor()).toHaveValue('30');
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await expect_nothing_unsaved();

    // The session that editor used is gone again. Delete acquires another.
    await select_cell(2, 1);
    await page.keyboard.press('Delete');
    await expect(cell(2, 1)).toHaveText('');
    await expect(save()).toHaveClass(/has-unsaved/);
});

// A textarea holds CRLF as LF. Reading that back as the cell's text would
// make an untouched cell an edit.
for (const extension of ['csv', 'xlsx']) {
    test(`an unchanged ${extension} cell with CRLF line breaks opened and committed leaves nothing behind`, async () => {
        const text = 'first\r\nsecond';
        const bytes = extension === 'xlsx'
            ? Buffer.from(build_fixture_xlsx({ sheets: [{
                name: 'Lines',
                body: '<sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Name</t></is></c></row>'
                    + '<row r="2"><c r="A2" t="inlineStr"><is><t>first&#13;&#10;second</t></is></c></row>'
                    + '<row r="3"><c r="A3" t="inlineStr"><is><t>other</t></is></c></row></sheetData>',
            }] }))
            : Buffer.from(`Name\r\n"${text}"\r\nother\r\n`);
        const file = path.join(root, `lines.${extension}`);
        fs.writeFileSync(file, bytes);
        await app!.close();
        app = await launch_app(isolated_user_data('tv-edit-without-mode-data-'), [file]);
        await expect.poll(
            () => app!.windows().filter((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
            { timeout: 30_000 },
        ).toBe(1);
        page = app.windows().find((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX))!;
        await page.locator('#glide-cell-1-0').waitFor({ state: 'attached' });

        // This one-column XLSX opens without a Header Row.
        const row = extension === 'xlsx' ? 1 : 0;
        await select_cell(1, row);
        await page.keyboard.press('Enter');
        await expect(editor()).toHaveValue('first\nsecond');
        await expect_nothing_unsaved();
        await page.keyboard.press('Enter');
        await expect(editor()).toHaveCount(0);
        await expect(cell(1, row + 1)).toHaveAttribute('aria-selected', 'true');

        await expect_nothing_unsaved();
        expect(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()
            .some((window) => window.isDocumentEdited()))).toBe(false);
        expect(fs.readFileSync(file)).toEqual(bytes);
    });
}

test('Discard drops every unsaved change at once, and undo brings them back the first time', async () => {
    await select_cell(2, 1);
    await page.keyboard.press('Delete');
    await expect(cell(2, 1)).toHaveText('');
    await expect(discard()).toBeVisible();

    await discard().click();
    await expect(cell(2, 1)).toHaveText('25');
    await expect_nothing_unsaved();

    await undo();
    await expect(cell(2, 1)).toHaveText('');
    await expect(save()).toHaveClass(/has-unsaved/);
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
});

test('undo reaches an edit made before a cancelled editor released the session', async () => {
    await select_cell(1, 0);
    await page.keyboard.type('Zed');
    await expect(editor()).toHaveValue('Zed');
    await page.keyboard.press('Enter');
    await expect(cell(1, 0)).toHaveText('Zed');
    await undo();
    await expect(cell(1, 0)).toHaveText('Alice');
    await expect_nothing_unsaved();

    // Acquire and release a session with nothing in it, then redo at once.
    await select_cell(3, 2);
    await page.keyboard.press('Enter');
    await expect(editor()).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(editor()).toBeHidden();
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'redo' }, '*'));
    await expect(cell(1, 0)).toHaveText('Zed');
    await expect(save()).toHaveClass(/has-unsaved/);
});

test('a paste is the first edit, and Cmd/Ctrl+S saves it', async () => {
    await app!.evaluate(({ clipboard }) => clipboard.writeText('P1\tP2\nP3\tP4'));
    await select_cell(1, 0);
    await page.keyboard.press('ControlOrMeta+V');
    await expect(cell(1, 0)).toHaveText('P1');
    await expect(cell(2, 1)).toHaveText('P4');
    await expect(save()).toHaveClass(/has-unsaved/);

    await page.keyboard.press('ControlOrMeta+S');
    await expect.poll(() => fs.readFileSync(csv, 'utf8'))
        .toBe('Name,Age,City\nP1,P2,New York\nP3,P4,London\nCharlie,35,Paris\n');
    await expect_nothing_unsaved();
});

test('a paste of what the cell already holds lets its session go', async () => {
    // What the webview tells the host, as the main process receives it.
    await app!.evaluate(({ ipcMain }) => {
        const sent: { type: string }[] = [];
        (globalThis as { webview_messages?: typeof sent }).webview_messages = sent;
        ipcMain.on('tableViewer:webviewMessage', (_event, envelope: { message: { type: string } }) => {
            sent.push(envelope.message);
        });
    });
    const sent_types = () => app!.evaluate(() =>
        (globalThis as { webview_messages?: { type: string }[] }).webview_messages!.map(({ type }) => type));
    await select_cell(1, 0);

    // The paste event itself, carrying its data, so the OS clipboard is not shared.
    await page.evaluate(() => {
        const data = new DataTransfer();
        data.setData('text/plain', 'Alice');
        window.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true }));
    });
    await expect.poll(sent_types).toContain('requestEditSession');
    await expect.poll(sent_types).toContain('releaseEditSession');
    await expect(cell(1, 0)).toHaveText('Alice');
    await expect_nothing_unsaved();
    expect(fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
});

test('the add-row launcher is there from the start and its first use adds a row', async () => {
    const rows = page.locator('tbody tr');
    await expect(rows).toHaveCount(3);
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await expect(save()).toHaveClass(/has-unsaved/);

    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8').split('\n').length).toBe(6);
    await expect_nothing_unsaved();
});

// Save releases the editing session and leaves the file holding what the
// overlay held, so the two tests below are the ones that prove history survives
// both: the first undo after a save has to act, with no second press and no
// warning.
test('undo after Save walks a saved edit back on the first press, and redo returns it', async () => {
    await select_cell(1, 0);
    await page.keyboard.type('Hello', { delay: 0 });
    await expect(editor()).toHaveValue('Hello');
    await page.keyboard.press('Enter');
    await expect(cell(1, 0)).toHaveText('Hello');
    await save().click();
    const saved = 'Name,Age,City\nHello,30,New York\nBob,25,London\nCharlie,35,Paris\n';
    await expect.poll(() => fs.readFileSync(csv, 'utf8')).toBe(saved);
    await expect_nothing_unsaved();

    // One press: the cell goes back, as an unsaved change over the saved file.
    await undo();
    await expect(cell(1, 0)).toHaveText('Alice');
    await expect(save()).toHaveClass(/has-unsaved/);
    expect(fs.readFileSync(csv, 'utf8')).toBe(saved);

    // Redo lands on what the file already holds, so nothing is left to save.
    await page.evaluate(() => window.postMessage({ type: 'editCommand', command: 'redo' }, '*'));
    await expect(cell(1, 0)).toHaveText('Hello');
    await expect_nothing_unsaved();

    // And the undo can be saved, which writes the original back.
    await undo();
    await expect(cell(1, 0)).toHaveText('Alice');
    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
    await expect_nothing_unsaved();
});

test('undo after Save takes a saved appended row back out on the first press', async () => {
    const rows = page.locator('tbody tr');
    await page.getByRole('button', { name: 'Add rows' }).click();
    await page.getByRole('button', { name: 'Add row', exact: true }).click();
    await expect(rows).toHaveCount(4);
    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8')).toBe(`${fixture_text},,\n`);
    await expect_nothing_unsaved();
    // The saved row is a row of the file now, with a cell of its own.
    await expect(cell(1, 3)).toBeAttached();

    // The row stays in place until the next save removes it.
    await undo();
    await expect(save()).toHaveClass(/has-unsaved/);
    await save().click();
    await expect.poll(() => fs.readFileSync(csv, 'utf8')).toBe(fixture_text);
    await expect(rows).toHaveCount(3);
    await expect_nothing_unsaved();
});

/**
 * Send `keys` through CDP, a key down and up for each, without waiting for
 * one to be handled before sending the next. They reach the app in order and
 * as fast as a barcode scanner, a text expander, or key repeat sends them:
 * faster than Playwright's `press`, and often before the render that follows
 * the key before. `\n` is Enter and `\t` is Tab.
 */
async function type_fast(keys: string): Promise<void> {
    const special: Record<string, { key: string; code: string; windowsVirtualKeyCode: number; text?: string }> = {
        '\n': { key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, text: '\r' },
        '\t': { key: 'Tab', code: 'Tab', windowsVirtualKeyCode: 9 },
    };
    const cdp = await page.context().newCDPSession(page);
    try {
        await Promise.all([...keys].flatMap((character) => {
            const named = special[character];
            const key = named === undefined ? { key: character } : {
                key: named.key,
                code: named.code,
                windowsVirtualKeyCode: named.windowsVirtualKeyCode,
            };
            const text = named === undefined ? character : named.text;
            return [
                cdp.send('Input.dispatchKeyEvent', text === undefined
                    ? { ...key, type: 'rawKeyDown' }
                    : { ...key, type: 'keyDown', text, unmodifiedText: text }),
                cdp.send('Input.dispatchKeyEvent', { ...key, type: 'keyUp' }),
            ];
        }));
    } finally {
        await cdp.detach();
    }
}

/** Make an edit elsewhere, so that the session stays held. */
async function hold_session(): Promise<void> {
    await select_cell(3, 2);
    await page.keyboard.press('Delete');
    await expect(cell(3, 2)).toHaveText('');
    await expect(save()).toHaveClass(/has-unsaved/);
}

test('keys typed fast under a session after an Enter or Tab start the next edit at the next cell', async () => {
    await hold_session();
    // Enter commits "ab" and selects the cell below, where "cd" starts the
    // next edit, however soon after the Enter it comes. The second Enter
    // commits it there.
    await select_cell(1, 0);
    await type_fast('ab\ncd\n');
    await expect(cell(1, 2)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('ab');
    await expect(cell(1, 1)).toHaveText('cd');

    // Tab commits and selects the cell to the right.
    await select_cell(1, 2);
    await type_fast('ef\tgh\t');
    await expect(cell(3, 2)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 2)).toHaveText('ef');
    await expect(cell(2, 2)).toHaveText('gh');
});

test('a barcode scan under a session fills one cell per scan, each ending with Enter', async () => {
    await hold_session();
    await select_cell(2, 0);
    await type_fast('12345\n67890\n');
    await expect(cell(2, 2)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeHidden();
    await expect(cell(2, 0)).toHaveText('12345');
    await expect(cell(2, 1)).toHaveText('67890');
    await expect(cell(2, 2)).toHaveText('35');
});

/** Open `file` in a fresh app, in place of the fixture. */
async function relaunch_with(file: string): Promise<void> {
    await app!.close();
    app = await launch_app(isolated_user_data('tv-edit-without-mode-data-'), [file]);
    await expect.poll(
        () => app!.windows().filter((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX)).length,
        { timeout: 30_000 },
    ).toBe(1);
    page = app.windows().find((candidate) => candidate.url().startsWith(VIEWER_URL_PREFIX))!;
    await page.locator('#glide-cell-1-0').waitFor({ state: 'attached' });
}

const inline = (ref: string, text: string) => `<c r="${ref}" t="inlineStr"><is><t>${text}</t></is></c>`;

// An Enter on the last row, or a Tab on its last cell, adds a row, and the
// host takes a moment to admit it. Keys typed in that moment belong to the
// new row, as they would to the next cell anywhere else.
for (const extension of ['csv', 'xlsx']) {
    test(`keys typed fast after an Enter or Tab that adds a row to a ${extension} start the next edit in the new row`, async () => {
        if (extension === 'xlsx') await relaunch_with_xlsx();
        const rows = page.locator('tbody tr');
        const last = (await rows.count()) - 1;
        await hold_session();

        await select_cell(1, last);
        await press_at_once(['a', 'b', 'Enter', 'x', 'y', 'z']);
        await expect(rows).toHaveCount(last + 2);
        await expect(cell(1, last + 1)).toHaveAttribute('aria-selected', 'true');
        await expect(editor()).toHaveValue('xyz');
        await expect(cell(1, last)).toHaveText('ab');
        await page.keyboard.press('Tab');
        await expect(editor()).toBeHidden();
        await expect(cell(1, last + 1)).toHaveText('xyz');

        // Tab on the new row's last cell adds another and moves to its first.
        await page.keyboard.press('Tab');
        await expect(cell(3, last + 1)).toHaveAttribute('aria-selected', 'true');
        await press_at_once(['c', 'Tab', 'q', 'r']);
        await expect(rows).toHaveCount(last + 3);
        await expect(cell(1, last + 2)).toHaveAttribute('aria-selected', 'true');
        await expect(editor()).toHaveValue('qr');
        await expect(cell(3, last + 1)).toHaveText('c');
        await page.keyboard.press('Tab');
        await expect(editor()).toBeHidden();
        await expect(cell(1, last + 2)).toHaveText('qr');
    });
}

test('keys after an Enter that adds a row, typed before the session is granted, start the next edit in the new row', async () => {
    const rows = page.locator('tbody tr');
    await select_cell(1, 2);
    await press_at_once(['a', 'b', 'Enter', 'x', 'y', 'z']);
    await expect(rows).toHaveCount(4);
    await expect(cell(1, 3)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toHaveValue('xyz');
    await expect(cell(1, 2)).toHaveText('ab');
    await page.keyboard.press('Tab');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 3)).toHaveText('xyz');
});

/** Replace the fixture with the same table as an xlsx workbook. */
async function relaunch_with_xlsx(): Promise<void> {
    const file = path.join(root, 'basic.xlsx');
    fs.writeFileSync(file, Buffer.from(build_fixture_xlsx({ sheets: [{
        name: 'People',
        body: '<sheetData>'
            + `<row r="1">${inline('A1', 'Name')}${inline('B1', 'Age')}${inline('C1', 'City')}</row>`
            + `<row r="2">${inline('A2', 'Alice')}<c r="B2"><v>30</v></c>${inline('C2', 'New York')}</row>`
            + `<row r="3">${inline('A3', 'Bob')}<c r="B3"><v>25</v></c>${inline('C3', 'London')}</row>`
            + `<row r="4">${inline('A4', 'Charlie')}<c r="B4"><v>35</v></c>${inline('C4', 'Paris')}</row>`
            + '</sheetData>',
    }] })));
    await relaunch_with(file);
}

// A Tab on the grid past the last cell, with no editor open, adds a row the
// same way, and keys typed while it is added belong to the new row too.
for (const extension of ['csv', 'xlsx']) {
    test(`keys typed while a Tab on the grid adds a row to a ${extension} start an edit in the new row`, async () => {
        if (extension === 'xlsx') await relaunch_with_xlsx();
        const rows = page.locator('tbody tr');
        const last = (await rows.count()) - 1;
        // The session is held by an edit away from the last row, whose cells
        // keep their values.
        await select_cell(1, 0);
        await page.keyboard.press('Delete');
        await expect(cell(1, 0)).toHaveText('');
        await expect(save()).toHaveClass(/has-unsaved/);

        await select_cell(3, last);
        await press_at_once(['Tab', 'x', 'y', 'z']);
        await expect(rows).toHaveCount(last + 2);
        await expect(cell(1, last + 1)).toHaveAttribute('aria-selected', 'true');
        await expect(editor()).toHaveValue('xyz');
        await page.keyboard.press('Tab');
        await expect(editor()).toBeHidden();
        await expect(cell(1, last + 1)).toHaveText('xyz');
        await expect(cell(3, last)).toHaveText('Paris');
    });
}

test('a Tab on the grid past the last cell adds a row before any session, and keys typed after it go there', async () => {
    const rows = page.locator('tbody tr');
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
    await select_cell(3, 2);
    await press_at_once(['Tab', 'x', 'y', 'z']);
    await expect(rows).toHaveCount(4);
    await expect(cell(1, 3)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toHaveValue('xyz');
    await page.keyboard.press('Tab');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 3)).toHaveText('xyz');
    await expect(cell(3, 2)).toHaveText('Paris');
});

test('a Tab on the grid that adds a row before any session lets go of the session once the row is undone', async () => {
    const rows = page.locator('tbody tr');
    const root_el = page.locator('.grid-shell-root');
    await expect(root_el).toHaveAttribute('data-edit-session', 'none');
    await select_cell(3, 2);
    await page.keyboard.press('Tab');
    await expect(rows).toHaveCount(4);
    await expect(cell(1, 3)).toHaveAttribute('aria-selected', 'true');
    await expect(editor()).toBeHidden();
    await expect(save()).toHaveClass(/has-unsaved/);
    await undo();
    await expect(rows).toHaveCount(3);
    await expect_nothing_unsaved();
    await expect(root_el).toHaveAttribute('data-edit-session', 'none');
});

/** The body rows the grid shows, as `a|b|c`. */
const shown_rows = () => page.evaluate(() => [...document.querySelectorAll('tbody tr')].map((line) =>
    [...line.querySelectorAll('td')].map((data) => data.textContent ?? '').join('|')));

/** The state strip's text: the filter chips, among others. */
const strip = () => page.evaluate(() =>
    ((document.querySelector('.state-strip') as HTMLElement | null)?.innerText ?? '').replace(/\s+/g, ' ').trim());

/** Choose "Filter…" in a column's header menu (`column` from 0) and return the filter editor it opens. */
async function open_filter_from_header_menu(column: number) {
    const menu = await open_column_menu(page, column);
    // Opening the menu is what acquires the session, when none is held.
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'held');
    await menu.getByRole('menuitem', { name: /^Filter…/ }).click();
    await expect(menu).toHaveCount(0);
    return page.locator('.filter-popover');
}

/** Fill in the open filter editor with "contains `text`" and apply it. */
async function apply_contains(text: string): Promise<void> {
    const popover = page.locator('.filter-popover');
    await popover.locator('#filter-condition').selectOption('contains');
    await popover.getByLabel('Filter value').fill(text);
    await popover.getByRole('button', { name: 'Apply' }).click();
    await expect(popover).toBeHidden();
}

test('Filter… in a column menu opens a filter that stays open after the menu\'s session is let go', async () => {
    // What the host last said about the session: it answers the release with
    // a snapshot that names none, and until then refuses a sort or filter.
    await page.evaluate(() => {
        const seen = window as typeof window & { __smokeHostSession?: string | null };
        window.addEventListener('message', (event) => {
            const data = event.data as {
                type?: string;
                snapshot?: { capabilities?: { csvEditSessionId?: string } };
            } | null;
            if (data?.type !== 'workbookSnapshot') return;
            seen.__smokeHostSession = data.snapshot?.capabilities?.csvEditSessionId ?? null;
        });
    });
    const popover = await open_filter_from_header_menu(0);

    // Nothing is unsaved, so the session the menu acquired is released, and
    // the release is delivered to the window as a snapshot.
    await expect.poll(() => page.evaluate(() => ({
        window: document.querySelector('.grid-shell-root')?.getAttribute('data-edit-session'),
        host: (window as typeof window & { __smokeHostSession?: string | null }).__smokeHostSession,
    }))).toEqual({ window: 'none', host: null });
    await expect(popover).toBeVisible();
    await expect(popover.locator('.filter-popover-colname')).toHaveText('Name');

    await apply_contains('li');
    await expect.poll(strip).toContain('Name contains “li”');
    await expect.poll(shown_rows).toEqual(['Alice|30|New York', 'Charlie|35|Paris']);
    // A filter is a view: there is nothing to save, and no session is held.
    await expect_nothing_unsaved();
    await expect(page.locator('.grid-shell-root')).toHaveAttribute('data-edit-session', 'none');
});

test('a filter on a column with an unsaved edit in its first row is named by the column\'s header', async () => {
    await select_cell(1, 0);
    await page.keyboard.type('Ann');
    await page.keyboard.press('Enter');
    await expect(editor()).toBeHidden();
    await expect(cell(1, 0)).toHaveText('Ann');
    await expect(save()).toHaveClass(/has-unsaved/);

    // The unsaved edit keeps the session, so the menu acquires none and
    // nothing is released: the editor has only to name its column.
    const popover = await open_filter_from_header_menu(0);
    await expect(popover).toBeVisible();
    await expect(popover.locator('.filter-popover-colname')).toHaveText('Name');
    await apply_contains('Bob');
    await expect.poll(strip).toContain('Name contains “Bob”');
    await expect.poll(shown_rows).toEqual(['Bob|25|London']);

    // The chip's own editor and the Columns list name it the same way.
    await page.locator('.filter-chip-body').click();
    await expect(popover.locator('.filter-popover-colname')).toHaveText('Name');
    await popover.getByRole('button', { name: 'Cancel' }).click();
    await expect(popover).toBeHidden();
    await page.locator('.column-visibility-trigger').click();
    await expect(page.locator('.column-visibility-name').first()).toHaveText('Name');
});

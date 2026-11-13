// Restored structural drafts across a relaunch (row and column structure
// design, "Integration and desktop smoke": close with unsaved structural
// changes; restored drafts after relaunch).
//
// Runs in the CI desktop-relaunch job, so it keeps that job's rule: no menu
// commands and no focus assertions. Everything it checks it reads through the
// grid's accessibility table, the state database's bytes, the window count, and
// the file on disk. Every wait polls.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import { isolated_user_data, state_database_path } from './smoke-helpers';
import {
    choose,
    edit_toggle,
    enter_edit_mode,
    exit_app,
    grid_headers,
    grid_rows,
    install_dialog_capture,
    launch_structural_viewer,
    leave_edit_mode_saving,
    open_column_menu,
    open_row_menu,
    save_screenshot,
    take_dialogs,
    type_into_cell,
    viewer_count,
} from './structure-helpers';

/** Whether the state database holds every one of `needles`. The Pending
 *  Changes JSON is stored inline in the SQLite pages, so its IDs and typed
 *  values appearing there is the durability signal. */
function durable(user_data_dir: string, needles: readonly string[]): boolean {
    try {
        const bytes = fs.readFileSync(state_database_path(user_data_dir));
        return needles.every((needle) => bytes.includes(needle));
    } catch {
        return false;
    }
}

test('unsaved row and column changes survive closing the window and relaunching, then save', async () => {
    test.setTimeout(180_000);
    const test_root = isolated_user_data('tv-structure-relaunch-');
    const user_data_dir = path.join(test_root, 'user-data');
    fs.mkdirSync(user_data_dir);
    const file = path.join(test_root, 'fruit.csv');
    fs.writeFileSync(file, 'name,qty\napple,1\nbanana,2\ncherry,3\ndate,4\n');

    try {
        // --- First launch: insert, delete, and type; then close the window. ---
        const first = await launch_structural_viewer(user_data_dir, file);
        try {
            const page = first.page;
            await install_dialog_capture(first.app);
            await enter_edit_mode(page);
            await choose(await open_row_menu(page, 1), 'Insert row above');
            await expect.poll(async () => (await grid_rows(page))[1]).toBe('Row 2, inserted||');
            await type_into_cell(page, 1, 1, 'kiwi');
            await choose(await open_row_menu(page, 3), 'Delete row');
            await expect.poll(() => grid_rows(page)).toContain('Row removed, was row 3|cherry|3');
            await choose(await open_column_menu(page, 1), 'Insert column right');
            await expect.poll(() => grid_headers(page)).toContain('Column C, inserted|New column');
            await type_into_cell(page, 3, 0, 'crisp');
            await expect
                .poll(() => durable(user_data_dir, ['insert-row:', 'insert-column:', 'kiwi', 'crisp']),
                    { timeout: 30_000 })
                .toBe(true);
            await save_screenshot(page, '07-relaunch-before-close');

            // Closing keeps the drafts: no prompt, and the file is untouched.
            await first.app.evaluate(({ BrowserWindow }) => {
                for (const window of BrowserWindow.getAllWindows()) window.close();
            });
            await expect.poll(() => viewer_count(first.app), { timeout: 30_000 }).toBe(0);
            expect(await take_dialogs(first.app)).toEqual([]);
            expect(fs.readFileSync(file, 'utf8'))
                .toBe('name,qty\napple,1\nbanana,2\ncherry,3\ndate,4\n');
        } finally {
            await exit_app(first.app);
        }

        // --- Second launch: the drafts come back, and Save writes them. -----
        const second = await launch_structural_viewer(user_data_dir, file);
        try {
            const page = second.page;
            await install_dialog_capture(second.app);
            await expect(edit_toggle(page)).toHaveClass(/has-unsaved/, { timeout: 30_000 });
            if (await edit_toggle(page).getAttribute('aria-pressed') !== 'true') {
                await enter_edit_mode(page);
            }
            await expect.poll(() => grid_rows(page), { timeout: 30_000 }).toEqual([
                '|apple|1|crisp',
                'Row 2, inserted|kiwi||',
                '|banana|2|',
                'Row removed, was row 3|cherry|3|',
                '|date|4|',
            ]);
            await expect.poll(() => grid_headers(page))
                .toEqual(['|name', '|qty', 'Column C, inserted|New column']);
            await save_screenshot(page, '08-relaunch-restored-drafts');

            await leave_edit_mode_saving(second.app, page);
            await expect.poll(() => fs.readFileSync(file, 'utf8'))
                .toBe('name,qty,New column\napple,1,crisp\nkiwi,,\nbanana,2,\ndate,4,\n');
            await expect(edit_toggle(page)).not.toHaveClass(/has-unsaved/);
        } finally {
            await exit_app(second.app);
        }
    } finally {
        fs.rmSync(test_root, { recursive: true, force: true });
    }
});

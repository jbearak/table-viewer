// A main-process evaluate that lands while main is busy must still answer.
import * as fs from 'fs';
import * as path from 'path';
import { expect, test } from '@playwright/test';
import type { ElectronApplication } from '@playwright/test';
import { isolated_user_data, launch_app } from './smoke-helpers';

let app: ElectronApplication | undefined;
let user_data_dir = '';

test.beforeEach(() => {
    user_data_dir = isolated_user_data('table-viewer-busy-main-');
});

test.afterEach(async () => {
    await app?.close().catch(() => {});
    app = undefined;
    fs.rmSync(user_data_dir, { recursive: true, force: true });
});

test('an evaluate that arrives while main is busy allocating still gets its answer', async () => {
    const file = path.join(user_data_dir, 'busy.csv');
    fs.writeFileSync(file, 'name\na\n');
    app = await launch_app(user_data_dir, [file]);
    let answered_while_busy = 0;
    for (let round = 0; round < 20; round += 1) {
        // Busy main for 300 ms, allocating so the young generation collects.
        await app.evaluate(() => {
            setTimeout(() => {
                const main = globalThis as typeof globalThis & { __tableViewerSmokeBusy?: boolean };
                main.__tableViewerSmokeBusy = true;
                const end = Date.now() + 300;
                let keep: unknown[] = [];
                while (Date.now() < end) {
                    keep.push(new Array(64).fill(end));
                    if (keep.length > 10_000) keep = [];
                }
                main.__tableViewerSmokeBusy = false;
            }, 0);
        });
        const answers = await Promise.all(Array.from({ length: 5 }, (_, index) =>
            app!.evaluate((_electron, value) => ({
                value,
                busy: (globalThis as typeof globalThis & { __tableViewerSmokeBusy?: boolean })
                    .__tableViewerSmokeBusy === true,
            }), index)));
        expect(answers.map((answer) => answer.value)).toEqual([0, 1, 2, 3, 4]);
        answered_while_busy += answers.filter((answer) => answer.busy).length;
    }
    // Otherwise every evaluate missed the busy stretch, and the test proved nothing.
    expect(answered_while_busy).toBeGreaterThan(0);
});

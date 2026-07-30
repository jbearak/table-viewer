import { app } from 'electron';
import { run_sqlite_api_probe } from './sqlite-api-probe.mjs';

async function main() {
    let exit_code = 0;
    try {
        // Wait for Electron's platform lifecycle to initialize before requesting exit.
        // Calling app.exit() before readiness can leave Linux helper processes alive
        // under xvfb even though the synchronous SQLite probe has completed.
        await app.whenReady();
        const result = run_sqlite_api_probe('electron-main');
        if (result.electron !== '43.2.0') {
            throw new Error(`expected Electron 43.2.0, received ${result.electron}`);
        }
        process.stdout.write(`${JSON.stringify(result)}\n`);
    } catch (error) {
        exit_code = 1;
        process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
    } finally {
        app.exit(exit_code);
    }
}

void main();

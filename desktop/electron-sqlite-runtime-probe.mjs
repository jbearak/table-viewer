import { writeSync } from 'node:fs';
import { app } from 'electron';
import { run_sqlite_api_probe } from './sqlite-api-probe.mjs';

function write_output(stream, text) {
    // Probe output is one short line. A synchronous descriptor write both flushes it
    // before app.exit() and fails immediately if a pipe has already closed.
    writeSync(stream.fd, text);
}

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
        write_output(process.stdout, `${JSON.stringify(result)}\n`);
    } catch (error) {
        exit_code = 1;
        try {
            write_output(
                process.stderr,
                `${error instanceof Error ? error.message : String(error)}\n`,
            );
        } catch {
            // A closed diagnostic pipe must not keep the Electron process alive.
        }
    } finally {
        app.exit(exit_code);
    }
}

void main();

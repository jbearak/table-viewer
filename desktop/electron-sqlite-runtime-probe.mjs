import { app } from 'electron';
import { run_sqlite_api_probe } from './sqlite-api-probe.mjs';

let exit_code = 0;
try {
    const result = run_sqlite_api_probe('electron-main');
    if (result.electron !== '43.2.0') {
        throw new Error(`expected Electron 43.2.0, received ${result.electron}`);
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
} catch (error) {
    exit_code = 1;
    process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
} finally {
    // The probe has no windows or asynchronous work: its observable completion is
    // the SQLite result above, after which the Electron process terminates itself.
    app.exit(exit_code);
}

import { run_sqlite_api_probe } from './sqlite-api-probe.mjs';

const result = run_sqlite_api_probe('host-node');
if (result.node !== '26.5.1') {
    throw new Error(`expected standalone Node 26.5.1, received ${result.node}`);
}
process.stdout.write(`${JSON.stringify(result)}\n`);

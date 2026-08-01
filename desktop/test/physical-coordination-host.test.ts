import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { desktop_physical_coordination_port } from '../main/desktop-host-ports';

function resource(filePath: string, scheme = 'file') {
    return {
        scheme,
        authority: '',
        path: filePath,
        query: '',
        fragment: '',
        fsPath: filePath,
    };
}

describe('desktop physical coordination host port', () => {
    let directory: string;
    let target: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-desktop-physical-port-'));
        target = path.join(directory, 'data.csv');
        fs.writeFileSync(target, 'a\n');
    });

    afterEach(() => {
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('keeps providers view-only', () => {
        expect(desktop_physical_coordination_port.availability(resource(target, 'memfs')))
            .toEqual({ type: 'viewOnly', reason: 'non-file' });
    });

    it('keeps native files view-only without a proven conditional installer', async () => {
        expect(desktop_physical_coordination_port.availability(resource(target)))
            .toEqual({ type: 'viewOnly', reason: 'conditional-install-unsupported' });
        expect(await desktop_physical_coordination_port.acquire(resource(target)))
            .toEqual({ type: 'viewOnly', reason: 'conditional-install-unsupported' });
    });
});

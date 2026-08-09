import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { vscode_physical_coordination_port } from '../vscode-host-ports';
import * as vscode from './mocks/vscode';

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

describe('VS Code physical coordination host port', () => {
    let directory: string;
    let target: string;

    beforeEach(() => {
        directory = fs.mkdtempSync(path.join(os.tmpdir(), 'tv-vscode-physical-port-'));
        target = path.join(directory, 'data.csv');
        fs.writeFileSync(target, 'a\n');
        vscode.env.remoteName = undefined;
    });

    afterEach(() => {
        vscode.env.remoteName = undefined;
        fs.rmSync(directory, { recursive: true, force: true });
    });

    it('keeps providers and remote extension hosts view-only', () => {
        expect(vscode_physical_coordination_port.availability(resource(target, 'memfs')))
            .toEqual({ type: 'viewOnly', reason: 'non-file' });
        vscode.env.remoteName = 'ssh-remote';
        expect(vscode_physical_coordination_port.availability(resource(target)))
            .toEqual({ type: 'viewOnly', reason: 'remote-host' });
    });

    it('keeps native files view-only without a proven conditional installer', async () => {
        expect(vscode_physical_coordination_port.availability(resource(target)).type)
            .toBe('viewOnly');
        expect((await vscode_physical_coordination_port.acquire(resource(target))).type)
            .toBe('viewOnly');
    });
});

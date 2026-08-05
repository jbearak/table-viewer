import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
// The release probe is executable JavaScript so the workflows can run it without
// compiling the extension test project first.
// @ts-expect-error The executable probe intentionally has no TypeScript declarations.
import { expected_vsix_paths, unzip_text, validate_archived_manifest, validate_companion_entries, validate_externalized_sqlite, validate_main_entries } from '../../scripts/check-vsix-packages.mjs';
// @ts-expect-error The executable registry gate intentionally has no TypeScript declarations.
import { wait_for_extension_version } from '../../scripts/wait-extension-version.mjs';

const main_manifest = {
    name: 'table-viewer',
    publisher: 'jbearak',
    version: '1.2.3',
};
const companion_manifest = {
    name: 'table-viewer-companion',
    publisher: 'jbearak',
    version: '1.2.3',
};

const main_entries = [
    'extension/package.json',
    'extension/dist/extension.js',
    'extension/dist/webview/index.js',
    'extension/dist/webview/index.css',
];
const companion_entries = [
    'extension/package.json',
    'extension/LICENSE.txt',
    'extension/dist/extension.js',
];
const release_build = readFileSync(
    resolve(__dirname, '../../.github/workflows/release-build.yml'),
    'utf8',
);
const release_publish = readFileSync(
    resolve(__dirname, '../../.github/workflows/release-publish.yml'),
    'utf8',
);
const package_manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../package.json'),
    'utf8',
)) as { scripts: Record<string, string> };
const release_tools_manifest = JSON.parse(readFileSync(
    resolve(__dirname, '../../.github/release-tools/package.json'),
    'utf8',
)) as { dependencies: Record<string, string> };
const release_tools_lock = JSON.parse(readFileSync(
    resolve(__dirname, '../../.github/release-tools/package-lock.json'),
    'utf8',
)) as {
    lockfileVersion: number;
    packages: Record<string, { version?: string; integrity?: string }>;
};
const bump_version = readFileSync(resolve(__dirname, '../../scripts/bump-version.sh'), 'utf8');
const setup = readFileSync(resolve(__dirname, '../../scripts/setup.sh'), 'utf8');

describe('dual VSIX release package validation', () => {
    it('derives distinct exact-version paths from stable package identities', () => {
        expect(expected_vsix_paths(main_manifest, companion_manifest)).toEqual({
            version: '1.2.3',
            main: 'table-viewer-1.2.3.vsix',
            companion: 'companion/table-viewer-companion-1.2.3.vsix',
        });
    });

    it('rejects a companion version or identity mismatch', () => {
        expect(() => expected_vsix_paths(main_manifest, {
            ...companion_manifest,
            version: '1.2.4',
        })).toThrow(/versions differ/u);
        expect(() => expected_vsix_paths(main_manifest, {
            ...companion_manifest,
            name: 'wrong-companion',
        })).toThrow(/unexpected companion extension id/u);
    });

    it('requires main runtime/webview output and excludes companion artifacts', () => {
        expect(() => validate_main_entries(main_entries)).not.toThrow();
        expect(() => validate_main_entries([
            ...main_entries,
            'extension/companion/src/extension.ts',
        ])).toThrow(/companion files/u);
        expect(() => validate_main_entries(main_entries.filter(
            (entry) => entry !== 'extension/dist/webview/index.js',
        ))).toThrow(/missing extension\/dist\/webview\/index.js/u);
    });

    it('requires only the built companion payload, not source, tests, or nested VSIX files', () => {
        expect(() => validate_companion_entries(companion_entries)).not.toThrow();
        for (const leaked of [
            'extension/src/extension.ts',
            'extension/test/companion-store.test.ts',
            'extension/dist-types/extension.d.ts',
            'extension/tsconfig.json',
            'extension/table-viewer-companion-1.2.3.vsix',
        ]) {
            expect(() => validate_companion_entries([
                ...companion_entries,
                leaked,
            ])).toThrow(/excluded source\/test artifact/u);
        }
    });

    it('builds, checksums, uploads, and reinspects both exact-version release artifacts', () => {
        expect(release_build).toContain('run: npm run package:release');
        expect(release_build).toContain('sha256sum "$MAIN_VSIX" > "$MAIN_VSIX.sha256"');
        expect(release_build).toContain('working-directory: companion');
        expect(release_build).toContain('COMPANION_VSIX="table-viewer-companion-${VERSION}.vsix"');
        expect(release_build).toContain('sha256sum "$COMPANION_VSIX" > "$COMPANION_VSIX.sha256"');
        expect(release_build).toContain('companion/table-viewer-companion-${{ steps.version.outputs.version }}.vsix');
        expect(release_publish).toContain('run: npm run probe:vsix:packages');
        expect(release_publish).toContain('working-directory: companion');
        expect(release_publish).toContain('sha256sum -c "table-viewer-companion-${VERSION}.vsix.sha256"');
    });

    it('executes privileged release code only from the immutable successful build commit', () => {
        expect(release_publish).toContain("RUN_HEAD_SHA: ${{ github.event.workflow_run.head_sha }}");
        expect(release_publish).toContain('ref: ${{ steps.release.outputs.sha }}');
        expect(release_publish).toContain('RELEASE_SHA: ${{ steps.release.outputs.sha }}');
        expect(release_publish).toContain('.head_sha == $sha');
        expect(release_publish).toContain('.event == "workflow_dispatch"');
        expect(release_publish).not.toContain('$defaultBranch');
        expect(release_publish).not.toContain('| head -1');
        expect(release_publish).not.toContain('ref: ${{ env.RELEASE_TAG }}');
        expect(release_publish).not.toContain('tap/bin/update-cask.sh');
        expect(release_publish.match(/git\/ref\/tags\/\$\{THE_TAG\}/gu)).toHaveLength(7);
        expect(release_publish.match(/CURRENT_TAG_SHA.*!=.*RELEASE_SHA/gu)).toHaveLength(6);
        const expect_ordered = (before: string, after: string) => {
            const before_index = release_publish.indexOf(before);
            const after_index = release_publish.indexOf(after);
            expect(before_index, `missing step: ${before}`).toBeGreaterThan(-1);
            expect(after_index, `missing step: ${after}`).toBeGreaterThan(-1);
            expect(before_index).toBeLessThan(after_index);
        };
        expect_ordered(
            'Revalidate release tag before registry publication',
            'Publish companion to VS Code Marketplace',
        );
        expect_ordered(
            'Revalidate release tag before companion Open VSX publication',
            'Publish companion to Open VSX',
        );
        expect_ordered(
            'Revalidate release tag before main Marketplace publication',
            'Publish main extension to VS Code Marketplace',
        );
        expect_ordered(
            'Revalidate release tag before main Open VSX publication',
            'Publish main extension to Open VSX',
        );
        expect_ordered(
            'Revalidate release tag before GitHub Release',
            'Create GitHub Release',
        );
        expect_ordered(
            'Revalidate release tag before Homebrew bump',
            'Resolve Homebrew tap snapshot',
        );
        expect_ordered(
            'Checkout immutable release commit',
            'node scripts/wait-extension-version.mjs',
        );
        expect(release_build.match(/git\/ref\/tags\/\$\{THE_TAG\}/gu)).toHaveLength(2);
        expect(release_build.match(/EVENT_SHA: \$\{\{ github\.sha \}\}/gu)).toHaveLength(2);
        expect(release_build.match(/"\$SHA" != "\$EVENT_SHA"/gu)).toHaveLength(2);
        expect(release_build.match(/ref: \$\{\{ steps\.release\.outputs\.sha \}\}/gu)).toHaveLength(2);
        expect(release_build).not.toContain("ref: ${{ github.event_name == 'push' && github.sha || inputs.tag }}");
    });

    it('installs and invokes lockfile-pinned privileged publication tools', () => {
        expect(release_tools_manifest.dependencies).toEqual({
            '@vscode/vsce': '3.7.1',
            ovsx: '0.10.9',
        });
        expect(release_tools_lock.lockfileVersion).toBe(3);
        expect(release_tools_lock.packages['node_modules/@vscode/vsce']).toMatchObject({
            version: '3.7.1',
            integrity: expect.stringMatching(/^sha512-/u),
        });
        expect(release_tools_lock.packages['node_modules/ovsx']).toMatchObject({
            version: '0.10.9',
            integrity: expect.stringMatching(/^sha512-/u),
        });
        expect(release_publish).toContain('working-directory: .github/release-tools');
        expect(release_publish).toContain('run: npm ci --ignore-scripts');
        expect(release_publish).not.toMatch(/npm install --global|npm install -g/u);
        expect(release_publish.match(/\.github\/release-tools\/node_modules\/\.bin\/vsce publish/gu))
            .toHaveLength(2);
        expect(release_publish.match(/\.github\/release-tools\/node_modules\/\.bin\/ovsx publish/gu))
            .toHaveLength(2);
        expect(release_publish).not.toContain('--pat');
        expect(release_publish.match(/VSCE_PAT: \$\{\{ secrets\.VSCE_PAT \}\}/gu)).toHaveLength(2);
        expect(release_publish.match(/OVSX_PAT: \$\{\{ secrets\.OVSX_PAT \}\}/gu)).toHaveLength(2);
    });

    it('fails artifact listing distinctly from a valid empty result', () => {
        expect(release_publish).toContain('if ! CANDIDATES=$(gh api --paginate');
        expect(release_publish).toContain('ERROR: could not list repository artifacts');
        expect(release_publish).toContain('if [[ -n "$CANDIDATES" ]]; then');
        expect(release_publish).toContain("ERROR: No valid artifact found named '$ARTIFACT_NAME'");
        expect(release_publish).not.toContain('done < <(gh api --paginate');
    });

    it('publishes the companion before its dependent main extension in both registries', () => {
        const companion_marketplace = release_publish.indexOf('Publish companion to VS Code Marketplace');
        const companion_open_vsx = release_publish.indexOf('Publish companion to Open VSX');
        const main_marketplace = release_publish.indexOf('Publish main extension to VS Code Marketplace');
        const main_open_vsx = release_publish.indexOf('Publish main extension to Open VSX');
        expect(companion_marketplace).toBeGreaterThan(-1);
        expect(companion_open_vsx).toBeGreaterThan(-1);
        const marketplace_available = release_publish.indexOf('Wait for companion Marketplace availability');
        const open_vsx_available = release_publish.indexOf('Wait for companion Open VSX availability');
        expect(marketplace_available).toBeGreaterThan(companion_marketplace);
        expect(open_vsx_available).toBeGreaterThan(companion_open_vsx);
        expect(main_marketplace).toBeGreaterThan(marketplace_available);
        expect(main_open_vsx).toBeGreaterThan(open_vsx_available);
        expect(release_publish.match(/vsce publish --skip-duplicate/gu)).toHaveLength(2);
        expect(release_publish.match(/ovsx publish --skip-duplicate/gu)).toHaveLength(2);
    });

    it('keeps version bumps and local setup exact-version companion aware', () => {
        expect(bump_version).toContain("['package.json', 'companion/package.json']");
        expect(bump_version).toContain('git add package.json companion/package.json package-lock.json');
        expect(setup).toContain('npm run package:release');
        const companion_install = setup.indexOf('--install-extension "$COMPANION_VSIX_FILE" --force');
        const main_install = setup.indexOf('--install-extension "$VSIX_FILE" --force');
        const prior_inventory = setup.indexOf('--list-extensions --show-versions');
        const companion_restore = setup.indexOf('--install-extension "$PRIOR_COMPANION" --force');
        const companion_remove = setup.indexOf('--uninstall-extension "$COMPANION_EXTENSION_ID"');
        expect(prior_inventory).toBeGreaterThan(-1);
        expect(companion_install).toBeGreaterThan(prior_inventory);
        expect(main_install).toBeGreaterThan(companion_install);
        expect(companion_restore).toBeGreaterThan(main_install);
        expect(companion_remove).toBeGreaterThan(main_install);
        expect(setup).toContain('[ -n "$PRIOR_COMPANION" ]');
        expect(setup).toContain('[ -z "$PRIOR_COMPANION" ]');
        expect(setup).toContain('main install failed; companion restored');
        expect(setup).toContain('main install failed; companion rollback failed');
        expect(setup).toContain('if [ $ROLLBACK_FAILURES -ne 0 ]; then');
    });

    it('waits for delayed registry visibility and accepts an already indexed version', async () => {
        let calls = 0;
        let clock = 0;
        await expect(wait_for_extension_version({
            registry: 'open-vsx',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => {
                calls += 1;
                return calls === 1
                    ? new Response('{}', { status: 404 })
                    : new Response(JSON.stringify({ namespace: 'jbearak', name: 'table-viewer-companion', version: '1.2.3' }));
            },
            sleep: async (milliseconds: number) => { clock += milliseconds; },
            now: () => clock,
            timeoutMs: 10,
            intervalMs: 1,
        })).resolves.toBeUndefined();
        expect(calls).toBe(2);

        await expect(wait_for_extension_version({
            registry: 'marketplace',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => new Response(JSON.stringify({ results: [{ extensions: [{
                publisher: { publisherName: 'jbearak' },
                extensionName: 'table-viewer-companion',
                versions: [{ version: '1.2.3' }],
            }] }] })),
            sleep: async () => { throw new Error('already indexed must not wait'); },
        })).resolves.toBeUndefined();
    });

    it('retries transport failures and bounds stalled requests by the indexing deadline', async () => {
        let calls = 0;
        let clock = 0;
        await expect(wait_for_extension_version({
            registry: 'open-vsx',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async (_url: string, init?: RequestInit) => {
                calls += 1;
                expect(init?.signal).toBeInstanceOf(AbortSignal);
                if (calls === 1) throw new TypeError('transient connection reset');
                return new Response(JSON.stringify({
                    namespace: 'jbearak', name: 'table-viewer-companion', version: '1.2.3',
                }));
            },
            sleep: async (milliseconds: number) => { clock += milliseconds; },
            now: () => clock,
            timeoutMs: 10,
            intervalMs: 1,
        })).resolves.toBeUndefined();
        expect(calls).toBe(2);

        clock = 0;
        let aborts = 0;
        await expect(wait_for_extension_version({
            registry: 'marketplace',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => new Promise<Response>(() => undefined),
            sleep: async () => { throw new Error('a deadline-aborted request must not sleep'); },
            schedule: (callback: () => void, milliseconds: number) => {
                clock += milliseconds;
                callback();
                aborts += 1;
                return aborts;
            },
            cancel: () => undefined,
            now: () => clock,
            timeoutMs: 5,
            intervalMs: 1,
        })).rejects.toThrow(/indexing deadline/u);
        expect(aborts).toBe(1);

        clock = 0;
        aborts = 0;
        await expect(wait_for_extension_version({
            registry: 'open-vsx',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => ({
                status: 200,
                ok: true,
                json: async () => new Promise<unknown>(() => undefined),
            }),
            sleep: async () => { throw new Error('a stalled response body must not sleep'); },
            schedule: (callback: () => void, milliseconds: number) => {
                clock += milliseconds;
                callback();
                aborts += 1;
                return aborts;
            },
            cancel: () => undefined,
            now: () => clock,
            timeoutMs: 5,
            intervalMs: 1,
        })).rejects.toThrow(/indexing deadline/u);
        expect(aborts).toBe(1);
    });

    it('fails closed when registry indexing misses the deadline or returns a terminal error', async () => {
        let clock = 0;
        await expect(wait_for_extension_version({
            registry: 'open-vsx',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => new Response('{}', { status: 404 }),
            sleep: async (milliseconds: number) => { clock += milliseconds; },
            now: () => clock,
            timeoutMs: 2,
            intervalMs: 1,
        })).rejects.toThrow(/indexing deadline/u);
        await expect(wait_for_extension_version({
            registry: 'marketplace',
            publisher: 'jbearak',
            name: 'table-viewer-companion',
            version: '1.2.3',
            fetchImpl: async () => new Response('{}', { status: 403 }),
            sleep: async () => undefined,
        })).rejects.toThrow(/HTTP 403/u);
    });

    it('checks archived identity/version and companion node:sqlite externalization', () => {
        expect(() => validate_archived_manifest(main_manifest, main_manifest, 'main VSIX')).not.toThrow();
        expect(() => validate_archived_manifest(
            { ...main_manifest, version: '1.2.4' },
            main_manifest,
            'main VSIX',
        )).toThrow(/archived version/u);

        expect(package_manifest.scripts['bundle:companion']).toContain('--external:node:sqlite');
        expect(() => validate_externalized_sqlite('var e=require("node:sqlite");class t{}')).not.toThrow();
        expect(() => validate_externalized_sqlite('var e={}')).toThrow(/runtime import/u);
    });

    it('bounds unzip output and reports a missing executable actionably', () => {
        const execute = ((_file: string, _args: readonly string[], options: unknown) => {
            expect(options).toEqual({
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                windowsHide: true,
            });
            return 'extension/package.json\n';
        }) as never;
        expect(unzip_text(['-Z1', 'fixture.vsix'], execute)).toBe('extension/package.json\n');

        const missing = Object.assign(new Error('spawn unzip ENOENT'), { code: 'ENOENT' });
        expect(() => unzip_text(['-Z1', 'fixture.vsix'], (() => { throw missing; }) as never))
            .toThrow(/install unzip.*PATH/u);
        const corrupt = Object.assign(new Error('invalid archive'), { code: 9 });
        expect(() => unzip_text(['-Z1', 'fixture.vsix'], (() => { throw corrupt; }) as never))
            .toThrow(corrupt);
    });
});

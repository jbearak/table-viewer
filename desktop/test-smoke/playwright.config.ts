// Playwright config for the Electron desktop smoke test.
// Run with: npm run test:desktop-smoke (builds the bundles first).
// Deliberately separate from vitest (vitest.config.ts only picks up *.test.ts).
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.ts',
    // One Electron app at a time; the app uses a single-instance lock.
    workers: 1,
    fullyParallel: false,
    timeout: 60_000,
    expect: { timeout: 15_000 },
    reporter: [['list']],
});

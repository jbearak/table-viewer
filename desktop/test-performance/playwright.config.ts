// Playwright config for the desktop grid performance benchmark.
// Run with: npm run test:desktop-perf (builds the bundles first).
// Separate from the smoke suite: perf runs are longer, must not interleave
// with correctness specs, and their failures mean "regressed", not "broken".
import { defineConfig } from '@playwright/test';

export default defineConfig({
    testDir: '.',
    testMatch: '**/*.spec.ts',
    // One Electron app at a time; the app uses a single-instance lock, and
    // concurrent apps would contend for the GPU and poison frame timings.
    workers: 1,
    fullyParallel: false,
    // Scenario generation + launch + three scroll passes per file.
    timeout: 300_000,
    expect: { timeout: 30_000 },
    reporter: [['list']],
});

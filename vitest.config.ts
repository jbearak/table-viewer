import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'unit',
          include: ['src/test/**/*.test.ts', 'desktop/test/**/*.test.ts'],
        },
        resolve: {
          alias: {
            // The real `vscode` module is host-injected and unresolvable under node.
            // Alias it to a minimal mock so modules that touch a small slice of the
            // API (e.g. webview-html.ts) are unit-testable. See src/test/mocks/vscode.ts.
            vscode: fileURLToPath(new URL('./src/test/mocks/vscode.ts', import.meta.url)),
          },
        },
      },
      {
        // Ported upstream test suite for the vendored glide-data-grid fork.
        // Mirrors upstream's vitest config: jsdom + canvas mock + faked rAF.
        test: {
          name: 'glide',
          include: ['src/webview/glide-data-grid/test/**/*.test.{ts,tsx}'],
          environment: 'jsdom',
          setupFiles: ['src/webview/glide-data-grid/test/vitest.setup.ts'],
          clearMocks: true,
          fakeTimers: {
            toFake: [
              'setTimeout',
              'clearTimeout',
              'setInterval',
              'clearInterval',
              'setImmediate',
              'clearImmediate',
              'Date',
              'performance',
              'requestAnimationFrame',
              'cancelAnimationFrame',
            ],
          },
          deps: {
            optimizer: {
              web: {
                include: ['vitest-canvas-mock'],
              },
            },
          },
        },
      },
    ],
  },
});

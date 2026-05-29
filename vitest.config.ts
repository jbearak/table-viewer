import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['src/test/**/*.test.ts'],
  },
  resolve: {
    alias: {
      // The real `vscode` module is host-injected and unresolvable under node.
      // Alias it to a minimal mock so modules that touch a small slice of the
      // API (e.g. webview-html.ts) are unit-testable. See src/test/mocks/vscode.ts.
      vscode: fileURLToPath(new URL('./src/test/mocks/vscode.ts', import.meta.url)),
    },
  },
});

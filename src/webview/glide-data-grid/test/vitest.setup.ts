// Ported from upstream vitest.setup.js: canvas mock + ResizeObserver stub.
import "vitest-canvas-mock";

// A real class: vitest 4 mock functions are not constructible with `new`.
// No-op methods — no test inspects these calls.
(globalThis as Record<string, unknown>).ResizeObserver = class {
    observe() {}
    unobserve() {}
    disconnect() {}
};

Image.prototype.decode = () => new Promise(resolve => window.setTimeout(resolve, 10));
